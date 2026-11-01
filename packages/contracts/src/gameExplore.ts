import * as Schema from "effect/Schema";
import { GamePlaytestProbe, GamePlaytestStep, GameConsoleMessage, GameViewport } from "./game.ts";

/**
 * Bounded persistent exploration: short act/observe cycles against one frozen
 * export, saved as a server-owned trace, then independently replayed. One
 * live browser session exists globally (a 16 GB host cannot hold two
 * headless Chromes beside a dev server); exploration never qualifies,
 * promotes or passes quality — only a fresh replay of the saved sequence
 * counts as independent confirmation, and only of the traced steps.
 */
export const GAME_EXPLORE_BOUNDS = {
  /** Input steps one act call may carry. Short cycles stay observable. */
  maxStepsPerCall: 6,
  /** Nominal game time one act call may advance. */
  maxSequenceMsPerCall: 10_000,
  /** Act calls one session may make. */
  maxCalls: 16,
  /** Input steps one session may execute in total. */
  maxTotalSteps: 48,
  /** Nominal game milliseconds one session may advance in total. */
  maxTotalNominalMs: 60_000,
  /** Persisted screenshots one session may keep. One per act. */
  maxImages: 24,
  /** Serialized trace bytes one session may keep. */
  maxTraceBytes: 256 * 1024,
  /** Wall time a session may stay open before it is expired and saved. */
  wallTtlMs: 20 * 60_000,
  /** Idle time before an untouched session is expired and saved. */
  idleTtlMs: 5 * 60_000,
  /** Console messages returned (and traced) per act. */
  maxConsolePerAct: 20,
  /** Characters kept per console message. */
  maxConsoleChars: 500,
  /** Interactive controls listed per native act. */
  maxUiPerAct: 64,
  /** Visible text entries per native act. */
  maxTextPerAct: 128,
  /** Script/engine errors returned per native act. */
  maxErrorsPerAct: 20,
  /** Values kept per inspect step. */
  maxInspectValues: 64,
} as const;

const sessionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/**
 * Exploration plays the current game sources natively with the game paused
 * between acts. There is no web backend: the game under test is the live
 * folder, never an export.
 */
export const GameExploreStartInput = Schema.Struct({
  /** How long to wait for Godot to boot. */
  bootTimeoutMs: Schema.optionalKey(Schema.Finite),
});
export type GameExploreStartInput = typeof GameExploreStartInput.Type;

export const GameExploreStartResult = Schema.Struct({
  sessionId,
  /** The current source snapshot id. */
  buildId: Schema.String,
  sourceId: Schema.NullOr(Schema.String),
  /** The project window every act plays in. */
  viewport: GameViewport,
  booted: Schema.Boolean,
  bootMs: Schema.NullOr(Schema.Number),
  message: Schema.String,
  callsLeft: Schema.Int,
  wallTtlMs: Schema.Int,
  idleTtlMs: Schema.Int,
});
export type GameExploreStartResult = typeof GameExploreStartResult.Type;

export const GameExploreUiStep = Schema.Struct({
  ui: Schema.Struct({
    id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    action: Schema.Literals(["click", "drag"]),
    to: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  }),
});
export type GameExploreUiStep = typeof GameExploreUiStep.Type;

export const GameExploreInspectStep = Schema.Struct({
  inspect: Schema.Struct({
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    properties: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))).check(
        Schema.isMaxLength(GAME_EXPLORE_BOUNDS.maxInspectValues),
      ),
    ),
  }),
});
export type GameExploreInspectStep = typeof GameExploreInspectStep.Type;

/**
 * Steps an exploration act may carry: the shared playtest steps plus ui
 * (real mouse at a listed control) and inspect (read-only reflection).
 */
export const GameExploreStep = Schema.Union([
  GamePlaytestStep,
  GameExploreUiStep,
  GameExploreInspectStep,
]);
export type GameExploreStep = typeof GameExploreStep.Type;

export const GameExploreUiControl = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  rect: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
});
export type GameExploreUiControl = typeof GameExploreUiControl.Type;

export const GameExploreNativeError = Schema.Struct({
  message: Schema.String,
  where: Schema.String,
});
export type GameExploreNativeError = typeof GameExploreNativeError.Type;

export const GameExploreUiResult = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  received: Schema.Boolean,
  detail: Schema.String,
});
export type GameExploreUiResult = typeof GameExploreUiResult.Type;

export const GameExploreInspectValue = Schema.Union([
  Schema.Number,
  Schema.Boolean,
  Schema.String,
  Schema.Null,
  Schema.Array(Schema.Number),
]);
export type GameExploreInspectValue = typeof GameExploreInspectValue.Type;

export const GameExploreInspection = Schema.Struct({
  path: Schema.String,
  values: Schema.Record(Schema.String, GameExploreInspectValue),
  error: Schema.optionalKey(Schema.String),
});
export type GameExploreInspection = typeof GameExploreInspection.Type;

export const GameExploreActInput = Schema.Struct({
  sessionId,
  /** 1–6 route steps. Web takes the shared playtest steps; native also takes ui and inspect. */
  steps: Schema.Array(GameExploreStep).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(GAME_EXPLORE_BOUNDS.maxStepsPerCall),
  ),
});
export type GameExploreActInput = typeof GameExploreActInput.Type;

