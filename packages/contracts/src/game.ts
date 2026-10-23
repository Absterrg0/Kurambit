import * as Schema from "effect/Schema";
import { RuntimeMode } from "./providerPolicy.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { GameDesignRead, GameDesignState } from "./gameDesign.ts";
import { GameScenarioCriterionResult, GameScenarioKindCoverage } from "./gameScenario.ts";

export const GameAsset = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("model"),
  source: Schema.String,
  script: Schema.String,
  export: Schema.String,
  thumbnail: Schema.optionalKey(Schema.String),
  updatedAt: Schema.String,
});
export const GameTemplateId = Schema.Literals(["3d-explorer", "2d-platformer", "blank"]);
export type GameTemplateId = typeof GameTemplateId.Type;
export const GameTemplate = Schema.Struct({
  id: GameTemplateId,
  name: Schema.String,
  description: Schema.String,
  dimension: Schema.Literals(["2d", "3d"]),
  /** The game-relative suite whose pass is the game's qualification test. */
  testSuite: Schema.String,
  /**
   * The scene play starts in, which the check runs after the main scene so a
   * failure in gameplay initialization cannot hide behind the menu.
   */
  gameplayScene: Schema.optionalKey(Schema.String),
  /**
   * The template ships the read-only StudioProbe. Games built from such a
   * template owe a state probe: a playtest that cannot read one has proven
   * nothing about play, so it must not qualify the game.
   */
  probe: Schema.optionalKey(Schema.Boolean),
});
export type GameTemplate = typeof GameTemplate.Type;
/** The suite a game qualifies with unless its manifest names another one. */
export const DEFAULT_GAME_TEST_SUITE = "res://tests/smoke_test.gd";
/**
 * The starter templates the New game dialog offers. Template files live under
 * apps/server/templates/<id>/; a server test keeps this list and those folders in step.
 */
export const GAME_TEMPLATES: readonly GameTemplate[] = [
  {
    id: "3d-explorer",
    name: "3D Explorer",
    description:
      "Third-person exploration with real collision: collect the relics, cross the lava, unlock the gate.",
    dimension: "3d",
    testSuite: DEFAULT_GAME_TEST_SUITE,
    gameplayScene: "res://scenes/game.tscn",
    probe: true,
  },
  {
    id: "2d-platformer",
    name: "2D Platformer",
    description:
      "Side-scrolling platformer with real pixel art: run, jump and stomp through two levels of coins, spikes and slimes.",
    dimension: "2d",
    testSuite: DEFAULT_GAME_TEST_SUITE,
    gameplayScene: "res://scenes/game.tscn",
    probe: true,
  },
  {
    id: "blank",
    name: "Blank",
    description: "An empty Godot project: a camera, a light, and Web and Linux export presets.",
    dimension: "3d",
    testSuite: DEFAULT_GAME_TEST_SUITE,
    // Blank has no menu: its main scene is the game, and the check runs it once.
    gameplayScene: "res://scenes/main.tscn",
  },
];
export const DEFAULT_GAME_TEMPLATE: GameTemplateId = "3d-explorer";
/**
 * The design phase shown in the manifest. This is a display mirror only: the
 * server-owned approval record decides whether a design revision is approved.
 */
export const GameDesign = Schema.Struct({
  status: Schema.Literals(["draft", "approved"]),
  approvedAt: Schema.optionalKey(Schema.String),
});
export type GameDesign = typeof GameDesign.Type;
export const GameManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.String,
  brief: Schema.String,
  artDirection: Schema.String,
  // Games created before starter templates existed have no template key.
  template: Schema.optionalKey(GameTemplateId),
  // Display mirror of the server-owned verification policy. New games get it
  // from the template; old games are the one-time source the policy is adopted
  // from. Editing these keys never changes the exam.
  testSuite: Schema.optionalKey(Schema.String),
  gameplayScene: Schema.optionalKey(Schema.String),
  probe: Schema.optionalKey(Schema.Boolean),
  // Games created before the design step existed have no design key.
  design: Schema.optionalKey(GameDesign),
  engine: Schema.Struct({ name: Schema.Literal("godot"), version: Schema.String }),
  godotProject: Schema.String,
  assets: Schema.Array(GameAsset),
});
export type GameManifest = typeof GameManifest.Type;
export type GameAsset = typeof GameAsset.Type;
/** The suite that owns the `test` qualification stage for this game. */
export const gameTestSuite = (manifest: GameManifest): string =>
  manifest.testSuite ?? DEFAULT_GAME_TEST_SUITE;
