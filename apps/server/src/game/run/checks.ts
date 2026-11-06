// A ladder check that names state the game reports is scored by code, not by a
// model's reading: the plan writes the scenario and the expectation, a generated
// bot plays the scenario through the shared play session, and the expectation is
// evaluated here against what the game reported. Pure: no I/O.

/**
 * Where a scenario begins: in a run (the bot leaves the title the way the
 * starter shells take it, Enter on the focused Play), or on the title itself.
 */
export type CheckStart = "play" | "title";

/** Scenario input, in game time: hold a key, tap one, or let the game run. */
export type CheckInput =
  | { readonly hold: string; readonly ms: number }
  | { readonly press: string }
  | { readonly wait: number };

export type CheckValue = number | boolean | string;
type Ref =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "delta"; readonly key: string }
  | { readonly kind: "hud" };
type Op = "==" | "!=" | ">=" | "<=" | ">" | "<" | "contains";
export type Term = { readonly ref: Ref; readonly op: Op; readonly value: CheckValue };

/** What the game reported around the scenario. */
export type Observed = {
  readonly start: Record<string, unknown>;
  readonly end: Record<string, unknown>;
  readonly hud: string;
  /** Keys whose value the report cut to its first 60 characters (lists and objects among them). */
  readonly cut?: ReadonlyArray<string>;
  /** Enter presses when a scenario meant to start in a run never left the title, else 0. */
  readonly stuckOnTitle?: number;
};

export const MAX_INPUT_MS = 20_000;
/**
 * How a check's evidence starts when the check itself, not the game, failed:
 * nothing played could show it. The run rewrites such a check, and never
 * counts the round against the game.
 */
export const CANNOT_VERIFY = "cannot be verified in play: ";
const MAX_KEY = 64;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TERM =
  /^\s*(delta\(\s*([^)\s]+)\s*\)|hud|[A-Za-z_][A-Za-z0-9_.]*)\s*(==|!=|>=|<=|>|<|contains)\s*(.+?)\s*$/;

const literal = (text: string): CheckValue | null => {
  const t = text.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  const quoted = /^"([^"]*)"$|^'([^']*)'$/.exec(t);
  return quoted === null ? null : (quoted[1] ?? quoted[2] ?? "");
};

/** `zone >= 3 and won == true`, `delta(score) >= 1`, `hud contains "Best: Zone"`. */
export const parseExpect = (
  text: string,
): { readonly terms: ReadonlyArray<Term> } | { readonly error: string } => {
  const parts = text.split(/\s+and\s+/);
  if (text.trim().length === 0) return { error: "expect is empty" };
  if (parts.length > 4) return { error: "expect joins at most 4 terms with and" };
  const terms: Term[] = [];
  for (const part of parts) {
    const m = TERM.exec(part);
    if (m === null)
      return {
        error: `"${part.trim()}" is not <state key | delta(key) | hud> <== != >= <= > < contains> <number | true | false | "text">`,
      };
    const [, refText, deltaKey, op, valueText] = m;
    const value = literal(valueText!);
    if (value === null)
      return { error: `"${valueText}" is not a number, true, false or quoted text` };
    const ref: Ref =
      deltaKey !== undefined
        ? { kind: "delta", key: deltaKey }
        : refText === "hud"
          ? { kind: "hud" }
          : { kind: "key", key: refText! };
    if (ref.kind !== "hud" && !KEY.test(ref.key))
      return { error: `"${ref.key}" is not a state key` };
    // The check bot's report carries each key twice; bounded keys keep it whole.
    if (ref.kind !== "hud" && ref.key.length > MAX_KEY)
      return { error: `"${ref.key.slice(0, 20)}…" is longer than ${MAX_KEY} characters` };
    if (op === "contains" && ref.kind !== "hud" && typeof value !== "string")
      return { error: "contains takes quoted text" };
    if (ref.kind === "delta" && typeof value !== "number")
      return { error: "delta(...) compares to a number" };
    terms.push({ ref, op: op as Op, value });
  }
  return { terms };
};

