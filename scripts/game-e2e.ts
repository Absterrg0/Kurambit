#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalDateInEffect:off globalFetch:off cryptoRandomUUID:off globalConsoleInEffect:off preferSchemaOverJson:off -- Maintainer CLI owns process, filesystem, logging, authentication, and HTTP boundaries.
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import * as GameSnapshots from "../apps/server/src/game/GameSnapshots.ts";
import { RpcClient } from "effect/rpc";
import {
  CommandId,
  DEFAULT_GAME_TEMPLATE,
  GAME_TEMPLATES,
  MessageId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProviderInstanceId,
  WsRpcGroup,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS as O,
  type ThreadId,
  type RunId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type GameRepairLoop,
  type GameReviewRound,
  type GameStatus,
  type GameSubmissionFacts,
  unmetRevisionObligations,
  validateDesignDocument,
  type GameRevisionObligation,
} from "../packages/contracts/src/index.ts";
import {
  encodeRunSummary,
  loadGameBenchmarkBrief,
  readObligations,
  readProductionTiming,
  readVisualJudgements,
  REVIEW_INCOMPLETE_PREFIX,
  type GameBenchmarkObligationRead,
  type GameE2eProductionRead,
  type GameE2eRepairLoopRead,
  type GameE2eRunSummary,
  type GameE2eTurnRead,
} from "./game-benchmark/artifacts.ts";
import { assertSelectedBuildComplete } from "./game-benchmark/completion.ts";
import { prepareDisplaySandbox } from "./lib/display-sandbox.ts";
import { externalServerOrigin, startBenchmarkServer } from "./lib/benchmark-server.ts";
import { summarizeRepairLoop, watchRepairLoop } from "./game-benchmark/repairLoop.ts";
import {
  DEFAULT_OBSERVATION_MAX_ATTEMPTS,
  DEFAULT_OBSERVATION_RETRY_DELAY_MS,
  retryObservationRead,
} from "./lib/transport-recovery.ts";
import {
  makeOwnedObservationTransport,
  observationProtocolLayer,
} from "./lib/observation-transport.ts";
import { runTurnSubscription } from "./game-benchmark/turnSubscription.ts";
import {
  buildLiveEvidence,
  hasCompleteReviewEvidence,
  classifyLiveReviewOutcome,
  type LiveEvidenceBuilder,
  type LiveEvidenceLifecycle,
  type LiveEvidenceLifecycleCancel,
  type LiveEvidenceLifecycleStaleSubmit,
  type LiveEvidenceLifecycleSyntax,
  type LiveEvidenceRead,
} from "./game-benchmark/liveEvidence.ts";
import {
  LIFECYCLE_STALE_EDIT,
  LIFECYCLE_SYNTAX_DEFECT,
  parseSubmitToolOutput,
  parseVerifyToolOutput,
  pickLifecycleScript,
} from "./game-benchmark/lifecycle.ts";

const checkout = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const { values } = NodeUtil.parseArgs({
  options: {
    url: { type: "string" },
    // An external server runs agents and games with the operator's environment.
    "allow-external-server": { type: "boolean", default: false },
    "home-dir": { type: "string", default: NodePath.join(checkout, ".t3") },
    name: { type: "string" },
    "parent-dir": { type: "string", default: NodePath.join(checkout, ".t3/e2e-games") },
    template: { type: "string" },
    // `--plan-first false` skips the design turn for harness debugging; the product default is on.
    "plan-first": { type: "string", default: "true" },
    // `--review-design true` waits for the approval RPC between the design and
    // build turns (the developer opt-in); by default one turn designs and builds.
    "review-design": { type: "string", default: "false" },
    "design-only": { type: "boolean", default: false },
    brief: { type: "string" },
    "art-direction": { type: "string" },
    // A frozen brief fixture carries the brief, art direction, template and obligations.
    fixture: { type: "string" },
    // Where the benchmark reads this run's facts; the exit status stays the verdict.
    summary: { type: "string" },
    provider: { type: "string", default: "codex" },
    model: { type: "string", default: "gpt-6.1-sol" },
    "reasoning-effort": { type: "string", default: "medium" },
    revise: { type: "string" },
    // Verifier-directed extra playtest: a JSON array of GamePlaytestStep the agent must replay.
    "extra-playtest-steps": { type: "string" },
    // Open a copy of an already generated game and exercise the production
    // review loop on it instead of generating a new game.
    "existing-game": { type: "string" },
    // Minimal instruction stack: blank template, no design stage, reduced prompt.
    builder: { type: "string" },
    "game-copy": { type: "string" },
    // The original runner's --home-dir; design records are copied from its
    // benchmark server home, never from the live install.
    "source-home": { type: "string" },
    "review-request": { type: "string" },
    evidence: { type: "string" },
    // After the existing-game review passes, exercise the post-selection
    // lifecycle with the real agent: cancel a running tool, break and repair
    // the sources, then submit the stale exact build. Existing-game only.
    "exercise-lifecycle": { type: "boolean", default: false },
    "cancel-test": { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "3600000" },
    help: { type: "boolean", default: false },
  },
});
const existingGamePath = values["existing-game"];
const existingMode = existingGamePath !== undefined;
if (values.help || (!values.brief && !values.fixture && !existingMode)) {
  console.log(
    [
      'Usage: node scripts/game-e2e.ts (--brief "<game brief>" | --fixture scripts/game-benchmark/briefs/<id>.json | --existing-game <game root> --game-copy <new dir> --source-home <original --home-dir>) [--summary FILE] [--evidence FILE] [--url http://localhost:PORT [--allow-external-server]] [--home-dir .t3] [--name NAME] [--parent-dir DIR] [--template 3d-explorer|2d-platformer|2d-screen|blank] [--plan-first true|false] [--review-design false|true] [--design-only] [--provider opencode] [--model opencode-go/deepseek-v4.1-flash] [--reasoning-effort max] [--art-direction TEXT] [--revise TEXT] [--cancel-test] [--timeout-ms 3600000]',
      "--existing-game copies the game into --game-copy, opens the copy, and sends one bounded verify/submit request so the server's real critic, repair, build check and ballots run. It requires --source-home, --summary and --evidence, and never mutates the source game or source home.",
      "--exercise-lifecycle (with --existing-game only) continues after a verified selection: cancel a running headless tool, surface a real syntax failure then repair it, and submit the stale exact build. Each phase asserts the server's actual tool result, never model prose.",
      "--timeout-ms bounds the whole run, including the review loop. The runner stops early enough to write --summary with the submitted build and review state.",
    ].join("\n"),
  );
  process.exit(values.help ? 0 : 1);
}
if (existingMode) {
  if (values["game-copy"] === undefined || values["game-copy"].trim() === "")
    throw new Error("--existing-game requires --game-copy <new directory>");
  if (values.summary === undefined || values.summary.trim() === "")
    throw new Error("--existing-game requires --summary FILE so a failure still records its state");
  if (values.evidence === undefined || values.evidence.trim() === "")
    throw new Error("--existing-game requires --evidence FILE for the structured review record");
  if (values["source-home"] === undefined || values["source-home"].trim() === "")
    throw new Error(
      "--existing-game requires --source-home <the original run's --home-dir> so the game's design intent is copied, never mutated",
    );
  if (
    values.brief !== undefined ||
    values.fixture !== undefined ||
    values.template !== undefined ||
    values.revise !== undefined ||
    values["cancel-test"] === true ||
    values["extra-playtest-steps"] !== undefined ||
    values["review-design"] === "true"
  )
    throw new Error(
      "--existing-game copies one game and exercises its review; it does not create, revise or cancel a game",
    );
  // The isolation claim depends on this runner owning its server and home.
  // Reusing an operator server (or its provider sessions) would break the pair.
  if (values.url !== undefined)
    throw new Error("--existing-game always owns a private server; --url is refused");
  // This lane writes a private server home and a game copy. A live install is
  // someone's real data, not scratch, even when the path is syntactically new.
  const liveHomes = [
    NodePath.join(NodeOS.homedir(), ".game-studio"),
    NodePath.join(NodeOS.homedir(), ".t3"),
  ];
  const requestedHome = NodePath.resolve(values["home-dir"]);
  if (
    liveHomes.some(
      (live) => requestedHome === live || requestedHome.startsWith(`${live}${NodePath.sep}`),
    )
  )
    throw new Error("--home-dir must be a scratch directory, not a live Game Studio/T3 install");
  // A home with server state can carry a previous project, thread, provider
  // session or model selection into this arm. The fair pair uses a fresh home
  // per arm, so refuse reuse before the server can read it.
  const reusedHome = NodePath.join(requestedHome, "benchmark-server");
  if ((await NodeFSP.readdir(reusedHome).catch(() => [])).length > 0)
    throw new Error(
      `--home-dir ${requestedHome} already contains benchmark-server state; use a fresh home for this arm`,
    );
} else if (
  values["game-copy"] !== undefined ||
  values["source-home"] !== undefined ||
  values["review-request"] !== undefined ||
  values.evidence !== undefined ||
  values["exercise-lifecycle"] === true
) {
  throw new Error(
    "--game-copy, --source-home, --review-request, --evidence and --exercise-lifecycle are only used with --existing-game",
  );
}
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
// The harness lane must not be able to open a window on the machine the user is
// using. Every child this runner spawns inherits this env; an empty private
// XDG_RUNTIME_DIR leaves the compositor's default wayland-0 socket unfindable.
// Headless Chrome and `godot --headless` do not need a display.
const displaySandbox = await prepareDisplaySandbox(
  values.summary === undefined
    ? NodeOS.tmpdir()
    : NodePath.dirname(NodePath.resolve(values.summary)),
);
process.env = displaySandbox.environment;
// A server this runner does not own runs its game children with the operator's
// environment, so it can only be used when the caller says that is understood.
const externalServerUrl = externalServerOrigin({
  url: values.url,
  allowExternalServer: values["allow-external-server"] === true,
});
if (values["plan-first"] !== "true" && values["plan-first"] !== "false")
  throw new Error("--plan-first must be true or false");
if (values.builder !== undefined && values.builder !== "minimal")
  throw new Error("--builder must be minimal when set; omit it for the default scaffold");
const minimalBuilder = values.builder === "minimal";
if (minimalBuilder && existingMode)
  throw new Error("--builder minimal only applies to new games, not --existing-game");
const planFirst = minimalBuilder ? false : values["plan-first"] === "true";
if (values["review-design"] !== "true" && values["review-design"] !== "false")
  throw new Error("--review-design must be true or false");
const reviewDesign = planFirst && values["review-design"] === "true";
if (values["design-only"] && (!reviewDesign || existingMode || values.revise))
  throw new Error("--design-only requires --review-design true and a new game without --revise");
if (values.revise && !reviewDesign)
  throw new Error("--revise exercises the reviewed design flow; pass --review-design true");
let extraPlaytestSteps: ReadonlyArray<Record<string, unknown>> | undefined;
if (values["extra-playtest-steps"]) {
  const raw = JSON.parse(
    await NodeFSP.readFile(NodePath.resolve(values["extra-playtest-steps"]), "utf8"),
  ) as unknown;
  assert(
    Array.isArray(raw) && raw.length > 0,
    "--extra-playtest-steps must be a JSON array of playtest steps",
  );
  extraPlaytestSteps = raw as ReadonlyArray<Record<string, unknown>>;
}
const fixture =
  values.fixture === undefined
    ? null
    : await loadGameBenchmarkBrief(NodePath.resolve(values.fixture));
if (fixture !== null && (values.brief !== undefined || values["art-direction"] !== undefined))
  throw new Error("--fixture already carries the brief and art direction");
if (
  fixture !== null &&
  !minimalBuilder &&
  values.template !== undefined &&
  values.template !== fixture.template
)
  throw new Error(`--template ${values.template} disagrees with the fixture's ${fixture.template}`);
const template = existingMode
  ? undefined
  : minimalBuilder
    ? ("blank" as const)
    : GAME_TEMPLATES.find(
        (entry) => entry.id === (fixture?.template ?? values.template ?? DEFAULT_GAME_TEMPLATE),
      )?.id;
if (!existingMode && template === undefined)
  throw new Error(
    `--template must be one of ${GAME_TEMPLATES.map((entry) => entry.id).join(", ")}`,
  );
const briefText = existingMode ? "" : (fixture?.brief ?? values.brief!);
const artDirection = existingMode ? "" : (values["art-direction"] ?? fixture?.artDirection ?? "");
let gameName = existingMode
  ? "existing game"
  : (values.name ?? fixture?.title ?? `Tiny game ${Date.now()}`);
// Each provider names its reasoning option differently.
const reasoningOptionId =
  values.provider === "claudeAgent"
    ? "effort"
    : values.provider === "opencode"
      ? "variant"
      : "reasoningEffort";
