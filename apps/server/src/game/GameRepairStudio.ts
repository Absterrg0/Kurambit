// @effect-diagnostics nodeBuiltinImport:off -- Review frames are written to server state, not the game.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type GameOperationError,
  type GameReviewCheck,
  type GameReviewFrozenInputs,
  type GameViewport,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameService from "./GameService.ts";
import { gameRecordFile } from "./gameRecord.ts";
import { readLastPlaytest } from "./playtestEvidence.ts";

/** One captured frame the review may use, already written outside the game. */
export interface GameRepairStudioFrame {
  readonly label: string;
  /** Absolute server-state path. */
  readonly path: string;
}

export interface GameRepairStudioCheckInput {
  readonly threadId: ThreadId;
  readonly root: string;
  /** Which build the playtest should show. The service picks it itself. */
  readonly target: "incumbent" | "candidate";
  /**
   * The loop's frozen route and viewport. They were captured when the loop
   * opened and are replayed for every check, so a repair child's own playtest
   * can never substitute an easier route for the one it is judged on.
   */
  readonly inputs: GameReviewFrozenInputs;
}

export interface GameRepairStudioCheckResult {
  readonly checks: ReadonlyArray<GameReviewCheck>;
  readonly frames: ReadonlyArray<GameRepairStudioFrame>;
  /** The viewport this run actually played at, when the playtest reported it. */
  readonly viewport: GameViewport | null;
}

/** The export stage as the loop needs it to tell "no output" from "failed". */
export interface GameRepairStudioExportState {
  readonly outcome: "passed" | "failed" | "unknown" | "cancelled" | null;
  readonly finishedAt: string | null;
  readonly buildId: string | null;
  readonly detail: string | null;
}

/**
 * The playable bytes and where they came from. A review may only start for the
 * run that produced them, so the loop persists the build id and requires the
 * playtest to have played the same artifact.
 */
export interface GameRepairStudioProvenance {
  readonly playable: boolean;
  /** The build the export stage produced, when it recorded one. */
  readonly exportBuildId: string | null;
  /** The run whose tool call exported those bytes, when it was recorded. */
  readonly exportRunId: string | null;
  readonly exportFinishedAt: string | null;
  /** The build the qualifying playtest played, when it recorded one. */
  readonly playtestBuildId: string | null;
}

export type GameRepairStudioPromotion =
  | { readonly kind: "promoted" }
  | { readonly kind: "blocked"; readonly detail: string };

/**
 * The heavy, engine-facing half of the repair loop: playable completion, code
 * checks with captured frames, the export stage and promotion. Keeping it
 * behind one small service lets the loop's straight-line fiber run in tests
 * with scripted outcomes and no browser, and keeps GameService out of the
 * loop's dependency graph (GameService calls the loop for supersession).
 */
export class GameRepairStudio extends Context.Service<
  GameRepairStudio,
  {
    /** The run's playable completion and the exact export bytes it produced. */
    readonly exportProvenance: (
      root: string,
    ) => Effect.Effect<GameRepairStudioProvenance, GameOperationError>;
    /** The builder's own inputs, captured once when a loop opens. */
    readonly frozenInputs: (
      root: string,
    ) => Effect.Effect<GameReviewFrozenInputs, GameOperationError>;
    /** Plays one build with the frozen inputs and normalizes its real verdicts. */
    readonly check: (
      input: GameRepairStudioCheckInput,
    ) => Effect.Effect<GameRepairStudioCheckResult, GameOperationError>;
    readonly exportState: (
      root: string,
    ) => Effect.Effect<GameRepairStudioExportState, GameOperationError>;
    /** `guard` runs at the selection commit; a reason blocks the promotion. */
    readonly promote: (
      threadId: ThreadId,
      roundId: string,
      guard?: Effect.Effect<string | null>,
    ) => Effect.Effect<GameRepairStudioPromotion, GameOperationError>;
  }
>()("t3/game/GameRepairStudio") {}

/**
 * The playtest service's own measured verdicts, normalized into the stable
 * checks the loop freezes. Every check is a verdict, never a proxy: a frozen
 * player with animated scenery changes pixels and still fails movement, and a
 * run that does not qualify as honest gameplay fails `state` with its own
 * blockers. A measurement the run did not take stays `unmeasured` instead of
 * passing.
 */
