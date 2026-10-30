// @effect-diagnostics nodeBuiltinImport:off -- Review frames are written to server state, not the game.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  GameOperationError,
  type GameReviewCheck,
  type GameScenarioEvidence,
  type GameSubmissionFacts,
  type GameReviewFrozenInputs,
  type GameViewport,
  type GameWebPlaytestInput,
  type GameWebPlaytestResult,
  type GamePlaytestInputPair,
  type GamePlaytestStep,
  type ThreadId,
  playtestInputIssues,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GameQualification from "./GameQualification.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameService from "./GameService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { decodeScenarioEvidence } from "./gameScenarios.ts";
import { formatNativeDiagnostics, selectNativeLayout } from "./scenarioLayoutDiagnostics.ts";
import { formatNativeWorld, selectNativeSpatial } from "./scenarioSpatialDiagnostics.ts";
import { gameRecordFile } from "./gameRecord.ts";
import { selectInputPairFrames } from "./playtestInputPairs.ts";
import {
  alternateWindow,
  playedViewport,
  readPlaytestEvidence,
  readPlaytestEvidenceAt,
  readLastPlaytest,
  type PlaytestEvidenceRun,
} from "./playtestEvidence.ts";
import { candidateBuildDirectory, hashWebBuild } from "./webBuild.ts";

/** One captured frame the review may use, already written outside the game. */
export interface GameRepairStudioFrame {
  readonly inputPair?: GamePlaytestInputPair;
  readonly label: string;
  /** Absolute server-state path. */
  readonly path: string;
  /** The capture window these pixels came from, when known. */
  readonly width?: number;
  readonly height?: number;
  /** True for the differently shaped window capture; budgets never drop it. */
  readonly window?: boolean;
  /** Bounded numeric/boolean GameState scalars measured nearest this frame. */
  readonly observations?: Record<string, number | boolean>;
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
  /**
   * Same-source native layout hints for the critic, when the frozen scenario
   * evidence binds to this exact build. Hints name where to look with
   * game_try_input on Web frames; they are never Web defect proof, never a
   * repair defect, and never a gate. Absent when the state record is stale,
   * missing or unreadable.
   */
  readonly nativeDiagnostics?: GameRepairStudioNativeDiagnostics;
  /**
   * Same-source native world measurements for the critic, when the frozen
   * scenario evidence binds to this exact build. Portable world-space
   * numbers only, never a verdict, gate, defect or ballot change. Absent
   * when the state record is stale, missing, unreadable, or holds no
   * spatial snapshots.
   */
  readonly nativeWorld?: GameRepairStudioNativeWorld;
}

const readNativeScenarioEvidence = async (
  root: string,
  relative: string,
): Promise<GameScenarioEvidence[]> => {
  const results: GameScenarioEvidence[] = [];
  try {
    const canonicalRoot = await NodeFSP.realpath(root);
    const directory = await NodeFSP.realpath(GameProjectService.insideGame(root, relative));
    if (!directory.startsWith(canonicalRoot + NodePath.sep)) return results;
    const entries = await NodeFSP.opendir(directory);
    let visited = 0;
    let attempted = 0;
    for await (const entry of entries) {
      if (++visited > 64 || attempted >= 8) break;
      if (!entry.name.endsWith(".result.json")) continue;
      attempted += 1;
      const file = NodePath.join(directory, entry.name);
      const info = await NodeFSP.lstat(file);
      if (!info.isFile() || info.size > 200_000) continue;
      const handle = await NodeFSP.open(
        file,
        NodeFSP.constants.O_RDONLY |
          (NodeFSP.constants.O_NOFOLLOW ?? 0) |
          (NodeFSP.constants.O_NONBLOCK ?? 0),
      );
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > 200_000) continue;
        // Bound allocation and reads even if the file grows after stat.
        const bytes = Buffer.alloc(200_001);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        if (length > 200_000) continue;
        const decoded = decodeScenarioEvidence(bytes.subarray(0, length).toString("utf8"));
        if (decoded !== null) results.push(decoded);
      } finally {
        await handle.close();
      }
    }
  } catch {
    // Optional diagnostics cannot invalidate an otherwise playable artifact.
  }
  return results;
};