export const GameExploreActResult = Schema.Struct({
  sessionId,
  callIndex: Schema.Int,
  executedInputSteps: Schema.Int,
  /** Nominal game milliseconds this act advanced. Captures never stretch it. */
  nominalMs: Schema.Number,
  /** The probe sampled after this act ran. Descriptive only, never a verdict. */
  probe: Schema.NullOr(GamePlaytestProbe),
  /** Absolute server-owned path of this act's persisted screenshot, or null when the native run has no display. */
  screenshotPath: Schema.NullOr(Schema.String),
  /** Plain reason when screenshotPath is null (native headless only; web always has a screenshot). */
  screenshotReason: Schema.optionalKey(Schema.String),
  /** Visible text keyed <owner>.<name> (native only). */
  screenText: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Visible interactive controls (native only). */
  ui: Schema.optionalKey(Schema.Array(GameExploreUiControl)),
  /** Script and engine errors since the previous act, with file:line (native only). */
  errors: Schema.optionalKey(Schema.Array(GameExploreNativeError)),
  /** Per ui step, whether the control received real mouse input (native only). */
  uiResults: Schema.optionalKey(Schema.Array(GameExploreUiResult)),
  /** Per inspect step, the read-only values observed (native only). */
  inspections: Schema.optionalKey(Schema.Array(GameExploreInspection)),
  /** Console messages since the previous act, bounded. */
  consoleMessages: Schema.Array(GameConsoleMessage),
  consoleTruncated: Schema.Int,
  message: Schema.String,
  callsLeft: Schema.Int,
  totalNominalMs: Schema.Number,
});
export type GameExploreActResult = typeof GameExploreActResult.Type;

export const GameExploreCloseInput = Schema.Struct({ sessionId });
export type GameExploreCloseInput = typeof GameExploreCloseInput.Type;

export const GameExploreCloseResult = Schema.Struct({
  sessionId,
  reason: Schema.String,
  actions: Schema.Int,
  executedInputSteps: Schema.Int,
  totalNominalMs: Schema.Number,
  images: Schema.Int,
  message: Schema.String,
});
export type GameExploreCloseResult = typeof GameExploreCloseResult.Type;

/** Capture width/height bounds for exploration viewports. */
export const EXPLORE_CAPTURE_BOUNDS = { minDimension: 320, maxDimension: 1920 } as const;

/** Everything wrong with an exploration open request. Empty means the session may open. */
export const exploreCaptureIssues = (input: {
  readonly bootTimeoutMs?: number | undefined;
}): readonly string[] => {
  const issues: string[] = [];
  const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
  if (!Number.isFinite(bootTimeoutMs) || bootTimeoutMs <= 0)
    issues.push("bootTimeoutMs must be a positive number.");
  if (Number.isFinite(bootTimeoutMs) && bootTimeoutMs > 120_000)
    issues.push("bootTimeoutMs must be at most 120000 ms.");
  return issues;
};

/**
 * Keys exploration can send. The browser needs a physical key or a DOM key
 * name; a Godot InputMap action name such as `ui_accept` has neither, so it
 * reaches the game as a key it never receives.
 */
const BROWSER_KEY_NAMES: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "Shift",
  "Control",
  "Alt",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "Delete",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

const exploreStepDurationMs = (step: GameExploreStep): number => {
  if ("press" in step) return 50;
  if ("waitMs" in step) return step.waitMs;
  if ("holdMs" in step) return step.holdMs;
  return 0;
};

/**
 * Everything wrong with exploration steps. Empty means the steps may run.
 * Cheap and pure, so the server rejects before it serves a build or launches
 * the browser.
 */
export const exploreStepIssues = (steps: readonly GameExploreStep[]): readonly string[] => {
  const issues: string[] = [];
  for (const [index, step] of steps.entries()) {
    const duration = exploreStepDurationMs(step);
    if (!Number.isFinite(duration) || duration < 0)
      issues.push(`Step ${index + 1} has an invalid duration.`);
    if (Number.isFinite(duration) && duration > 10_000)
      issues.push(`Step ${index + 1} lasts ${duration} ms; one step may last at most 10000 ms.`);
    const fields: ReadonlyArray<readonly [string, readonly string[]]> =
      "press" in step
        ? [["press", [step.press]]]
        : "hold" in step
          ? [["hold", [step.hold]]]
          : "keys" in step
            ? [["keys", step.keys]]
            : "key" in step
              ? [["key", [step.key]]]
              : [];
    for (const [field, keys] of fields)
      for (const key of keys) {
        if (key.length === 0 || key.length > 80) {
          issues.push(`Step ${index + 1} ${field} must contain 1–80 characters.`);
          continue;
        }
        if (key.length === 1 || BROWSER_KEY_NAMES.has(key)) continue;
        issues.push(
          `Step ${index + 1} ${field} "${key}" is not a browser key. Exploration sends physical keys such as "Enter", "Space", "ArrowLeft", "w" or "F1", not Godot InputMap actions; use the key project.godot binds to the action here.`,
        );
      }
  }
  return issues;
};