/**
 * The server-owned exam for one game. It is written at creation and changed
 * only through an explicit creator action, never by editing game.json.
 */
export const GameVerificationPolicy = Schema.Struct({
  /** The canonical suite whose pass records the test stage. */
  testSuite: Schema.String,
  /** The scene play starts in; null when the game has no separate gameplay scene. */
  gameplayScene: Schema.NullOr(Schema.String),
  /** Whether a qualifying playtest must read the StudioProbe. */
  probe: Schema.Boolean,
});
export type GameVerificationPolicy = typeof GameVerificationPolicy.Type;
export const GameVerificationPolicyRead = Schema.Struct({
  policy: GameVerificationPolicy,
  /** Stable identity of this policy; a change invalidates recorded evidence. */
  revision: Schema.String,
});
export type GameVerificationPolicyRead = typeof GameVerificationPolicyRead.Type;
export const GameVerificationPolicyUpdateInput = Schema.Struct({
  threadId: ThreadId,
  testSuite: Schema.String,
  gameplayScene: Schema.NullOr(Schema.String),
  probe: Schema.Boolean,
});
export type GameVerificationPolicyUpdateInput = typeof GameVerificationPolicyUpdateInput.Type;
export class GameOperationError extends Schema.TaggedError<GameOperationError>()(
  "GameOperationError",
  {
    operation: Schema.String,
    path: Schema.String,
    reason: Schema.Literals([
      "io",
      "invalid-project",
      "invalid-path",
      "tool-missing",
      "wrong-version",
      "templates-missing",
      "unknown-template",
      "starter-templates-missing",
      "command-failed",
      "busy",
      "unsupported-platform",
      "checksum",
      "download",
      "project-not-found",
      "design-draft",
      "design-changed",
      "design-missing",
      "design-invalid",
      "design-hash-mismatch",
      "design-legacy",
      "design-revision-pending",
      "revision-missing",
      "thread-dispatch",
      "invalid-input",
    ]),
    detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    const fixes = {
      "invalid-project": "Open a folder containing a valid game.json, or create a new game.",
      "invalid-path": "Use a relative path inside the game project.",
      "tool-missing":
        "The executable is missing, is not a file, or cannot be executed. Fix its path in Settings > General > Game tools or GAME_STUDIO_BLENDER / GAME_STUDIO_GODOT. To use the managed version, clear the override and click Install tools in Settings > General > Game tools.",
      "wrong-version":
        "Use Godot 4.7.x and Blender 4.2 or later. Fix the executable path in Settings > General > Game tools. To use the managed version, clear the override and click Install tools in Settings > General > Game tools.",
      "templates-missing":
        "Install Godot export templates matching this executable's exact version at the path below. For managed tools, clear executable overrides in Settings > General > Game tools, then click Install tools in Settings > General > Game tools.",
      "unknown-template": "Pick a starter template from the New game dialog.",
      "starter-templates-missing":
        "Game Studio's starter template files are missing. Reinstall or update the app.",
      "command-failed":
        "The command failed. Read builds/logs for stdout and stderr, fix the reported error, and retry.",
      busy: "Another operation is running for this game. Wait for it or press Stop.",
      checksum: "The downloaded artifact failed its published checksum. Retry the install.",
      download: "The tool download failed. Check network access and retry the install.",
      io: "Check that the path exists and is writable. Read the server log for the underlying error.",
      "unsupported-platform": "Managed installation currently supports Linux x86_64 only.",
      "design-draft":
        "DESIGN.md is still a draft, so this game may not export, preview, run or playtest yet. Finish the design and ask for review; after the creator approves it on the Design tab, retry.",
      "design-changed":
        "DESIGN.md changed after the creator approved it, so this game may not export, preview, run or playtest until they review the new scope and re-approve it on the Design tab.",
      "design-revision-pending":
        "A change request is pending its review on the Design tab, so this game may not export, preview, run or playtest until they approve the change, or discard the request there.",
      "design-missing":
        "DESIGN.md is missing or unreadable. Write the design and ask the creator to approve it on the Design tab.",
      "design-invalid":
        "DESIGN.md is not ready to approve. Fix the listed issues, then ask the creator to approve it.",
      "design-hash-mismatch":
        "The design changed after the creator reviewed it. Refresh the Design tab, read the current version, and approve that.",
      "design-legacy":
        "This game was created before the design step, so it has no design to approve.",
      "revision-missing":
        "There is no pending change request for this game. Ask for a change on the Design tab first.",
      "project-not-found":
        "Open this game as a project and start a thread before using game tools.",
      "thread-dispatch":
        "The turn that follows this game operation could not be sent. For design approval, try approving again; for a change request, discard the pending request on the Design tab and request the change again.",
      "invalid-input":
        "The request is outside the limits this operation accepts. Read the detail, shrink the request, and retry.",
    };
    return `${this.operation}: ${fixes[this.reason]} Path: ${this.path}${this.detail ? `\n${this.detail}` : ""}`;
  }
}
// Tool failures are JSON objects, so include the computed recovery message explicitly.
export const GameOperationFailure = Schema.Struct({
  _tag: GameOperationError.fields._tag,
  operation: GameOperationError.fields.operation,
  path: GameOperationError.fields.path,
  reason: GameOperationError.fields.reason,
  detail: GameOperationError.fields.detail,
  message: Schema.String,
});
export const GameToolStatus = Schema.Struct({
  tool: Schema.Literals(["blender", "godot"]),
  path: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  ready: Schema.Boolean,
  verified: Schema.Boolean,
  message: Schema.String,
});
export const GameToolchainStatus = Schema.Struct({
  toolsDirectory: Schema.String,
  installing: Schema.Boolean,
  tools: Schema.Array(GameToolStatus),
});
export type GameToolchainStatus = typeof GameToolchainStatus.Type;
export const GameProcessResult = Schema.Struct({
  pid: Schema.Number,
  exitCode: Schema.Number,
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
  logPath: Schema.String,
});
export type GameProcessResult = typeof GameProcessResult.Type;
export const GameViewport = Schema.Struct({ width: Schema.Number, height: Schema.Number });
export type GameViewport = typeof GameViewport.Type;
/** One primitive GameState value the StudioProbe reports. */
export const GamePlaytestStateValue = Schema.Union([Schema.Number, Schema.Boolean, Schema.String]);
export type GamePlaytestStateValue = typeof GamePlaytestStateValue.Type;
export const GamePlaytestProbe = Schema.Struct({
  /** Public GameState members, bounded by the probe to 40 keys and 80-character strings. */
  gameState: Schema.Record(Schema.String, GamePlaytestStateValue),
  /** World position of the first node in the `player` group, or null outside gameplay. */
  player: Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number, z: Schema.Number })),
  /** Text of the visible Label, RichTextLabel, Button and Label3D nodes; older probes omit it. */
  hudText: Schema.optionalKey(Schema.String),
});
export type GamePlaytestProbe = typeof GamePlaytestProbe.Type;
export const GamePlaytestStateChange = Schema.Struct({
  key: Schema.String,
  before: GamePlaytestStateValue,
  after: GamePlaytestStateValue,
});
export type GamePlaytestStateChange = typeof GamePlaytestStateChange.Type;
/**
 * What the in-game probe saw during a playtest. `before` is the gameplay
 * baseline (the first sample a player input step set up), `after` the last
 * gameplay sample; `playerMoved` and `changes` are measured against the
 * baseline, so opening the game from its menu is not mistaken for movement.
 */