const modelSelection = {
  instanceId: ProviderInstanceId.make(values.provider),
  model: values.model,
  options: [{ id: reasoningOptionId, value: values["reasoning-effort"] }],
};
const selectionIsRequested = (selection: {
  instanceId: string;
  model: string;
  options?: ReadonlyArray<{ id: string; value: string | boolean }>;
}) =>
  selection.instanceId === values.provider &&
  selection.model === values.model &&
  selection.options?.find((option) => option.id === reasoningOptionId)?.value ===
    values["reasoning-effort"];
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const makeClient = RpcClient.make(WsRpcGroup);
type Client = Effect.Success<typeof makeClient>;
const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
const started = Date.now();
// `--timeout-ms` covers the whole run, review included. Reserve a little of it
// so a bounded phase can return and the summary can record what exists instead
// of the outer Effect timeout killing the process mid-read.
const timeoutDeadlineMs = started + timeoutMs;
const timeoutReserveMs = Math.min(60_000, Math.floor(timeoutMs / 10));
const timeline = (message: string) =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
// The benchmark reads these facts; the process exit and PASS lines stay the e2e verdict.
const summaryStartedAt = new Date().toISOString();
let summaryPhase = existingMode ? "copy" : "create";
let summaryTimedOut = false;
let summaryError: string | null = null;
let gameInfo: GameE2eRunSummary["game"] = null;
let review: GameE2eRunSummary["review"] = null;
let reviewLoop: GameE2eRepairLoopRead | null = null;
let qualification: GameStatus["qualification"] | null = null;
let lastPlaytest: GameStatus["lastPlaytest"] = null;
let obligations: ReadonlyArray<GameBenchmarkObligationRead> = [];
const turns: GameE2eTurnRead[] = [];
let productionTiming: GameE2eProductionRead | null = null;
// Existing-game evidence. These are plain values so the final summary can be
// written after the fiber is interrupted, without another RPC read.
let existingSource: string | null = null;
let existingCopy: string | null = null;
let existingSourceHome: string | null = null;
let existingRouteSteps = 0;
let copyDurationMs: number | null = null;
let sourceStatusBefore: string | null = null;
let sourceStatusAfter: string | null = null;
let sourceBytesBefore: string | null = null;
let existingBuilder: LiveEvidenceBuilder = {
  runId: null,
  status: null,
  durationMs: null,
  selectionMatches: false,
  toolCalls: [],
  sourceChanged: null,
  sourceDelta: null,
};
let liveLoop: GameRepairLoop | null = null;
let liveRounds: ReadonlyArray<GameReviewRound> = [];
let liveRoundEvidence: ReadonlyArray<{
  readonly roundId: string;
  readonly role: "critic" | "ballot";
  readonly order: number;
}> = [];
let liveSelectedBuildFacts: GameSubmissionFacts | null = null;
let liveSelectedBuildId: string | null = null;
let liveReviewPhase: string | null = null;
let liveTimedOut = false;
let liveEvidence: LiveEvidenceRead | null = null;
// Post-selection lifecycle facts, one per phase; null until that phase runs.
let lifecycleStaleSubmit: LiveEvidenceLifecycleStaleSubmit | null = null;
let lifecycleSyntax: LiveEvidenceLifecycleSyntax | null = null;
let lifecycleCancel: LiveEvidenceLifecycleCancel | null = null;
const captureLiveEvidence = () => {
  if (!existingMode) return;
  const builderTurn = turns.find((turn) => turn.name === "review-request");
  const lifecycle: LiveEvidenceLifecycle | null =
    lifecycleStaleSubmit === null && lifecycleSyntax === null && lifecycleCancel === null
      ? null
      : {
          staleSubmit: lifecycleStaleSubmit,
          syntaxFailure: lifecycleSyntax,
          cancellation: lifecycleCancel,
        };
  liveEvidence = buildLiveEvidence({
    source: existingSource ?? "",
    copy: existingCopy ?? values["game-copy"] ?? "",
    sourceHome: existingSourceHome ?? values["source-home"] ?? "",
    gameName,
    model: modelSelection,
    startedAt: summaryStartedAt,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    copyDurationMs,
    phase: summaryPhase,
    timedOut: summaryTimedOut || liveTimedOut,
    error: summaryError,
    routeSteps: existingRouteSteps,
    builder: {
      ...existingBuilder,
      durationMs: existingBuilder.durationMs ?? builderTurn?.durationMs ?? null,
    },
    loop: liveLoop,
    rounds: liveRounds,
    evidence: liveRoundEvidence,
    selectedBuildFacts: liveSelectedBuildFacts,
    selectedBuildId: liveSelectedBuildId,
    reviewPhase: liveReviewPhase,
    lifecycle,
  });
};
const harnessCommit = await exec("git", ["rev-parse", "HEAD"], {
  cwd: checkout,
  timeout: 30_000,
})
  .then((result) => result.stdout.trim())
  .catch(() => "unknown");
// The timeout branch runs outside `main`'s closure, where TypeScript's flow
// analysis only sees the initial null; the getter keeps the real record.
const recordedReviewLoop = (): GameE2eRepairLoopRead | null => reviewLoop;

const writeSummary = async () => {
  if (values.summary !== undefined) {
    const path = NodePath.resolve(values.summary);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    const judgements = await readVisualJudgements(gameRoot);
    const summary: GameE2eRunSummary = {
      schemaVersion: 2,
      review: review ?? null,
      harnessCommit,
      startedAt: summaryStartedAt,
      durationMs: Date.now() - started,
      phase: summaryPhase,
      timedOut: summaryTimedOut,
      fixture: fixture === null ? null : { id: fixture.id, checksum: fixture.checksum },
      game: gameInfo,
      turns,
      production: productionTiming,
      loop: reviewLoop,
      qualification,
      lastPlaytest,
      obligations,
      // A copied game carries the source's old playtest folders. They are not
      // this run's evidence, so only judgements made after it started count.
      visualJudgements: existingMode
        ? judgements.filter(
            (judgement) => Date.parse(judgement.judgedAt) >= Date.parse(summaryStartedAt),
          )
        : judgements,
      error: summaryError,
    };
    await NodeFSP.writeFile(path, encodeRunSummary(summary));
    console.log(`Summary written: ${path}`);
  }
  if (existingMode && values.evidence !== undefined) {
    captureLiveEvidence();
    const path = NodePath.resolve(values.evidence);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, `${JSON.stringify(liveEvidence, null, 2)}\n`);
    console.log(`Evidence written: ${path}`);
  }
};
const recordStatus = (status: GameStatus) => {
  qualification = status.qualification;
  lastPlaytest = status.lastPlaytest;
  const stateStage = status.qualification.stages.find((stage) => stage.stage === "state");
  obligations =
    fixture === null
      ? []
      : readObligations(
          fixture.obligations,
          status.design.state === "approved" ? status.design.acceptance : [],
          stateStage?.criteria ?? [],
          // A stale or unknown state stage measured another source tree; its
          // typed samples cannot prove the current game.
          {
            measurementEligible: stateStage?.status === "passed" || stateStage?.status === "failed",
          },
        );
};
// The production record names the turn that produced, so a turn that submitted
// nothing cannot inherit the previous turn's milestones.
const recordProduction = (status: GameStatus, run: OrchestrationV2Run) => {
  if (status.production.runId === null || String(status.production.runId) !== String(run.id))
    return;
  productionTiming = readProductionTiming({
    production: status.production,
    turnStartedAtMs: DateTime.toEpochMillis(run.startedAt ?? run.requestedAt),
  });
};
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
class HarnessError extends Data.TaggedError("HarnessError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}
const toError = (cause: unknown) =>
  new HarnessError({ message: cause instanceof Error ? cause.message : String(cause), cause });
const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toError });

const serverHome = NodePath.join(NodePath.resolve(values["home-dir"]), "benchmark-server");

/**
 * The server keys game-owned records by a digest of the game root's realpath.
 * The copy gets its own key, so records are read from the source and written
 * under the copy's key; the source files are never opened for writing.
 */
const gameStateDigest = async (root: string): Promise<string> => {
  const canonical = await NodeFSP.realpath(root);
  return NodeCrypto.createHash("sha256")
    .update(NodePath.resolve(canonical))
    .digest("hex")
    .slice(0, 32);
};

interface ExistingGameCopy {
  readonly source: string;
  readonly copy: string;
  readonly name: string;
}

/**
 * Copies an existing game into an unused directory. `dereference` turns any
 * symlink into a real file, so a copied path cannot write back into the source
 * game even if the generated project contains one.
 */
const copyExistingGame = async (
  sourceInput: string,
  destinationInput: string,
): Promise<ExistingGameCopy> => {
  const source = await NodeFSP.realpath(sourceInput).catch(() => NodePath.resolve(sourceInput));
  const requested = NodePath.resolve(destinationInput);
  const parent = NodePath.dirname(requested);
  await NodeFSP.mkdir(parent, { recursive: true });
  // Resolve the parent before creating the copy so a symlinked parent cannot
  // place the destination inside the source game.
  const destination = NodePath.join(await NodeFSP.realpath(parent), NodePath.basename(requested));
  if (destination === source || destination.startsWith(`${source}${NodePath.sep}`))
    throw new Error(`--game-copy must be outside the source game (${source})`);
  if (source.startsWith(`${destination}${NodePath.sep}`))
    throw new Error(`--game-copy must not contain the source game (${source})`);
  const exists = await NodeFSP.lstat(destination).then(
    () => true,
    () => false,
  );
  if (exists)
    throw new Error(
      `--game-copy ${destination} already exists; use a fresh directory so a previous run's copy is never overwritten`,
    );
  await NodeFSP.cp(source, destination, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  });
  const copy = await NodeFSP.realpath(destination);
  const manifest = JSON.parse(await NodeFSP.readFile(NodePath.join(copy, "game.json"), "utf8")) as {
    name?: unknown;
  };
  if (typeof manifest.name !== "string" || manifest.name.trim() === "")
    throw new Error(`The copied game's game.json has no name: ${copy}`);
  return { source, copy, name: manifest.name };
};

/**
 * Design intent and approval are server-owned records, not game files. A fresh
 * private home would read the copy as design-draft and refuse every export and
 * verify, so copy exactly those records and re-key their game path.
 */
