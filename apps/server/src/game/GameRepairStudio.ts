// @effect-diagnostics nodeBuiltinImport:off -- Review frames are written to server state, not the game.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type GameOperationError,
  type GameReviewCheck,
  type GameSubmissionFacts,
  type GameReviewFrozenInputs,
  type GameViewport,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GameQualification from "./GameQualification.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameService from "./GameService.ts";
import { gameRecordFile } from "./gameRecord.ts";
import { readLastPlaytest } from "./playtestEvidence.ts";
import { candidateBuildDirectory, hashWebBuild } from "./webBuild.ts";

/** One captured frame the review may use, already written outside the game. */
export interface GameRepairStudioFrame {
  readonly label: string;
  /** Absolute server-state path. */
  readonly path: string;
}

export interface GameRepairStudioCheckInput {
  readonly threadId: ThreadId;
  readonly root: string;
  /** The immutable build's role in the comparison. */
  readonly target: "incumbent" | "candidate";
  readonly buildId: string;
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
 * What the server can prove about one build before anyone reviews it. Every
 * check is code-measured: the bytes on disk, the export record naming them, and
 * the playtest record that played those exact bytes. A caller's note is never
 * evidence; it is only recorded beside these facts.
 */
export type GameRepairStudioSubmissionFacts = GameSubmissionFacts;

/**
 * The exact bytes an export produced and where they came from. Review starts
 * from a builder's submission, not from an inferred playable state; this read
 * supplies the fallback export identity.
 */
export interface GameRepairStudioProvenance {
  /** The build the export stage produced, when it recorded one. */
  readonly exportBuildId: string | null;
  /** The run whose tool call exported those bytes, when it was recorded. */
  readonly exportRunId: string | null;
}

export type GameRepairStudioPromotion =
  | { readonly kind: "promoted" }
  | { readonly kind: "blocked"; readonly detail: string };

/**
 * The heavy, engine-facing half of the repair loop: the facts behind a
 * submission, code checks with captured frames, the export stage and
 * promotion. Keeping it behind one small service lets the loop's straight-line
 * fiber run in tests with scripted outcomes and no browser, and keeps
 * GameService out of the loop's dependency graph (GameService calls the loop
 * for supersession).
 */
export class GameRepairStudio extends Context.Service<
  GameRepairStudio,
  {
    /** The run's exact export bytes and where they came from. */
    readonly exportProvenance: (
      root: string,
    ) => Effect.Effect<GameRepairStudioProvenance, GameOperationError>;
    /**
     * Verifies the facts a submission (or the loop's fallback) must pass: the
     * build exists, hashes to its id, has recorded sources, and was played by
     * a playtest that booted, logged no console errors and responded.
     */
    readonly submissionFacts: (
      root: string,
      buildId?: string,
    ) => Effect.Effect<GameRepairStudioSubmissionFacts, GameOperationError>;
    /** The builder's own inputs, captured once when a loop opens. */
    readonly frozenInputs: (
      root: string,
      buildId?: string,
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
      const rounds = yield* GameRoundStore.GameRoundStore;

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
          const exported = yield* qualification.stageRecord(root, "export");
          return {
            exportBuildId: exported?.buildId ?? null,
            exportRunId: exported?.runId ?? null,
          } satisfies GameRepairStudioProvenance;
        });

