import * as Schema from "effect/Schema";
import { GamePlaytestProbe, GamePlaytestStep, GameConsoleMessage } from "./game.ts";
import { GamePlayMark } from "./gamePlays.ts";

/**
 * Exploration: short act/observe cycles in one browser session on the game's
 * current sources. It never qualifies, promotes or passes quality.
 */
export const GAME_EXPLORE_BOUNDS = {
  /** Input steps one act call may carry. Short cycles stay observable. */
  maxStepsPerCall: 6,
  /**
   * Nominal game time one act call may advance: long enough to watch an opponent's turn, a
   * timer or a lap in one act, which agents asked for (12-30 s) and split across calls when refused.
   */
  maxSequenceMsPerCall: 30_000,
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
  /** One hold or key step's game time; a plain wait may take the whole act's. */
  maxStepMs: 10_000,
  /** Game seconds a scripted act plays when it names none, and the most it may. */
  defaultScriptSeconds: 60,
  maxScriptSeconds: 300,
  /** Probe marks a scripted act answers with, spread over its run. */
  maxTrailMarks: 20,
} as const;

const sessionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/**
 * What a play session starts with as the game's saved data. `fresh` (the
 * default) starts with none and leaves none behind. `keep` uses one stable
 * save location per game and engine under the game's ignored
 * `.studio/saves/`, so what one kept session saves the next one reads; it is
 * never the user's own saves.
 */
export const GameSaves = Schema.Literals(["fresh", "keep"]);
export type GameSaves = typeof GameSaves.Type;

/**
 * Exploration plays the current game sources: three.js games load the static
 * folder in headless Chromium (real keyboard/mouse, screenshots, console
 * errors, a read-only `window.__studio` probe).
 */
export const GameExploreStartInput = Schema.Struct({
  /** How long to wait for the game to boot. */
  bootTimeoutMs: Schema.optionalKey(Schema.Finite),
  /** Omitted means `fresh`. */
  saves: Schema.optionalKey(GameSaves),
});
export type GameExploreStartInput = typeof GameExploreStartInput.Type;

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

/**
 * A scripted act: a module that exports `decide(obs)`, played by the page's stepped runner (shell
 * studio.bot) on a fresh run, each fixed step, pressing the player's own controls.
 */
export const GamePlayScript = Schema.Struct({
  file: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
      description: "A .mjs under .studio/bot/.",
    }),
  ),
  source: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
      description: "Or the module's source inline.",
    }),
  ),
  seconds: Schema.optionalKey(
    Schema.Finite.annotate({ description: "Game seconds before it stops; 60 when omitted, ≤300." }),
  ),
});
export type GamePlayScript = typeof GamePlayScript.Type;

/** The session page's size, as a player's window would be. */
export const GamePlayViewport = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: 320, maximum: 1920 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 240, maximum: 1080 })),
});
export type GamePlayViewport = typeof GamePlayViewport.Type;

/**
 * `game_play` op `act`: input batches in this thread's session; with no `sessionId` it opens one
 * (what op start did) and acts in it. A browser game takes the shared playtest steps only.
 */
export const GamePlayActInput = Schema.Struct({
  sessionId: Schema.optionalKey(sessionId),
  /** Input steps, or `decide`: one of the two. */
  steps: Schema.optionalKey(
    Schema.Array(GamePlaytestStep).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(GAME_EXPLORE_BOUNDS.maxStepsPerCall),
    ),
  ),
  decide: Schema.optionalKey(GamePlayScript),
  viewport: Schema.optionalKey(GamePlayViewport),
  includeImage: Schema.optionalKey(Schema.Boolean).annotate({
    description: "true: each screenshot step's frame too; false: no picture.",
  }),
  ...GameExploreStartInput.fields,
});
export type GamePlayActInput = typeof GamePlayActInput.Type;

/** Most bytes of JSON an `eval` value answers with. */
export const GAME_EVAL_MAX_BYTES = 16 * 1024;

/** `game_play` op `eval`: JavaScript in the session's page, like T3's preview_evaluate. */
export const GameEvalInput = Schema.Struct({
  expression: Schema.NonEmptyString.check(Schema.isMaxLength(20_000)).annotate({
    description:
      "JavaScript run in the playing game's page; awaited; its JSON value answers, ≤16 KB.",
  }),
  sessionId: Schema.optionalKey(sessionId),
});
export type GameEvalInput = typeof GameEvalInput.Type;