export const GamePlaytestState = Schema.Struct({
  before: Schema.NullOr(GamePlaytestProbe),
  after: Schema.NullOr(GamePlaytestProbe),
  /** Net player displacement from the gameplay baseline to the last gameplay sample. */
  playerMoved: Schema.Number,
  /**
   * GameState values that moved away from their gameplay baseline (clocks ride
   * out of the baseline test because a value that only ever rises proves
   * nothing; no key names are needed).
   */
  changes: Schema.Array(GamePlaytestStateChange),
  /**
   * GameState keys whose last value never appears in the visible on-screen
   * text. Feedback for the agent, not a verdict; absent when the probe reports
   * no screen text.
   */
  notOnScreen: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type GamePlaytestState = typeof GamePlaytestState.Type;
export const GamePlaytestStep = Schema.Union([
  Schema.Struct({
    key: Schema.String.annotate({
      description: 'Key to hold while playing, such as "ArrowUp", "w", "Space".',
    }),
    holdMs: Schema.Number.annotate({ description: "Hold the key for this long." }),
  }),
  Schema.Struct({
    keys: Schema.Array(Schema.String).annotate({
      description:
        'Keys to hold at the same time, such as ["Shift", "w"] for a running jump or ["w", "Space"].',
    }),
    holdMs: Schema.Number.annotate({ description: "Hold every key for this long." }),
  }),
  Schema.Struct({ waitMs: Schema.Number.annotate({ description: "Wait before the next step." }) }),
  Schema.Struct({
    click: Schema.Literals(["left", "middle", "right"]).annotate({
      description:
        "Click this mouse button at the centre of the game canvas. Web games need a click before they can capture the pointer, and menu buttons need a click to press them.",
    }),
  }),
  Schema.Struct({
    mouseMove: Schema.Struct({ dx: Schema.Number, dy: Schema.Number }).annotate({
      description:
        "Move the pointer by dx/dy pixels from its current position, for mouse-look and camera controls.",
    }),
  }),
  Schema.Struct({
    screenshot: Schema.String.check(Schema.isMaxLength(80)).annotate({
      description: "Capture a frame mid-sequence and label it, for evidence between steps.",
    }),
  }),
]);
export type GamePlaytestStep = typeof GamePlaytestStep.Type;
export const GamePlaytestInputPair = Schema.Struct({
  stepIndex: Schema.Int,
  phase: Schema.Literals(["before", "after"]),
  input: GamePlaytestStep,
  changedPercent: Schema.NullOr(Schema.Number),
  stateChanges: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        before: Schema.NullOr(GamePlaytestStateValue),
        after: Schema.NullOr(GamePlaytestStateValue),
      }),
    ),
  ),
});
export type GamePlaytestInputPair = typeof GamePlaytestInputPair.Type;
export const GamePlaytestFrame = Schema.Struct({
  label: Schema.String,
  inputPair: Schema.optionalKey(GamePlaytestInputPair),
  path: Schema.String,
  /**
   * The probe snapshot taken nearest this frame, persisted with the evidence
   * so a cover can be chosen from observed play rather than frame labels.
   * Older evidence and the boot frame may have none.
   */
  probe: Schema.optionalKey(GamePlaytestProbe),
});
export type GamePlaytestFrame = typeof GamePlaytestFrame.Type;
export const GameLastPlaytest = Schema.Struct({
  at: Schema.String,
  directory: Schema.String,
  success: Schema.Boolean,
  responded: Schema.Boolean,
  changedPercent: Schema.Number,
  consoleErrorCount: Schema.Number,
  frames: Schema.Array(GamePlaytestFrame),
  /**
   * The run no longer matches the current game: the web build was rebuilt
   * after it, or its passing evidence no longer matches the current sources.
   * A run that failed to qualify is not marked stale for that reason alone.
   */
  stale: Schema.Boolean,
  /**
   * The frame chosen to represent the game, picked from the persisted
   * per-frame probe state of the latest run that qualified as real play (a
   * real observed moment of play), or null when no run proved gameplay. That
   * run can be older than this newest run when the newest failed to qualify.
   */
  coverFrame: Schema.optionalKey(Schema.NullOr(GamePlaytestFrame)),
  /**
   * Whether the newest run counted as honest gameplay evidence. `success`
   * only says the browser run booted, responded and logged no errors; a run
   * that did none of the play it owed is still a successful tool call. Absent
   * on evidence written before the verdict existed.
   */
  qualifies: Schema.optionalKey(Schema.Boolean),
  /** Structured reasons the run did not qualify; empty when it did. */
  blockers: Schema.optionalKey(Schema.Array(Schema.String)),
  /** What changed from the run's gameplay baseline, when the probe saw it. */
  interaction: Schema.optionalKey(Schema.String),
  /**
   * The ordinary-input route this run used. A review replays the same route on
   * both builds, so it is not chosen again after the fact.
   */
  steps: Schema.optionalKey(Schema.Array(GamePlaytestStep)),
  /**
   * The base viewport the route was recorded at, when the evidence kept it.
   * A review replays the route in the same frame, so a different window size
   * cannot be mistaken for a gameplay difference.
   */
  viewport: Schema.optionalKey(GameViewport),
});
export type GameLastPlaytest = typeof GameLastPlaytest.Type;
/**
 * One qualification stage. `design` is the creator's approval of the current
 * DESIGN.md; `state` grades the approved behaviour criteria.
 */