/**
 * Bounded native layout hints bound to the selected build's exact source.
 * The text is critic evidence file content; the directories name the durable
 * records it was read from.
 */
export interface GameRepairStudioNativeDiagnostics {
  readonly sourceId: string;
  /** Game-relative scenario evidence the hints were read from. */
  readonly evidenceDirectory: string;
  /** Bounded markdown: hints with native-geometry uncertainty, never verdicts. */
  readonly text: string;
}

/**
 * Bounded native world measurements bound to the selected build's exact
 * source. The text is critic evidence file content (JSON, no code); the
 * directories name the durable records it was read from.
 */
export interface GameRepairStudioNativeWorld {
  readonly sourceId: string;
  /** Game-relative scenario evidence the measurements were read from. */
  readonly evidenceDirectory: string;
  /** Bounded JSON: world-space numbers with honesty notes, never verdicts. */
  readonly text: string;
}

/**
 * One critic experiment replayed for the ballots. It is a read-only playtest in
 * an isolated store: it must not write playtest bindings or qualification.
 */
export interface GameRepairStudioExperimentInput {
  readonly threadId: ThreadId;
  readonly root: string;
  readonly buildId: string;
  readonly steps: ReadonlyArray<GamePlaytestStep>;
  /** Uncaptured prelude replayed from fresh boot before steps, when recorded. */
  readonly setupSteps?: ReadonlyArray<GamePlaytestStep>;
  readonly captureEveryMs: number;
  readonly viewport: GameViewport | null;
}

