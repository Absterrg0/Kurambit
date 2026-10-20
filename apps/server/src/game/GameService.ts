// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  GameOperationError,
  gameTestSuite,
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
  type GameOperationEvent,
  type GameProcessResult,
  type ThreadId,
  fitScreenshotsToBudget,
  GAME_PLAYTEST_BOUNDS,
  playtestInputIssues,
} from "@t3tools/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import { insideGame } from "./GameProjectService.ts";
import { commandDetail } from "./commandDetail.ts";
import { isWebBuildFresh, webBuildIndex } from "./webBuild.ts";
import { exportedSourceId, snapshotSource } from "./sourceSnapshot.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameOperations from "./GameOperations.ts";
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
import {
  describePlaytestState,
  playtestShowsGameplay,
  satisfiedObservations,
} from "./playtestState.ts";
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
  const designApprovals = yield* GameDesignApproval.GameDesignApproval;
  const playtest = yield* GameWebPlaytest.GamePlaytest;
  const operations = yield* GameOperations.GameOperations;
  const active = new Map<
    string,
    { cancelled: Deferred.Deferred<void>; done: Deferred.Deferred<void> }
  >();
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
   * Qualification says the export matches the sources; the artifact still has to
   * exist. A deleted or half-cleaned build is stale even when its record is not.
   */
  const webBuildIsCurrent = (root: string, read: GameQualificationRead) =>
    Effect.promise(async () => {
      if (!isWebBuildFresh(read)) return false;
      const stat = await NodeFSP.stat(webBuildIndex(root)).catch(() => null);
      return stat?.isFile() ?? false;
    });
  /**
   * Qualification is a server-owned record written from actual operation
   * results. Failing to persist it must not turn a real build into a crash; the
   * missing stage keeps the game unqualified either way.
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
  const exportGame = Effect.fnUntraced(function* (root: string, target: "Web" | "Linux") {
    const { godot, cwd, godotProject } = yield* engine(root);
    // Capture the inputs before the import/export pipeline touches the tree, then
    // again after: a source edit during the export would otherwise qualify a
    // mixed build. Only the web build is what players and playtests see, so only
    // it owns the export stage.
    const before = yield* snapshot(root, godotProject);
    const recordExport = (
      outcome: "passed" | "failed",
      sourceId: string | null,
      buildId: string | null,
    ) =>
      target === "Web"
        ? recordQualification(root, {
            stage: "export",
            outcome,
            sourceId,
            buildId,
            evidenceDirectory: null,
          })
        : Effect.void;
    const knownSourceId = (value: typeof before) =>
      value.kind === "known" ? value.sourceId : null;
    const toolStatus = yield* tools.status;
    const engineStatus = toolStatus.tools.find((tool) => tool.tool === "godot");
    if (!engineStatus?.ready)
      return yield* new GameOperationError({
        operation: "Godot export",
        path: godot.templates ?? godot.path,
        reason: "templates-missing",
        detail: `Godot executable: ${godot.path} (${godot.version}).`,
      });
    const imported = yield* importGame(root);
    if (!imported.success) {
      yield* recordExport("failed", knownSourceId(before), null);
      return imported;
    }
    const output = NodePath.join(
      root,
      target === "Web" ? "builds/web/index.html" : "builds/linux/game.x86_64",
    );
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(NodePath.dirname(output), { recursive: true }),
      catch: (cause) =>
        new GameOperationError({ operation: "export", path: output, reason: "io", cause }),
    });
    const result = response(
      yield* processes.run({
        root,
        executable: godot.path,
        args: ["--headless", "--path", cwd, "--export-release", target, output],
        operation: `export-${target.toLowerCase()}`,
        timeoutMs: 300_000,
      }),
      output,
    );
    if (!result.success) {
      yield* recordExport("failed", knownSourceId(before), null);
      return result;
    }
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
    const after = yield* snapshot(root, godotProject);
    const exportedSource = exportedSourceId(before, after);
    const finishedAt = DateTime.formatIso(yield* DateTime.now);
    yield* recordExport(
      exportedSource === null ? "failed" : "passed",
      exportedSource,
      exportedSource === null ? null : `${exportedSource}:${finishedAt}`,
    );
    return result;
  });
  const webPlaytest = Effect.fnUntraced(function* (root: string, input: GameWebPlaytestInput) {
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
    const manifest = yield* projects.read(root);
    const beforePlaytest = yield* qualification.read(root, manifest.godotProject);
    if (!(yield* webBuildIsCurrent(root, beforePlaytest))) {
      const exported = yield* exportGame(root, "Web");
      if (!exported.success)
        return yield* new GameOperationError({
          operation: "Web playtest",
          path: NodePath.join(root, "builds/web"),
          reason: "command-failed",
          detail: exported.message,
        });
    }
    const url = yield* preview.open(root);
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
    const result = yield* playtest.run({
      executable,
      url,
      profileDirectory: NodePath.join(root, "builds/logs", `playtest-${NodeCrypto.randomUUID()}`),
      width: input.width ?? 960,
      height: input.height ?? 540,
      bootTimeoutMs: input.bootTimeoutMs ?? 90_000,
      steps: input.steps ?? [],
    });
    // Informational only: which approved promises this run happened to show. It
    // never feeds qualification; the server-owned scenario runner is the gate.
    const design = yield* designApprovals.status(root, manifest);
    const approval = design.state === "approved" ? yield* designApprovals.read(root) : null;
    const observations = satisfiedObservations(approval?.acceptance ?? [], result.state);
    const hasObservable = (approval?.acceptance ?? []).some(
      (criterion) => criterion.observe !== undefined,
    );
    const observationNote = hasObservable
      ? ` Design observations satisfied here: ${observations.length === 0 ? "none" : observations.join(", ")} (informational; the scenario stage gates).`
      : "";
    const budgeted = fitScreenshotsToBudget(result.screenshots);
    const droppedFrames = budgeted.dropped.length;
    const evidence = yield* Effect.tryPromise({
      try: () =>
        writePlaytestEvidence({
          root,
          result: { ...result, designObservations: observations },
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
    // The playtest played whatever export was current before it ran: either the
    // reused build or the one this call just made.
    const build = (yield* qualification.read(root, manifest.godotProject)).stages.find(
      (stage) => stage.stage === "export",
    );
    // A template game ships StudioProbe, so a run that only changed pixels (an
    // idle animation, a menu transition, a clock) must not qualify. Games created
    // before the probe keep the pixel rule and say so.
    const stepsGiven = (input.steps?.length ?? 0) > 0;
    const probe = result.state;
    const stateAdvanced = probe !== null && playtestShowsGameplay(probe);
    // A template game owes the probe it was created with. The creation record is
    // server-owned, so deleting scripts/studio_probe.gd cannot downgrade the
    // playtest to the pixel rule without failing the stage.
    const probeRequired = (yield* designApprovals.readProbe(root)) ?? manifest.probe === true;
    const missingProbe = probeRequired && probe === null;
    const gaps: string[] = [];
    if (!stepsGiven) gaps.push("input steps");
    if (!result.success) gaps.push("a run without console errors");
    if (!result.responded) gaps.push("a visible response");
    if (probe !== null && !stateAdvanced) gaps.push("player movement or a GameState change");
    if (missingProbe) gaps.push("the StudioProbe autoload (scripts/studio_probe.gd)");
    const qualifies = gaps.length === 0;
    const probesMissing = "StudioProbe missing — restore scripts/studio_probe.gd autoload";
    yield* recordQualification(root, {
      stage: "playtest",
      outcome: qualifies ? "passed" : "failed",
      sourceId: build?.status === "passed" ? build.sourceId : null,
      buildId: build?.status === "passed" ? build.buildId : null,
      evidenceDirectory: evidence.directory,
      detail: missingProbe
        ? probesMissing
        : probe === null
          ? "No state probe in this game; the playtest was judged on input steps and a visible response."
          : `State probe: ${describePlaytestState(probe)}.`,
    });
    const framesNote =
      droppedFrames === 0
        ? ""
        : ` ${droppedFrames} frame(s) exceeded the ${GAME_PLAYTEST_BOUNDS.maxResultImageBytes / (1024 * 1024)} MB response budget; they stay in ${evidence.directory}.`;
    return {
      ...result,
      screenshots: budgeted.kept,
      message: `${
        qualifies
          ? result.message
          : `${result.message} Qualification: a qualifying playtest needs ${gaps.join(", ")}.${missingProbe ? ` ${probesMissing}.` : ""}`
      }${observationNote}${framesNote}`,
      designObservations: observations,
      evidenceDirectory: evidence.directory,
    };
  });
  /** Imports first: a fresh game has no .godot cache, so .tres files and class_names cannot resolve. */
  const checkGame = Effect.fnUntraced(function* (root: string) {
    const startedAt = yield* Clock.currentTimeMillis;
    const temporary = NodePath.join(root, "builds/logs", `godot-check-${NodeCrypto.randomUUID()}`);
    const scriptPath = NodePath.join(temporary, "check.gd");
    const resultPath = NodePath.join(temporary, "result.json");
    const { godot, cwd, godotProject } = yield* engine(root);
    const manifest = yield* projects.read(root);
    const gameplayScene = manifest.gameplayScene ?? "";
    const imported = yield* importGame(root);
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
        imported.process === null ? "" : `${imported.process.stdout}\n${imported.process.stderr}`;
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
        ...(manifest.gameplayScene === undefined
          ? [
              {
                file: "game.json",
                message:
                  "No gameplayScene is declared, so the check ran only the main scene (the menu); gameplay initialization was not exercised. Add the scene play starts in to game.json.",
              },
            ]
          : []),
      ];
      const result = {
        ok: errors.length === 0 && reported !== null && !run.timedOut,
        errors: limitIssues(errors),
        warnings: limitIssues(warnings),
        entries: reported?.entries ?? [],
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
      };
      const source = yield* snapshot(root, godotProject);
      yield* recordQualification(root, {
        stage: "check",
        outcome: result.ok ? "passed" : "failed",
        sourceId: source.kind === "known" ? source.sourceId : null,
        buildId: null,
        evidenceDirectory: null,
      });
      return result;
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
      ),
    );
  });
  /**
   * Runs the agent-written routes under real physics and grades them against the
   * creator's approved observations. Routes are pure input data: this method
   * supplies the exam, the game supplies the answer.
   */
  const scenariosRun = Effect.fnUntraced(function* (root: string) {
    const { godot, cwd, godotProject } = yield* engine(root);
    const manifest = yield* projects.read(root);
    const imported = yield* importGame(root);
    const design = yield* designApprovals.status(root, manifest);
    const approval = yield* designApprovals.read(root);
    const mode: "criteria" | "legacy" | "none" =
      design.state === "approved" && approval !== null
        ? "criteria"
        : design.state === "legacy"
          ? "legacy"
          : "none";
    const criteria = mode === "criteria" && approval !== null ? approval.acceptance : [];
    const sourceBefore = yield* snapshot(root, godotProject);
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
      yield* recordQualification(root, {
        stage: "state",
        outcome: "failed",
        sourceId: sourceBefore.kind === "known" ? sourceBefore.sourceId : null,
        buildId: null,
        evidenceDirectory: null,
        designHash: approval?.designHash ?? null,
        criteria: failed.summary.criteria,
        detail: failed.summary.detail,
      });
      return failed;
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
        (total, step) => total + ("press" in step ? 2 : "hold" in step ? step.frames : step.wait),
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
        playerMoved: reported?.playerMoved ?? false,
        error,
        invalidActions: reported?.invalidActions ?? [],
        observations: reported?.observations ?? [],
      });
    }
    const sourceAfter = yield* snapshot(root, godotProject);
    const sourceId = exportedSourceId(sourceBefore, sourceAfter);
    if (sourceId === null)
      errors.push("The game sources changed while the scenarios ran; the result is not current.");
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
    yield* recordQualification(root, {
      stage: "state",
      outcome: summary.passed ? "passed" : "failed",
      sourceId,
      buildId: null,
      evidenceDirectory: evidenceReference,
      designHash: approval?.designHash ?? null,
      criteria: summary.criteria,
      detail: summary.detail,
    });
    return {
      ok: summary.passed && errors.length === 0,
      summary,
      scenarios: runs,
      errors,
      evidenceDirectory: evidenceReference,
    };
  });
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
   * The design phase is the gate between planning and building: while the
   * current DESIGN.md has no matching approval record the game must not export,
   * preview, run or playtest, and must not mint Blender assets. The record is
   * authoritative, so editing game.json cannot lift the gate.
   */
  const refuseWhileUnapproved = (root: string, operation: string) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root).pipe(Effect.orElseSucceed(() => null));
      if (manifest === null) return;
      const design = yield* designApprovals.status(root, manifest);
      if (design.state !== "draft" && design.state !== "changed") return;
      return yield* new GameOperationError({
        operation,
        path: NodePath.join(root, "DESIGN.md"),
        reason: design.state === "changed" ? "design-changed" : "design-draft",
      });
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
      if (root !== null) yield* cancel(root);
    }),
    status: Effect.fn("GameService.status")(function* (threadId) {
      const root = yield* projects.resolve(threadId);
      // Qualification first: its source snapshot is also the inventory cache
      // key, so a status read that finds unchanged sources does no file walk
      // beyond the snapshot it already needed for freshness.
      const manifest = yield* projects.read(root);
      const design = yield* designApprovals.status(root, manifest);
      const approval = yield* designApprovals.read(root);
      const qualificationRead = yield* qualification.read(
        root,
        manifest.godotProject,
        design.state,
        approval?.designHash ?? null,
      );
      const inventory = yield* projects.inventory(root, qualificationRead.sourceId);
      const playtestStage = qualificationRead.stages.find((stage) => stage.stage === "playtest");
      const lastPlaytest = yield* Effect.tryPromise({
        try: () => readLastPlaytest(root, inventory.builds),
        catch: () =>
          new GameOperationError({
            operation: "read-playtest",
            path: NodePath.join(root, "builds/playtests"),
            reason: "io",
          }),
      }).pipe(
        Effect.orElseSucceed(() => null),
        // Qualification owns freshness: the newest run is only current when its
        // recorded source and build still match the game.
        Effect.map((playtest) =>
          playtest === null ? null : { ...playtest, stale: playtestStage?.status !== "passed" },
        ),
      );
      return {
        root,
        ...inventory,
        design,
        webBuildStale: !(yield* webBuildIsCurrent(root, qualificationRead)),
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
    export: (threadId, target) =>
      withRoot(threadId, `Export ${target}`, (root) =>
        Effect.andThen(refuseWhileUnapproved(root, "export"), exportGame(root, target)),
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
          const { godot, cwd, godotProject } = yield* engine(root);
          const manifest = yield* projects.read(root);
          const suite = gameTestSuite(manifest);
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
          const result = response(
            yield* processes.run({
              root,
              executable: godot.path,
              args: ["--headless", "--path", cwd, "--script", resolved],
              operation: "godot-test",
              timeoutMs: Math.max(1_000, Math.min(timeoutMs, 300_000)),
            }),
          );
          // Only the game's canonical suite owns the test stage; any other script
          // is a diagnostic run and must not make the game look qualified.
          const ran = NodePath.relative(cwd, resolved).split(NodePath.sep).join("/");
          const canonical = suite.replace(/^res:\/\//, "").replaceAll("\\", "/");
          if (ran !== canonical)
            return {
              ...result,
              message: `${result.message} Only the canonical suite (${suite}) records qualification, so this run did not change it.`,
            };
          const source = yield* snapshot(root, godotProject);
          yield* recordQualification(root, {
            stage: "test",
            outcome: result.success ? "passed" : "failed",
            sourceId: source.kind === "known" ? source.sourceId : null,
            buildId: null,
            evidenceDirectory: null,
          });
          return result;
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
          if (action === "export-linux") return yield* exportGame(root, "Linux");
          if (action === "native") {
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
              args: ["--path", cwd],
              operation: "native",
              timeoutMs: 24 * 60 * 60_000,
            });
            return {
              success: true,
              message: `Native game started with PID ${launched.pid}. Output: ${launched.logPath}`,
              path: launched.logPath,
              url: null,
              process: null,
            };
          }
          // Play reuses a fresh web build; Rebuild forces a new export. Scenes
          // and scripts can be edited by any provider outside this service, so
          // the qualification export stage is the only thing that decides.
          const manifest = yield* projects.read(root);
          const needsExport =
            action === "rebuild" ||
            !(yield* webBuildIsCurrent(
              root,
              yield* qualification.read(root, manifest.godotProject),
            ));
          if (needsExport) {
            const exported = yield* exportGame(root, "Web");
            if (!exported.success) return exported;
            const url = yield* preview.open(root);
            return { ...exported, message: "Web game is ready to play.", url };
          }
          const url = yield* preview.open(root);
          return {
            success: true,
            message: "Loaded the existing web build.",
            path: webBuildIndex(root),
            url,
            process: null,
          };
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
