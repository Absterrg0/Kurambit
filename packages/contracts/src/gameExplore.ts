import * as Schema from "effect/Schema";
import {
  GamePlaytestProbe,
  GamePlaytestState,
  GamePlaytestStep,
  GameConsoleMessage,
  GameViewport,
} from "./game.ts";

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
const hex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const GameExploreTarget = Schema.Literals(["web", "native"]);
export type GameExploreTarget = typeof GameExploreTarget.Type;

export const GameExploreStartInput = Schema.Struct({
  /**
   * The recorded export to explore. Omitted means the build Play currently
   * serves; a missing selection is an error, never a fresh export.
   * Ignored for target native, which plays the current game sources.
   */
  buildId: Schema.optionalKey(hex64),
  /** Which backend to play through. Omitted means the frozen Web export. */
  target: Schema.optionalKey(GameExploreTarget),
  /** Capture width in pixels; defaults to the playtest box. Native always runs at the project's window size. */
  width: Schema.optionalKey(Schema.Finite),
  /** Capture height in pixels; defaults to the playtest box. Native always runs at the project's window size. */
  height: Schema.optionalKey(Schema.Finite),
  /** How long to wait for Godot to boot. */
  bootTimeoutMs: Schema.optionalKey(Schema.Finite),
});
export type GameExploreStartInput = typeof GameExploreStartInput.Type;

export const GameExploreStartResult = Schema.Struct({
  sessionId,
  /** The trace this session saves; replay names it after close. */
  traceId: Schema.String,
  target: GameExploreTarget,
  /** For web the frozen export; for native the current source snapshot id. */
  buildId: Schema.String,
  sourceId: Schema.NullOr(Schema.String),
  /** The frozen capture window every act plays in. */
  viewport: GameViewport,
  baseViewport: GameViewport,
  captureScale: Schema.Number,
  booted: Schema.Boolean,
  bootMs: Schema.NullOr(Schema.Number),
  pauseConfirmed: Schema.NullOr(Schema.Boolean),
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
 * Steps an exploration act may carry. Web accepts the shared playtest steps;
 * native additionally accepts ui (real mouse at a listed control) and inspect
 * (read-only reflection). The service rejects ui/inspect on web.
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
  traceId: Schema.String,
  /** Absolute server-owned path of the persisted trace. */
  tracePath: Schema.String,
  traceSaved: Schema.Boolean,
  reason: Schema.String,
  actions: Schema.Int,
  executedInputSteps: Schema.Int,
  totalNominalMs: Schema.Number,
  images: Schema.Int,
  message: Schema.String,
});
export type GameExploreCloseResult = typeof GameExploreCloseResult.Type;

export const GameExploreReplayInput = Schema.Struct({
  /** A trace id from a closed exploration session. Never an arbitrary path. */
  traceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type GameExploreReplayInput = typeof GameExploreReplayInput.Type;

export const GameExploreReplayFrame = Schema.Struct({
  label: Schema.String,
  /** Absolute server-owned path of this replay's own fresh frame. */
  path: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  probe: Schema.optionalKey(GamePlaytestProbe),
});
export type GameExploreReplayFrame = typeof GameExploreReplayFrame.Type;

export const GameExploreReplayResult = Schema.Struct({
  traceId: Schema.String,
  buildId: Schema.String,
  /** Absolute server-owned directory of this replay's own fresh evidence. */
  evidenceDirectory: Schema.String,
  success: Schema.Boolean,
  booted: Schema.Boolean,
  responded: Schema.Boolean,
  message: Schema.String,
  /** The fresh run's own probe summary. The trace's probe is never replayed. */
  state: Schema.NullOr(GamePlaytestState),
  consoleMessages: Schema.Array(GameConsoleMessage),
  frames: Schema.Array(GameExploreReplayFrame),
});
export type GameExploreReplayResult = typeof GameExploreReplayResult.Type;
