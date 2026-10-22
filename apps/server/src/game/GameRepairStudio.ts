// @effect-diagnostics nodeBuiltinImport:off -- Review frames are written to server state, not the game.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type GameOperationError,
  type GamePlaytestStep,
  type GameReviewCheck,
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
}

export interface GameRepairStudioCheckResult {
  readonly checks: ReadonlyArray<GameReviewCheck>;
  readonly frames: ReadonlyArray<GameRepairStudioFrame>;
  /** The route both builds were played with, frozen away from the builder. */
  readonly steps: ReadonlyArray<GamePlaytestStep>;
}

/** The export stage as the loop needs it to tell "no output" from "failed". */
export interface GameRepairStudioExportState {
  readonly outcome: "passed" | "failed" | "unknown" | "cancelled" | null;
  readonly finishedAt: string | null;
  readonly buildId: string | null;
  readonly detail: string | null;
}

export type GameRepairStudioPromotion =
  | { readonly kind: "promoted" }
  | { readonly kind: "blocked"; readonly detail: string };

/**
 * The heavy, engine-facing half of the repair loop: playable completion, code
 * checks with captured frames, the export stage and promotion. Keeping it
 * behind one small service lets the loop's phase machine run in tests with
 * scripted outcomes and no browser, and keeps GameService out of the loop's
 * dependency graph (GameService calls the loop for supersession).
 */
export class GameRepairStudio extends Context.Service<
  GameRepairStudio,
  {
    /** The t48 playable completion: an export and a playtest of those bytes. */
    readonly playable: (root: string) => Effect.Effect<boolean, GameOperationError>;
    /** Plays one build with the frozen route and normalizes its checks. */
    readonly check: (
      input: GameRepairStudioCheckInput,
    ) => Effect.Effect<GameRepairStudioCheckResult, GameOperationError>;
    readonly exportState: (
      root: string,
    ) => Effect.Effect<GameRepairStudioExportState, GameOperationError>;
    readonly promote: (
      threadId: ThreadId,
      roundId: string,
    ) => Effect.Effect<GameRepairStudioPromotion, GameOperationError>;
  }
>()("t3/game/GameRepairStudio") {}

const checkResult = (result: {
  readonly success: boolean;
  readonly booted: boolean;
  readonly responded: boolean;
  readonly consoleMessages: ReadonlyArray<{ readonly level: string }>;
  readonly state: unknown;
  readonly pauseConfirmed?: boolean | null | undefined;
}): ReadonlyArray<GameReviewCheck> => {
  const consoleErrors = result.consoleMessages.filter(
    (message) => message.level === "error",
  ).length;
  return [
    { id: "boot", status: result.booted ? "passed" : "failed" },
    {
      id: "console",
      status: consoleErrors === 0 && result.success ? "passed" : "failed",
      ...(consoleErrors === 0 ? {} : { detail: `${consoleErrors} console errors` }),
    },
    { id: "input", status: result.responded ? "passed" : "failed" },
    { id: "state", status: result.state === null ? "unmeasured" : "passed" },
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

      const playable = (root: string) =>
        Effect.gen(function* () {
          const manifest = yield* projects.read(root);
          const read = yield* qualification.read(root, manifest.godotProject);
          return read.completion === "complete";
        });

      const check: GameRepairStudio["Service"]["check"] = (input) =>
        Effect.gen(function* () {
          // The builder's own demo route is frozen evidence, not something the
          // repair child gets to choose again.
          const last = yield* Effect.promise(() =>
            readLastPlaytest(input.root, [], null).catch(() => null),
          );
          const steps = last?.steps ?? [];
          const result = yield* game.webPlaytest(
            input.threadId,
            steps.length === 0 ? {} : { steps: [...steps] },
          );
          const frames = yield* storeFrames(input.root, result.screenshots);
          return {
            checks: checkResult(result),
            frames,
            steps,
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

      const promote: GameRepairStudio["Service"]["promote"] = (threadId, roundId) =>
        game
          .promote(threadId, roundId)
          .pipe(
            Effect.map((promotion) =>
              promotion.kind === "promoted"
                ? ({ kind: "promoted" } as const)
                : ({ kind: "blocked", detail: promotion.detail } as const),
            ),
          );

      return GameRepairStudio.of({ playable, check, exportState, promote });
    }),
  );