export interface GameRepairStudioExperimentResult {
  readonly frames: ReadonlyArray<GameRepairStudioFrame>;
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
     * a playtest that booted, logged no console errors, executed input and,
     * when the record measured one, passed its gameplay exam. A failed verdict
     * on this exact build is a hard failed playtest; older records without one
     * stay readable instead of failing for the missing field.
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
    /** Replays one critic experiment route without recording a playtest. */
    readonly experiment: (
      input: GameRepairStudioExperimentInput,
    ) => Effect.Effect<GameRepairStudioExperimentResult, GameOperationError>;
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
 * A measured gameplay verdict is a real check. It is absent from old records,
 * which stays unknown and never becomes a pass or a failure on its own.
 */
const playtestCheck = (
  qualifies: boolean | undefined,
  blockers: readonly string[] | undefined,
): ReadonlyArray<GameReviewCheck> =>
  qualifies === undefined
    ? []
    : [
        {
          id: "playtest",
          status: qualifies ? "passed" : "failed",
          ...(qualifies
            ? {}
            : {
                detail: `The build's own playtest did not qualify${
                  blockers === undefined || blockers.length === 0 ? "." : `: ${blockers.join("; ")}`
                }`.slice(0, 1000),
              }),
        },
      ];

/** Only execution facts gate the loop; measurements are evidence for the critic. */
const checkResult = (
  result: GameWebPlaytestResult,
  inputs: GameReviewFrozenInputs,
): ReadonlyArray<GameReviewCheck> => {
  const consoleErrors =
    result.consoleErrorCount ??
    result.consoleMessages.filter((message) => message.level === "error").length;
  const executed = result.executedInputSteps;
  return [
    { id: "boot", status: result.booted ? "passed" : "failed" },
    {
      id: "console",
      status: consoleErrors === 0 ? "passed" : "failed",
      detail: `${consoleErrors} console errors`,
    },
    {
      id: "input",
      status: executed === undefined ? "unmeasured" : executed > 0 ? "passed" : "failed",
      detail:
        executed === undefined
          ? "Input dispatch was not recorded; playtest again."
          : `${executed} input steps executed`,
      measurements: {
        steps: [...inputs.steps],
        changedPercent: result.changedPercent,
        state: result.state,
        designObservations: [...(result.designObservations ?? [])],
      },
    },
    ...playtestCheck(result.qualifies, result.blockers),
  ];
};

/** The same checks read from the build's own recorded playtest. */
const storedCheckResult = (
  playtest: {
    readonly booted: boolean;
    readonly responded: boolean;
    readonly executedInputSteps?: number;
    readonly consoleErrors: number;
    readonly qualifies?: boolean;
    readonly blockers?: readonly string[];
  },
  measurements: NonNullable<GameReviewCheck["measurements"]>,
): ReadonlyArray<GameReviewCheck> => {
  const executed = playtest.executedInputSteps;
  return [
    { id: "boot", status: playtest.booted ? "passed" : "failed" },
    {
      id: "console",
      status: playtest.consoleErrors === 0 ? "passed" : "failed",
      detail: `${playtest.consoleErrors} console errors`,
    },
    {
      id: "input",
      status: executed === undefined ? "unmeasured" : executed > 0 ? "passed" : "failed",
      detail:
        executed === undefined
          ? "Input dispatch was not recorded; playtest again."
          : `${executed} input steps executed`,
      measurements,
    },
    ...playtestCheck(playtest.qualifies, playtest.blockers),
  ];
};

const sameViewport = (left: GameViewport | null, right: GameViewport | null) =>
  left === null || right === null
    ? left === right
    : left.width === right.width && left.height === right.height;

/** The build's record can answer this check only for the exact frozen route. */
const sameFrozenRoute = (
  playtest: {
    readonly steps: ReadonlyArray<GamePlaytestStep>;
    readonly viewport: GameViewport | null;
    readonly captureScale?: number;
  },
  inputs: GameReviewFrozenInputs,
) =>
  JSON.stringify(playtest.steps) === JSON.stringify(inputs.steps) &&
  sameViewport(playedViewport(playtest.viewport, playtest.captureScale), inputs.viewport);

const evidencePath = (root: string, directory: string) =>
  NodePath.isAbsolute(directory) ? directory : NodePath.join(root, directory);

const readEvidence = (root: string, directory: string) =>
  NodePath.isAbsolute(directory)
    ? readPlaytestEvidenceAt(directory)
    : readPlaytestEvidence(root, directory);

/** Read the stored pixels while their folder still exists; the caller copies them. */
const readEvidenceFrames = (
  root: string,
  directory: string,
  run: PlaytestEvidenceRun,
): Effect.Effect<
  ReadonlyArray<{
    readonly label: string;
    readonly inputPair?: GamePlaytestInputPair;
    readonly data: string;
    readonly width: number;
    readonly height: number;
    readonly observations?: Record<string, number | boolean>;
  }>,
  GameOperationError
> =>
  Effect.tryPromise({
    try: () =>
      Promise.all(
        selectInputPairFrames(run.frames).map(async (frame) => ({
          label: frame.label,
          ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
          width: frame.width,
          height: frame.height,
          ...(frame.probe === undefined
            ? {}
            : { observations: studioObservations(frame.probe.gameState) }),
          data: (
            await NodeFSP.readFile(NodePath.join(evidencePath(root, directory), frame.file))
          ).toString("base64"),
        })),
      ),
    catch: (cause) =>
      new GameOperationError({
        operation: "Read review evidence",
        path: evidencePath(root, directory),
        reason: "io",
        cause,
      }),
  });

/** Preserve the probe's 40-key bound until the session can select approved keys. */
const studioObservations = (
  gameState: Readonly<Record<string, number | boolean | string | null | undefined>>,
): Record<string, number | boolean> => {
  const picked: Record<string, number | boolean> = {};
  for (const key of Object.keys(gameState).toSorted()) {
    if (Object.keys(picked).length >= 40) break;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const raw = gameState[key];
    if (typeof raw === "boolean") picked[key] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) picked[key] = raw;
  }
  return picked;
};

/**
 * The one extra capture a check takes: a fixed short burst in a differently
 * shaped window, so the critic and both ballots can see letterboxing, clipping
 * or overflow that the played window hides. The burst is deliberately not the
 * frozen route: its pointer pixels belong to the played window, while this run
 * is about layout, not replaying the game's own demo.
 */