const lookup = (state: Record<string, unknown>, key: string): unknown => {
  if (key in state) return state[key];
  let at: unknown = state;
  for (const part of key.split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
};

const compare = (actual: unknown, op: Op, expected: CheckValue): boolean => {
  if (op === "contains")
    return (
      typeof actual === "string" && actual.toLowerCase().includes(String(expected).toLowerCase())
    );
  if (typeof expected === "number") {
    const n =
      typeof actual === "number" ? actual : typeof actual === "string" ? Number(actual) : NaN;
    if (!Number.isFinite(n)) return false;
    return op === "=="
      ? n === expected
      : op === "!="
        ? n !== expected
        : op === ">="
          ? n >= expected
          : op === "<="
            ? n <= expected
            : op === ">"
              ? n > expected
              : n < expected;
  }
  const same = actual === expected || String(actual) === String(expected);
  return op === "==" ? same : op === "!=" ? !same : false;
};

const shown = (v: unknown) => (v === undefined ? "missing" : JSON.stringify(v));

/** Each term against what the game reported; a key the game never reports fails, saying so. */
export const evaluate = (
  terms: ReadonlyArray<Term>,
  seen: Observed,
): { readonly pass: boolean; readonly detail: string; readonly missing: ReadonlyArray<string> } => {
  const missing: string[] = [];
  const lines = terms.map((t) => {
    let actual: unknown;
    if (t.ref.kind === "hud") actual = seen.hud;
    else if (t.ref.kind === "key") actual = lookup(seen.end, t.ref.key);
    else {
      const a = Number(lookup(seen.start, t.ref.key));
      const b = Number(lookup(seen.end, t.ref.key));
      actual = Number.isFinite(a) && Number.isFinite(b) ? b - a : undefined;
    }
    if (actual === undefined && t.ref.kind !== "hud") missing.push(t.ref.key);
    const ok = actual !== undefined && compare(actual, t.op, t.value);
    const name =
      t.ref.kind === "key" ? t.ref.key : t.ref.kind === "delta" ? `delta(${t.ref.key})` : "hud";
    const value = t.ref.kind === "hud" ? JSON.stringify(seen.hud.slice(0, 120)) : shown(actual);
    return {
      ok,
      text: `${name} ${t.op} ${JSON.stringify(t.value)}: ${ok ? "yes" : "no"} (read ${value})`,
    };
  });
  return { pass: lines.every((l) => l.ok), detail: lines.map((l) => l.text).join("; "), missing };
};

/** The scenario's total game time, for the bot's wall budget. */
export const inputMs = (input: ReadonlyArray<CheckInput>): number =>
  input.reduce((sum, s) => sum + ("hold" in s ? s.ms : "wait" in s ? s.wait : 100), 0);

/** The state keys an expectation reads; the bot reports only these. */
export const keysOf = (terms: ReadonlyArray<Term>): ReadonlyArray<string> => [
  ...new Set(terms.flatMap((t) => (t.ref.kind === "hud" ? [] : [t.ref.key]))),
];

/** The text a HUD term looks for; the bot reports the HUD lines that hold it. */
export const needlesOf = (terms: ReadonlyArray<Term>): ReadonlyArray<string> =>
  terms.flatMap((t) => (t.ref.kind === "hud" ? [String(t.value)] : []));

/**
 * What a check bot reported in its status evidence, or null when that is not
 * its report. The report is bounded by construction (at most 4 keys of at most
 * 64 characters, values cut to 60, the HUD to 200), so it always fits the bot
 * status's 4096-byte evidence: one missing is a fault of ours, not the game's.
 */
export const readReport = (evidence: unknown): Observed | null => {
  if (evidence === null || typeof evidence !== "object") return null;
  const { s, e, h, title, cut } = evidence as {
    s?: unknown;
    e?: unknown;
    h?: unknown;
    title?: unknown;
    cut?: unknown;
  };
  if (s === null || typeof s !== "object" || e === null || typeof e !== "object") return null;
  return {
    start: s as Record<string, unknown>,
    end: e as Record<string, unknown>,
    hud: typeof h === "string" ? h : "",
    stuckOnTitle: typeof title === "number" ? title : 0,
    cut: Array.isArray(cut) ? cut.filter((key): key is string => typeof key === "string") : [],
  };
};

/**
 * A bot that plays one check's scenario and reports what the game showed; it
 * judges nothing. It waits for the probe, records the start state, plays the
 * input in game time, lets the game settle, then reports
 * the named keys at start and end and the HUD text, in its status evidence (the
 * note is prose and cut short), holding just what the expectation reads.
 */
export const checkBot = (spec: {
  readonly what: string;
  readonly from: CheckStart;
  readonly input: ReadonlyArray<CheckInput>;
  readonly keys: ReadonlyArray<string>;
  readonly needles: ReadonlyArray<string>;
}): string => `// Generated by Kurambit from a ladder check. Edit the ladder's check, not this file.
export const goal = ${JSON.stringify(`Check: ${spec.what}`)};
export const tempo = 10;
export const switchMargin = 0;
export const stallSeconds = ${Math.ceil(inputMs(spec.input) / 1000) + 30};
const from = ${JSON.stringify(spec.from)};
const input = ${JSON.stringify(spec.input)};
const keys = ${JSON.stringify(spec.keys)};
const needles = ${JSON.stringify(spec.needles.map((n) => n.toLowerCase()))};
let phase = "wait";
let pressedAt = -9;
let onTitle = false;
let onTitleAtStart = false;
let since = null;
let step = 0;
let start = null;
let end = null;
let hud = "";
// Wall time, not the game's clock: many games stop their clock when paused, and a
// scenario that waits on it would never finish once the game pauses.
const seconds = () => Date.now() / 1000;
let titlePresses = 0;
export function observe(api, last) {
  const t = seconds();
  const gs = last?.probe?.gameState;
  if (gs && typeof gs === "object") end = gs;
  if (typeof last?.probe?.hudText === "string") hud = last.probe.hudText;
  if (since === null) since = t;
  // A run starts from the title by Enter, one press a second; after 10 s the
  // scenario goes on and the report shows the title it stayed on.
  if (phase === "wait" && from === "play" && end?.state === "title" && t - since < 10) {
    if (t - pressedAt >= 1) {
      api.press("Enter");
      pressedAt = t;
      titlePresses += 1;
    }
    onTitle = true;
    return { phase };
  }
  if (phase === "wait" && onTitle) {
    onTitle = false;
    since = t;
  }
  if (phase === "wait" && end !== null && t - since >= 0.5) {
    onTitleAtStart = from === "play" && end?.state === "title";
    start = end;
    phase = "input";
    since = t;
  }
  if (phase === "input") {
    const s = input[step];
    if (s === undefined) {
      phase = "settle";
      since = t;
    } else if ("press" in s) {
      api.press(s.press);
      step += 1;
      since = t;
    } else if ("hold" in s) {
      api.hold(s.hold);
      if ((t - since) * 1000 >= s.ms) {
        api.release(s.hold);
        step += 1;
        since = t;
      }
    } else if ((t - since) * 1000 >= s.wait) {
      step += 1;
      since = t;
    }
  }
  if (phase === "settle" && t - since >= 0.5) phase = "report";
  return { phase };
}
export function options() {
  return [{ name: "scenario", run: () => "running" }];
}
export function policy() {
  return "scenario";
}
const read = (state, key) => {
  if (state === null) return null;
  if (key in state) return state[key];
  let at = state;
  for (const part of key.split(".")) at = at !== null && typeof at === "object" ? at[part] : undefined;
  return at === undefined ? null : at;
};
// The report fits the bot status's 4096-byte evidence whatever the game holds:
// at most 4 keys of at most 64 characters, each value a number, a boolean or
// text of at most 60 characters. A list or an object becomes the start of its
// JSON text, and the report names every value it cut.
const cut = new Set();
const pick = (state) => {
  const out = {};
  for (const key of keys) {
    const v = read(state, key);
    if (v === null) continue;
    if (typeof v === "number" || typeof v === "boolean") out[key] = Number.isFinite(v) || typeof v === "boolean" ? v : String(v);
    else {
      const text = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
      if (text.length > 60 || typeof v !== "string") cut.add(key);
      out[key] = text.slice(0, 60);
    }
  }
  return out;
};
export function status(obs) {
  if (obs.phase !== "report") return { state: "running", note: \`stopped at \${obs.phase}\${obs.phase === "input" ? \` step \${step + 1} of \${input.length}\` : ""}\` };
  const lines = hud.split("\\n").filter((l) => needles.some((n) => l.toLowerCase().includes(n)));
  const h = (lines.length > 0 ? lines.join("\\n") : hud).slice(0, 200);
  const s = pick(start);
  const e = pick(end);
  return { state: "done", note: "scenario reported", evidence: { s, e, h, title: onTitleAtStart ? titlePresses : 0, cut: [...cut] } };
}
`;

// ── Check lint: what a check may ask, so every check can be verified in play.
const WORD_NUMBER: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  dozen: 12,
  twenty: 20,
  hundred: 100,
};
const numberOf = (word: string): number =>
  /^\d+$/.test(word) ? Number(word) : (WORD_NUMBER[word.toLowerCase()] ?? 0);