export const GameQualificationStage = Schema.Literals([
  "design",
  "check",
  "test",
  "export",
  "playtest",
  "state",
]);
export type GameQualificationStage = typeof GameQualificationStage.Type;
export const GameQualificationStageStatus = Schema.Literals([
  "passed",
  "failed",
  "missing",
  "stale",
  "unknown",
]);
export type GameQualificationStageStatus = typeof GameQualificationStageStatus.Type;
/**
 * Playable completion is deliberately narrower than qualification: a current
 * web export plus a playtest that played those exact bytes. Check, test, the
 * state exam are certification, and stay optional.
 */
export const GameCompletionState = Schema.Literals(["complete", "incomplete", "unknown"]);
export type GameCompletionState = typeof GameCompletionState.Type;
export const GameQualificationStageRead = Schema.Struct({
  stage: GameQualificationStage,
  status: GameQualificationStageStatus,
  /** The source snapshot the stage recorded, or null when it never recorded one. */
  sourceId: Schema.NullOr(Schema.String),
  /** The build an export produced or a playtest played, when applicable. */
  buildId: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  /** The per-criterion result the state stage recorded, when there is one. */
  criteria: Schema.optionalKey(Schema.Array(GameScenarioCriterionResult)),
  /** Proven/failed/missing counts per kind for the state stage. */
  coverage: Schema.optionalKey(Schema.Array(GameScenarioKindCoverage)),
  /** Why the state stage passed or failed, including legacy rules. */
  detail: Schema.optionalKey(Schema.String),
  /** For an export, the build-addressed directory its files live in. */
  buildDirectory: Schema.optionalKey(Schema.String),
});
export type GameQualificationStageRead = typeof GameQualificationStageRead.Type;
/**
 * The server's own verdict, derived from records it wrote after real operations.
 * A stage only counts while its source snapshot (and, for playtests, its build)
 * still matches the files on disk. `unknown` means the source tree could not be
 * snapshotted within the scan bound, so nothing can be called current.
 */
