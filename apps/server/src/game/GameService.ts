// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  GameOperationError,
  type GameCheckResult,
  type GameSceneInspectResult,
  type GameScenariosRunResult,
  type GameScenarioEvidence,
  type GameStatus,
  type GameQualificationRead,
  type GameAction,
  type GameActionResult,
  type GameBlenderInput,
  GameBlenderResult,
  GameWebPlaytestInput,
  GameWebPlaytestResult,
  type GameAcceptanceCriterion,
  type GameOperationEvent,
  type GameProcessResult,
  type ThreadId,
  fitScreenshotsToBudget,
  GAME_PLAYTEST_BOUNDS,
  integerScaledCapture,
  PLAYTEST_DEFAULT_CAPTURE,
  playtestInputIssues,
} from "@t3tools/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import { insideGame } from "./GameProjectService.ts";
import { commandDetail } from "./commandDetail.ts";
import {
  CANDIDATE_BUILDS_DIRECTORY,
  WEB_BUILD_DIRECTORY,
  candidateBuildDirectory,
  describeWebArtifacts,
  hashWebBuild,
  hashWebBuildDirectory,
  isWebBuildFresh,
} from "./webBuild.ts";
import { comparedSource, snapshotSource } from "./sourceSnapshot.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import { blenderWrapper } from "./blenderScript.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import {
  RawCheckResult,
  mergeCheckIssues,
  parseGodotIssues,
  limitIssues,
} from "./godotCheckOutput.ts";
import { GODOT_CHECK_SCRIPT } from "./godotCheckScript.ts";
import { GODOT_SCENARIO_SCRIPT } from "./godotScenarioScript.ts";
import { GODOT_INSPECT_SCRIPT } from "./godotInspectScript.ts";
import {
  decodeScenarioEvidence,
  parseProjectInputActions,
  readScenarioFiles,
  scenarioActionIssues,
  scenarioObservations,
  scenarioRequestJson,
} from "./gameScenarios.ts";
import { evaluateScenarios } from "./scenarioEvaluation.ts";
import { readLastPlaytest, writePlaytestEvidence } from "./playtestEvidence.ts";
import { satisfiedObservations } from "./playtestState.ts";
import * as GameVisualJudge from "./GameVisualJudge.ts";
import { formatVisualReport } from "./visualReport.ts";
import { parseGodotViewport } from "./godotViewport.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";

export class GameService extends Context.Service<
  GameService,
  {
    readonly cancelThread: (threadId: ThreadId) => Effect.Effect<void, GameOperationError>;
    readonly status: (threadId: ThreadId) => Effect.Effect<GameStatus, GameOperationError>;
    /** Operation pushes for every game this server runs. */
    readonly events: Stream.Stream<GameOperationEvent>;
    readonly action: (
      threadId: ThreadId,
      action: GameAction,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly blender: (
      threadId: ThreadId,
      input: typeof GameBlenderInput.Type,
    ) => Effect.Effect<typeof GameBlenderResult.Type, GameOperationError>;
    readonly import: (threadId: ThreadId) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly test: (
      threadId: ThreadId,
      script: string,
      timeoutMs?: number,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly export: (
      threadId: ThreadId,
      target: "Web" | "Linux",
      options?: { readonly roundId?: string | undefined },
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * Runs the native game. The creator's own Play may watch it on their
     * display; an agent's tool always asks for `headless`.
     */
    readonly native: (
      threadId: ThreadId,
      options?: { readonly display?: "headless" | "inherit" | undefined },
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly webPlaytest: (
      threadId: ThreadId,
      input: GameWebPlaytestInput,
    ) => Effect.Effect<GameWebPlaytestResult, GameOperationError>;
    readonly check: (threadId: ThreadId) => Effect.Effect<GameCheckResult, GameOperationError>;
    readonly scenariosRun: (
      threadId: ThreadId,
    ) => Effect.Effect<GameScenariosRunResult, GameOperationError>;
    readonly inspectScene: (
      threadId: ThreadId,
      scenePath: string,
    ) => Effect.Effect<GameSceneInspectResult, GameOperationError>;
  }
>()("t3/game/GameService") {}
const decodeBlenderMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      objects: Schema.Number,
      meshes: Schema.Number,
      materials: Schema.Number,
      dimensions: Schema.Array(Schema.Number),
      warnings: Schema.Array(Schema.String),
    }),
  ),
);
const RawSceneInspect = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optionalKey(Schema.String),
    scenePath: Schema.optionalKey(Schema.String),
    nodes: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          path: Schema.String,
          name: Schema.String,
          type: Schema.String,
          script: Schema.optionalKey(Schema.String),
          groups: Schema.Array(Schema.String),
          position: Schema.optionalKey(Schema.Array(Schema.Number)),
          collisionLayer: Schema.optionalKey(Schema.Number),
          collisionMask: Schema.optionalKey(Schema.Number),
          children: Schema.Array(Schema.String),
        }),
      ),
    ),
    nodeCount: Schema.optionalKey(Schema.Number),
    truncated: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeSceneInspect = Schema.decodeUnknownSync(RawSceneInspect);