const VOLUME_TEXT = [/\bat least (\d+|[a-z]+)\b/gi, /\b(\d+|[a-z]+) or more\b/gi];
// Testers judge still frames without sound: these can never be seen in play.
const AUDIO =
  /\b(sounds?|soundtrack|audio|audible|music|musical|sfx|chimes?|thuds?|rattles?|jingles?|beeps?|hears?|heard|volume|melody|tune)\b/i;
const TRANSIENT =
  /\b(shakes?|shaking|screen ?shake|flash(es|ing)?|flicker(s|ing)?|blink(s|ing)?|hit[- ]?(stop|pause)|squash(es|ing)?|split[- ]second)\b|\b0?\.\d+ ?(s|sec|secs|seconds)\b|\b\d{1,3} ?ms\b/i;

/** What a check asks that play cannot verify or that rewards volume, in plain words; null when it is fine. */
export const lintCheck = (check: {
  readonly what: string;
  readonly how?: string | undefined;
  readonly kind?: "state" | "look" | undefined;
  readonly setup?: string | undefined;
  readonly values?: unknown;
  readonly expect?: string | undefined;
}): string | null => {
  if (check.setup !== undefined || check.values !== undefined)
    return "a check starts from the title or from play with real input only: drop setup and values (no setup states or teleports). A goal deeper than 20 s of scripted input is a look check a tester plays to";
  if (check.kind === "state") {
    const parsed = parseExpect(check.expect ?? "");
    if ("error" in parsed) return null;
    for (const term of parsed.terms) {
      if (term.ref.kind === "hud" || typeof term.value !== "number") continue;
      const volume = (term.op === ">=" && term.value > 1) || (term.op === ">" && term.value >= 1);
      if (volume) {
        const name = term.ref.kind === "delta" ? `delta(${term.ref.key})` : term.ref.key;
        return `"${name} ${term.op} ${term.value}" rewards volume: use == for an exact state, >= 1 for exists, or an upper bound`;
      }
    }
    return null;
  }
  const text = `${check.what} ${check.how ?? ""}`;
  for (const pattern of VOLUME_TEXT)
    for (const match of text.matchAll(pattern))
      if (numberOf(match[1] ?? "") >= 2)
        return `"${match[0]}" rewards volume: check that something exists or happens, not how much of it`;
  const audio = AUDIO.exec(text);
  if (audio !== null)
    return `a look check cannot judge "${audio[0]}": testers see still frames without sound. Have the game report it as state (a count of sounds played, whether music runs) and make it a state check`;
  const transient = TRANSIENT.exec(text);
  if (transient !== null)
    return `a look check cannot judge "${transient[0]}": it is over faster than frames show. Have the game report it as state (a count of shakes or flashes started) and make it a state check`;
  return null;
};