export const GameQualificationRead = Schema.Struct({
  state: Schema.Literals(["qualified", "unqualified", "unknown"]),
  /**
   * Playable completion: the current web export and a playtest of those exact
   * bytes. It does not require the optional certification stages, so a game
   * that ships a playable build is complete even when test/state are missing.
   */
  completion: GameCompletionState,
  /**
   * Every mechanical stage and the design passed. Review decisions are separate
   * and do not certify all presentation criteria.
   */
  mechanicsQualified: Schema.Boolean,
  /** The game's current source snapshot, or null when it is unknown. */
  sourceId: Schema.NullOr(Schema.String),
  /** The current qualified web build, when one exists. */
  buildId: Schema.NullOr(Schema.String),
  /**
   * Identity of the web build actually served from `builds/web`, from the
   * export record's artifact descriptor while those bytes are still on disk.
   * Current with stale sources is not the same thing: a source edit or a failed
   * rebuild must not treat the running preview as replaced.
   */
  servedArtifactId: Schema.NullOr(Schema.String),
  stages: Schema.Array(GameQualificationStageRead),
});
export type GameQualificationRead = typeof GameQualificationRead.Type;
/**
 * A game operation the server is running, or the last one it ran. Its events
 * replace polling: a stage opened while idle learns about a later agent build
 * from the push, not from a two-second status loop.
 */