const WINDOW_BURST: ReadonlyArray<GamePlaytestStep> = [
  { key: "ArrowRight", holdMs: 400 },
  { key: "Space", holdMs: 250 },
  { click: "left" },
];

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
          readonly inputPair?: GamePlaytestInputPair;
          readonly data: string;
          readonly width?: number;
          readonly height?: number;
          /** Marks the alternate-window evidence frames. */
          readonly window?: boolean;
          readonly observations?: Record<string, number | boolean>;
          readonly probe?: { readonly gameState: Record<string, number | boolean | string> };
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
            frames.push({
              label: shot.label,
              path: file,
              ...(shot.inputPair === undefined ? {} : { inputPair: shot.inputPair }),
              ...(shot.width === undefined ? {} : { width: shot.width }),
              ...(shot.height === undefined ? {} : { height: shot.height }),
              ...(shot.window === true ? { window: true } : {}),
              ...(() => {
                const direct = shot.observations;
                if (direct !== undefined) return { observations: direct };
                const probe = shot.probe;
                if (probe === undefined) return {};
                return { observations: studioObservations(probe.gameState) };
              })(),
            });
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
          const routeIssues = playtestInputIssues({ steps: [...evidence.steps] });
          const blockers = evidence.blockers ?? [];
          if (routeIssues.length > 0)
            checks.push(
              check(
                "playtest",
                "failed",
                `The recorded playtest route is not a browser route: ${routeIssues.join(" ")}`,
              ),
            );
          else if (evidence.qualifies === false)
            checks.push(
              check(
                "playtest",
                "failed",
                `The build's own playtest did not qualify${
                  blockers.length === 0 ? "." : `: ${blockers.join("; ")}`
                }`,
              ),
            );
          else if (evidence.qualifies === true) checks.push(check("playtest", "passed"));
          const inputSteps = evidence.executedInputSteps;
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
              inputSteps === undefined
                ? "unmeasured"
                : inputSteps > 0 && evidence.responded
                  ? "passed"
                  : "failed",
              inputSteps === undefined
                ? "Input dispatch was not recorded; playtest again."
                : inputSteps === 0
                  ? "The playtest executed no input steps; waits and screenshots do not count."
                  : evidence.responded
                    ? `${inputSteps} input steps executed`
                    : "The playtest recorded no visible response to its input.",
            ),
          ]);
        });

      const frozenInputs: GameRepairStudio["Service"]["frozenInputs"] = (root, buildId) =>
        Effect.gen(function* () {
          if (buildId !== undefined) {
            const recorded = yield* rounds.exported(root, buildId);
            return {
              steps: [...(recorded?.playtest?.steps ?? [])],
              // Pointer coordinates are pixels in the window the route was
              // played in, not in the game's base viewport.
              viewport: playedViewport(
                recorded?.playtest?.viewport,
                recorded?.playtest?.captureScale,
              ),
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
            viewport: playedViewport(last?.viewport, last?.captureScale),
            // Godot playtests are not seeded today; say so instead of inventing one.
            seed: "unknown",
          } satisfies GameReviewFrozenInputs;
        });

      /**
       * The alternate-window evidence for one build. Its own playtest writes to
       * an isolated store and is removed after the two frames are kept, so it
       * can never replace the build's playtest record or its history.
       */
      const windowEvidence = (input: {
        readonly threadId: ThreadId;
        readonly root: string;
        readonly buildId: string;
        readonly size: GameViewport;
      }) =>
        Effect.gen(function* () {
          const size = `${input.size.width}x${input.size.height}`;
          const directory = NodePath.join(
            gameRecordFile(options.stateDir, "game-review-windows", input.root, ""),
            NodeCrypto.randomUUID(),
          );
          const attempt = yield* game
            .webPlaytestBuild(
              input.threadId,
              input.buildId,
              {
                steps: [...WINDOW_BURST],
                width: input.size.width,
                height: input.size.height,
                exactSize: true,
              },
              directory,
              "persisted",
            )
            .pipe(Effect.result);
          if (attempt._tag === "Failure") {
            yield* Effect.promise(() =>
              NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined),
            );
            return {
              frames: [] as ReadonlyArray<GameRepairStudioFrame>,
              check: {
                id: "window",
                status: "failed" as const,
                detail: `${size} window: ${attempt.failure.message.slice(0, 300)}`,
              } satisfies GameReviewCheck,
            };
          }
          // Read the run's evidence before the isolated store is removed, so a
          // response byte cap cannot leave only the dropped frames as evidence.
          return yield* Effect.gen(function* () {
            const result = attempt.success;
            const evidenceDirectory = result.evidenceDirectory;
            const persisted =
              evidenceDirectory === undefined
                ? null
                : yield* Effect.promise(() => readPlaytestEvidenceAt(evidenceDirectory));
            const booted = persisted?.frames.find((frame) => frame.label === "booted");
            const after = persisted?.frames.find((frame) => frame.label === "after-steps");
            const shots =
              persisted !== null
                ? yield* Effect.promise(() =>
                    Promise.all(
                      [booted, after]
                        .filter((frame) => frame !== undefined)
                        .map(async (frame) => ({
                          label: frame!.label,
                          width: frame!.width,
                          height: frame!.height,
                          data: (
                            await NodeFSP.readFile(NodePath.join(evidenceDirectory!, frame!.file))
                          ).toString("base64"),
                        })),
                    ),
                  )
                : result.screenshots
                    .filter((shot) => shot.label === "booted" || shot.label === "after-steps")
                    .map((shot) => ({
                      label: shot.label,
                      width: shot.width,
                      height: shot.height,
                      data: shot.data,
                    }));
            const frames = yield* storeFrames(
              input.root,
              shots.map((shot) => ({
                ...shot,
                label:
                  shot.label === "booted"
                    ? `window ${size}: boot`
                    : `window ${size}: after a short input burst`,
                window: true,
              })),
            );
            return {
              frames,
              check: {
                id: "window",
                status:
                  result.booted && frames.length > 0 ? ("passed" as const) : ("failed" as const),
                // Evidence, not a gate: FACT_CHECK_IDS does not include it.
                detail: `${size} window${result.booted ? "" : " did not boot"}`,
              } satisfies GameReviewCheck,
            };
          }).pipe(
            Effect.ensuring(
              Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
            ),
          );
        });

      /**
       * Frozen same-source scenario layout hints for the critic. Reads the
       * state stage's durable evidence (the exact scenario result files the
       * exam wrote) and binds them to this build's recorded source: a stale,
       * missing or unreadable record selects nothing, honestly. Bounded: at
       * most a few small result files, each capped in bytes.
       */
      const nativeDiagnosticsFor = (
        root: string,
        buildId: string,
      ): Effect.Effect<GameRepairStudioNativeDiagnostics | undefined, GameOperationError> =>
        Effect.gen(function* () {
          const stateRecord = yield* qualification
            .stageRecord(root, "state")
            .pipe(Effect.orElseSucceed(() => null));
          const stateSourceId = stateRecord?.sourceId ?? null;
          const evidenceDirectory = stateRecord?.evidenceDirectory ?? null;
          if (stateSourceId === null || evidenceDirectory === null) return undefined;
          const exported = yield* rounds
            .exported(root, buildId)
            .pipe(Effect.orElseSucceed(() => null));
          if (exported === null) return undefined;
          const exportStage = yield* qualification
            .stageRecord(root, "export")
            .pipe(Effect.orElseSucceed(() => null));
          // Qualification input identities and rollback byte manifests are
          // different namespaces. Bind through the exact build's export stage.
          const exportInputSourceId = exportStage?.sourceId ?? null;
          if (
            exportStage?.outcome !== "passed" ||
            exportStage.buildId !== buildId ||
            exportInputSourceId === null ||
            exportInputSourceId !== stateSourceId
          )
            return undefined;
          const scenarios = yield* Effect.promise(() =>
            readNativeScenarioEvidence(root, evidenceDirectory),
          );
          if (scenarios.length === 0) return undefined;
          const selected = selectNativeLayout({
            stateSourceId,
            stateEvidenceDirectory: evidenceDirectory,
            exportInputSourceId,
            scenarios,
          });
          if (selected === null) return undefined;
          return {
            sourceId: selected.sourceId,
            evidenceDirectory: selected.evidenceDirectory,
            text: formatNativeDiagnostics(selected),
          } satisfies GameRepairStudioNativeDiagnostics;
        });

      /**
       * Frozen same-source scenario world measurements for the critic. Uses
       * the exact source binding as the layout hints above: the state
       * record's source must equal the passed export's source for this
       * build, or nothing is selected, honestly. Bounded JSON, never a
       * verdict, gate, defect or ballot change.
       */
      const nativeWorldFor = (
        root: string,
        buildId: string,
      ): Effect.Effect<GameRepairStudioNativeWorld | undefined, GameOperationError> =>
        Effect.gen(function* () {
          const stateRecord = yield* qualification
            .stageRecord(root, "state")
            .pipe(Effect.orElseSucceed(() => null));
          const stateSourceId = stateRecord?.sourceId ?? null;
          const evidenceDirectory = stateRecord?.evidenceDirectory ?? null;
          if (stateSourceId === null || evidenceDirectory === null) return undefined;
          const exported = yield* rounds
            .exported(root, buildId)
            .pipe(Effect.orElseSucceed(() => null));
          if (exported === null) return undefined;
          const exportStage = yield* qualification
            .stageRecord(root, "export")
            .pipe(Effect.orElseSucceed(() => null));
          const exportInputSourceId = exportStage?.sourceId ?? null;
          if (
            exportStage?.outcome !== "passed" ||
            exportStage.buildId !== buildId ||
            exportInputSourceId === null ||
            exportInputSourceId !== stateSourceId
          )
            return undefined;
          const scenarios = yield* Effect.promise(() =>
            readNativeScenarioEvidence(root, evidenceDirectory),
          );
          if (scenarios.length === 0) return undefined;
          const selected = selectNativeSpatial({
            stateSourceId,
            stateEvidenceDirectory: evidenceDirectory,
            exportInputSourceId,
            scenarios,
          });
          if (selected === null) return undefined;
          return {
            sourceId: selected.sourceId,
            evidenceDirectory: selected.evidenceDirectory,
            text: formatNativeWorld(selected),
          } satisfies GameRepairStudioNativeWorld;
        });

      const check: GameRepairStudio["Service"]["check"] = (input) =>
        Effect.gen(function* () {
          const { inputs } = input;
          const size =
            inputs.viewport === null
              ? {}
              : { width: inputs.viewport.width, height: inputs.viewport.height };
          // A route a browser cannot send is not a game verdict. Reject it
          // before any run so a boot-only fallback can never look like a pass.
          const routeIssues = playtestInputIssues({ steps: [...inputs.steps], ...size });
          if (routeIssues.length > 0)
            return yield* new GameOperationError({
              operation: "Review check",
              path: input.root,
              reason: "invalid-input",
              detail: routeIssues.join("\n"),
            });

          // Frozen same-source scenario hints for the critic, when they
          // exist: the state stage's durable evidence binds to this build's
          // exact source, or the hints are honestly omitted. Candidate builds
          // get none: the evidence predates the repair.
          const native =
            input.target === "incumbent"
              ? yield* nativeDiagnosticsFor(input.root, input.buildId)
              : undefined;
          const nativeWorld =
            input.target === "incumbent"
              ? yield* nativeWorldFor(input.root, input.buildId)
              : undefined;
          const withNative = {
            ...(native === undefined ? {} : { nativeDiagnostics: native }),
            ...(nativeWorld === undefined ? {} : { nativeWorld }),
          };
          const recorded = yield* rounds.exported(input.root, input.buildId).pipe(Effect.result);
          const playtest =
            recorded._tag === "Success" ? (recorded.success?.playtest ?? null) : null;
          // A failed verdict on this exact build is a hard fact even when a
          // later replay uses a different frozen route. A passing replay must
          // not erase the build's own failed qualification.
          const failedBinding =
            playtest !== null && playtest.qualifies === false
              ? playtestCheck(false, playtest.blockers)
              : [];
          // Reuse the build's own run only when it measured the same exact
          // frozen route. A different or older route must be replayed.
          if (
            playtest !== null &&
            playtest.qualifies !== undefined &&
            playtest.evidenceDirectory !== undefined &&
            sameFrozenRoute(playtest, inputs)
          ) {
            const intact = yield* Effect.promise(() =>
              hashWebBuild(input.root, candidateBuildDirectory(input.buildId)).then(
                (hashed) => hashed?.buildId === input.buildId,
                () => false,
              ),
            );
            if (!intact)
              return yield* new GameOperationError({
                operation: "Review check",
                path: input.root,
                reason: "invalid-input",
                detail: `Build ${input.buildId} is missing or its bytes changed after export; export the game again.`,
              });
            const evidence = yield* Effect.promise(() =>
              readEvidence(input.root, playtest.evidenceDirectory!),
            );
            const shots =
              evidence === null
                ? null
                : yield* readEvidenceFrames(input.root, playtest.evidenceDirectory!, evidence).pipe(
                    Effect.orElseSucceed(() => null),
                  );
            // Wall-time evidence is not controlled-clock evidence. A stored
            // pass from before the controlled driver must be replayed for
            // adjudication, never reused as a controlled pass. A stored
            // failure stays a hard failure either way, so it reuses as before.
            const legacyPass =
              playtest.qualifies === true && evidence?.timing !== "controlled-clock";
            if (evidence !== null && shots !== null && shots.length > 0 && !legacyPass) {
              const played =
                playedViewport(playtest.viewport, playtest.captureScale) ?? inputs.viewport;
              const checks = storedCheckResult(playtest, {
                steps: [...inputs.steps],
                changedPercent: evidence.changedPercent,
                state: evidence.state,
                designObservations: [...evidence.designObservations],
              });
              const frames = yield* storeFrames(input.root, shots);
              if (playtest.qualifies === false)
                return { checks, frames, viewport: played, ...withNative };
              const window = yield* windowEvidence({
                threadId: input.threadId,
                root: input.root,
                buildId: input.buildId,
                size: alternateWindow(played),
              });
              return {
                checks: [...checks, window.check],
                frames: [...frames, ...window.frames],
                viewport: played,
                ...withNative,
              } satisfies GameRepairStudioCheckResult;
            }
          }

          // A review replay is evidence, never the builder's playtest record.
          // The isolated folder also gives a response byte cap persisted frames.
          const reviewRun = (playtestInput: GameWebPlaytestInput) =>
            Effect.gen(function* () {
              const directory = NodePath.join(
                gameRecordFile(options.stateDir, "game-review-replays", input.root, ""),
                NodeCrypto.randomUUID(),
              );
              return yield* Effect.gen(function* () {
                const played = yield* game
                  .webPlaytestBuild(input.threadId, input.buildId, playtestInput, directory)
                  .pipe(Effect.result);
                if (played._tag === "Failure")
                  return { failure: played.failure, shots: [] as const };
                const evidenceDirectory = played.success.evidenceDirectory;
                const evidence =
                  evidenceDirectory === undefined
                    ? null
                    : yield* Effect.promise(() => readEvidence(input.root, evidenceDirectory));
                return {
                  success: played.success,
                  shots:
                    evidence === null || evidenceDirectory === undefined
                      ? played.success.screenshots
                      : yield* readEvidenceFrames(input.root, evidenceDirectory, evidence),
                } as const;
              }).pipe(
                Effect.ensuring(
                  Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
                ),
              );
            });

          const replay = yield* reviewRun({ steps: [...inputs.steps], ...size });
          if ("failure" in replay) {
            // An invalid route or a changed build is the caller's to fix. A
            // boot-only fallback here would hide that behind weaker evidence.
            if (replay.failure.reason === "invalid-input") return yield* replay.failure;
            const intact = yield* Effect.promise(() =>
              hashWebBuild(input.root, candidateBuildDirectory(input.buildId)).then(
                (hashed) => hashed?.buildId === input.buildId,
                () => false,
              ),
            );
            if (!intact) return yield* replay.failure;
            const boot = yield* reviewRun(size);
            if ("failure" in boot)
              return {
                checks: [
                  {
                    id: "replay",
                    status: "failed" as const,
                    detail: replay.failure.message.slice(0, 1000),
                  },
                  {
                    id: "boot",
                    status: "failed" as const,
                    detail: boot.failure.message.slice(0, 1000),
                  },
                  ...failedBinding,
                ],
                frames: [],
                viewport: inputs.viewport,
                ...withNative,
              } satisfies GameRepairStudioCheckResult;
            return {
              checks: [
                {
                  id: "replay",
                  status: "failed" as const,
                  detail: replay.failure.message.slice(0, 1000),
                },
                ...checkResult(boot.success, { ...inputs, steps: [] }).filter(
                  (entry) => entry.id !== "input" && entry.id !== "playtest",
                ),
                ...failedBinding,
              ],
              frames: yield* storeFrames(input.root, boot.shots),
              viewport:
                playedViewport(boot.success.baseViewport, boot.success.captureScale) ??
                inputs.viewport,
              ...withNative,
            } satisfies GameRepairStudioCheckResult;
          }
          const result = replay.success;
          const frames = yield* storeFrames(input.root, replay.shots);
          const played =
            playedViewport(result.baseViewport, result.captureScale) ?? inputs.viewport;
          const window = yield* windowEvidence({
            threadId: input.threadId,
            root: input.root,
            buildId: input.buildId,
            size: alternateWindow(played),
          });
          return {
            checks: [
              ...checkResult(result, inputs).filter(
                (entry) => entry.id !== "playtest" || failedBinding.length === 0,
              ),
              ...failedBinding,
              window.check,
            ],
            frames: [...frames, ...window.frames],
            viewport: playedViewport(result.baseViewport, result.captureScale),
            ...withNative,
          } satisfies GameRepairStudioCheckResult;
        });

      const experiment: GameRepairStudio["Service"]["experiment"] = (input) =>
        Effect.gen(function* () {
          // The route is replayed in its own experiment store. GameService
          // skips stage writes and the build playtest binding for that path.
          // Setup+steps replay fresh with the same capture boundary, so cited
          // step indices never alias and setup is never omitted.
          const directory = NodePath.join(
            gameRecordFile(options.stateDir, "game-review-experiments", input.root, ""),
            NodeCrypto.randomUUID(),
          );
          const setupSteps = [...(input.setupSteps ?? [])];
          const fullSteps = [...setupSteps, ...input.steps];
          const result = yield* game
            .webPlaytestBuild(
              input.threadId,
              input.buildId,
              {
                steps: fullSteps,
                captureEveryMs: input.captureEveryMs,
                captureAllSteps: true,
                ...(input.viewport === null
                  ? {}
                  : { width: input.viewport.width, height: input.viewport.height }),
              },
              directory,
              "persisted",
              ...(setupSteps.length === 0
                ? []
                : ([{ captureFromStep: setupSteps.length }] as const)),
            )
            .pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  const evidenceDirectory = result.evidenceDirectory;
                  const persisted =
                    evidenceDirectory === undefined
                      ? null
                      : yield* Effect.promise(() => readPlaytestEvidenceAt(evidenceDirectory));
                  const screenshots =
                    persisted === null
                      ? result.screenshots
                      : yield* Effect.promise(() =>
                          Promise.all(
                            persisted.frames.map(async (frame) => ({
                              label: frame.label,
                              ...(frame.inputPair === undefined
                                ? {}
                                : { inputPair: frame.inputPair }),
                              ...(frame.probe === undefined
                                ? {}
                                : { probe: { gameState: frame.probe.gameState } }),
                              data: (
                                await NodeFSP.readFile(
                                  NodePath.join(evidenceDirectory!, frame.file),
                                )
                              ).toString("base64"),
                            })),
                          ),
                        );
                  return { frames: yield* storeFrames(input.root, screenshots) };
                }),
              ),
              Effect.ensuring(
                Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
              ),
            );
          return result satisfies GameRepairStudioExperimentResult;
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
        experiment,
        exportState,
        promote,
      });
    }),
  );