const copyDesignRecords = async (input: {
  readonly sourceHome: string;
  readonly targetHome: string;
  readonly sourceRoot: string;
  readonly targetRoot: string;
}): Promise<void> => {
  const candidates = [
    NodePath.resolve(input.sourceHome),
    NodePath.join(NodePath.resolve(input.sourceHome), "benchmark-server"),
  ];
  let sourceState: string | null = null;
  for (const candidate of candidates) {
    const directory = NodePath.join(candidate, "userdata", "game-design");
    if ((await NodeFSP.stat(directory).catch(() => null))?.isDirectory() === true) {
      sourceState = directory;
      break;
    }
  }
  if (sourceState === null)
    throw new Error(
      `No game-design records under --source-home ${input.sourceHome} (looked for userdata/game-design and benchmark-server/userdata/game-design)`,
    );
  const sourceDigest = await gameStateDigest(input.sourceRoot);
  const targetDigest = await gameStateDigest(input.targetRoot);
  const targetDirectory = NodePath.join(input.targetHome, "userdata", "game-design");
  await NodeFSP.mkdir(targetDirectory, { recursive: true });
  let copiedIntent = false;
  for (const suffix of [".intent.json", ".json"] as const) {
    const text = await NodeFSP.readFile(
      NodePath.join(sourceState, `${sourceDigest}${suffix}`),
      "utf8",
    ).catch(() => null);
    if (text === null) continue;
    const record = JSON.parse(text) as Record<string, unknown>;
    // The record is keyed by root, but carries the path too; re-key both so a
    // later read cannot mistake the source game for this copy.
    record.game = input.targetRoot;
    // A copied approval must not carry the source thread's build-dispatch ids;
    // this copy's build turn is dispatched by its own new run.
    if (suffix === ".json") delete record.buildDispatch;
    await NodeFSP.writeFile(
      NodePath.join(targetDirectory, `${targetDigest}${suffix}`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    if (suffix === ".intent.json") copiedIntent = true;
  }
  if (!copiedIntent)
    throw new Error(
      `The source game has no design intent record (${sourceDigest}.intent.json); the copy would open as design-draft and refuse verify`,
    );
};

const dispatchMessage = (client: Client, threadId: ThreadId, text: string) =>
  client[O.dispatchCommand]({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    threadId,
    messageId: MessageId.make(NodeCrypto.randomUUID()),
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  });

/** Git-visible paths and diffs are the fair-pair control: a build-turn edit is recorded. */
const gitStatusOf = async (root: string): Promise<string | null> => {
  try {
    const [status, diff, cached] = await Promise.all([
      exec("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: root,
        timeout: 30_000,
      }),
      exec("git", ["diff", "--stat"], { cwd: root, timeout: 30_000 }),
      exec("git", ["diff", "--cached", "--stat"], { cwd: root, timeout: 30_000 }),
    ]);
    return [status.stdout.trim(), diff.stdout.trim(), cached.stdout.trim()].join("\n");
  } catch {
    return null;
  }
};

const gitStatusDelta = (before: string | null, after: string | null) => {
  if (before === null || after === null) return null;
  const beforeLines = new Set(before.split("\n").filter(Boolean));
  const afterLines = new Set(after.split("\n").filter(Boolean));
  return {
    added: [...afterLines].filter((line) => !beforeLines.has(line)),
    removed: [...beforeLines].filter((line) => !afterLines.has(line)),
  };
};

/**
 * The copy already exists and plays. This asks for the production verification
 * path only: one recorded-route verify, a minimal fix only if a gate fails, and
 * the submit that gives the loop its origin. The critic, repair child, candidate
 * check and ballots remain the server's work, never the builder's claim.
 */
const DEFAULT_EXISTING_REVIEW_REQUEST = `This is an isolated copy of an already generated game. Do not generate a new game, redesign it, or change its verification policy. Preserve its mechanics, art direction and approved DESIGN.md. Exercise the production review path on the existing implementation: read AGENTS.md and game_status, run game_verify once with exactly the recorded input route below (it checks, runs the canonical test, exports Web and records a playtest of those exact bytes), inspect the returned frames, and if the playtest qualifies call game_submit with one line naming what the build is. If a gate fails, make only the smallest source fix needed and run game_verify again with the same route. Do not edit checks, evidence, review records, DESIGN.md, game.json or the route. The server decides review outcomes; do not claim them. Stop after the submit.`;

/**
 * Lifecycle prompts. Each names exactly one tool path so the harness can read
 * the real tool result; none asks the model to judge the outcome.
 */
const LIFECYCLE_CANCEL_PROMPT = `Use game_blender_run now with id cancellation_probe, reset=true, thumbnail=false, and Python script: import time; time.sleep(120). This is an intentional lifecycle cancellation test: the turn will be interrupted while the tool runs. Do not use shell commands, game_verify, game_submit or any other tool. Stop after the call.`;
const lifecycleBreakPrompt = (route: string, viewport: string) =>
  `The game sources now contain a real GDScript syntax error. Run game_verify once with exactly the recorded input route below, inspect its result, and report the failed stage and the file:line it names. Change no files, run no other tool, and stop after reporting. Recorded route (use exactly in game_verify): ${route}\nRecorded viewport: ${viewport}`;
const lifecycleRepairPrompt = (route: string, viewport: string) =>
  `Repair the syntax error the check named: remove exactly those broken lines and change nothing else. Then run game_verify once with exactly the recorded input route below, inspect the returned frames, and if it passes call game_submit with a one-line note naming the repaired build. Report each tool result and stop. Recorded route (use exactly in game_verify): ${route}\nRecorded viewport: ${viewport}`;
const lifecycleStalePrompt = (buildId: string) =>
  `Call game_submit now with buildId ${buildId} exactly and the one-line note "Lifecycle stale-submit probe.". The game sources changed after that build was exported; the server must judge whether it still stands. Do not export, verify, edit, or repair anything. Report the tool's accepted flag, message and checks verbatim and stop.`;

const authenticate = async (origin: string, homeDir: string) => {
  // Mint a fresh, scoped client grant. Never print the credential or pairing URL.
  const { stdout } = await exec(
    process.execPath,
    ["apps/server/src/bin.ts", "pair", "--base-dir", homeDir],
    { cwd: checkout, timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  const match = stdout.match(/Pairing URL:\s*(https?:\/\/\S+)/);
  assert(match?.[1], "pair did not return a pairing URL");
  const pairing = new URL(match[1]);
  const credential = new URLSearchParams(pairing.hash.slice(1)).get("token");
  assert(credential, "pair did not return a token");
  const request = async <T>(endpoint: string, init: RequestInit): Promise<T> => {
    const response = await fetch(new URL(endpoint, origin), {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`${endpoint}: HTTP ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const access = await request<{ access_token: string }>("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Game Studio e2e",
      client_device_type: "desktop",
    }),
  });
  const ticket = await request<{ ticket: string }>("/api/auth/websocket-ticket", {
    method: "POST",
    headers: { Authorization: `Bearer ${access.access_token}` },
  });
  const socket = new URL("/ws", origin);
  socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
  socket.searchParams.set("wsTicket", ticket.ticket);
  socket.searchParams.set(
    ORCHESTRATION_PROTOCOL_QUERY_PARAM,
    String(ORCHESTRATION_PROTOCOL_VERSION),
  );
  timeline(`Authenticated at ${origin}`);
  return socket.toString();
};

/**
 * Providers call MCP tools directly, or wrap them in a code-mode `execute`; a
 * wrapped call only names its tools inside the code. Keep the extracted name as
 * the harness's record of what ran in a turn.
 */
const toolNameOf = (item: OrchestrationV2TurnItem): string => {
  if (item.type !== "dynamic_tool") return item.title ?? "command";
  const code =
    item.toolName === "execute" &&
    typeof (item.input as { code?: unknown } | undefined)?.code === "string"
      ? (item.input as { code: string }).code
      : "";
  // `const G = tools["t3-code-…"]` aliases the MCP namespace before calling.
  const aliases = new Set<string>();
  for (const match of code.matchAll(
    /(?:const|let|var)\s+([\w$]+)\s*=\s*tools(?:\s*\.\s*\w+|\s*\[[^\]]+\])/g,
  ))
    aliases.add(match[1]!);
  const namespace = `tools(?:\\s*\\.\\s*\\w+|\\s*\\[[^\\]]+\\])?${
    aliases.size > 0 ? `|\\b(?:${[...aliases].join("|")})\\b` : ""
  }`;
  const calls = new Set<string>();
  for (const match of code.matchAll(
    new RegExp(`(?:${namespace})\\s*(?:\\.\\s*\\w+\\s*)?\\.\\s*([A-Za-z]\\w*)\\s*\\(`, "g"),
  ))
    calls.add(match[1]!);
  for (const match of code.matchAll(
    new RegExp(
      `(?:${namespace})\\s*(?:\\.\\s*\\w+\\s*)?\\[\\s*["'\`]([\\w/:-]+)["'\`]\\s*\\]\\s*\\(`,
      "g",
    ),
  ))
    calls.add(match[1]!);
  return item.toolName !== null && item.toolName !== "execute"
    ? item.toolName
    : code === ""
      ? (item.title ?? "execute")
      : calls.size > 0
        ? [...calls].join(", ")
        : "execute";
};
interface TurnToolCall {
  readonly name: string;
}

/**
 * Every tool item in one turn. The live projection is a bounded window, so a
 * long turn's early calls can fall out of it; `observed` keeps the items as the
 * thread stream delivered them while the turn ran.
 */
const collectTurnTools = (
  client: Client,
  threadId: ThreadId,
  runId: RunId,
  observed?: ReadonlyMap<string, OrchestrationV2TurnItem>,
): Effect.Effect<ReadonlyArray<TurnToolCall>, HarnessError> =>
  Effect.gen(function* () {
    const projection = yield* client[O.getThreadProjection]({ threadId });
    const items = new Map<string, OrchestrationV2TurnItem>(observed);
    for (const item of projection.turnItems) items.set(item.id, item);
    const calls: TurnToolCall[] = [];
    for (const item of items.values()) {
      if (item.runId !== runId) continue;
      if (item.type !== "dynamic_tool" && item.type !== "command_execution") continue;
      calls.push({ name: toolNameOf(item) });
    }
    return calls;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new HarnessError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    ),
  );

const logTurnTools = (label: string, calls: ReadonlyArray<TurnToolCall>) => {
  const counts = new Map<string, number>();
  for (const call of calls)
    for (const name of call.name
      .split(", ")
      .map((part) => part.trim())
      .filter(Boolean))
      counts.set(name, (counts.get(name) ?? 0) + 1);
  const summary = [...counts].map(([name, count]) => `${name} x${count}`).join(", ");
  timeline(`${label} tools: ${summary === "" ? "none" : summary}`);
};
const stageSummary = (status: GameStatus) =>
  status.qualification.stages.map((stage) => `${stage.stage}=${stage.status}`).join(", ");

/**
 * The actual tool results for one turn, never the model's prose. An output
 * the projection withheld is fetched through getTurnItem; a result that still
 * cannot be read stays `undefined` so the caller fails on it explicitly.
 */
const toolOutputsForRun = (
  client: Client,
  threadId: ThreadId,
  runId: RunId,
  observed: ReadonlyMap<string, OrchestrationV2TurnItem>,
): Effect.Effect<ReadonlyArray<{ name: string; output: unknown }>, HarnessError> =>
  Effect.gen(function* () {
    const projection = yield* client[O.getThreadProjection]({ threadId });
    const items = new Map<string, OrchestrationV2TurnItem>(observed);
    for (const item of projection.turnItems) items.set(item.id, item);
    const outputs: { name: string; output: unknown }[] = [];
    for (const item of items.values()) {
      if (item.runId !== runId || item.type !== "dynamic_tool") continue;
      let output: unknown = item.output;
      if (output === undefined) {
        const full = yield* client[O.getTurnItem]({ threadId, itemId: item.id }).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (full?.item !== null && full?.item !== undefined && full.item.type === "dynamic_tool")
          output = full.item.output;
      }
      outputs.push({ name: toolNameOf(item), output });
    }
    return outputs;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new HarnessError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    ),
  );

/** Proof a cancelled turn actually stopped a running headless tool. */
interface TurnCancelProof {
  readonly tool: string;
  readonly itemId: string;
  readonly processes: ReadonlyArray<{ readonly pid: number; readonly operation: string }>;
}

const waitForTurn = (
  client: Client,
  threadId: ThreadId,
  previous: ReadonlySet<RunId>,
  options: {
    cancel?: boolean;
    /**
     * Which running tool to cancel. The default keeps the creation-mode probe;
     * the lifecycle cancel names its exact tool instead of any `game_` prefix.
     */
    cancelMatch?: RegExp;
    /**
     * When set, the interrupt waits until `game.status` lists a tracked
     * process: cancelling before the tool's process starts (or after its
     * result) proves nothing, so the waiter observes the process first, hands
     * it to `onCancelProof`, and only then interrupts through orchestration.
     */
    awaitTrackedProcess?: { timeoutMs?: number };
    onCancelProof?: (proof: TurnCancelProof) => void;
    observed?: Map<string, OrchestrationV2TurnItem>;
    observedRuns?: Set<RunId>;
    onReady?: () => Effect.Effect<unknown, Error>;
    onRun?: (run: OrchestrationV2Run) => void;
  } = {},
) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<OrchestrationV2Run, HarnessError>();
    const seen = new Map<string, string>();
    let target: RunId | undefined;
    let armed = false;
    let interrupted = false;
    let cancelProof: TurnCancelProof | null = null;
    const observeRun = (run: OrchestrationV2Run) =>
      Effect.gen(function* () {
        options.observedRuns?.add(run.id);
        if (previous.has(run.id)) return;
        target ??= run.id;
        if (run.id !== target) return;
        options.onRun?.(run);
        if (terminal.has(run.status)) yield* Deferred.succeed(done, run);
      });
    const observeTool = (item: OrchestrationV2TurnItem) =>
      Effect.gen(function* () {
        if (item.runId && previous.has(item.runId)) return;
        options.observed?.set(item.id, item);
        if (item.type !== "dynamic_tool" && item.type !== "command_execution") return;
        const name = toolNameOf(item);
        if (seen.get(item.id) !== item.status) {
          seen.set(item.id, item.status);
          timeline(`${name}: ${item.status}`);
        }
        if (
          options.cancel &&
          !armed &&
          item.status === "running" &&
          (options.cancelMatch ?? /game_/).test(name)
        ) {
          assert(item.runId, "Game tool has no run ID");
          armed = true;
          if (options.awaitTrackedProcess !== undefined) {
            const deadline = Date.now() + (options.awaitTrackedProcess.timeoutMs ?? 120_000);
            let tracked: GameStatus["processes"] | null = null;
            while (tracked === null) {
              if (Date.now() >= deadline)
                throw new HarnessError({
                  message: `Turn showed ${name} running but gameStatus never listed a tracked process; the tool may have finished before its process started. Cancellation was not exercised.`,
                  cause: null,
                });
              yield* Effect.sleep(Duration.millis(1000));
              const status = yield* client[WS_METHODS.gameStatus]({ threadId }).pipe(
                Effect.orElseSucceed(() => null),
              );
              if (status !== null && status.processes.length > 0) tracked = status.processes;
            }
            cancelProof = {
              tool: name,
              itemId: item.id,
              processes: tracked.map((entry) => ({ pid: entry.pid, operation: entry.operation })),
            };
            options.onCancelProof?.(cancelProof);
            timeline(
              `Cancelling after tracked process started: ${tracked.map((entry) => `${entry.operation} pid ${entry.pid}`).join(", ")}`,
            );
          } else timeline("Interrupting turn during game tool");
          interrupted = true;
          yield* client[O.dispatchCommand]({
            type: "run.interrupt",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
            runId: item.runId,
            reason: "e2e cancellation test",
          });
        }
      });
    const ready = yield* Deferred.make<void, HarnessError>();
    const subscriber = yield* client[O.subscribeThread]({
      threadId,
      requestCompletionMarker: true,
    }).pipe(
      (entries) =>
        runTurnSubscription({
          entries,
          onEntry: (entry) =>
            Effect.gen(function* () {
              if (entry.kind === "snapshot") {
                for (const item of entry.projection.turnItems) yield* observeTool(item);
                for (const run of entry.projection.runs) yield* observeRun(run);
                yield* Deferred.succeed(ready, undefined);
              } else if (entry.kind === "synchronized") yield* Deferred.succeed(ready, undefined);
              else if (entry.kind === "event") {
                if (entry.event.type === "turn-item.updated")
                  yield* observeTool(entry.event.payload);
                else if (entry.event.type === "run.created" || entry.event.type === "run.updated")
                  yield* observeRun(entry.event.payload);
              }
            }),
          ready,
          done,
          failure: toError,
          closedBeforeReady: `The thread subscription closed before its snapshot for ${threadId}.`,
          closedBeforeDone: `The thread subscription closed before turn ${threadId} finished.`,
        }),
      Effect.forkChild,
    );
    try {
      yield* Deferred.await(ready);
      if (options.onReady) yield* options.onReady();
      const run = yield* Deferred.await(done);
      timeline(`Turn ${run.id}: ${run.status}`);
      if (options.cancel === true && options.awaitTrackedProcess !== undefined) {
        // A cancel that never saw a tracked process is not a pass, even when
        // the run itself ended interrupted for another reason.
        assert(
          cancelProof !== null && run.status === "interrupted",
          cancelProof === null
            ? `Turn ended ${run.status} without ever showing a tracked process; cancellation was not exercised`
            : `Turn ended ${run.status} after the interrupt was dispatched; expected interrupted`,
        );
      } else
        assert(
          options.cancel ? interrupted && run.status === "interrupted" : run.status === "completed",
          `Turn ended ${run.status}${options.cancel && !interrupted ? " without exercising cancellation" : ""}`,
        );
      return run;
    } finally {
      yield* Fiber.interrupt(subscriber);
    }
  });

/** Wall time and fate per turn, so a slow build is visible in the results table. */
const timedTurn = <A, E>(name: string, run: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const startedTurn = Date.now();
    const exit = yield* Effect.exit(run);
    turns.push({
      name,
      status: exit._tag === "Success" ? "completed" : "failed",
      durationMs: Date.now() - startedTurn,
    });
    if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause);
    return exit.value;
  });

const printStatus = (status: GameStatus) => {
  console.log(
    JSON.stringify(
      {
        assets: status.assets,
        scenes: status.scenes,
        builds: status.builds,
        processes: status.processes,
      },
      null,
      2,
    ),
  );
};
const revisionSnapshot = async (root: string) => {
  const manifest = JSON.parse(await NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"));
  // Read GLB POSITION accessor bounds so this works for assets produced outside the wrapper too.
  const assets = await Promise.all(
    manifest.assets.map(async (asset: { id: string; export: string; updatedAt: string }) => {
      const bytes = await NodeFSP.readFile(NodePath.join(root, asset.export));
      const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
      const positions =
        gltf.meshes?.flatMap((mesh: { primitives: { attributes: { POSITION: number } }[] }) =>
          mesh.primitives.map((primitive) => gltf.accessors[primitive.attributes.POSITION]),
        ) ?? [];
      return {
        id: asset.id,
        export: asset.export,
        updatedAt: asset.updatedAt,
        bounds: positions.map((accessor: { min: number[]; max: number[] }) => ({
          min: accessor.min,
          max: accessor.max,
          dimensions: accessor.max.map((value, i) => value - accessor.min[i]!),
        })),
      };
    }),
  );
  return assets;
};
/** The design turn's bar, shared with the server so both agree on approvability. */
const assertDesignFilled = (skeleton: string, design: string) => {
  const validation = validateDesignDocument({ design, skeleton });
  assert(
    validation.issues.length === 0,
    `DESIGN.md is not approvable:\n${validation.issues.join("\n")}`,
  );
};

const filesUnder = async (directory: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (current: string) => {
    const entries = await NodeFSP.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = NodePath.join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(NodePath.relative(directory, path));
    }
  };
  await walk(directory);
  return found;
};

let gameRoot: string | undefined;
const main = Effect.gen(function* () {
  if (existingMode) {
    const copyStartedAt = Date.now();
    const copied = yield* promise(() => copyExistingGame(existingGamePath!, values["game-copy"]!));
    existingSource = copied.source;
    existingCopy = copied.copy;
    existingSourceHome = NodePath.resolve(values["source-home"]!);
    gameName = copied.name;
    gameRoot = copied.copy;
    // The source home is only read. The copy's own fresh home gets re-keyed
    // design intent and approval, so the game opens approved without touching
    // the original's records.
    yield* promise(() =>
      copyDesignRecords({
        sourceHome: existingSourceHome!,
        targetHome: serverHome,
        sourceRoot: existingSource!,
        targetRoot: existingCopy!,
      }),
    );
    timeline(
      "Copied design intent/approval only; old selected build, game-rounds, qualification, snapshots and loop records were not copied. The verify/submit turn creates this copy's new build records.",
    );
    copyDurationMs = Date.now() - copyStartedAt;
    timeline(
      `Copied ${existingSource} to ${existingCopy} (${gameName}) in ${(copyDurationMs / 1000).toFixed(1)}s`,
    );
  }
  // Without --url the runner owns a private server under the display sandbox.
  // Its home is a subdirectory so an operator's live server in the same
  // checkout is neither reused nor overwritten.
  const server =
    externalServerUrl === null
      ? yield* promise(() =>
          startBenchmarkServer({
            checkout,
            homeDir: serverHome,
            sandbox: displaySandbox,
            logPath: NodePath.join(serverHome, "server.log"),
            provider: values.provider,
          }),
        )
      : null;
  yield* Effect.addFinalizer(() => promise(async () => server?.stop()).pipe(Effect.ignore));
  const origin = externalServerUrl ?? server!.url;
  const pairingHome =
    externalServerUrl === null ? serverHome : NodePath.resolve(values["home-dir"]);
  // Bounded transport recovery for observation reads during a known run/review.
  // Same thread/run/loop/source identity, same overall deadline; mutations are
  // never retried. A failed reconnect aborts with its own cause.
  //
  // The transport owns at most one live socket/protocol/client: each build runs
  // in its own child scope via the shared observation glue, and a reconnect
  // closes the replaced scope promptly instead of leaking it until the parent
  // scope ends. Leaving this scope (or interrupting it) closes current.
  let transportOutages = 0;
  let lastObservedLoop: GameRepairLoop | null = null;
  const observationScope = yield* Effect.scope;
  const transport = yield* makeOwnedObservationTransport((scope) =>
    Effect.gen(function* () {
      const freshUrl = yield* promise(() => authenticate(origin, pairingHome));
      const freshContext = yield* Layer.buildWithScope(observationProtocolLayer(freshUrl), scope);
      return yield* makeClient.pipe(Effect.provide(freshContext));
    }),
  );
  let client = yield* transport.current;
  const reconnectTransport = Effect.gen(function* () {
    transportOutages += 1;
    timeline(
      `transport outage ${transportOutages}: reconnecting observation transport (same thread/run/loop; mutations never replayed)`,
    );
    yield* transport.reconnect;
    client = yield* transport.current;
  }).pipe(Effect.provideService(Scope.Scope, observationScope));
  const created = existingMode
    ? yield* client[WS_METHODS.gameOpen]({
        path: existingCopy!,
        modelSelection,
      })
    : yield* client[WS_METHODS.gameCreate]({
        name: gameName,
        parentDirectory: NodePath.resolve(values["parent-dir"]),
        template: template!,
        brief: briefText,
        artDirection,
        planFirst,
        ...(reviewDesign ? { reviewDesign: true } : {}),
        modelSelection,
        runtimeMode: "full-access",
        ...(minimalBuilder ? { builder: "minimal" as const } : {}),
      });
  gameRoot = created.root;
  gameInfo = { name: gameName, root: created.root, threadId: created.threadId };
  summaryPhase = existingMode ? "open" : reviewDesign ? "design" : "build";
  console.log(`Game root: ${created.root}`);
  console.log(`Thread: ${created.threadId}`);
  // The live projection only keeps a bounded recent window; keep every item the
  // thread stream reports so long turns still have a complete tool timeline.
  const observedTurnItems = new Map<string, OrchestrationV2TurnItem>();
  const observedRunIds = new Set<RunId>();
  // Resilient observation reads for the review wait. Same thread/run/loop
  // identity, same overall deadline; a reconnect never replays a mutation.
  const resilientReviewStatus = () =>
    retryObservationRead(
      () =>
        client[WS_METHODS.gameReviewStatus]({ threadId: created.threadId }).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result.loop !== null) lastObservedLoop = result.loop;
            }),
          ),
        ),
      () => reconnectTransport,
      {
        maxAttempts: DEFAULT_OBSERVATION_MAX_ATTEMPTS,
        retryDelayMs: DEFAULT_OBSERVATION_RETRY_DELAY_MS,
        deadlineMs: timeoutDeadlineMs,
        deadlineReserveMs: timeoutReserveMs,
        onOutage: (info) =>
          Effect.sync(() =>
            timeline(
              `observation read transport loss (attempt ${info.attempt}): retrying with a fresh transport`,
            ),
          ),
      },
    );
  const resilientReviewHistory = () =>
    retryObservationRead(
      () => client[WS_METHODS.gameReviewHistory]({ threadId: created.threadId, limit: 20 }),
      () => reconnectTransport,
      {
        maxAttempts: DEFAULT_OBSERVATION_MAX_ATTEMPTS,
        retryDelayMs: DEFAULT_OBSERVATION_RETRY_DELAY_MS,
        deadlineMs: timeoutDeadlineMs,
        deadlineReserveMs: timeoutReserveMs,
        onOutage: (info) =>
          Effect.sync(() =>
            timeline(
              `observation history transport loss (attempt ${info.attempt}): retrying with a fresh transport`,
            ),
          ),
      },
    );
  const resilientGameStatus = () =>
    retryObservationRead(
      () => client[WS_METHODS.gameStatus]({ threadId: created.threadId }),
      () => reconnectTransport,
      {
        maxAttempts: DEFAULT_OBSERVATION_MAX_ATTEMPTS,
        retryDelayMs: DEFAULT_OBSERVATION_RETRY_DELAY_MS,
        deadlineMs: timeoutDeadlineMs,
        deadlineReserveMs: timeoutReserveMs,
        onOutage: (info) =>
          Effect.sync(() =>
            timeline(
              `observation status transport loss (attempt ${info.attempt}): retrying with a fresh transport`,
            ),
          ),
      },
    );
  const preserveLastLoopOnTransportFailure = () =>
    Effect.sync(() => {
      if (reviewLoop !== null || lastObservedLoop === null) return;
      const last = lastObservedLoop;
      reviewLoop = {
        id: last.id,
        status: last.status,
        decision: last.decision ?? null,
        reason: last.reason ?? null,
        startedAt: last.startedAt,
        finishedAt: last.finishedAt ?? null,
        repairsUsed: last.repairsUsed ?? 0,
        budget: last.budget,
        rounds: [],
        selectedBuildId: null,
        waitedMs: Date.now() - started,
        timedOut: false,
        timedOutBy: null,
      };
      timeline(
        `preserved last observed review loop ${last.id} (${last.status}) in the summary after transport failure`,
      );
    });
  const resilientGameReviewStatusChecked = () =>
    retryObservationRead(
      () =>
        client[WS_METHODS.gameReviewStatus]({
          threadId: created.threadId,
          checkSelectedBuild: true,
        }),
      () => reconnectTransport,
      {
        maxAttempts: DEFAULT_OBSERVATION_MAX_ATTEMPTS,
        retryDelayMs: DEFAULT_OBSERVATION_RETRY_DELAY_MS,
        deadlineMs: timeoutDeadlineMs,
        deadlineReserveMs: timeoutReserveMs,
        onOutage: (info) =>
          Effect.sync(() =>
            timeline(
              `observation review transport loss (attempt ${info.attempt}): retrying with a fresh transport`,
            ),
          ),
      },
    );
  yield* Effect.addFinalizer(() =>
    client[WS_METHODS.gameAction]({ threadId: created.threadId, action: "stop" }).pipe(
      Effect.ignore,
    ),
  );
  // `--timeout-ms` interrupts the scoped run. Stop the review loop and its
  // owned child first, then let the server finalizer kill the process group;
  // the normal completed path is already clean and skips this.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (summaryPhase === "done" && !summaryTimedOut && summaryError === null) return;
      yield* client[WS_METHODS.gameReviewStop]({ threadId: created.threadId }).pipe(
        Effect.timeoutOption("10 seconds"),
        Effect.ignore,
      );
      const projection = yield* client[O.getThreadProjection]({ threadId: created.threadId }).pipe(
        Effect.timeoutOption("10 seconds"),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(projection)) {
        for (const run of projection.value.runs) {
          if (terminal.has(run.status)) continue;
          yield* client[O.dispatchCommand]({
            type: "run.interrupt",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: created.threadId,
            runId: run.id,
            reason: "e2e timeout cleanup",
          }).pipe(Effect.timeoutOption("5 seconds"), Effect.ignore);
        }
      }
    }).pipe(Effect.uninterruptible),
  );
  /**
   * The loop opens from the turn's completion event, and a repair may move the
   * sources while it runs. Wait for it before reading completion, so the gate
   * below sees the final selected build instead of a mid-repair snapshot. The
   * loop's own budget plus a shutdown margin bounds that wait, and so does the
   * caller's `--timeout-ms`; the waiter stops early enough to record the build.
   */
  const watchReviewLoop = (label: string, turn: OrchestrationV2Run) =>
    Effect.gen(function* () {
      const watched = yield* watchRepairLoop({
        status: resilientReviewStatus(),
        history: resilientReviewHistory(),
        // A stopped loop from the previous build turn is still the newest
        // record until this turn's reactor opens its own.
        forRunId: turn.id,
        deadlineMs: timeoutDeadlineMs,
        deadlineReserveMs: timeoutReserveMs,
        onWait: (message) => timeline(`${label}: ${message}`),
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* preserveLastLoopOnTransportFailure();
            if (transportOutages > 0)
              timeline(
                `${label}: observation transport had ${transportOutages} outage(s); failing with last observed loop preserved`,
              );
            return yield* Effect.fail(error);
          }),
        ),
      );
      if (watched === null) {
        timeline(`${label}: no review loop started`);
        return null;
      }
      const decision =
        watched.loop.decision === null
          ? "no decision"
          : `${watched.loop.decision}${watched.loop.reason === null ? "" : `: ${watched.loop.reason}`}`;
      timeline(
        `${label}: review loop ${watched.loop.id} ${
          watched.timedOut
            ? `still running at ${watched.timedOutBy === "harness-deadline" ? "the run timeout" : "its budget bound"}`
            : `ended ${watched.loop.status}`
        } (${decision}), ${watched.rounds.length} round(s), ${Math.round(watched.waitedMs / 1000)}s`,
      );
      return watched;
    });
  const requireReviewEvidence = (loopId: string) =>
    Effect.gen(function* () {
      const history = yield* resilientReviewHistory();
      const entries = history.rounds.filter((entry) => entry.round.loopId === loopId);
      assert(
        hasCompleteReviewEvidence(
          entries.map((entry) => entry.round),
          entries.flatMap((entry) =>
            entry.evidence.map((ref) => ({
              roundId: entry.round.id,
              role: ref.role,
              order: ref.order,
            })),
          ),
        ),
        `${REVIEW_INCOMPLETE_PREFIX}Review loop ${loopId} did not record complete judgment evidence.`,
      );
    });
  if (existingMode) {
    // A fresh private home plus a fresh copy must give this run a new thread,
    // node and model selection. If gameOpen resumed anything, the old node and
    // its selection would contaminate the comparison.
    const initial = yield* client[O.getThreadProjection]({ threadId: created.threadId });
    assert(
      initial.runs.length === 0,
      `gameOpen resumed ${initial.runs.length} existing run(s) on the copy; use a fresh --home-dir so the review starts from a new node and run`,
    );
    assert(
      selectionIsRequested(initial.thread.modelSelection),
      `gameOpen opened the copy with ${JSON.stringify(initial.thread.modelSelection)} instead of ${values.provider}/${values.model} (${reasoningOptionId}=${values["reasoning-effort"]})`,
    );
    // The review loop opens only from a completed builder turn that exported
    // and playtested. The source game already has that route; replaying it
    // verifies the copied sources and gives the loop its frozen inputs without
    // asking the model to invent a new game or a new route.
    const before = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      before.design.state === "approved" ||
        before.design.state === "legacy" ||
        before.design.autoRevision !== undefined,
      `The copied game opened as design-${before.design.state}; verify would refuse before the review could run. Check --source-home.`,
    );
    const route = before.lastPlaytest?.steps ?? [];
    assert(
      route.length > 0,
      "The copied game's newest playtest has no recorded input route, so the review loop would have nothing to replay. Run the source game's playtest first or use a game with one.",
    );
    existingRouteSteps = route.length;
    timeline(`Recorded route: ${route.length} step(s)`);
    sourceStatusBefore = yield* promise(() => gitStatusOf(existingCopy!));
    sourceBytesBefore = yield* GameSnapshots.GameSnapshots.use((snapshots) =>
      snapshots.capture(existingCopy!),
    ).pipe(
      Effect.map((snapshot) => snapshot.sourceId),
      Effect.provide(GameSnapshots.layer({ stateDir: NodeOS.tmpdir() })),
    );
    const request = `${values["review-request"] ?? DEFAULT_EXISTING_REVIEW_REQUEST}\n\nRecorded route (use exactly in game_verify): ${JSON.stringify(route)}\nRecorded viewport: ${JSON.stringify(before.lastPlaytest?.viewport ?? null)}`;
    summaryPhase = "review-request";
    const requestRun = yield* timedTurn(
      "review-request",
      waitForTurn(client, created.threadId, new Set(), {
        observed: observedTurnItems,
        observedRuns: observedRunIds,
        onReady: () => dispatchMessage(client, created.threadId, request),
        onRun: (run) => {
          existingBuilder = {
            ...existingBuilder,
            runId: String(run.id),
            status: run.status,
          };
        },
      }),
    );
    const requestCalls = yield* collectTurnTools(
      client,
      created.threadId,
      requestRun.id,
      observedTurnItems,
    );
    sourceStatusAfter = yield* promise(() => gitStatusOf(existingCopy!));
    const sourceBytesAfter = yield* GameSnapshots.GameSnapshots.use((snapshots) =>
      snapshots.capture(existingCopy!),
    ).pipe(
      Effect.map((snapshot) => snapshot.sourceId),
      Effect.provide(GameSnapshots.layer({ stateDir: NodeOS.tmpdir() })),
    );
    const sourceDelta = gitStatusDelta(sourceStatusBefore, sourceStatusAfter);
    existingBuilder = {
      runId: String(requestRun.id),
      status: requestRun.status,
      durationMs: turns.find((turn) => turn.name === "review-request")?.durationMs ?? null,
      selectionMatches: selectionIsRequested(requestRun.modelSelection),
      toolCalls: requestCalls,
      sourceChanged:
        sourceDelta === null
          ? null
          : sourceDelta.added.length > 0 || sourceDelta.removed.length > 0,
      sourceDelta,
      sourceBytesChanged: sourceBytesBefore !== sourceBytesAfter,
    };
    logTurnTools("review request", requestCalls);
    if (sourceDelta !== null)
      timeline(
        `Builder git delta: ${sourceDelta.added.length} added, ${sourceDelta.removed.length} removed snapshot line(s)${existingBuilder.sourceChanged ? "" : " (no source edit)"}`,
      );
    assert(
      existingBuilder.selectionMatches,
      `The builder turn did not run ${values.provider}/${values.model} with ${reasoningOptionId}=${values["reasoning-effort"]}: ${JSON.stringify(requestRun.modelSelection)}`,
    );
    const submitted = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    recordStatus(submitted);
    recordProduction(submitted, requestRun);
    summaryPhase = "review";
    const buildLoop = yield* watchReviewLoop("after the review request", requestRun);
    liveTimedOut = buildLoop?.timedOut === true;
    if (buildLoop?.timedOutBy === "harness-deadline") summaryTimedOut = true;
    const after = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    recordStatus(after);
    recordProduction(after, requestRun);
    liveSelectedBuildId = after.selectedBuildId;
    if (buildLoop !== null)
      reviewLoop = summarizeRepairLoop({
        watched: buildLoop,
        selectedBuildId: after.selectedBuildId,
      });
    review = yield* client[WS_METHODS.gameReviewStatus]({
      threadId: created.threadId,
      checkSelectedBuild: true,
    });
    if (buildLoop !== null) liveLoop = review.loop ?? null;
    liveSelectedBuildFacts = review.selectedBuildFacts ?? null;
    liveReviewPhase = review.phase;
    const history = yield* client[WS_METHODS.gameReviewHistory]({
      threadId: created.threadId,
      limit: 20,
    });
    const loopId = buildLoop?.loop.id ?? null;
    liveRounds = history.rounds
      .map((entry) => entry.round)
      .filter((round) => loopId !== null && round.loopId === loopId);
    liveRoundEvidence = history.rounds.flatMap((entry) =>
      entry.evidence.map((ref) => ({
        roundId: entry.round.id,
        role: ref.role,
        order: ref.order,
      })),
    );
    captureLiveEvidence();
    const evidenceReview = liveEvidence?.review ?? null;
    if (evidenceReview !== null)
      timeline(
        `Review evidence: outcome=${evidenceReview.outcome}, judged=${evidenceReview.coverage.judgedRounds}, promoted=${evidenceReview.coverage.promotedRounds.length}, vetoed=${evidenceReview.coverage.vetoedRounds.length}, repairs=${evidenceReview.attempts.repairsUsed}/${evidenceReview.attempts.repairsBudget}, complete=${String(evidenceReview.evidenceComplete)}`,
      );
    if (review.loop !== null)
      assert(
        selectionIsRequested(review.loop.builderSelection) &&
          selectionIsRequested(review.loop.reviewSelection),
        `The review loop did not freeze ${values.provider}/${values.model} with ${reasoningOptionId}=${values["reasoning-effort"]} for the builder and review children: ${JSON.stringify({ builder: review.loop.builderSelection, review: review.loop.reviewSelection })}`,
      );
    if (buildLoop === null)
      throw new HarnessError({
        message:
          "The review request completed but opened no review loop for its run. The summary records the submitted build and review state.",
        cause: null,
      });
    if (buildLoop.timedOutBy === "harness-deadline")
      throw new HarnessError({
        message: `The run timeout (${Math.round(timeoutMs / 60_000)} minute(s)) ended during review loop ${buildLoop.loop.id}; it was still running after ${Math.round(
          buildLoop.waitedMs / 60_000,
        )} minute(s). The summary records the submitted build and the review state observed so far.`,
        cause: null,
      });
    // A loop still running at its own bound has no terminal decision. Never
    // call that a pass just because a completed earlier round looks complete.
    if (buildLoop.timedOut)
      throw new HarnessError({
        message: `Review loop ${buildLoop.loop.id} was still running when its ${buildLoop.timedOutBy === "loop-budget" ? "budget plus shutdown margin" : "observed bound"} ended after ${Math.round(
          buildLoop.waitedMs / 60_000,
        )} minute(s); the selected build is kept. The summary records the observed rounds.`,
        cause: null,
      });
    assertSelectedBuildComplete("after the review", after, review.selectedBuildFacts ?? null);
    assert(
      liveEvidence?.review?.evidenceComplete === true,
      `${REVIEW_INCOMPLETE_PREFIX}The review loop did not record complete evidence for a judged round: ${JSON.stringify(liveEvidence?.review?.coverage ?? null)}. The summary records what exists.`,
    );
    if (values["exercise-lifecycle"] === true) {
      // Post-selection lifecycle, cheapest first. Cancel proves interruption
      // and admission recovery (the break turn is its next turn); break and
      // repair prove a real gate failure and its recovery through a new review;
      // the stale submit runs last because a refusal opens no loop.
      const lifecycleSend = (text: string) => dispatchMessage(client, created.threadId, text);
      const lifecycleTurn = (
        name: string,
        text: string,
        turnOptions?: {
          cancel?: boolean;
          cancelMatch?: RegExp;
          awaitTrackedProcess?: { timeoutMs?: number };
          onCancelProof?: (proof: TurnCancelProof) => void;
        },
      ) =>
        timedTurn(
          name,
          waitForTurn(client, created.threadId, new Set(observedRunIds), {
            ...turnOptions,
            observed: observedTurnItems,
            observedRuns: observedRunIds,
            onReady: () => lifecycleSend(text),
          }),
        );
      const submitFactsOf = (outputs: ReadonlyArray<{ name: string; output: unknown }>) =>
        outputs
          .filter((entry) =>
            entry.name
              .split(", ")
              .map((part) => part.trim())
              .includes("game_submit"),
          )
          .map((entry) => parseSubmitToolOutput(entry.output));
      const verifyFactsOf = (outputs: ReadonlyArray<{ name: string; output: unknown }>) =>
        outputs
          .filter((entry) =>
            entry.name
              .split(", ")
              .map((part) => part.trim())
              .includes("game_verify"),
          )
          .map((entry) => parseVerifyToolOutput(entry.output));
      const artifactFileUsable = (directory: string | null | undefined) =>
        promise(async () => {
          if (directory === null || directory === undefined || directory === "") return false;
          try {
            const stat = await NodeFSP.stat(NodePath.join(existingCopy!, directory, "index.html"));
            return stat.isFile() && stat.size > 0;
          } catch {
            return false;
          }
        });

      summaryPhase = "lifecycle-cancel";
      const cancelBefore = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
      assert(
        cancelBefore.processes.length === 0,
        `Lifecycle cancel started with tracked processes: ${JSON.stringify(cancelBefore.processes)}`,
      );
      assert(
        cancelBefore.selectedBuildId !== null,
        "Lifecycle cancel started with no selected build",
      );
      const cancelProofHolder: { proof: TurnCancelProof | null } = { proof: null };
      const cancelRun = yield* lifecycleTurn("lifecycle-cancel", LIFECYCLE_CANCEL_PROMPT, {
        cancel: true,
        cancelMatch: /game_blender_run/,
        awaitTrackedProcess: { timeoutMs: 120_000 },
        onCancelProof: (proof) => {
          cancelProofHolder.proof = proof;
        },
      });
      logTurnTools(
        "lifecycle-cancel",
        yield* collectTurnTools(client, created.threadId, cancelRun.id, observedTurnItems),
      );
      const cancelAfter = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
      const observedProof = cancelProofHolder.proof;
      assert(
        observedProof !== null,
        "Lifecycle cancel observed no tracked process; waitForTurn should have failed first",
      );
      assert(
        cancelAfter.processes.length === 0,
        `Cancellation leaked processes: ${JSON.stringify(cancelAfter.processes)}`,
      );
      yield* promise(async () => {
        for (const tracked of observedProof.processes) {
          try {
            process.kill(tracked.pid, 0);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ESRCH") continue;
            throw cause;
          }
          throw new Error(`Cancelled tool PID ${tracked.pid} is still alive`);
        }
      });
      assert(
        cancelAfter.selectedBuildId === cancelBefore.selectedBuildId,
        `Cancellation changed the selected build ${cancelBefore.selectedBuildId} -> ${cancelAfter.selectedBuildId}`,
      );
      lifecycleCancel = {
        tool: observedProof.tool,
        processObserved: {
          pid: observedProof.processes[0]!.pid,
          operation: observedProof.processes[0]!.operation,
        },
        runInterrupted: cancelRun.status === "interrupted",
        processesEmptyAfter: cancelAfter.processes.length === 0,
        selectedUnchanged: cancelAfter.selectedBuildId === cancelBefore.selectedBuildId,
      };
      timeline(
        `Lifecycle cancel: ${observedProof.tool} ${observedProof.processes[0]!.operation} pid ${observedProof.processes[0]!.pid} interrupted, no processes remain, selection unchanged`,
      );

      summaryPhase = "lifecycle-break";
      const gdRelatives = yield* promise(async () => {
        const found: string[] = [];
        const walk = async (directory: string, prefix: string): Promise<void> => {
          for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
            const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) await walk(NodePath.join(directory, entry.name), relative);
            else if (relative.endsWith(".gd")) found.push(`godot/${relative}`);
          }
        };
        await walk(NodePath.join(existingCopy!, "godot"), "");
        return found;
      });
      const breakScript = pickLifecycleScript(gdRelatives);
      const breakPath = NodePath.join(existingCopy!, breakScript);
      yield* promise(() => NodeFSP.appendFile(breakPath, `\n${LIFECYCLE_SYNTAX_DEFECT}`));
      timeline(`Lifecycle break: appended a syntax defect to ${breakScript}`);
      const breakRun = yield* lifecycleTurn(
        "lifecycle-break",
        lifecycleBreakPrompt(
          JSON.stringify(route),
          JSON.stringify(before.lastPlaytest?.viewport ?? null),
        ),
      );
      logTurnTools(
        "lifecycle-break",
        yield* collectTurnTools(client, created.threadId, breakRun.id, observedTurnItems),
      );
      const breakOutputs = yield* toolOutputsForRun(
        client,
        created.threadId,
        breakRun.id,
        observedTurnItems,
      );
      const breakVerifies = verifyFactsOf(breakOutputs);
      assert(
        breakVerifies.length > 0,
        `Lifecycle break turn ran no game_verify; tools: ${breakOutputs.map((entry) => entry.name).join(", ") || "none"}`,
      );
      for (const facts of breakVerifies) {
        assert(
          facts !== null,
          "Lifecycle break turn's game_verify result was unreadable; refusing to grade it",
        );
        assert(
          facts.success === false,
          `Broken sources verified as a pass; no false PASS is allowed: ${JSON.stringify(facts)}`,
        );
      }
      const breakFailure = breakVerifies[0]!;
      assert(
        breakFailure.failedStage === "check",
        `Expected the check stage to stop the broken verify, got ${breakFailure.failedStage ?? "none"}`,
      );
      assert(
        breakFailure.checkOk === false && breakFailure.checkErrors.length > 0,
        "The broken verify surfaced no check error",
      );
      assert(
        !breakFailure.hasBuild && !breakFailure.hasPlaytest,
        "The broken verify recorded a build or playtest; no false PASS is allowed",
      );
      const brokenBytes = yield* promise(() => NodeFSP.readFile(breakPath, "utf8"));
      assert(
        brokenBytes.includes(LIFECYCLE_SYNTAX_DEFECT.trim()),
        "The lifecycle break turn changed the broken file; it was told to change nothing",
      );
      const breakStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
      const breakUsableFs = yield* artifactFileUsable(review.selectedBuildFacts?.directory);
      assert(
        breakStatus.selectedBuildId === liveSelectedBuildId,
        `The syntax failure lost the selected build ${liveSelectedBuildId} -> ${breakStatus.selectedBuildId}`,
      );
      assert(
        breakStatus.selectedArtifactUsable === true && breakUsableFs,
        `The syntax failure lost the old artifact: usable=${String(breakStatus.selectedArtifactUsable)} files=${String(breakUsableFs)}`,
      );
      const firstError = breakFailure.checkErrors[0]!;
      lifecycleSyntax = {
        script: breakScript,
        failedStage: breakFailure.failedStage,
        checkErrors: breakFailure.checkErrors.length,
        firstError:
          `${firstError.file ?? "?"}:${firstError.line ?? "?"} ${firstError.message}`.slice(0, 200),
        falsePass: false,
        selectedHeld: true,
        repaired: false,
        submittedBuildId: null,
        recovery: null,
      };
      timeline(`Lifecycle break: check failed as ${lifecycleSyntax.firstError}; selection held`);

      summaryPhase = "lifecycle-repair";
      const repairRun = yield* lifecycleTurn(
        "lifecycle-repair",
        lifecycleRepairPrompt(
          JSON.stringify(route),
          JSON.stringify(before.lastPlaytest?.viewport ?? null),
        ),
      );
      logTurnTools(
        "lifecycle-repair",
        yield* collectTurnTools(client, created.threadId, repairRun.id, observedTurnItems),
      );
      const repairOutputs = yield* toolOutputsForRun(
        client,
        created.threadId,
        repairRun.id,
        observedTurnItems,
      );
      const repairVerifies = verifyFactsOf(repairOutputs);
      assert(
        repairVerifies.length > 0 && repairVerifies.every((facts) => facts !== null),
        "Lifecycle repair turn ran no readable game_verify",
      );
      const repairVerify = repairVerifies[repairVerifies.length - 1]!;
      assert(
        repairVerify.success === true,
        `The repair verify did not pass: ${JSON.stringify(repairVerify)}`,
      );
      const repairSubmits = submitFactsOf(repairOutputs);
      assert(
        repairSubmits.length > 0 && repairSubmits.every((facts) => facts !== null),
        "Lifecycle repair turn ran no readable game_submit",
      );
      const repairSubmit = repairSubmits[repairSubmits.length - 1]!;
      assert(
        repairSubmit.accepted === true,
        `The repair submit was refused: ${repairSubmit.message}; checks: ${JSON.stringify(repairSubmit.checks)}`,
      );
      const repairedBytes = yield* promise(() => NodeFSP.readFile(breakPath, "utf8"));
      assert(
        !repairedBytes.includes(LIFECYCLE_SYNTAX_DEFECT.trim()),
        "The repair turn left the syntax defect in place",
      );
      const repairedStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
      recordStatus(repairedStatus);
      recordProduction(repairedStatus, repairRun);
      summaryPhase = "lifecycle-recovery";
      const repairLoop = yield* watchReviewLoop("after the lifecycle repair", repairRun);
      if (repairLoop?.timedOutBy === "harness-deadline") {
        summaryTimedOut = true;
        throw new HarnessError({
          message: `The run timeout ended during lifecycle recovery loop ${repairLoop.loop.id}; it was still running after ${Math.round(repairLoop.waitedMs / 60_000)} minute(s).`,
          cause: null,
        });
      }
      if (repairLoop === null)
        throw new HarnessError({
          message:
            "The repair turn submitted but opened no review loop for its run; recovery is unproven.",
          cause: null,
        });
      if (repairLoop.timedOut)
        throw new HarnessError({
          message: `Lifecycle recovery loop ${repairLoop.loop.id} was still running at its bound after ${Math.round(repairLoop.waitedMs / 60_000)} minute(s); recovery is unproven.`,
          cause: null,
        });
      if (repairLoop.loop.decision === null)
        throw new HarnessError({
          message: `Lifecycle recovery loop ${repairLoop.loop.id} ended with no decision (${repairLoop.loop.reason ?? "no reason"}); recovery is unproven.`,
          cause: null,
        });
      const recovered = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
      recordStatus(recovered);
      recordProduction(recovered, repairRun);
      const repairReview = yield* client[WS_METHODS.gameReviewStatus]({
        threadId: created.threadId,
        checkSelectedBuild: true,
      });
      yield* requireReviewEvidence(repairLoop.loop.id);
      assertSelectedBuildComplete(
        "after the lifecycle repair",
        recovered,
        repairReview.selectedBuildFacts ?? null,
      );
      lifecycleSyntax = {
        ...lifecycleSyntax!,
        repaired: true,
        submittedBuildId: repairSubmit.buildId,
        recovery: {
          loopId: repairLoop.loop.id,
          decision: repairLoop.loop.decision,
          reason: repairLoop.loop.reason,
          outcome: classifyLiveReviewOutcome(repairLoop.loop, repairLoop.timedOut),
          selectedBuildId: recovered.selectedBuildId,
        },
      };
      timeline(
        `Lifecycle repair: verify passed, submit accepted (${(repairSubmit.buildId ?? "?").slice(0, 12)}), recovery loop ${repairLoop.loop.id} decided ${repairLoop.loop.decision}`,
      );

      summaryPhase = "lifecycle-stale";
      const staleBefore = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
      const staleBuild = staleBefore.selectedBuildId;
      assert(staleBuild !== null, "Lifecycle stale submit started with no selected build");
      const stalePath = NodePath.join(existingCopy!, breakScript);
      const staleOriginal = yield* promise(() => NodeFSP.readFile(stalePath, "utf8"));
      const staleGitBefore = yield* promise(() => gitStatusOf(existingCopy!));
      yield* promise(() => NodeFSP.appendFile(stalePath, `\n${LIFECYCLE_STALE_EDIT}`));
      const staleEdited = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
      const staleStage =
        staleEdited.qualification.stages.find((stage) => stage.stage === "export")?.status ?? null;
      assert(
        staleStage === "stale",
        `The test-owned source edit did not stale the export stage (export=${staleStage ?? "none"}); refusing to grade a no-op edit`,
      );
      try {
        const staleRun = yield* lifecycleTurn("lifecycle-stale", lifecycleStalePrompt(staleBuild));
        logTurnTools(
          "lifecycle-stale",
          yield* collectTurnTools(client, created.threadId, staleRun.id, observedTurnItems),
        );
        const staleOutputs = yield* toolOutputsForRun(
          client,
          created.threadId,
          staleRun.id,
          observedTurnItems,
        );
        const staleSubmits = submitFactsOf(staleOutputs);
        assert(
          staleSubmits.length > 0 && staleSubmits.every((facts) => facts !== null),
          `Lifecycle stale turn ran no readable game_submit; tools: ${staleOutputs.map((entry) => entry.name).join(", ") || "none"}`,
        );
        const staleVerdict = staleSubmits[staleSubmits.length - 1]!;
        if (staleVerdict.accepted === false) {
          assert(
            staleVerdict.message.startsWith("Submission refused:"),
            `The stale submit failed in an unexpected way: ${staleVerdict.message}`,
          );
          const staleAfter = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
          const staleFacts = yield* client[WS_METHODS.gameReviewStatus]({
            threadId: created.threadId,
            checkSelectedBuild: true,
          });
          const staleUsableFs = yield* artifactFileUsable(staleFacts.selectedBuildFacts?.directory);
          assert(
            staleAfter.selectedBuildId === staleBuild,
            `The refused submit moved the selected build ${staleBuild} -> ${staleAfter.selectedBuildId}`,
          );
          assert(
            staleAfter.selectedArtifactUsable === true && staleUsableFs,
            `The refused submit lost the old artifact: usable=${String(staleAfter.selectedArtifactUsable)} files=${String(staleUsableFs)}`,
          );
          lifecycleStaleSubmit = {
            buildId: staleVerdict.buildId ?? staleBuild,
            accepted: false,
            reason: staleVerdict.message.slice(0, 500),
            checks: staleVerdict.checks,
            selectedBefore: staleBuild,
            selectedAfter: staleAfter.selectedBuildId,
            artifactUsableAfter: staleAfter.selectedArtifactUsable === true && staleUsableFs,
            exportStageAfter: staleStage,
            editRestored: false,
          };
          timeline(`Lifecycle stale: refused as ${staleVerdict.message.slice(0, 160)}`);
        } else {
          const acceptedAfter = yield* client[WS_METHODS.gameStatus]({
            threadId: created.threadId,
          });
          const acceptedFacts = yield* client[WS_METHODS.gameReviewStatus]({
            threadId: created.threadId,
            checkSelectedBuild: true,
          });
          const acceptedUsableFs = yield* artifactFileUsable(
            acceptedFacts.selectedBuildFacts?.directory,
          );
          let postLoop = "";
          if (
            acceptedFacts.loop !== null &&
            String(acceptedFacts.loop.originatingRunId) === String(staleRun.id)
          ) {
            const watched = yield* watchReviewLoop("after the accepted stale submit", staleRun);
            postLoop = `; the acceptance opened review loop ${watched?.loop.id ?? acceptedFacts.loop.id} (decision ${watched?.loop.decision ?? acceptedFacts.loop.decision}, reason ${(watched?.loop.reason ?? acceptedFacts.loop.reason ?? "none").slice(0, 200)})`;
          }
          lifecycleStaleSubmit = {
            buildId: staleVerdict.buildId ?? staleBuild,
            accepted: true,
            reason: `${staleVerdict.message}${postLoop}`.slice(0, 500),
            checks: staleVerdict.checks,
            selectedBefore: staleBuild,
            selectedAfter: acceptedAfter.selectedBuildId,
            artifactUsableAfter: acceptedAfter.selectedArtifactUsable === true && acceptedUsableFs,
            exportStageAfter: staleStage,
            editRestored: false,
          };
          throw new HarnessError({
            message: `game_submit on the stale exact build ${staleBuild} was ACCEPTED after a real engine-source edit (export stage ${staleStage}); the tree moved on but the old bytes were declared again. Expected a refusal naming the stale fact. Selection ${staleBuild} -> ${acceptedAfter.selectedBuildId}${postLoop}. This is a server product bug; the evidence records the acceptance.`,
            cause: null,
          });
        }
      } finally {
        yield* promise(async () => {
          const current = await NodeFSP.readFile(stalePath, "utf8");
          if (current !== staleOriginal) await NodeFSP.writeFile(stalePath, staleOriginal);
        });
        const staleRestoredBytes = yield* promise(() => NodeFSP.readFile(stalePath, "utf8"));
        const staleGitAfter = yield* promise(() => gitStatusOf(existingCopy!));
        assert(
          staleRestoredBytes === staleOriginal,
          "The harness could not restore its test-owned stale edit",
        );
        assert(
          staleGitAfter === staleGitBefore,
          `Restoring the test-owned edit left other diffs in the copy: ${JSON.stringify(staleGitAfter)}`,
        );
        if (lifecycleStaleSubmit !== null)
          lifecycleStaleSubmit = { ...lifecycleStaleSubmit, editRestored: true };
      }
      timeline("PASS (lifecycle: cancel, syntax repair, stale refusal)");
      const finalStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
      const finalReview = yield* client[WS_METHODS.gameReviewStatus]({
        threadId: created.threadId,
        checkSelectedBuild: true,
      });
      assertSelectedBuildComplete(
        "after lifecycle recovery",
        finalStatus,
        finalReview.selectedBuildFacts,
      );
      recordStatus(finalStatus);
      review = finalReview;
      liveSelectedBuildId = finalStatus.selectedBuildId;
      liveSelectedBuildFacts = finalReview.selectedBuildFacts ?? null;
    }
    summaryPhase = "done";
    timeline("PASS (existing game review)");
    return;
  }

  // The create commit holds the untouched skeleton; read it before the design
  // turn can edit or commit over the file it has to replace.
  const designSkeleton = reviewDesign
    ? yield* promise(async () => {
        try {
          return (await exec("git", ["show", "HEAD:DESIGN.md"], { cwd: created.root })).stdout;
        } catch {
          return NodeFSP.readFile(NodePath.join(created.root, "DESIGN.md"), "utf8");
        }
      })
    : "";
  let buildRun: OrchestrationV2Run;
  if (reviewDesign) {
    const designRun = yield* timedTurn(
      "design",
      waitForTurn(client, created.threadId, new Set(), {
        observed: observedTurnItems,
        observedRuns: observedRunIds,
      }),
    );
    logTurnTools(
      "design",
      yield* collectTurnTools(client, created.threadId, designRun.id, observedTurnItems),
    );
    const design = yield* promise(() =>
      NodeFSP.readFile(NodePath.join(created.root, "DESIGN.md"), "utf8"),
    );
    yield* promise(async () => assertDesignFilled(designSkeleton, design));
    const designStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      designStatus.design.state === "draft",
      `Design turn did not leave the design in draft (${JSON.stringify(designStatus.design)})`,
    );
    assert(designStatus.assets.length === 0, "Design turn created Blender assets");
    assert(designStatus.builds.length === 0, "Design turn produced a build");
    assert(designStatus.lastPlaytest === null, "Design turn ran a playtest");
    const designArtifacts = yield* promise(async () => [
      ...(await filesUnder(NodePath.join(created.root, "builds/web"))),
      ...(await filesUnder(NodePath.join(created.root, "builds/linux"))),
      ...(await filesUnder(NodePath.join(created.root, "builds/playtests"))),
      ...(await filesUnder(NodePath.join(created.root, "art/blender"))),
      ...(await filesUnder(NodePath.join(created.root, "art/scripts"))),
      ...(await filesUnder(NodePath.join(created.root, "art/previews"))),
    ]);
    assert(
      designArtifacts.length === 0,
      `Design turn created build or art artifacts: ${designArtifacts.join(", ")}`,
    );
    const designChanges = yield* promise(async () => {
      const result = await exec("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: created.root,
      });
      return result.stdout.trim();
    });
    timeline(
      `Design turn changed paths: ${designChanges === "" ? "none" : designChanges.replace(/\n/g, ", ")}`,
    );
    // The draft stage's contract is one file: DESIGN.md. The server gate refuses
    // staging tools, but files under godot/ and art/ are written by the agent
    // directly, so diff-only-DESIGN.md is what proves the turn kept its stage.
    assert(
      designChanges.split("\n").every((line) => line === "M DESIGN.md" || line === ""),
      `Design turn touched files beyond DESIGN.md:\n${designChanges}`,
    );
    if (values["design-only"]) {
      recordStatus(designStatus);
      summaryPhase = "design-only";
      timeline("PASS (draft design only; not approved or built)");
      return;
    }
    // Approve through the same RPC the Design tab calls, with the hash the
    // status read returned, then wait for the build turn.
    const designHash = designStatus.design.currentHash;
    assert(designHash !== null, "Status reported no DESIGN.md hash for the draft");
    const approval = yield* client[WS_METHODS.gameApproveDesign]({
      threadId: created.threadId,
      expectedDesignHash: designHash,
    });
    assert(approval.approvedAt.length > 0, "Approval returned no timestamp");
    assert(approval.designHash === designHash, "Approval recorded a different design hash");
    timeline(`Design approved at ${approval.approvedAt}`);
    const approvedStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      approvedStatus.design.state === "approved",
      `The server did not record the approved design (${JSON.stringify(approvedStatus.design)})`,
    );
    assert(
      approvedStatus.design.acceptance.length >= 5,
      `Approval bound only ${approvedStatus.design.acceptance.length} acceptance criteria`,
    );
    assert(
      approvedStatus.design.acceptance.some((criterion) => criterion.kind === "mechanic"),
      "Approved acceptance is missing a mechanic criterion",
    );
    buildRun = yield* timedTurn(
      "build",
      waitForTurn(client, created.threadId, new Set(observedRunIds), {
        observed: observedTurnItems,
        observedRuns: observedRunIds,
      }),
    );
  } else {
    buildRun = yield* timedTurn(
      "build",
      waitForTurn(client, created.threadId, new Set(), {
        observed: observedTurnItems,
        observedRuns: observedRunIds,
      }),
    );
  }
  if (planFirst && !reviewDesign) {
    // Without review the design is evidence, never a gate: report what the
    // server recorded and let the run go on whatever DESIGN.md holds.
    const designStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    const design = designStatus.design;
    timeline(
      `Design: ${design.state}, revision ${design.autoRevision ?? 0}, ${design.acceptance.length} criteria${
        design.issues.length === 0 ? "" : `; issues: ${design.issues.join(" | ")}`
      }${(design.warnings ?? []).length === 0 ? "" : `; warnings: ${(design.warnings ?? []).join(" | ")}`}`,
    );
  }
  const buildCalls = yield* collectTurnTools(
    client,
    created.threadId,
    buildRun.id,
    observedTurnItems,
  );
  logTurnTools("build", buildCalls);
  // The build turn has ended; record what it submitted before the review wait.
  // A run timeout during that wait still names the game and its production
  // milestones instead of looking like a build that never submitted.
  const submitted = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
  recordStatus(submitted);
  recordProduction(submitted, buildRun);
  summaryPhase = "review";
  const buildLoop = yield* watchReviewLoop("after the build turn", buildRun);
  const action = (operation: "preview" | "export-linux" | "native" | "stop") =>
    client[WS_METHODS.gameAction]({ threadId: created.threadId, action: operation }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          assert(result.success, result.message);
          timeline(`${operation}: ${result.message}`);
        }),
      ),
    );
  const status = yield* resilientGameStatus().pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        // The watch already observed the loop; keep it even when a follow-up
        // status read cannot. Mutations are still never replayed.
        if (buildLoop !== null && reviewLoop === null) {
          reviewLoop = summarizeRepairLoop({
            watched: buildLoop,
            selectedBuildId: null,
          });
          timeline(
            `preserved review loop ${buildLoop.loop.id} with unknown selection after status transport failure`,
          );
        }
        yield* preserveLastLoopOnTransportFailure();
        return yield* Effect.fail(error);
      }),
    ),
  );
  // Record before any assertion: a failed run still has to say what it graded.
  recordStatus(status);
  recordProduction(status, buildRun);
  if (productionTiming !== null) {
    const minutes = (ms: number | null) =>
      ms === null ? "no submit" : `${Math.round(ms / 60_000)}m`;
    timeline(
      `Production: first playable after ${minutes(productionTiming.firstPlayableMs)}, final submit after ${minutes(productionTiming.lastSubmitMs)} (${productionTiming.submissions} accepted submit(s))`,
    );
  }
  if (buildLoop !== null)
    reviewLoop = summarizeRepairLoop({
      watched: buildLoop,
      selectedBuildId: status.selectedBuildId,
    });
  review = yield* resilientGameReviewStatusChecked().pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* preserveLastLoopOnTransportFailure();
        return yield* Effect.fail(error);
      }),
    ),
  );
  // The wait stopped early because the caller's whole-run cap would otherwise
  // kill the process mid-review. Keep the submitted build and review state in
  // the summary, but never call a run that ran out of time a pass.
  if (buildLoop?.timedOutBy === "harness-deadline") {
    summaryTimedOut = true;
    throw new HarnessError({
      message: `The run timeout (${Math.round(timeoutMs / 60_000)} minute(s)) ended during review loop ${buildLoop.loop.id}; it was still running after ${Math.round(
        buildLoop.waitedMs / 60_000,
      )} minute(s). The summary records the submitted build and the review state observed so far.`,
      cause: null,
    });
  }
  assert(
    buildLoop !== null && !buildLoop.timedOut && buildLoop.loop.decision !== null,
    "The build did not finish a decided review loop; the summary records what exists.",
  );
  yield* requireReviewEvidence(buildLoop.loop.id);
  printStatus(status);
  if (status.assets.length === 0) timeline("Build turn produced no Blender assets");
  else
    assert(
      status.assets.some((asset) => asset.usedBy.length > 0),
      "No Blender asset is used by a Godot scene",
    );
  assert(
    status.builds.some((build) => build.target === "Web"),
    "No web build exists after the build turn",
  );
  assertSelectedBuildComplete("after the build turn", status, review.selectedBuildFacts);
  summaryPhase = "playable";
  timeline(`Qualification: ${stageSummary(status)}`);
  if (status.lastPlaytest !== null)
    timeline(
      `Latest folder playtest evidence: ${status.lastPlaytest.directory} (${status.lastPlaytest.frames.length} frames, ${status.lastPlaytest.changedPercent.toFixed(1)}% changed${
        status.lastPlaytest.stale ? ", stale" : ""
      })`,
    );
  const preview = yield* action("preview");
  summaryPhase = "preview";
  yield* promise(async () => {
    assert(preview.url, "Preview has no URL");
    const index = await fetch(preview.url, { signal: AbortSignal.timeout(30_000) });
    assert(
      index.ok && index.headers.get("content-type")?.startsWith("text/html"),
      "Preview index.html has wrong content type or status",
    );
    assert((await index.text()).length > 0, "Preview HTML is empty");
    const directory = review?.selectedBuildFacts?.directory;
    assert(directory != null, "The selected build has no artifact directory");
    const files = await NodeFSP.readdir(NodePath.join(created.root, directory));
    const wasmFile = files.find((file) => file.endsWith(".wasm"));
    assert(wasmFile, "Web export contains no wasm");
    const wasm = await fetch(new URL(wasmFile, preview.url), {
      method: "HEAD",
      signal: AbortSignal.timeout(30_000),
    });
    assert(
      wasm.ok && wasm.headers.get("content-type") === "application/wasm",
      "Preview wasm has wrong content type or status",
    );
    timeline(`Preview HTTP: index.html text/html; ${wasmFile} application/wasm`);
  });
  yield* action("export-linux");
  summaryPhase = "native";
  try {
    yield* action("native");
    const running = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    const native = running.processes.find((entry) => entry.operation === "native");
    assert(native, "Native process exited before it could be stopped");
    yield* action("stop");
    yield* promise(async () => {
      try {
        process.kill(native.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          timeline(`Native PID ${native.pid} is gone`);
          return;
        }
        throw error;
      }
      throw new Error(`Native PID ${native.pid} survived Stop`);
    });
  } finally {
    yield* client[WS_METHODS.gameAction]({ threadId: created.threadId, action: "stop" });
  }
  const send = (text: string) => dispatchMessage(client, created.threadId, text);
  const followup = (text: string, cancel = false) =>
    Effect.gen(function* () {
      return yield* waitForTurn(client, created.threadId, new Set(observedRunIds), {
        cancel,
        observed: observedTurnItems,
        observedRuns: observedRunIds,
        onReady: () => send(text),
      });
    });
  // `game_web_playtest` exists only on the agent's MCP surface, so the verifier's
  // extra playtest is a turn the agent drives with the exact steps it is given.
  if (extraPlaytestSteps) {
    const beforeExtra = status.lastPlaytest;
    const extraRun = yield* timedTurn(
      "extra-playtest",
      followup(
        `Run game_web_playtest now with exactly these steps: ${JSON.stringify(
          extraPlaytestSteps,
        )}. The web build is current; do not change any game files. Report the playtest result.`,
      ),
    );
    logTurnTools(
      "extra-playtest",
      yield* collectTurnTools(client, created.threadId, extraRun.id, observedTurnItems),
    );
    const extraStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    recordStatus(extraStatus);
    summaryPhase = "extra-playtest";
    assert(
      extraStatus.lastPlaytest !== null &&
        extraStatus.lastPlaytest.directory !== beforeExtra?.directory,
      "Extra playtest wrote no new evidence folder",
    );
    assert(
      extraStatus.lastPlaytest.responded,
      "Extra playtest did not prove that the game responded to input",
    );
    // The verifier's playtest is deliberately weaker (generic steps), so it cannot
    // re-gate a game that already qualified after the build turn (:591).
    timeline(
      `Extra playtest: ${extraStatus.lastPlaytest.directory} (${extraStatus.lastPlaytest.frames.length} frames, ${extraStatus.lastPlaytest.changedPercent.toFixed(1)}% changed)`,
    );
  }
  if (values.revise) {
    // The request is a server RPC, not a chat line, and its review is data: the
    // server keeps a pending revision record with the approved hash it amends,
    // the Design tab reads a criteria diff against it, and only a decision
    // through the revisions flow reaches the sources (review-r2 finding F16).
    const reviseText = values.revise;
    // Obligations this revision may never drop, frozen before the agent works.
    // The double jump is only real when a mechanic criterion still observes it.
    const reviseObligations: ReadonlyArray<GameRevisionObligation> = [
      { kind: "mechanic", key: "air_jumps", expect: ">=1" },
    ];
    const before = yield* promise(() => revisionSnapshot(created.root));
    // A throwaway index captures uncommitted agent work without touching the game's own index.
    const index = NodePath.join(created.root, "builds/logs/e2e-snapshot.index");
    const snapshotTree = () =>
      promise(async () => {
        const env = { ...process.env, GIT_INDEX_FILE: index };
        await exec("git", ["add", "-A"], { cwd: created.root, env });
        return (await exec("git", ["write-tree"], { cwd: created.root, env })).stdout.trim();
      });
    const baseline = yield* snapshotTree();
    const requestChangeRun = yield* timedTurn(
      "revise-request",
      waitForTurn(client, created.threadId, new Set(observedRunIds), {
        observed: observedTurnItems,
        observedRuns: observedRunIds,
        onReady: () =>
          client[WS_METHODS.gameRequestChange]({
            threadId: created.threadId,
            text: reviseText,
          }),
      }),
    );
    logTurnTools(
      "revise-request",
      yield* collectTurnTools(client, created.threadId, requestChangeRun.id, observedTurnItems),
    );
    let reviseStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      reviseStatus.design.state === "revision-pending",
      `The change request left the design ${reviseStatus.design.state} instead of revision-pending`,
    );
    assert(
      reviseStatus.design.pendingRevision?.text === reviseText,
      "The pending revision did not carry the requested change",
    );
    assert(
      reviseStatus.design.approvedHash !== null &&
        reviseStatus.design.pendingRevision?.baseHash === reviseStatus.design.approvedHash,
      "The request is not pinned to the approved revision",
    );
    // The document diff a reviewer reads. The agent has not asked to remove
    // anything in this flow, but the harness shows what actually changed.
    const revisionDiff = reviseStatus.design.revisionDiff;
    assert(revisionDiff !== null, "The pending revision carries no criteria diff for review");
    assert(
      revisionDiff.added.length + revisionDiff.changed.length + revisionDiff.removed.length > 0,
      "The revised design shows no criteria diff; the request turned into no contract change",
    );
    // The design stage cannot call this game buildable while the request pends.
    assert(
      reviseStatus.qualification.stages.find((stage) => stage.stage === "design")?.status ===
        "failed",
      "The change request left the design stage qualified",
    );
    timeline(
      `Revision review: ${revisionDiff.added.length} added, ${revisionDiff.changed.length} changed, ${revisionDiff.removed.length} removed criteria`,
    );
    // Approve only a revision that kept every frozen proof.
    const unmet = unmetRevisionObligations(reviseStatus.design.acceptance, reviseObligations);
    assert(
      unmet.length === 0,
      `The revised design dropped required proof: ${JSON.stringify(unmet)}`,
    );
    const revisedHash = reviseStatus.design.currentHash;
    assert(revisedHash !== null, "The revised design has no hash to approve");
    // Approving the revision both records it and dispatches the revision's own
    // build turn, so the harness observes that turn from subscription time.
    const approveRevisionRun = yield* timedTurn(
      "revise-build",
      waitForTurn(client, created.threadId, new Set(observedRunIds), {
        observed: observedTurnItems,
        observedRuns: observedRunIds,
        onReady: () =>
          client[WS_METHODS.gameApproveRevision]({
            threadId: created.threadId,
            expectedDesignHash: revisedHash,
          }),
      }),
    );
    logTurnTools(
      "revise-build",
      yield* collectTurnTools(client, created.threadId, approveRevisionRun.id, observedTurnItems),
    );
    // Record the revision's design and production state before its review wait,
    // so a run timeout during that wait still reports what the turn submitted.
    summaryPhase = "revise";
    recordStatus(yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId }));
    const reviseLoop = yield* watchReviewLoop("after the revision turn", approveRevisionRun);
    reviseStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    recordStatus(reviseStatus);
    if (reviseLoop !== null)
      reviewLoop = summarizeRepairLoop({
        watched: reviseLoop,
        selectedBuildId: reviseStatus.selectedBuildId,
      });
    if (reviseLoop?.timedOutBy === "harness-deadline") {
      review = yield* client[WS_METHODS.gameReviewStatus]({
        threadId: created.threadId,
        checkSelectedBuild: true,
      });
      summaryTimedOut = true;
      throw new HarnessError({
        message: `The run timeout (${Math.round(timeoutMs / 60_000)} minute(s)) ended during revision review loop ${reviseLoop.loop.id}; it was still running after ${Math.round(
          reviseLoop.waitedMs / 60_000,
        )} minute(s). The summary records the revision state observed so far.`,
        cause: null,
      });
    }
    assert(reviseStatus.design.state === "approved", "The approved revision did not take");
    assert(reviseStatus.design.pendingRevision === null, "The approved revision is still pending");
    assert(
      reviseStatus.design.acceptance.length >= 5,
      `The revised design bound only ${reviseStatus.design.acceptance.length} acceptance criteria`,
    );
    const after = yield* promise(() => revisionSnapshot(created.root));
    console.log("Revision assets before/after:", JSON.stringify({ before, after }, null, 2));
    const revised = yield* snapshotTree();
    const changedPaths = yield* promise(async () => {
      const result = await exec("git", ["diff", "--name-only", baseline, revised], {
        cwd: created.root,
      });
      return result.stdout.trim().split("\n").filter(Boolean);
    });
    const diff = yield* promise(() =>
      exec("git", ["diff", "--stat", baseline, revised], { cwd: created.root }),
    );
    console.log("Changed files:\n" + diff.stdout);
    assert(diff.stdout.trim() !== "", "Revision turn changed no files");
    // The contract itself is the first thing a change touches: a revision that
    // ships bytecode without its DESIGN.md source edit is not a reviewed change.
    assert(
      changedPaths.includes("DESIGN.md"),
      "Revision turn shipped changes without a DESIGN.md source diff",
    );
    // The design mirror in game.json changes on approval; neither is the game.
    // The revision has to reach real sources.
    assert(
      changedPaths.some((path) => path !== "DESIGN.md" && path !== "game.json"),
      "Revision turn changed only design files, not the game",
    );
    assert(
      reviseStatus.design.state === "approved",
      "Revision turn changed the approved design without re-approval",
    );
    review = yield* client[WS_METHODS.gameReviewStatus]({
      threadId: created.threadId,
      checkSelectedBuild: true,
    });
    assert(
      reviseLoop !== null && !reviseLoop.timedOut && reviseLoop.loop.decision !== null,
      "The revision did not finish a decided review loop; the summary records what exists.",
    );
    yield* requireReviewEvidence(reviseLoop.loop.id);
    assertSelectedBuildComplete("after the revision turn", reviseStatus, review.selectedBuildFacts);
    timeline(
      `After revise: webBuildStale=${String(reviseStatus.webBuildStale)}, newest playtest=${
        reviseStatus.lastPlaytest?.directory ?? "none"
      }, ${stageSummary(reviseStatus)}`,
    );
  }
  if (values["cancel-test"]) {
    yield* timedTurn(
      "cancel-test",
      followup(
        "Use game_blender_run now with id cancellation_probe, reset=true, thumbnail=false, and Python script: import time; time.sleep(120). This is an intentional cancellation test. Do not use shell commands, do not build anything else.",
        true,
      ),
    );
    const cancelled = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      cancelled.processes.length === 0,
      `Cancellation leaked processes: ${JSON.stringify(cancelled.processes)}`,
    );
    timeline("Cancellation: no tracked processes remain");
  }
  const finishedStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
  recordStatus(finishedStatus);
  summaryPhase = "done";
  timeline(
    `PASS (selected artifact playable; folder mechanics ${finishedStatus.qualification.state})`,
  );
});
const program = main.pipe(Effect.timeoutOption(`${timeoutMs} millis`), Effect.scoped);
const fiber = Effect.runFork(program);
let stoppingSignal: NodeJS.Signals | null = null;
const stop = (signal: NodeJS.Signals) => {
  if (stoppingSignal !== null) return;
  stoppingSignal = signal;
  timeline(`Received ${signal}; stopping`);
  // Interrupt rather than exit: the scoped finalizers stop the private server
  // group and the game action this run started.
  fiber.interruptUnsafe(fiber.id);
};
const onSigint = () => stop("SIGINT");
const onSigterm = () => stop("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
try {
  const exit = await Effect.runPromise(Fiber.await(fiber));
  if (stoppingSignal !== null) {
    summaryError = `Stopped by ${stoppingSignal}.`;
    console.error(`FAIL: stopped by ${stoppingSignal}`);
    process.exitCode = 1;
  } else if (Exit.isFailure(exit)) {
    throw Cause.squash(exit.cause);
  } else if (Option.isNone(exit.value)) {
    summaryTimedOut = true;
    const timedOutLoop = recordedReviewLoop();
    summaryError = `Timed out after ${Math.round(timeoutMs / 60_000)} minute(s) at phase "${summaryPhase}"${
      timedOutLoop === null ? "" : `; review loop ${timedOutLoop.id} was ${timedOutLoop.status}`
    }. The caller's --timeout-ms bounds the whole run, including review.`;
    console.error("FAIL: timed out");
    process.exitCode = 1;
  }
} catch (error: unknown) {
  summaryError = error instanceof Error ? error.message : String(error);
  console.error("FAIL:", error);
  if (gameRoot) console.error(`Game root: ${gameRoot}`);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  await writeSummary().catch((cause: unknown) => {
    console.error("Could not write --summary:", cause);
  });
}