export const GameOperationState = Schema.Literals(["running", "succeeded", "failed"]);
export type GameOperationState = typeof GameOperationState.Type;
export const GameStatus = Schema.Struct({
  root: Schema.String,
  manifest: GameManifest,
  /** The server-owned design lifecycle: the approval record, never game.json alone. */
  design: GameDesignRead,
  /** Game-relative paths, when the file exists on disk. */
  designPath: Schema.NullOr(Schema.String),
  briefPath: Schema.NullOr(Schema.String),
  toolchain: GameToolchainStatus,
  assets: Schema.Array(Schema.Struct({ ...GameAsset.fields, usedBy: Schema.Array(Schema.String) })),
  scenes: Schema.Array(Schema.String),
  /**
   * The design resolution from `godot/project.godot`, in which the web preview
   * is framed. Falls back to Godot's own default when the project does not set one.
   */
  viewport: GameViewport,
  /** A web build exists but game sources changed after it: play would be out of date. */
  webBuildStale: Schema.Boolean,
  /**
   * The selected build's identity, whether or not its files are still usable.
   * A candidate export never changes it; only promotion or a direct publish does.
   */
  selectedBuildId: Schema.NullOr(Schema.String),
  /**
   * Whether every served file of the selected build is still present and
   * nonempty. Null when nothing is selected. Byte identity is checked when Play
   * opens the build, not on every status read.
   */
  selectedArtifactUsable: Schema.NullOr(Schema.Boolean),
  /**
   * Whether the current source bytes are the ones the selected build was
   * exported from. `"unknown"` is status's cheap answer: byte freshness costs
   * a full source read, so it is only computed on an explicit check (status
   * with `checkSources`, or a round decision). This says nothing about whether
   * the selected build itself is usable.
   */
  sourcesDifferFromPlay: Schema.Union([Schema.Boolean, Schema.Literal("unknown")]),
  /** Server-owned qualification of the current sources. */
  qualification: GameQualificationRead,
  builds: Schema.Array(
    Schema.Struct({ target: Schema.String, path: Schema.String, updatedAt: Schema.String }),
  ),
  processes: Schema.Array(
    Schema.Struct({ pid: Schema.Number, operation: Schema.String, logPath: Schema.String }),
  ),
  previewUrl: Schema.NullOr(Schema.String),
  logsDirectory: Schema.String,
  lastPlaytest: Schema.NullOr(GameLastPlaytest),
  operation: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      state: GameOperationState,
      message: Schema.String,
      /** When the operation started, so clients can show elapsed time honestly. */
      at: Schema.String,
    }),
  ),
});
export type GameStatus = typeof GameStatus.Type;
/**
 * One push about a game operation, for every client that might be showing that
 * game. `at` identifies the event itself (start and finish are separate events),
 * so a subscriber can tell a repeat from news.
 */
export const GameOperationEvent = Schema.Struct({
  revision: Schema.optionalKey(Schema.Number),
  root: Schema.String,
  name: Schema.String,
  state: Schema.Union([GameOperationState, Schema.Literal("cancelled")]),
  message: Schema.String,
  at: Schema.String,
});
export type GameOperationEvent = typeof GameOperationEvent.Type;
/**
 * The cheap library verdict: the server's qualification record and design
 * record, without walking the game's sources. `asOf` is when the record was
 * written; the Stage still does the exact check against the files on disk.
 */
export const GameQualificationSummary = Schema.Struct({
  state: Schema.Literals(["qualified", "unqualified"]),
  /** The playable build the record proves, without a source walk. */
  completion: Schema.Literals(["complete", "incomplete"]),
  asOf: Schema.NullOr(Schema.String),
});
export type GameQualificationSummary = typeof GameQualificationSummary.Type;
export const GameCreateInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  parentDirectory: Schema.String,
  template: Schema.optionalKey(GameTemplateId),
  brief: Schema.String.check(Schema.isMinLength(1)),
  artDirection: Schema.optionalKey(Schema.String),
  /** Write DESIGN.md before building. Defaults to true. */
  planFirst: Schema.optionalKey(Schema.Boolean),
  /**
   * Wait for the creator to approve each DESIGN.md revision before building.
   * Defaults to false: the server records every revision itself and the agent
   * builds in the same turn.
   */
  reviewDesign: Schema.optionalKey(Schema.Boolean),
  modelSelection: ModelSelection,
  runtimeMode: Schema.optionalKey(RuntimeMode),
});
export type GameCreateInput = typeof GameCreateInput.Type;
export const GameOpenInput = Schema.Struct({ path: Schema.String, modelSelection: ModelSelection });
export const GameProjectResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  root: Schema.String,
});
/**
 * One row in the games library. It is a batched read: the sidebar must not ask
 * for a game's status once per project. `coverImagePath` is game-relative; the
 * client asks the asset service for a URL only when it actually shows a cover.
 */