const decodeCheckResult = Schema.decodeUnknownSync(RawCheckResult);
const decodeText = <A>(decode: (text: string) => A, text: string | null): A | null => {
  if (text === null) return null;
  try {
    return decode(text);
  } catch {
    return null;
  }
};
const isGameOperationError = Schema.is(GameOperationError);
const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const processes = yield* GameProcesses.GameProcesses;
  const tools = yield* GameToolchain.GameToolchain;
  const preview = yield* GamePreview.GamePreview;
  const browser = yield* PreviewBrowser.PreviewBrowser;
  const qualification = yield* GameQualification.GameQualification;
  const rounds = yield* GameRoundStore.GameRoundStore;
  const designApprovals = yield* GameDesignApproval.GameDesignApproval;
  const playtest = yield* GameWebPlaytest.GamePlaytest;
  const visualJudge = yield* GameVisualJudge.GameVisualJudge;
  const operations = yield* GameOperations.GameOperations;
  const active = new Map<
    string,
    { cancelled: Deferred.Deferred<void>; done: Deferred.Deferred<void> }
  >();
  /**
   * The current source's byte identity, reused while qualification's legacy
   * Godot size/mtime snapshot is unchanged. Status polls must not rehash a
   * game's Blender originals every two seconds; an art-only edit that does not
   * touch the Godot project is reported once the playable tree changes.
   */
  const playIdentityCache = new Map<string, { read: string; sourceId: string | null }>();
  const cancel = Effect.fnUntraced(function* (root: string) {
    const operation = active.get(root);
    if (operation === undefined) return;
    yield* Deferred.succeed(operation.cancelled, undefined);
    // The race interrupts work and awaits its finalizers, including native child exit.
    yield* Deferred.await(operation.done);
  });
  /**
   * Operations report failure in more than one shape: action results use
   * `success`, the Godot check uses `ok`. The shared operation state has to see
   * both, or a failed check announces success to the stage.
   */
  const operationFailed = (result: unknown): boolean => {
    if (typeof result !== "object" || result === null) return false;
    if ("success" in result && result.success === false) return true;
    if ("ok" in result && result.ok === false) return true;
    return false;
  };
  const exclusive = <A>(root: string, name: string, work: Effect.Effect<A, GameOperationError>) =>
    Effect.gen(function* () {
      if (active.has(root))
        return yield* new GameOperationError({ operation: name, path: root, reason: "busy" });
      const cancelled = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const at = DateTime.formatIso(yield* DateTime.now);
      active.set(root, { cancelled, done });
      yield* operations.record(
        root,
        { name, state: "running", message: `${name} is running.`, at },
        "running",
      );
      const stopped = Deferred.isDone(cancelled);
      return yield* work.pipe(
        Effect.raceFirst(
          Deferred.await(cancelled).pipe(
            Effect.andThen(
              Effect.fail(
                new GameOperationError({
                  operation: name,
                  path: root,
                  reason: "command-failed",
                  detail: "Operation cancelled.",
                }),
              ),
            ),
          ),
        ),
        Effect.tap((result) =>
          Effect.gen(function* () {
            const failed = operationFailed(result);
            yield* operations.record(
              root,
              {
                name,
                state: failed ? "failed" : "succeeded",
                message:
                  typeof result === "object" && result !== null && "message" in result
                    ? String(result.message)
                    : `${name} completed.`,
                at,
              },
              failed ? "failed" : "succeeded",
            );
          }),
        ),
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const wasCancelled = yield* stopped;
            yield* operations.record(
              root,
              {
                name,
                // The status field has no cancelled state; Stop reads as a
                // failed run with an honest message.
                state: "failed",
                message: error.message,
                at,
              },
              wasCancelled ? "cancelled" : "failed",
            );
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* operations.record(
              root,
              { name, state: "failed", message: `${name} was cancelled.`, at },
              "cancelled",
            );
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            active.delete(root);
          }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
        ),
      );
    });
  const engine = Effect.fnUntraced(function* (root: string) {
    const manifest = yield* projects.read(root);
    const godot = yield* tools.executable("godot");
    return {
      godot,
      cwd: insideGame(root, manifest.godotProject),
      godotProject: manifest.godotProject,
    };
  });
  const snapshot = (root: string, godotProject: string) =>
    Effect.promise(() => snapshotSource(root, godotProject));
  /**
   * Qualification says the export matches the sources and its artifact files;
   * the read verifies both, so anything else forces a rebuild.
   */
  const webBuildIsCurrent = (read: GameQualificationRead) =>
    Effect.sync(() => isWebBuildFresh(read));
  /**
   * Qualification is a server-owned record written from actual operation
   * results. Failing to persist it must not turn a real build into a crash; the
   * missing stage leaves the game uncertified either way.
   */
  const recordQualification = (root: string, input: GameQualification.QualificationRecordInput) =>
    qualification.record(root, input).pipe(
      Effect.catchTags({
        GameOperationError: (error) =>
          Effect.logWarning("Could not write the game qualification record.", {
            operation: error.operation,
            reason: error.reason,
          }),
      }),
    );
  type StageOutcome = Omit<GameQualification.QualificationRecordInput, "stage">;
  const interruptedOutcome = (operation: string): StageOutcome => ({
    outcome: "cancelled",
    sourceId: null,
    buildId: null,
    evidenceDirectory: null,
    detail: `The ${operation} was cancelled before it finished.`,
  });
  const failedOutcome = (
    exit: Exit.Exit<unknown, GameOperationError>,
    operation: string,
  ): StageOutcome => {
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) return interruptedOutcome(operation);
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isSome(error))
        return {
          outcome: "failed",
          sourceId: null,
          buildId: null,
          evidenceDirectory: null,
          detail: error.value.message,
        };
    }
    return {
      outcome: "unknown",
      sourceId: null,
      buildId: null,
      evidenceDirectory: null,
      detail: `The ${operation} ended without a result that can be trusted.`,
    };
  };
  /**
   * Owns one qualification attempt. The stage is removed before the work runs,
   * so an interruption, defect or failed terminal write leaves it missing
   * instead of readable as the previous pass; every exit then records an honest
   * outcome through finalization rather than only the returned results.
   */
  const ownStage = <A>(
    root: string,
    stage: GameQualification.StoredQualificationStage,
    operation: string,
    work: Effect.Effect<{ readonly value: A; readonly record: StageOutcome }, GameOperationError>,
  ): Effect.Effect<A, GameOperationError> =>
    Effect.gen(function* () {
      yield* qualification.begin(root, stage);
      const completed = yield* work.pipe(
        Effect.onExit((exit) =>
          recordQualification(root, {
            stage,
            ...(Exit.isSuccess(exit) ? exit.value.record : failedOutcome(exit, operation)),
          }),
        ),
      );
      return completed.value;
    });
  /**
   * Judges a qualifying playtest's persisted frames. The visual stage is bound
   * to the exact source, build and approved design it graded, and an
   * unavailable judge records an unknown attempt, never a pass.
   */
  const judgeVisualStage = (input: {
    readonly root: string;
    readonly sourceId: string;
    readonly buildId: string;
    readonly designHash: string | null;
    readonly evidenceDirectory: string;
    readonly acceptance: readonly GameAcceptanceCriterion[];
  }) =>
    Effect.gen(function* () {
      // An exhausted budget must not open a stage it will refuse: `begin`
      // deletes the previous verdict and the refusal would leave it missing.
      if (
        (yield* visualJudge.previous(input.root, input)) === null &&
        (yield* visualJudge.remaining(input.root, input.designHash)) <= 0
      )
        return null;
      return yield* ownStage(
        input.root,
        "visual",
        "Visual judge",
        visualJudge.run(input.root, input).pipe(
          Effect.map(
            (
              run,
            ): {
              readonly value: GameVisualJudge.GameVisualJudgeRun;
              readonly record: StageOutcome;
            } => {
              if (run.status === "exhausted")
                return {
                  value: run,
                  record: {
                    // An exhausted certification budget is not a failed look:
                    // it leaves the visual stage uncertified for this revision.
                    outcome: "unknown",
                    sourceId: input.sourceId,
                    buildId: input.buildId,
                    evidenceDirectory: input.evidenceDirectory,
                    designHash: input.designHash,
                    detail:
                      "The visual review budget for this approved design revision is spent; the look is uncertified, not failed.",
                  },
                };
              const judgement = run.judgement;
              return {
                value: run,
                record: {
                  outcome:
                    judgement.status === "passed"
                      ? "passed"
                      : judgement.status === "unavailable"
                        ? "unknown"
                        : "failed",
                  sourceId: input.sourceId,
                  buildId: input.buildId,
                  // A reused verdict names the run whose frames it was read from.
                  evidenceDirectory: judgement.evidenceDirectory,
                  designHash: input.designHash,
                  visual: judgement,
                  detail: judgement.detail ?? `Visual judge: ${judgement.status}.`,
                },
              };
            },
          ),
        ),
      );
    });
  const response = (
    process: GameProcessResult,
    outputPath: string | null = null,
  ): GameActionResult => {
    const errors = (process.stdout + "\n" + process.stderr)
      .split("\n")
      .filter((line) => /(?:SCRIPT ERROR|ERROR:|Parse Error)/.test(line));
    const success = process.exitCode === 0 && !process.timedOut && errors.length === 0;
    return {
      success,
      message: success
        ? "Completed successfully."
        : `Command failed${process.timedOut ? " after its timeout" : ` with exit code ${process.exitCode}`}. ${errors.slice(0, 8).join("\n")} See ${process.logPath}\n${commandDetail(process)}`,
      path: outputPath,
      url: null,
      process,
    };
  };
  const importGame = Effect.fnUntraced(function* (root: string) {
    const { godot, cwd } = yield* engine(root);
    return response(
      yield* processes.run({
        root,
        executable: godot.path,
        args: ["--headless", "--path", cwd, "--editor", "--import"],
        operation: "godot-import",
        timeoutMs: 180_000,
      }),
    );
  });
  /**
   * How a successful export relates to the selected build. `publish` makes it
   * the one Play serves; `candidate` is a round's challenger and must not
   * disturb Play while it is reviewed.
   */
  type ExportSelection =
    | { readonly mode: "publish" }
    | { readonly mode: "candidate"; readonly roundId: string };

  const runExport = Effect.fnUntraced(function* (
    root: string,
    target: "Web" | "Linux",
    selection: ExportSelection,
  ) {
    const { godot, cwd, godotProject } = yield* engine(root);
    const failedExport = (sourceId: string | null, detail?: string): StageOutcome => ({
      outcome: "failed",
      sourceId,
      buildId: null,
      evidenceDirectory: null,
      ...(detail === undefined ? {} : { detail }),
    });
    const toolStatus = yield* tools.status;
    const engineStatus = toolStatus.tools.find((tool) => tool.tool === "godot");
    if (!engineStatus?.ready)
      return yield* new GameOperationError({
        operation: "Godot export",
        path: godot.templates ?? godot.path,
        reason: "templates-missing",
        detail: `Godot executable: ${godot.path} (${godot.version}).`,
      });
    // Import first: Godot's import can write sidecars inside the project, so a
    // legacy before/after snapshot is taken around the export. Web exports build
    // from a frozen copy of the game-owned source instead, so the candidate
    // record names the exact bytes the engine read.
    const frozen = target === "Web" ? yield* rounds.freeze(root) : null;
    const frozenProject =
      frozen === null ? null : NodePath.join(frozen.directory, "files", godotProject);
    const imported =
      frozenProject === null
        ? yield* importGame(root)
        : response(
            yield* processes.run({
              root,
              executable: godot.path,
              args: ["--headless", "--path", frozenProject, "--editor", "--import"],
              operation: "godot-import",
              timeoutMs: 180_000,
            }),
          );
    if (!imported.success)
      return { value: imported, record: failedExport(frozen?.sourceId ?? null) };
    const before = frozen === null ? yield* snapshot(root, godotProject) : null;
    const beforeSourceId =
      frozen?.sourceId ?? (before !== null && before.kind === "known" ? before.sourceId : null);
    // Web exports stage in a hidden directory under the candidate root, never in
    // the served tree. A partial or failed export therefore cannot change what
    // Play loads; only a complete, hashed artifact is moved into place.
    const staging =
      target === "Web"
        ? NodePath.join(root, CANDIDATE_BUILDS_DIRECTORY, `.staging-${NodeCrypto.randomUUID()}`)
        : null;
    const output =
      staging === null
        ? NodePath.join(root, "builds/linux/game.x86_64")
        : NodePath.join(staging, "index.html");
    const cleanedUp = Effect.ensuring(
      Effect.promise(() =>
        staging === null
          ? Promise.resolve()
          : NodeFSP.rm(staging, { recursive: true, force: true }),
      ),
    );
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(NodePath.dirname(output), { recursive: true }),
        catch: (cause) =>
          new GameOperationError({ operation: "export", path: output, reason: "io", cause }),
      });
      const result = response(
        yield* processes.run({
          root,
          executable: godot.path,
          args: ["--headless", "--path", frozenProject ?? cwd, "--export-release", target, output],
          operation: `export-${target.toLowerCase()}`,
          timeoutMs: 300_000,
        }),
        output,
      );
      if (!result.success) return { value: result, record: failedExport(beforeSourceId) };
      yield* Effect.tryPromise({
        try: async () => {
          for (const file of target === "Web"
            ? [
                output,
                output.replace(/\.html$/, ".wasm"),
                output.replace(/\.html$/, ".js"),
                output.replace(/\.html$/, ".pck"),
              ]
            : [output]) {
            const stat = await NodeFSP.stat(file);
            if (!stat.isFile() || stat.size === 0) throw new Error(`Empty export: ${file}`);
          }
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "export-output",
            path: output,
            reason: "command-failed",
            detail:
              `Expected nonempty export files were missing.\n${commandDetail(result.process!)}`.slice(
                -4096,
              ),
            cause,
          }),
      });
      // Hash the staged artifact before it becomes visible. The hash is the
      // directory name, so an immutable build can never be overwritten later
      // with different bytes under the same identity.
      const hashed =
        staging === null ? null : yield* Effect.promise(() => hashWebBuildDirectory(staging));
      if (target === "Web" && hashed === null)
        return {
          value: result,
          record: failedExport(
            beforeSourceId,
            "The exported web build directory could not be read back.",
          ),
        };
      // The frozen copy is the export input; prove it still hashes to the
      // manifest the candidate will name before sealing the artifact. The
      // editable folder is checked too: an edit during the export means the
      // build no longer describes the current game.
      const afterSourceId = frozen === null ? null : yield* rounds.sourceId(root);
      const frozenSourceId =
        frozen === null ? null : yield* rounds.frozenSourceId(frozen.directory);
      const comparison =
        frozen === null
          ? comparedSource(before!, yield* snapshot(root, godotProject), "export")
          : frozenSourceId !== frozen.sourceId
            ? {
                kind: "changed" as const,
                detail:
                  "The frozen export copy changed while the export ran; the build was not published.",
              }
            : afterSourceId !== frozen.sourceId
              ? {
                  kind: "changed" as const,
                  detail:
                    "The game folder changed during the export; the build was not published because it no longer describes the current sources.",
                }
              : { kind: "current" as const, sourceId: frozen.sourceId };
      const finishedAt = DateTime.formatIso(yield* DateTime.now);
      if (comparison.kind !== "current") {
        const detail = comparison.detail;
        return {
          value: {
            ...result,
            success: false,
            message: `${detail}\n${commandDetail(result.process!)}`.slice(-4096),
          },
          record: failedExport(beforeSourceId, detail),
        };
      }
      // Qualification still identifies sources by its legacy size/mtime
      // snapshot; the candidate's own record carries the byte identity.
      const legacyAfter = frozen === null ? null : yield* snapshot(root, godotProject);
      const qualificationSourceId =
        frozen === null
          ? comparison.sourceId
          : legacyAfter !== null && legacyAfter.kind === "known"
            ? legacyAfter.sourceId
            : null;
      const directory = hashed === null ? null : candidateBuildDirectory(hashed.buildId);
      if (hashed !== null && directory !== null) {
        const final = NodePath.join(root, directory);
        const existing = yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(final, "index.html")).then(
            () => true,
            () => false,
          ),
        );
        const staged = staging!;
        const same =
          existing &&
          (yield* Effect.promise(() => hashWebBuildDirectory(final)))?.buildId === hashed.buildId;
        if (same) yield* Effect.promise(() => NodeFSP.rm(staged, { recursive: true, force: true }));
        else {
          // A directory under our own hash that does not hash to it is
          // corruption; replace it rather than serve bytes the id did not name.
          if (existing)
            yield* Effect.promise(() => NodeFSP.rm(final, { recursive: true, force: true }));
          yield* Effect.promise(() => NodeFSP.rename(staged, final));
        }
      }
      // The record names every served file, not just index.html: a deleted or
      // replaced .pck must force a rebuild before anyone plays it. Paths stay
      // game-relative so a legacy builds/web record reads the same way.
      const artifacts =
        directory === null
          ? null
          : yield* Effect.promise(() => describeWebArtifacts(root, directory));
      if (target === "Web" && (artifacts === null || hashed === null || directory === null))
        return {
          value: result,
          record: failedExport(
            beforeSourceId,
            "The exported web build directory could not be read back.",
          ),
        };
      if (hashed !== null && directory !== null) {
        // Round decisions use the byte manifest identity of the frozen input,
        // not a capture taken after the artifact was sealed.
        const roundSourceId = frozen?.sourceId ?? (yield* rounds.sourceId(root));
        const artifact = {
          buildId: hashed.buildId,
          directory,
          sourceId: roundSourceId,
          engine: "godot" as const,
          target: "Web" as const,
          entry: "index.html",
        };
        if (selection.mode === "candidate")
          yield* rounds.recordCandidate(root, selection.roundId, artifact);
        else yield* rounds.select(root, artifact);
        return {
          value: {
            ...result,
            path: NodePath.join(root, directory, "index.html"),
            message:
              selection.mode === "candidate"
                ? "Web game built as a candidate; Play keeps the selected build until the round promotes it."
                : "Web game is ready to play.",
          },
          record: {
            outcome: "passed" as const,
            sourceId: qualificationSourceId,
            buildId: hashed.buildId,
            evidenceDirectory: null,
            artifacts: artifacts!,
            buildDirectory: directory,
          },
        };
      }
      return {
        value: result,
        record: {
          outcome: "passed" as const,
          sourceId: comparison.sourceId,
          buildId: `${comparison.sourceId}:${finishedAt}`,
          evidenceDirectory: null,
        },
      };
    }).pipe(cleanedUp);
  });
  const exportGame = (root: string, target: "Web" | "Linux", selection: ExportSelection) =>
    target === "Web"
      ? ownStage(root, "export", "export", runExport(root, target, selection))
      : runExport(root, target, selection).pipe(Effect.map((completed) => completed.value));

  /** The round currently repairing this game, if any. */
  const runningRound = (root: string) =>
    rounds
      .read(root)
      .pipe(
        Effect.map((state) => state.rounds.find((round) => round.status === "running") ?? null),
      );
  /**
   * Every export path uses this decision. While a round is open its export is
   * the challenger and must not replace the selected build; outside one, the
   * creator's export is a normal publish.
   */
  const exportSelection = (root: string): Effect.Effect<ExportSelection, GameOperationError> =>
    runningRound(root).pipe(
      Effect.map((active) =>
        active === null
          ? ({ mode: "publish" } as const)
          : ({ mode: "candidate", roundId: active.id } as const),
      ),
    );
  /**
   * The build Play should show: the selected one while its immutable directory
   * still hashes to its recorded id, otherwise a pre-change builds/web game, or
   * null when the game has never been built.
   */
  const selectedPreview = (root: string) =>
    Effect.gen(function* () {
      const state = yield* rounds.read(root);
      const selected = state.selected;
      if (selected !== null) {
        const hashed = yield* Effect.promise(() => hashWebBuild(root, selected.directory));
        if (hashed !== null && hashed.buildId === selected.buildId)
          return {
            directory: selected.directory,
            selected,
            url: yield* preview.select(root, selected.directory),
          };
      }
      // Only a game with no selection may fall back to a pre-change build; a
      // broken selected record must rebuild, not silently serve something else.
      if (selected !== null) return null;
      const legacy = yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(root, WEB_BUILD_DIRECTORY, "index.html")).then(
          () => true,
          () => false,
        ),
      );
      if (legacy)
        return {
          directory: WEB_BUILD_DIRECTORY,
          selected: null,
          url: yield* preview.select(root, WEB_BUILD_DIRECTORY),
        };
      return null;
    });
  /** Builds and publishes the current sources, then serves that build. */
  const publishWeb = (root: string) =>
    Effect.gen(function* () {
      const exported = yield* exportGame(root, "Web", { mode: "publish" });
      if (!exported.success) return exported;
      const served = yield* selectedPreview(root);
      return served === null
        ? exported
        : { ...exported, message: "Web game is ready to play.", url: served.url };
    });
  /**
   * Starts the native game. `display` is the caller's claim: the creator's Play
   * may watch it on their own desktop, while every agent-facing run is headless.
   */
  const nativeGame = (root: string, display: "headless" | "inherit") =>
    Effect.gen(function* () {
      if (processes.list(root).some((entry) => entry.operation === "native"))
        return yield* new GameOperationError({
          operation: "native",
          path: root,
          reason: "busy",
        });
      const { godot, cwd } = yield* engine(root);
      const imported = yield* importGame(root);
      if (!imported.success) return imported;
      const launched = yield* processes.start({
        root,
        executable: godot.path,
        // Godot 4 needs the headless display driver, not merely an unset
        // DISPLAY: without it a windowed run fails to initialize offscreen.
        // Only the creator's own Play asks to inherit the display.
        args: display === "headless" ? ["--headless", "--path", cwd] : ["--path", cwd],
        operation: "native",
        display,
        timeoutMs: 24 * 60 * 60_000,
      });
      return {
        success: true,
        message: `Native game started with PID ${launched.pid}. Output: ${launched.logPath}`,
        path: launched.logPath,
        url: null,
        process: null,
      };
    });

  const webPlaytest = (root: string, input: GameWebPlaytestInput) =>
    Effect.gen(function* () {
      // Reject before exporting, serving, or launching the browser: a bad capture
      // request must not cost a build or hold the game's operation lock.
      const issues = playtestInputIssues(input);
      if (issues.length > 0)
        return yield* new GameOperationError({
          operation: "Web playtest",
          path: root,
          reason: "invalid-input",
          detail: issues.join("\n"),
        });
      return yield* ownStage(
        root,
        "playtest",
        "playtest",
        Effect.gen(function* () {
          const manifest = yield* projects.read(root);
          const identity = yield* designApprovals.readPolicy(root, manifest);
          const beforePlaytest = yield* qualification.read(root, manifest.godotProject);
          if (!(yield* webBuildIsCurrent(beforePlaytest))) {
            const exported = yield* exportGame(root, "Web", yield* exportSelection(root));
            if (!exported.success)
              return yield* new GameOperationError({
                operation: "Web playtest",
                path: NodePath.join(root, "builds/web"),
                reason: "command-failed",
                detail: exported.message,
              });
          }
          // Bind the run to the build that exists now, before it starts. A later
          // replacement makes this build stale through the export record.
          const build = (yield* qualification.read(root, manifest.godotProject)).stages.find(
            (stage) => stage.stage === "export",
          );
          // Playtest the bytes the export record names, which may be a round's
          // candidate; Play itself keeps serving the selected build.
          const url = yield* preview.open(root, build?.buildDirectory ?? WEB_BUILD_DIRECTORY);
          const executable = yield* browser.executable.pipe(
            Effect.mapError(
              (cause) =>
                new GameOperationError({
                  operation: "Web playtest",
                  path: root,
                  reason: "tool-missing",
                  detail: `Game Studio's preview browser is not ready. ${cause.message} Once the install finishes, retry game_web_playtest.`,
                }),
            ),
          );
          // The exam this run is judged against, read before the run starts so a
          // mid-run approval change cannot swap the rules under the agent's feet.
          const designSnapshot = yield* designApprovals.snapshot(root, manifest);
          const approval = designSnapshot.read.state === "approved" ? designSnapshot.record : null;
          // The game keeps its own pixel grid: capture a whole-number multiple of
          // the project's base viewport that fits the requested box, so a 640×360
          // game is recorded in real pixels instead of letterboxed into a box.
          const projectGodot = yield* Effect.tryPromise({
            try: () =>
              NodeFSP.readFile(NodePath.join(root, manifest.godotProject, "project.godot"), "utf8"),
            catch: (cause) =>
              new GameOperationError({
                operation: "Web playtest",
                path: NodePath.join(root, manifest.godotProject, "project.godot"),
                reason: "io",
                cause,
              }),
          });
          const baseViewport = parseGodotViewport(projectGodot);
          const capture = integerScaledCapture(baseViewport, {
            width: input.width ?? PLAYTEST_DEFAULT_CAPTURE.width,
            height: input.height ?? PLAYTEST_DEFAULT_CAPTURE.height,
          });
          if (capture === null)
            return yield* new GameOperationError({
              operation: "Web playtest",
              path: root,
              reason: "invalid-input",
              detail: `The game's base viewport (${baseViewport.width}×${baseViewport.height}) does not fit the capture bounds (${GAME_PLAYTEST_BOUNDS.minDimension}–${GAME_PLAYTEST_BOUNDS.maxDimension} px). Change display/window/size in project.godot first.`,
            });
          const result = yield* playtest.run({
            executable,
            url,
            profileDirectory: NodePath.join(
              root,
              "builds/logs",
              `playtest-${NodeCrypto.randomUUID()}`,
            ),
            width: capture.width,
            height: capture.height,
            bootTimeoutMs: input.bootTimeoutMs ?? 90_000,
            steps: input.steps ?? [],
            probeRequired: identity.policy.probe,
            acceptance: approval?.acceptance ?? null,
          });
          // Informational only: which approved promises this run happened to show. It
          // never feeds qualification; the evaluator and the scenario runner do.
          const observations = satisfiedObservations(approval?.acceptance ?? [], result.state);
          const hasObservable = (approval?.acceptance ?? []).some(
            (criterion) => criterion.observe !== undefined,
          );
          const observationNote = hasObservable
            ? ` Design observations satisfied here: ${observations.length === 0 ? "none" : observations.join(", ")} (informational; the scenario stage gates).`
            : "";
          const qualifies = result.qualifies ?? false;
          const blockers = result.blockers ?? [];
          // A template game owes the probe it was created with. The verification
          // policy is server-owned, so deleting scripts/studio_probe.gd or editing
          // game.json cannot downgrade the playtest to the pixel rule.
          const probeRequired = identity.policy.probe;
          const missingProbe = probeRequired && result.state === null;
          const probesMissing = "StudioProbe missing — restore scripts/studio_probe.gd autoload";
          const budgeted = fitScreenshotsToBudget(result.screenshots);
          const droppedFrames = budgeted.dropped.length;
          const enriched = {
            ...result,
            designObservations: observations,
            baseViewport,
            captureScale: capture.scale,
          };
          const evidence = yield* Effect.tryPromise({
            try: () =>
              writePlaytestEvidence({
                root,
                result: enriched,
                steps: input.steps ?? [],
              }),
            catch: (cause) =>
              new GameOperationError({
                operation: "Web playtest evidence",
                path: NodePath.join(root, "builds/playtests"),
                reason: "io",
                cause,
              }),
          });
          const framesNote =
            droppedFrames === 0
              ? ""
              : ` ${droppedFrames} frame(s) exceeded the ${GAME_PLAYTEST_BOUNDS.maxResultImageBytes / (1024 * 1024)} MB response budget; they stay in ${evidence.directory}.`;
          const qualificationNote = qualifies
            ? ""
            : ` Qualification: this run does not count as honest gameplay evidence${
                blockers.length === 0 ? "" : `: ${blockers.join("; ")}`
              }.${missingProbe ? ` ${probesMissing}.` : ""}`;
          // Only a qualifying mechanics run reaches the visual stage: there is
          // no point grading the look of a run that did not prove gameplay.
          const visualAttempt =
            qualifies &&
            build?.status === "passed" &&
            build.sourceId !== null &&
            build.buildId !== null
              ? yield* judgeVisualStage({
                  root,
                  sourceId: build.sourceId,
                  buildId: build.buildId,
                  designHash: approval?.designHash ?? null,
                  evidenceDirectory: evidence.directory,
                  acceptance: approval?.acceptance ?? [],
                })
              : undefined;
          const visual = visualAttempt?.status === "judged" ? visualAttempt.judgement : null;
          const visualNote =
            visual !== null
              ? `${
                  visualAttempt?.status === "judged" && visualAttempt.reused
                    ? `\nVisual judge: this source, build and design already have a verdict from ${visual.evidenceDirectory}; it is reused and no round was spent.`
                    : ""
                }\n${formatVisualReport(visual)}`
              : visualAttempt === null
                ? "\nVisual judge: the review budget for this design revision is spent. The look is uncertified, not failed; keep the playable build and its playtest current."
                : "";
          return {
            value: {
              ...enriched,
              screenshots: budgeted.kept,
              message: `${result.message}${qualificationNote}${observationNote}${framesNote}${visualNote}`,
              evidenceDirectory: evidence.directory,
              ...(visual === null ? {} : { visual }),
            },
            record: {
              outcome: qualifies ? ("passed" as const) : ("failed" as const),
              sourceId: build?.status === "passed" ? build.sourceId : null,
              buildId: build?.status === "passed" ? build.buildId : null,
              evidenceDirectory: evidence.directory,
              probeRequired,
              detail: missingProbe
                ? probesMissing
                : result.state === null
                  ? "No state probe in this game; the playtest was judged on input steps and a visible response."
                  : `Interaction: ${result.interaction}.`,
            },
          };
        }),
      );
    });
  /** Imports first: a fresh game has no .godot cache, so .tres files and class_names cannot resolve. */
  const checkGame = (root: string) =>
    ownStage(
      root,
      "check",
      "check",
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const temporary = NodePath.join(
          root,
          "builds/logs",
          `godot-check-${NodeCrypto.randomUUID()}`,
        );
        const scriptPath = NodePath.join(temporary, "check.gd");
        const resultPath = NodePath.join(temporary, "result.json");
        const { godot, cwd, godotProject } = yield* engine(root);
        const manifest = yield* projects.read(root);
        // The server-owned exam, never game.json: the agent can edit that file.
        const identity = yield* designApprovals.readPolicy(root, manifest);
        const gameplayScene = identity.policy.gameplayScene ?? "";
        // Import is cache preparation, not the check itself: Godot's import can
        // write sidecar files inside the project, so the inputs are read after it
        // and before the checking script runs.
        const imported = yield* importGame(root);
        const before = yield* snapshot(root, godotProject);
        return yield* Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.mkdir(temporary, { recursive: true });
              await NodeFSP.writeFile(scriptPath, GODOT_CHECK_SCRIPT);
            },
            catch: (cause) =>
              new GameOperationError({
                operation: "godot-check",
                path: temporary,
                reason: "io",
                cause,
              }),
          });
          const run = yield* processes.run({
            root,
            executable: godot.path,
            args: [
              "--headless",
              "--path",
              cwd,
              "--script",
              scriptPath,
              "--",
              resultPath,
              gameplayScene,
            ],
            operation: "godot-check",
            timeoutMs: 120_000,
          });
          const resultText = yield* Effect.promise(() =>
            NodeFSP.readFile(resultPath, "utf8").catch(() => null),
          );
          const reported = decodeText(decodeCheckResult, resultText);
          const importedOutput =
            imported.process === null
              ? ""
              : `${imported.process.stdout}\n${imported.process.stderr}`;
          const importedIssues = parseGodotIssues(importedOutput);
          const parsed = [...importedIssues, ...parseGodotIssues(`${run.stdout}\n${run.stderr}`)];
          const errors = mergeCheckIssues(reported?.errors ?? [], parsed);
          if (!imported.success && importedIssues.length === 0)
            errors.unshift({
              file: "godot/project.godot",
              message: `Import failed with exit code ${imported.process?.exitCode ?? -1}. ${imported.message}`,
            });
          if (reported === null)
            errors.unshift({
              file: "godot/project.godot",
              message:
                "The Godot check script did not report a result. The project may have crashed during startup.",
            });
          if (run.timedOut)
            errors.unshift({
              file: "godot/project.godot",
              message: "The Godot check timed out before finishing its physics frames.",
            });
          if (run.exitCode !== 0 && errors.length === 0)
            errors.unshift({
              file: "godot/project.godot",
              message: `Godot exited with code ${run.exitCode}. ${commandDetail(run)}`,
            });
          // A game created before gameplay entries is checked as it always was, but
          // the warning says what the check did not cover rather than implying it did.
          const warnings = [
            ...(reported?.warnings ?? []),
            ...(identity.policy.gameplayScene === null
              ? [
                  {
                    file: "verification policy",
                    message:
                      "The verification policy declares no gameplay scene, so the check ran only the main scene (the menu); gameplay initialization was not exercised.",
                  },
                ]
              : []),
          ];
          const after = yield* snapshot(root, godotProject);
          const comparison = comparedSource(before, after, "check");
          if (comparison.kind !== "current")
            warnings.unshift({ file: "godot/", message: comparison.detail });
          const result = {
            ok: errors.length === 0 && reported !== null && !run.timedOut,
            errors: limitIssues(errors),
            warnings: limitIssues(warnings),
            entries: reported?.entries ?? [],
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          };
          return {
            value: result,
            record: {
              outcome: result.ok
                ? comparison.kind === "current"
                  ? ("passed" as const)
                  : ("unknown" as const)
                : ("failed" as const),
              sourceId: comparison.kind === "current" ? comparison.sourceId : null,
              buildId: null,
              evidenceDirectory: null,
              policyRevision: identity.revision,
              ...(comparison.kind === "current" ? {} : { detail: comparison.detail }),
            },
          };
        }).pipe(
          Effect.ensuring(
            Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
          ),
        );
      }),
    );
  /**
   * Runs the agent-written routes under real physics and grades them against the
   * creator's approved observations. Routes are pure input data: this method
   * supplies the exam, the game supplies the answer.
   */
  const scenariosRun = (root: string) =>
    ownStage(
      root,
      "state",
      "scenarios",
      Effect.gen(function* () {
        const { godot, cwd, godotProject } = yield* engine(root);
        const manifest = yield* projects.read(root);
        const identity = yield* designApprovals.readPolicy(root, manifest);
        const imported = yield* importGame(root);
        // Import may write sidecars inside the project; read the inputs after it
        // and before the scenario runners execute them.
        const sourceBefore = yield* snapshot(root, godotProject);
        const designSnapshot = yield* designApprovals.snapshot(root, manifest);
        const design = designSnapshot.read;
        const approval = designSnapshot.record;
        const mode: "criteria" | "legacy" | "none" =
          design.state === "approved" && approval !== null
            ? "criteria"
            : design.state === "legacy"
              ? "legacy"
              : "none";
        const criteria = mode === "criteria" && approval !== null ? approval.acceptance : [];
        const evidenceDirectory = NodePath.join(
          root,
          "builds/logs",
          `scenarios-${NodeCrypto.randomUUID()}`,
        );
        const evidenceReference = NodePath.relative(root, evidenceDirectory);
        const writeFailure = (errors: readonly string[]): GameScenariosRunResult => {
          const summary = evaluateScenarios({ mode, criteria, runs: [] });
          const failed = {
            ...summary,
            passed: false,
            reason: "scenario-failed" as const,
            detail: errors[0] ?? summary.detail,
          };
          return {
            ok: false,
            summary: failed,
            scenarios: [],
            errors: [...errors],
            evidenceDirectory: null,
          };
        };
        if (!imported.success) {
          const errors = [`The Godot import failed before the scenarios ran: ${imported.message}`];
          const failed = writeFailure(errors);
          return {
            value: failed,
            record: {
              outcome: "failed" as const,
              sourceId: sourceBefore.kind === "known" ? sourceBefore.sourceId : null,
              buildId: null,
              evidenceDirectory: null,
              designHash: approval?.designHash ?? null,
              criteria: failed.summary.criteria,
              ...(failed.summary.coverage === undefined
                ? {}
                : { coverage: failed.summary.coverage }),
              detail: failed.summary.detail,
            },
          };
        }
        const projectText = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(cwd, "project.godot"), "utf8").catch(() => ""),
        );
        const projectActions = parseProjectInputActions(projectText);
        const files = yield* Effect.promise(() => readScenarioFiles(cwd));
        const errors = [...files.errors];
        const runnable = files.scenarios.filter((file) => {
          const issues = scenarioActionIssues(file.scenario, projectActions);
          if (issues.length === 0) return true;
          errors.push(`${file.scenario.id}: ${issues.join(" ")}`);
          return false;
        });
        const observations = scenarioObservations(mode, criteria);
        const scriptPath = NodePath.join(evidenceDirectory, "scenario.gd");
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(evidenceDirectory, { recursive: true });
            await NodeFSP.writeFile(scriptPath, GODOT_SCENARIO_SCRIPT);
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "godot-scenarios",
              path: evidenceDirectory,
              reason: "io",
              cause,
            }),
        });
        const runs: GameScenarioEvidence[] = [];
        for (const file of runnable) {
          const planned = file.scenario.steps.reduce(
            (total, step) =>
              total + ("press" in step ? 2 : "hold" in step ? step.frames : step.wait),
            0,
          );
          const timeoutMs = Math.min(
            300_000,
            Math.max(60_000, Math.ceil(((planned + 300) / 60) * 1000 * 3)),
          );
          const requestPath = NodePath.join(evidenceDirectory, `${file.scenario.id}.request.json`);
          const resultPath = NodePath.join(evidenceDirectory, `${file.scenario.id}.result.json`);
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              requestPath,
              scenarioRequestJson({
                scenarioPath: file.path,
                observations,
                sampleEvery: 6,
                bootFrames: 30,
              }),
            ),
          );
          const startedAt = yield* Clock.currentTimeMillis;
          const run = yield* processes.run({
            root,
            executable: godot.path,
            args: [
              "--headless",
              "--fixed-fps",
              "60",
              "--path",
              cwd,
              "--script",
              scriptPath,
              "--",
              requestPath,
              resultPath,
            ],
            operation: "godot-scenarios",
            timeoutMs,
          });
          const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
          const resultText = yield* Effect.promise(() =>
            NodeFSP.readFile(resultPath, "utf8").catch(() => null),
          );
          const reported = resultText === null ? null : decodeScenarioEvidence(resultText);
          const scriptIssues = parseGodotIssues(`${run.stdout}\n${run.stderr}`);
          let error: string | null = null;
          if (run.timedOut) error = `The scenario timed out after ${timeoutMs} ms.`;
          else if (reported === null)
            error = `The runner did not report a result. The project may have crashed during startup. ${commandDetail(run)}`;
          else if (reported.error !== null) error = reported.error;
          else if (scriptIssues.length > 0)
            error = `Godot reported: ${scriptIssues
              .slice(0, 3)
              .map((issue) => `${issue.file}${issue.line ? `:${issue.line}` : ""} ${issue.message}`)
              .join(" | ")}`;
          else if (scriptIssues.length === 0 && run.exitCode !== 0)
            error = `Godot exited with code ${run.exitCode}. ${commandDetail(run)}`;
          runs.push({
            id: file.scenario.id,
            frames: reported?.frames ?? 0,
            durationMs: reported?.durationMs ?? elapsedMs,
            firstInputFrame: reported?.firstInputFrame ?? null,
            baselineFrame: reported?.baselineFrame ?? null,
            playerMoved: reported?.playerMoved ?? false,
            error,
            invalidActions: reported?.invalidActions ?? [],
            observations: reported?.observations ?? [],
          });
        }
        const sourceAfter = yield* snapshot(root, godotProject);
        const comparison = comparedSource(sourceBefore, sourceAfter, "scenarios");
        if (comparison.kind !== "current") errors.push(comparison.detail);
        const evaluated = evaluateScenarios({ mode, criteria, runs });
        const summary =
          errors.length > 0 && evaluated.passed
            ? {
                ...evaluated,
                passed: false,
                reason: "scenario-failed" as const,
                detail: errors[0]!,
              }
            : evaluated;
        return {
          value: {
            ok: summary.passed && errors.length === 0,
            summary,
            scenarios: runs,
            errors,
            evidenceDirectory: evidenceReference,
          },
          record: {
            outcome: summary.passed ? ("passed" as const) : ("failed" as const),
            sourceId: comparison.kind === "current" ? comparison.sourceId : null,
            buildId: null,
            evidenceDirectory: evidenceReference,
            designHash: approval?.designHash ?? null,
            criteria: summary.criteria,
            ...(summary.coverage === undefined ? {} : { coverage: summary.coverage }),
            policyRevision: identity.revision,
            detail: comparison.kind === "current" ? summary.detail : comparison.detail,
          },
        };
      }),
    );
  const inspectScene = Effect.fnUntraced(function* (root: string, scenePath: string) {
    const { godot, cwd } = yield* engine(root);
    const relative = scenePath.replace(/^res:\/\//, "");
    const resolved = yield* Effect.try({
      try: () => insideGame(cwd, relative),
      catch: (cause) =>
        isGameOperationError(cause)
          ? cause
          : new GameOperationError({
              operation: "inspect-scene",
              path: scenePath,
              reason: "invalid-path",
              cause,
            }),
    });
    if (!resolved.endsWith(".tscn"))
      return yield* new GameOperationError({
        operation: "inspect-scene",
        path: scenePath,
        reason: "invalid-path",
      });
    const temporary = NodePath.join(
      root,
      "builds/logs",
      `godot-inspect-${NodeCrypto.randomUUID()}`,
    );
    const scriptPath = NodePath.join(temporary, "inspect.gd");
    const resultPath = NodePath.join(temporary, "result.json");
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(temporary, { recursive: true });
          await NodeFSP.writeFile(scriptPath, GODOT_INSPECT_SCRIPT);
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "inspect-scene",
            path: temporary,
            reason: "io",
            cause,
          }),
      });
      const run = yield* processes.run({
        root,
        executable: godot.path,
        args: ["--headless", "--path", cwd, "--script", scriptPath, "--", resolved, resultPath],
        operation: "godot-inspect",
        timeoutMs: 60_000,
      });
      const resultText = yield* Effect.promise(() =>
        NodeFSP.readFile(resultPath, "utf8").catch(() => null),
      );
      const raw = decodeText(decodeSceneInspect, resultText);
      if (raw === null || raw.error !== undefined)
        return yield* new GameOperationError({
          operation: "inspect-scene",
          path: scenePath,
          reason: "command-failed",
          detail: (raw?.error ?? commandDetail(run)).slice(-4096),
        });
      return {
        scenePath: `res://${NodePath.relative(cwd, resolved).split(NodePath.sep).join("/")}`,
        nodes: raw.nodes ?? [],
        nodeCount: raw.nodeCount ?? raw.nodes?.length ?? 0,
        truncated: raw.truncated ?? false,
      };
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
      ),
    );
  });
  const withRoot = Effect.fnUntraced(function* <A>(
    threadId: ThreadId,
    name: string,
    work: (root: string) => Effect.Effect<A, GameOperationError>,
  ) {
    const root = yield* projects.resolve(threadId);
    return yield* exclusive(root, name, work(root));
  });
  /**
   * For a reviewed design, the design phase is the gate between planning and
   * building: while the current DESIGN.md has no matching approval record the game must not export,
   * preview, run or playtest, and must not mint Blender assets. The record is
   * authoritative, so editing game.json cannot lift the gate.
   */
  const refuseWhileUnapproved = (root: string, operation: string) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root).pipe(Effect.orElseSucceed(() => null));
      if (manifest === null) return;
      const design = yield* designApprovals.status(root, manifest);
      // A game without design review records revisions as they land; its
      // design is evidence for the exam, never a gate on building.
      if (design.autoRevision !== undefined) return;
      if (
        design.state !== "draft" &&
        design.state !== "changed" &&
        design.state !== "revision-pending"
      )
        return;
      return yield* new GameOperationError({
        operation,
        path: NodePath.join(root, "DESIGN.md"),
        reason:
          design.state === "changed"
            ? "design-changed"
            : design.state === "revision-pending"
              ? "design-revision-pending"
              : "design-draft",
      });
    });
  /** Runs one Godot script and returns what the test stage would record for it. */
  const testGame = (root: string, script: string, timeoutMs: number, policyRevision?: string) =>
    Effect.gen(function* () {
      const { godot, cwd, godotProject } = yield* engine(root);
      const resolved = yield* Effect.try({
        try: () => insideGame(cwd, script.replace(/^res:\/\//, "")),
        catch: (cause) =>
          isGameOperationError(cause)
            ? cause
            : new GameOperationError({
                operation: "test",
                path: script,
                reason: "invalid-path",
                cause,
              }),
      });
      if (!resolved.endsWith(".gd"))
        return yield* new GameOperationError({
          operation: "test",
          path: script,
          reason: "invalid-path",
        });
      // The suite must have been the source Godot loaded, not a later edit.
      const before = yield* snapshot(root, godotProject);
      const result = response(
        yield* processes.run({
          root,
          executable: godot.path,
          args: ["--headless", "--path", cwd, "--script", resolved],
          operation: "godot-test",
          timeoutMs: Math.max(1_000, Math.min(timeoutMs, 300_000)),
        }),
      );
      const after = yield* snapshot(root, godotProject);
      const comparison = comparedSource(before, after, "test");
      return {
        value:
          comparison.kind === "current"
            ? result
            : { ...result, message: `${result.message} ${comparison.detail}` },
        record: {
          outcome: result.success
            ? comparison.kind === "current"
              ? ("passed" as const)
              : ("unknown" as const)
            : ("failed" as const),
          sourceId: comparison.kind === "current" ? comparison.sourceId : null,
          buildId: null,
          evidenceDirectory: null,
          ...(policyRevision === undefined ? {} : { policyRevision }),
          ...(comparison.kind === "current" ? {} : { detail: comparison.detail }),
        },
      };
    });
  return GameService.of({
    events: operations.events,
    cancelThread: Effect.fn("GameService.cancelThread")(function* (threadId) {
      const root = yield* projects.resolve(threadId).pipe(
        Effect.catchTags({
          GameOperationError: (error) =>
            error.reason === "project-not-found" || error.reason === "invalid-project"
              ? Effect.succeed(null)
              : Effect.fail(error),
        }),
      );
      if (root !== null) {
        yield* cancel(root);
        // A user turn that was cancelled supersedes the round it was repairing;
        // the round is persisted terminal so a later restart cannot revive it.
        yield* rounds.stopRunning(
          root,
          "The user's turn was cancelled, so the open repair round was stopped and its candidate is not selected.",
        );
      }
    }),
    status: Effect.fn("GameService.status")(function* (threadId) {
      const root = yield* projects.resolve(threadId);
      // Qualification first: its source snapshot is also the inventory cache
      // key, so a status read that finds unchanged sources does no file walk
      // beyond the snapshot it already needed for freshness.
      const manifest = yield* projects.read(root);
      const designSnapshot = yield* designApprovals.snapshot(root, manifest);
      const design = designSnapshot.read;
      // The record this read used; a separate read could observe a newer
      // automatic revision and bind the exam to a different design.
      const approval = designSnapshot.record;
      const policy = yield* designApprovals.readPolicy(root, manifest);
      const qualificationRead = yield* qualification.read(
        root,
        manifest.godotProject,
        design.state,
        approval?.designHash ?? null,
        { policyRevision: policy.revision, probeRequired: policy.policy.probe },
        approval?.acceptance ?? design.acceptance,
      );
      const inventory = yield* projects.inventory(root, qualificationRead.sourceId);
      const roundState = yield* rounds.read(root);
      const selected = roundState.selected;
      const selectedPresent =
        selected === null
          ? null
          : yield* Effect.promise(async () => {
              // Cheap structural check for status polling: a missing or empty
              // artifact file must read as stale. Byte identity is checked when
              // Play actually opens the build, not on every poll.
              for (const name of ["index.html", "index.js", "index.wasm", "index.pck"]) {
                const stat = await NodeFSP.stat(
                  NodePath.join(root, selected.directory, name),
                ).catch(() => null);
                if (stat === null || !stat.isFile() || stat.size === 0) return false;
              }
              return true;
            });
      // The inventory reports what exists under builds/, but Play follows the
      // selected record. Name that build honestly: a stale candidate export must
      // not make the served build look newer than it is. With nothing selected,
      // only the legacy mutable build can be played; candidates are evidence.
      const builds =
        selected === null
          ? inventory.builds.filter(
              (build) => build.target !== "Web" || build.path.startsWith(`${WEB_BUILD_DIRECTORY}/`),
            )
          : [
              ...inventory.builds.filter((build) => build.target !== "Web"),
              {
                target: "Web",
                path: `${selected.directory}/${selected.entry}`,
                updatedAt: selected.promotedAt,
              },
            ];
      const legacyExport = qualificationRead.stages.find((stage) => stage.stage === "export");
      const legacyBuildCurrent =
        selected === null &&
        (legacyExport?.buildDirectory ?? WEB_BUILD_DIRECTORY) === WEB_BUILD_DIRECTORY &&
        // A candidate export record is evidence about the challenger, not the
        // legacy build Play would fall back to.
        (yield* webBuildIsCurrent(qualificationRead));
      // Play identity is a byte question: the selected build's own source
      // manifest against the current bytes. An unknown tree differs because it
      // cannot be shown to match. Hashing every file on a two-second poll would
      // be wasteful, so reuse the byte identity while qualification's cheap
      // size/mtime snapshot says the tree has not changed.
      let playSourceId: string | null = null;
      if (selected !== null) {
        const legacySourceId = qualificationRead.sourceId;
        const cached = legacySourceId === null ? undefined : playIdentityCache.get(root);
        if (legacySourceId === null) playSourceId = null;
        else if (cached !== undefined && cached.read === legacySourceId)
          playSourceId = cached.sourceId;
        else {
          playSourceId = yield* rounds
            .sourceId(root)
            .pipe(Effect.catch(() => Effect.succeed<string | null>(null)));
          playIdentityCache.set(root, { read: legacySourceId, sourceId: playSourceId });
        }
      }
      const playtestStage = qualificationRead.stages.find((stage) => stage.stage === "playtest");
      const lastPlaytest = yield* Effect.tryPromise({
        try: () =>
          // The approved exam the cover selection reads the same way the
          // playtest stage did: unapproved drafts prove nothing.
          readLastPlaytest(
            root,
            builds,
            design.state === "approved" ? (approval?.acceptance ?? design.acceptance) : null,
          ),
        catch: () =>
          new GameOperationError({
            operation: "read-playtest",
            path: NodePath.join(root, "builds/playtests"),
            reason: "io",
          }),
      }).pipe(
        Effect.orElseSucceed(() => null),
        // Qualification owns freshness: a run that qualified is current only
        // while its recorded source and build still match the game. A run that
        // failed the exam already says so through `qualifies`; marking it stale
        // too would claim its build changed, which may be false.
        Effect.map((playtest) =>
          playtest === null
            ? null
            : {
                ...playtest,
                stale:
                  playtest.qualifies === false
                    ? playtest.stale
                    : playtestStage?.status !== "passed",
              },
        ),
      );
      return {
        root,
        ...inventory,
        builds,
        design,
        // What Play would show, not what the last export produced: a good
        // candidate export does not make the selected build fresh, and a source
        // edit does not make the selected artifact unplayable.
        webBuildStale: selected !== null ? !selectedPresent : !legacyBuildCurrent,
        selectedBuildId: selected?.buildId ?? null,
        selectedArtifactUsable: selectedPresent,
        // Usability and source freshness are separate answers: the selected
        // build can be perfectly playable while the editable sources have moved
        // on, which is the normal state during a review round.
        sourcesDifferFromPlay: selected !== null && playSourceId !== selected.sourceId,
        qualification: qualificationRead,
        toolchain: yield* tools.status,
        processes: processes.list(root),
        previewUrl: preview.url(root),
        logsDirectory: NodePath.join(root, "builds/logs"),
        lastPlaytest,
        operation: operations.current(root),
      };
    }),
    import: (threadId) => withRoot(threadId, "Import", importGame),
    export: (threadId, target, options) =>
      withRoot(threadId, `Export ${target}`, (root) =>
        Effect.gen(function* () {
          yield* refuseWhileUnapproved(root, "export");
          // While a round runs, an export is that round's challenger: it must
          // not replace the build Play serves. Outside a round the builder's
          // export is the publish, so development stays immediate. A caller
          // that names a round is telling the server which loop it belongs to;
          // an expired round must fail rather than become a direct publication.
          const active = target === "Web" ? yield* runningRound(root) : null;
          if (options?.roundId !== undefined) {
            if (active === null || active.id !== options.roundId)
              return yield* new GameOperationError({
                operation: "Export Web",
                path: root,
                reason: "invalid-input",
                detail:
                  "That repair round is no longer running; its export was not published or recorded.",
              });
            return yield* exportGame(root, target, {
              mode: "candidate",
              roundId: active.id,
            });
          }
          return yield* exportGame(
            root,
            target,
            active === null ? { mode: "publish" } : { mode: "candidate", roundId: active.id },
          );
        }),
      ),
    native: (threadId, options) =>
      withRoot(threadId, "Native game", (root) =>
        Effect.andThen(
          refuseWhileUnapproved(root, "native"),
          // Default to headless: a caller that did not ask to watch a window
          // must never inherit the creator's display.
          nativeGame(root, options?.display ?? "headless"),
        ),
      ),
    webPlaytest: (threadId, input) =>
      withRoot(threadId, "Web playtest", (root) =>
        Effect.andThen(refuseWhileUnapproved(root, "web-playtest"), webPlaytest(root, input)),
      ),
    check: (threadId) => withRoot(threadId, "Godot check", checkGame),
    scenariosRun: (threadId) => withRoot(threadId, "Godot scenarios", scenariosRun),
    inspectScene: (threadId, scenePath) =>
      withRoot(threadId, "Inspect scene", (root) => inspectScene(root, scenePath)),
    test: (threadId, script, timeoutMs = 60_000) =>
      withRoot(threadId, "Test", (root) =>
        Effect.gen(function* () {
          const manifest = yield* projects.read(root);
          // The canonical suite comes from the server-owned policy, not the
          // manifest an agent can edit.
          const identity = yield* designApprovals.readPolicy(root, manifest);
          const suite = identity.policy.testSuite;
          const canonical = suite.replace(/^res:\/\//, "").replaceAll("\\", "/");
          const requested = NodePath.normalize(script.replace(/^res:\/\//, ""))
            .split(NodePath.sep)
            .join("/");
          // Only the game's canonical suite owns the test stage; any other script
          // is a diagnostic run and must not change qualification.
          if (requested !== canonical) {
            const diagnostic = yield* testGame(root, script, timeoutMs);
            return {
              ...diagnostic.value,
              message: `${diagnostic.value.message} Only the canonical suite (${suite}) records qualification, so this run did not change it.`,
            };
          }
          return yield* ownStage(
            root,
            "test",
            "test",
            testGame(root, script, timeoutMs, identity.revision),
          );
        }),
      ),
    blender: (threadId, input) =>
      withRoot(threadId, "Blender asset", (root) =>
        Effect.gen(function* () {
          yield* refuseWhileUnapproved(root, "blender");
          const blender = yield* tools.executable("blender");
          const manifest = yield* projects.read(root);
          if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.id))
            return yield* new GameOperationError({
              operation: "blender",
              path: input.id,
              reason: "invalid-path",
            });
          const asset = {
            id: input.id,
            kind: "model" as const,
            source: `art/blender/${input.id}.blend`,
            script: `art/scripts/${input.id}.py`,
            export: `${manifest.godotProject}/assets/models/${input.id}.glb`,
            ...(input.thumbnail === false ? {} : { thumbnail: `art/previews/${input.id}.png` }),
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
          const temporary = NodePath.join(
            root,
            "builds/logs",
            `blender-${NodeCrypto.randomUUID()}`,
          );
          return yield* Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: async () => {
                await NodeFSP.mkdir(temporary, { recursive: true });
                for (const relative of [
                  asset.source,
                  asset.script,
                  asset.export,
                  ...(asset.thumbnail ? [asset.thumbnail] : []),
                ])
                  await NodeFSP.mkdir(NodePath.dirname(insideGame(root, relative)), {
                    recursive: true,
                  });
                await NodeFSP.writeFile(insideGame(root, asset.script), input.script);
                await NodeFSP.writeFile(
                  NodePath.join(temporary, "run.py"),
                  blenderWrapper({
                    reset: input.reset ?? false,
                    source: insideGame(root, asset.source),
                    script: insideGame(root, asset.script),
                    exported: insideGame(root, asset.export),
                    thumbnail: asset.thumbnail ? insideGame(root, asset.thumbnail) : null,
                    metadata: NodePath.join(temporary, "result.json"),
                  }),
                );
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "blender-prepare",
                  path: temporary,
                  reason: "io",
                  cause,
                }),
            });
            const result = yield* processes.run({
              root,
              executable: blender.path,
              args: [
                "--background",
                "--factory-startup",
                "--threads",
                "2",
                "--python-exit-code",
                "1",
                "--python",
                NodePath.join(temporary, "run.py"),
              ],
              operation: "blender-asset",
              timeoutMs: 300_000,
            });
            if (result.exitCode !== 0)
              return yield* new GameOperationError({
                operation: "blender-asset",
                path: result.logPath,
                reason: "command-failed",
                detail: commandDetail(result),
              });
            const output = yield* Effect.tryPromise({
              try: async () => {
                for (const relative of [
                  asset.source,
                  asset.export,
                  ...(asset.thumbnail ? [asset.thumbnail] : []),
                ])
                  if ((await NodeFSP.stat(insideGame(root, relative))).size === 0)
                    throw new Error("Empty asset");
                return {
                  ...decodeBlenderMetadata(
                    await NodeFSP.readFile(NodePath.join(temporary, "result.json"), "utf8"),
                  ),
                  asset,
                  process: result,
                };
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "blender-output",
                  path: temporary,
                  reason: "command-failed",
                  detail:
                    `Expected asset files or metadata were missing or invalid.\n${commandDetail(result)}`.slice(
                      -4096,
                    ),
                  cause,
                }),
            });
            yield* projects.upsertAsset(root, asset);
            return output;
          }).pipe(
            Effect.ensuring(
              Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
            ),
          );
        }),
      ),
    action: Effect.fn("GameService.action")(function* (threadId, action) {
      const root = yield* projects.resolve(threadId);
      if (action === "stop") {
        yield* cancel(root);
        yield* processes.stop(root);
        yield* preview.stop(root);
        // Stopping the game is a user decision; a round that is repairing it
        // must not keep owning the folder afterwards.
        yield* rounds.stopRunning(
          root,
          "The creator stopped the game, so the open repair round was stopped.",
        );
        return {
          success: true,
          message: "Stopped this game's processes and preview server.",
          path: null,
          url: null,
          process: null,
        };
      }
      return yield* exclusive(
        root,
        action,
        Effect.gen(function* () {
          if (action === "verify") {
            const status = yield* tools.verify;
            return {
              success: status.tools.every((tool) => tool.ready && tool.verified),
              message: status.tools.map((tool) => `${tool.tool}: ${tool.message}`).join("\n"),
              path: status.toolsDirectory,
              url: null,
              process: null,
            };
          }
          // Only the toolchain check stays open during a draft; every staging
          // action here moves the game toward a playable build.
          yield* refuseWhileUnapproved(root, action);
          if (action === "export-linux")
            return yield* exportGame(root, "Linux", { mode: "publish" });
          // The creator's own Play may watch a native window; every agent-facing
          // run goes through the headless native method instead.
          if (action === "native") return yield* nativeGame(root, "inherit");
          // Rebuild forces a new export and publishes it. It is an explicit
          // user decision, so it supersedes an open round rather than becoming
          // that round's candidate.
          if (action === "rebuild") {
            yield* rounds.stopRunning(
              root,
              "An explicit Rebuild superseded the open repair round; its candidate was not selected.",
            );
            return yield* publishWeb(root);
          }
          const state = yield* rounds.read(root);
          const served = yield* selectedPreview(root);
          if (served !== null)
            return {
              success: true,
              message: "Loaded the selected web build.",
              path: NodePath.join(root, served.directory, "index.html"),
              url: served.url,
              process: null,
            };
          if (state.selected !== null)
            return {
              success: false,
              message:
                "The selected build is unavailable: its served files are missing or empty. Rebuild to export the current sources; Play does not publish unreviewed repair sources.",
              path: null,
              url: null,
              process: null,
            };
          // A first build with no round open is ordinary development. While a
          // round is open, its sources are the repair's and must be reviewed.
          const active = yield* runningRound(root);
          if (active !== null)
            return {
              success: false,
              message:
                "A repair round is open and there is no selected build to play. The round's candidate is not published automatically.",
              path: null,
              url: null,
              process: null,
            };
          return yield* publishWeb(root);
        }),
      );
    }),
  });
});
export const layer = Layer.effect(GameService, make).pipe(
  Layer.provide(GameWebPlaytest.layer),
  Layer.provideMerge(GameOperations.layer),
);
/** Tests inject a fake browser run; production uses the real playtest. */
export const layerWithPlaytest = (run: typeof GameWebPlaytest.playtest) =>
  Layer.effect(GameService, make).pipe(
    Layer.provide(GameWebPlaytest.layerOf(run)),
    Layer.provideMerge(GameOperations.layer),
  );