const checkResult = (result: {
  readonly success: boolean;
  readonly booted: boolean;
  readonly consoleMessages: ReadonlyArray<{ readonly level: string }>;
  readonly state: {
    readonly before: { readonly hudText?: string | undefined } | null;
    readonly after: { readonly hudText?: string | undefined } | null;
    readonly playerMoved: number;
    readonly notOnScreen?: ReadonlyArray<string> | undefined;
  } | null;
  readonly qualifies?: boolean | undefined;
  readonly blockers?: ReadonlyArray<string> | undefined;
  readonly pauseConfirmed?: boolean | null | undefined;
}): ReadonlyArray<GameReviewCheck> => {
  const consoleErrors = result.consoleMessages.filter(
    (message) => message.level === "error",
  ).length;
  const state = result.state;
  const moved = state === null ? null : state.playerMoved > 0;
  const hud =
    state === null
      ? null
      : [state.before, state.after].some((probe) => (probe?.hudText ?? "").trim().length > 0);
  // Some HUD text proves nothing about the game's state: a candidate can keep
  // its title and hide the score. This judges whether every GameState value
  // the probe read is shown on screen, and is unmeasured without screen text.
  const hidden = state?.notOnScreen;
  const blockers = (result.blockers ?? []).join("; ").slice(0, 1000);
  const checks: GameReviewCheck[] = [
    { id: "boot", status: result.booted ? "passed" : "failed" },
    {
      id: "console",
      status: consoleErrors === 0 && result.success ? "passed" : "failed",
      ...(consoleErrors === 0 ? {} : { detail: `${consoleErrors} console errors` }),
    },
    {
      id: "input",
      status: moved === null ? "unmeasured" : moved ? "passed" : "failed",
      ...(moved === false ? { detail: "the player did not move from the gameplay baseline" } : {}),
    },
    {
      id: "state",
      status:
        result.qualifies === undefined ? "unmeasured" : result.qualifies ? "passed" : "failed",
      ...(result.qualifies === false
        ? { detail: blockers === "" ? "the run did not qualify as gameplay" : blockers }
        : {}),
    },
    {
      id: "hud",
      status: hud === null ? "unmeasured" : hud ? "passed" : "failed",
      ...(hud === false ? { detail: "the probe saw no visible HUD text" } : {}),
    },
    {
      id: "state-on-screen",
      status: hidden === undefined ? "unmeasured" : hidden.length === 0 ? "passed" : "failed",
      ...(hidden !== undefined && hidden.length > 0
        ? { detail: `not on screen: ${hidden.join(", ")}`.slice(0, 1000) }
        : {}),
    },
    {
      id: "bridge",
      status:
        result.pauseConfirmed === undefined || result.pauseConfirmed === null
          ? "unmeasured"
          : result.pauseConfirmed
            ? "passed"
            : "failed",
    },
  ];
  return checks;
};

export const layer = (options: { readonly stateDir: string }) =>
  Layer.effect(
    GameRepairStudio,
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const qualification = yield* GameQualification.GameQualification;
      const projects = yield* GameProjectService.GameProjectService;

      const framesDirectory = (root: string) =>
        gameRecordFile(options.stateDir, "game-repair-frames", root, "");

      const storeFrames = (
        root: string,
        screenshots: ReadonlyArray<{
          readonly label: string;
          readonly data: string;
        }>,
      ) =>
        Effect.gen(function* () {
          if (screenshots.length === 0) return [];
          const directory = NodePath.join(framesDirectory(root), NodeCrypto.randomUUID());
          yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.mkdir(directory, { recursive: true });
              return true;
            },
            catch: () => false,
          }).pipe(Effect.orElseSucceed(() => false));
          const frames: GameRepairStudioFrame[] = [];
          for (const [index, shot] of screenshots.entries()) {
            const file = NodePath.join(
              directory,
              `frame-${String(index + 1).padStart(2, "0")}.png`,
            );
            const written = yield* Effect.tryPromise({
              try: async () => {
                await NodeFSP.writeFile(file, Buffer.from(shot.data, "base64"));
                return true;
              },
              catch: () => false,
            }).pipe(Effect.orElseSucceed(() => false));
            if (!written) continue;
            frames.push({ label: shot.label, path: file });
          }
          return frames;
        });

      const exportProvenance = (root: string) =>
        Effect.gen(function* () {
          const manifest = yield* projects.read(root);
          const read = yield* qualification.read(root, manifest.godotProject);
          const exported = yield* qualification.stageRecord(root, "export");
          const played = yield* qualification.stageRecord(root, "playtest");
          return {
            playable: read.completion === "complete",
            exportBuildId: exported?.buildId ?? null,
            exportRunId: exported?.runId ?? null,
            exportFinishedAt: exported?.finishedAt ?? null,
            playtestBuildId: played?.buildId ?? null,
          } satisfies GameRepairStudioProvenance;
        });

      const frozenInputs = (root: string) =>
        Effect.gen(function* () {
          // The builder's own demo route is frozen evidence, not something the
          // repair child gets to choose again.
          const last = yield* Effect.promise(() =>
            readLastPlaytest(root, [], null).catch(() => null),
          );
          return {
            steps: [...(last?.steps ?? [])],
            viewport: last?.viewport ?? null,
            // Godot playtests are not seeded today; say so instead of inventing one.
            seed: "unknown",
          } satisfies GameReviewFrozenInputs;
        });

      const check: GameRepairStudio["Service"]["check"] = (input) =>
        Effect.gen(function* () {
          const { inputs } = input;
          const result = yield* game.webPlaytest(input.threadId, {
            ...(inputs.steps.length === 0 ? {} : { steps: [...inputs.steps] }),
            ...(inputs.viewport === null
              ? {}
              : { width: inputs.viewport.width, height: inputs.viewport.height }),
          });
          const frames = yield* storeFrames(input.root, result.screenshots);
          return {
            checks: checkResult(result),
            frames,
            viewport: result.baseViewport ?? null,
          } satisfies GameRepairStudioCheckResult;
        });

      const exportState = (root: string) =>
        Effect.gen(function* () {
          const stage = yield* qualification.stageRecord(root, "export");
          return {
            outcome: stage?.outcome ?? null,
            finishedAt: stage?.finishedAt ?? null,
            buildId: stage?.buildId ?? null,
            detail: stage?.detail ?? null,
          } satisfies GameRepairStudioExportState;
        });

      const promote: GameRepairStudio["Service"]["promote"] = (threadId, roundId, guard) =>
        game
          .promote(threadId, roundId, { guard })
          .pipe(
            Effect.map((promotion) =>
              promotion.kind === "promoted"
                ? ({ kind: "promoted" } as const)
                : ({ kind: "blocked", detail: promotion.detail } as const),
            ),
          );

      return GameRepairStudio.of({
        exportProvenance,
        frozenInputs,
        check,
        exportState,
        promote,
      });
    }),
  );