export const GameSummary = Schema.Struct({
  projectId: ProjectId,
  root: Schema.String,
  name: Schema.String,
  template: Schema.NullOr(GameTemplateId),
  /** The server-owned design lifecycle, not game.json's display mirror. */
  designState: Schema.NullOr(GameDesignState),
  /** The operation running now, or the last one, for a building label. */
  operation: Schema.NullOr(Schema.Struct({ name: Schema.String, state: GameOperationState })),
  /** The qualification record's verdict, as of when it was written. */
  qualification: GameQualificationSummary,
  updatedAt: Schema.String,
  coverImagePath: Schema.NullOr(Schema.String),
});
export type GameSummary = typeof GameSummary.Type;
export const GameListResult = Schema.Array(GameSummary);
export type GameListResult = typeof GameListResult.Type;
export const GameThreadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * Ask the status read for the byte comparison it otherwise leaves
   * `unknown`; the read walks and hashes every source file when set.
   */
  checkSources: Schema.optionalKey(Schema.Boolean),
});
export const GameAction = Schema.Literals([
  "verify",
  "preview",
  "rebuild",
  "native",
  "stop",
  "export-linux",
]);
export type GameAction = typeof GameAction.Type;
export const GameActionInput = Schema.Struct({ threadId: ThreadId, action: GameAction });
export const GameActionResult = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.String,
  path: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  process: Schema.NullOr(GameProcessResult),
});
export type GameActionResult = typeof GameActionResult.Type;
export const GameConsoleMessage = Schema.Struct({
  level: Schema.Literals(["log", "info", "warning", "error"]),
  text: Schema.String,
});
export type GameConsoleMessage = typeof GameConsoleMessage.Type;
export const GamePlaytestScreenshot = Schema.Struct({
  label: Schema.String,
  inputPair: Schema.optionalKey(GamePlaytestInputPair),
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  /** The latest probe state when this frame was taken, so evidence can pair them. */
  probe: Schema.optionalKey(GamePlaytestProbe),
});
export type GamePlaytestScreenshot = typeof GamePlaytestScreenshot.Type;
/**
 * The capture envelope. A routine agent mistake must not hold the game's
 * operation lock for hours, allocate a huge result, or push an oversized frame
 * over the websocket. Step counts, per-step and total durations are enforced by
 * `playtestInputIssues` because they span the whole sequence.
 */