export const GameEvalResult = Schema.Struct({ sessionId, value: Schema.Unknown });
export type GameEvalResult = typeof GameEvalResult.Type;

/** Game time the page stepped, and the wall time that stepping took. */
export const GamePlayClock = Schema.Struct({ gameMs: Schema.Number, wallMs: Schema.Number });
export type GamePlayClock = typeof GamePlayClock.Type;

/**
 * From an act's first input to the first change the probe read, in game and wall time, and what
 * changed (`player`, a GameState key, `hud`); null times when nothing changed while it watched.
 * Anything that moves on its own (a timer, gravity) counts: `changed` says what it was.
 */
export const GamePlayResponse = Schema.Struct({
  gameMs: Schema.NullOr(Schema.Number),
  wallMs: Schema.NullOr(Schema.Number),
  watchedMs: Schema.Number,
  changed: Schema.Array(Schema.String),
});
export type GamePlayResponse = typeof GamePlayResponse.Type;

/** A scripted act's run: how it ended, its numbers, the play to replay, and its probe trail. */
export const GamePlayScriptRun = Schema.Struct({
  ended: Schema.Literals(["won", "lost", "stopped", "seconds", "wall", "error"]),
  note: Schema.String,
  seconds: Schema.Number,
  wallMs: Schema.Number,
  decisions: Schema.Number,
  /** The kept run's id: `replay` {"run": id, "at": s} shows a moment, {"save": name, "run": id} makes it a test play. */
  run: Schema.NullOr(Schema.String),
  trail: Schema.Array(GamePlayMark),
});
export type GamePlayScriptRun = typeof GamePlayScriptRun.Type;

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
  /** The frames the act's labelled `screenshot` steps took, in route order. */
  frames: Schema.optionalKey(
    Schema.Array(Schema.Struct({ label: Schema.String, path: Schema.String })),
  ),
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
  /** The page's size this act played at. */
  viewport: Schema.optionalKey(GamePlayViewport),
  clock: Schema.optionalKey(GamePlayClock),
  response: Schema.optionalKey(GamePlayResponse),
  script: Schema.optionalKey(GamePlayScriptRun),
  message: Schema.String,
});
export type GameExploreActResult = typeof GameExploreActResult.Type;

export const GameExploreCloseInput = Schema.Struct({ sessionId });
export type GameExploreCloseInput = typeof GameExploreCloseInput.Type;

export const GameExploreCloseResult = Schema.Struct({
  sessionId,
  reason: Schema.String,
  actions: Schema.Int,
  totalNominalMs: Schema.Number,
  /** Every act's stepping together. */
  clock: Schema.optionalKey(GamePlayClock),
  message: Schema.String,
});
export type GameExploreCloseResult = typeof GameExploreCloseResult.Type;

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
 * name; an engine's input action name such as `ui_accept` has neither, so it
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
  "Meta",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);
/**
 * KeyboardEvent codes, as a game's `ACTIONS` names its keys ("KeyW", "ShiftLeft", "Digit1"):
 * the browser presses them as the physical key.
 */
const BROWSER_KEY_CODE =
  /^(?:Key[A-Z]|Digit\d|Numpad(?:\d|Add|Subtract|Multiply|Divide|Decimal|Enter)|(?:Shift|Control|Alt|Meta)(?:Left|Right)|Minus|Equal|Bracket(?:Left|Right)|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|CapsLock)$/;

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
    // A plain wait may take the act's whole game time; a held key is a press, not a wait.
    const most =
      "waitMs" in step ? GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall : GAME_EXPLORE_BOUNDS.maxStepMs;
    if (Number.isFinite(duration) && duration > most)
      issues.push(`Step ${index + 1} lasts ${duration} ms; this step may last at most ${most} ms.`);
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
        if (key.length === 1 || BROWSER_KEY_NAMES.has(key) || BROWSER_KEY_CODE.test(key)) continue;
        issues.push(
          `Step ${index + 1} ${field} "${key}" is not a browser key. Exploration sends physical keys such as "Enter", "Space", "ArrowLeft", "w", "KeyW" or "ShiftLeft", not input action names; use the key the game binds to the action.`,
        );
      }
  }
  return issues;
};