      const submissionFacts: GameRepairStudio["Service"]["submissionFacts"] = (root, requested) =>
        Effect.gen(function* () {
          const exported =
            requested === undefined ? yield* qualification.stageRecord(root, "export") : null;
          const check = (
            id: string,
            status: GameReviewCheck["status"],
            detail?: string,
          ): GameReviewCheck => ({
            id,
            status,
            ...(detail === undefined || detail === "" ? {} : { detail: detail.slice(0, 1000) }),
          });
          const result = (
            buildId: string | null,
            directory: string | null,
            checks: ReadonlyArray<GameReviewCheck>,
          ): GameRepairStudioSubmissionFacts => {
            const failed = checks.filter((entry) => entry.status !== "passed");
            return {
              buildId,
              directory,
              checks,
              passed: failed.length === 0,
              reason:
                failed.length === 0
                  ? null
                  : failed
                      .map((entry) => `${entry.id}: ${entry.detail ?? entry.status}`)
                      .join("; "),
            };
          };
          const buildId = requested ?? exported?.buildId ?? null;
          if (buildId === null)
            return result(null, null, [
              check(
                "build",
                "failed",
                "This game has no exported build to submit; run game_export with target Web first.",
              ),
            ]);
          if (!/^[0-9a-f]{64}$/.test(buildId))
            return result(buildId, null, [
              check(
                "build",
                "failed",
                "The latest export has no content-addressed build id; export the game again.",
              ),
            ]);
          const directory = candidateBuildDirectory(buildId);
          const present = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(root, directory, "index.html")).then(
              (stat) => stat.isFile() && stat.size > 0,
              () => false,
            ),
          );
          const exists = check(
            "build",
            present ? "passed" : "failed",
            present
              ? undefined
              : `The build directory ${directory} is missing or has no non-empty index.html; export the game again.`,
          );
          if (!present) return result(buildId, directory, [exists]);
          const hashed = yield* Effect.promise(() =>
            hashWebBuild(root, directory).catch(() => null),
          );
          const bytes =
            hashed === null
              ? check("bytes", "failed", "The build's files could not be read and hashed.")
              : hashed.buildId === buildId
                ? check("bytes", "passed")
                : check(
                    "bytes",
                    "failed",
                    `The build's files changed after export and now hash to ${hashed.buildId}; export the game again.`,
                  );
          if (bytes.status !== "passed") return result(buildId, directory, [exists, bytes]);
          const recorded = yield* rounds.exported(root, buildId).pipe(Effect.result);
          if (recorded._tag === "Failure" || recorded.success === null)
            return result(buildId, directory, [
              exists,
              bytes,
              check(
                "sources",
                "failed",
                recorded._tag === "Failure"
                  ? (recorded.failure.detail ??
                      "The export's recorded sources are missing or unreadable.")
                  : "This build has no recorded export/source binding; export the game again.",
              ),
            ]);
          const evidence = recorded.success.playtest;
          const checks = [exists, bytes, check("sources", "passed")];
          if (evidence === null)
            return result(buildId, directory, [
              ...checks,
              check(
                "playtest",
                "failed",
                "This build has no recorded playtest; playtest it before submitting.",
              ),
            ]);
          checks.push(check("playtest", "passed"));
          const inputSteps = evidence.steps.filter(
            (step) => !("waitMs" in step) && !("screenshot" in step),
          ).length;
          const consoleErrors = evidence.consoleErrors;
          return result(buildId, directory, [
            ...checks,
            check(
              "boot",
              evidence.booted ? "passed" : "failed",
              evidence.booted ? undefined : "The playtest recorded that the game did not boot.",
            ),
            check(
              "console",
              consoleErrors === 0 ? "passed" : "failed",
              consoleErrors === 0 ? undefined : `${consoleErrors} console error(s)`,
            ),
            check(
              "input",
              inputSteps > 0 && evidence.responded ? "passed" : "failed",
              inputSteps === 0
                ? "The playtest executed no input steps; waits and screenshots do not count."
                : evidence.responded
                  ? undefined
                  : "The game did not visibly respond to the playtest's input.",
            ),
          ]);
        });

      const frozenInputs: GameRepairStudio["Service"]["frozenInputs"] = (root, buildId) =>
        Effect.gen(function* () {
          if (buildId !== undefined) {
            const recorded = yield* rounds.exported(root, buildId);
            return {
              steps: [...(recorded?.playtest?.steps ?? [])],
              viewport: recorded?.playtest?.viewport ?? null,
              seed: "unknown",
            } satisfies GameReviewFrozenInputs;
          }
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
          const result = yield* game.webPlaytestBuild(input.threadId, input.buildId, {
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
        submissionFacts,
        frozenInputs,
        check,
        exportState,
        promote,
      });
    }),
  );