export const GAME_PLAYTEST_BOUNDS = {
  minDimension: 320,
  maxDimension: 1920,
  maxStepMs: 10_000,
  maxSequenceMs: 120_000,
  maxSteps: 60,
  maxScreenshotSteps: 12,
  maxBootTimeoutMs: 120_000,
  /** Aggregate PNG bytes returned to the caller; the rest stay as evidence. */
  maxResultImageBytes: 6 * 1024 * 1024,
} as const;
export const GameWebPlaytestInput = Schema.Struct({
  steps: Schema.optionalKey(Schema.Array(GamePlaytestStep)),
  width: Schema.optionalKey(
    Schema.Number.check(
      Schema.isBetween({
        minimum: GAME_PLAYTEST_BOUNDS.minDimension,
        maximum: GAME_PLAYTEST_BOUNDS.maxDimension,
      }),
    ),
  ),
  height: Schema.optionalKey(
    Schema.Number.check(
      Schema.isBetween({
        minimum: GAME_PLAYTEST_BOUNDS.minDimension,
        maximum: GAME_PLAYTEST_BOUNDS.maxDimension,
      }),
    ),
  ),
  bootTimeoutMs: Schema.optionalKey(
    Schema.Number.check(
      Schema.isBetween({ minimum: 1, maximum: GAME_PLAYTEST_BOUNDS.maxBootTimeoutMs }),
    ),
  ),
});
export type GameWebPlaytestInput = typeof GameWebPlaytestInput.Type;
export const GameWebPlaytestResult = Schema.Struct({
  /** Actual dispatched input steps; absent in older recordings. */
  executedInputSteps: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  success: Schema.Boolean,
  booted: Schema.Boolean,
  bootMs: Schema.NullOr(Schema.Number),
  responded: Schema.Boolean,
  /** Share of sampled pixels that changed between the boot and after-steps frames. */
  changedPercent: Schema.Number,
  message: Schema.String,
  consoleMessages: Schema.Array(GameConsoleMessage),
  screenshots: Schema.Array(GamePlaytestScreenshot),
  /** Null when the game has no StudioProbe (games created before the probe existed). */
  state: Schema.NullOr(GamePlaytestState),
  /**
   * Approved observe criteria this playtest happened to satisfy. Informational:
   * the server-owned scenario runner is what gates the state stage.
   */
  designObservations: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Game-relative evidence directory, when the service persisted this run. */
  evidenceDirectory: Schema.optionalKey(Schema.String),
  /** Whether this run was honest gameplay evidence for the game's exam. */
  qualifies: Schema.optionalKey(Schema.Boolean),
  /** Structured reasons this run did not qualify; empty when it qualified. */
  blockers: Schema.optionalKey(Schema.Array(Schema.String)),
  /** What changed from the run's gameplay baseline, human readable. */
  interaction: Schema.optionalKey(Schema.String),
  /**
   * The stage's pause/mute bridge, exercised once by the driver like the play
   * surface does. Null when the check did not run; otherwise true only when
   * both ends of the postMessage confirmed the hidden pause.
   */
  pauseConfirmed: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  /** The project's base viewport the frames were scaled up from. */
  baseViewport: Schema.optionalKey(GameViewport),
  /** The integer multiple of the base viewport the frames were captured at. */
  captureScale: Schema.optionalKey(Schema.Number),
});
export type GameWebPlaytestResult = typeof GameWebPlaytestResult.Type;
export const GameCheckIssue = Schema.Struct({
  file: Schema.String,
  line: Schema.optionalKey(Schema.Number),
  message: Schema.String,
});
export type GameCheckIssue = typeof GameCheckIssue.Type;
export const GameCheckResult = Schema.Struct({
  ok: Schema.Boolean,
  errors: Schema.Array(GameCheckIssue),
  warnings: Schema.Array(GameCheckIssue),
  /** Which entry scenes the checker actually ran, in order: `main`, then `gameplay`. */
  entries: Schema.Array(Schema.String),
  durationMs: Schema.Number,
});
export type GameCheckResult = typeof GameCheckResult.Type;
export const GameSceneNode = Schema.Struct({
  /** Scene-relative node path; "." is the scene root. */
  path: Schema.String,
  name: Schema.String,
  type: Schema.String,
  script: Schema.optionalKey(Schema.String),
  groups: Schema.Array(Schema.String),
  position: Schema.optionalKey(Schema.Array(Schema.Number)),
  collisionLayer: Schema.optionalKey(Schema.Number),
  collisionMask: Schema.optionalKey(Schema.Number),
  /** Direct child names, in scene order. */
  children: Schema.Array(Schema.String),
});
export type GameSceneNode = typeof GameSceneNode.Type;
export const GameSceneInspectInput = Schema.Struct({ scenePath: Schema.String });
export const GameSceneInspectResult = Schema.Struct({
  scenePath: Schema.String,
  nodes: Schema.Array(GameSceneNode),
  nodeCount: Schema.Number,
  truncated: Schema.Boolean,
});
export type GameSceneInspectResult = typeof GameSceneInspectResult.Type;
export const GameBlenderInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/)),
  script: Schema.String,
  thumbnail: Schema.optionalKey(Schema.Boolean),
  reset: Schema.optionalKey(Schema.Boolean),
});
export const GameBlenderResult = Schema.Struct({
  asset: GameAsset,
  objects: Schema.Number,
  meshes: Schema.Number,
  materials: Schema.Number,
  dimensions: Schema.Array(Schema.Number),
  warnings: Schema.Array(Schema.String),
  process: GameProcessResult,
});
