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
  /** Enter presses when a scenario meant to start in a run never left the title, else 0. */
  readonly stuckOnTitle?: number;
};

export const MAX_INPUT_MS = 20_000;
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

/** What a check bot reported in its note, or null when the note is not its report. */
export const readReport = (note: string): Observed | null => {
  try {
    const r: unknown = JSON.parse(note);
    if (r === null || typeof r !== "object") return null;
    const { s, e, h, title } = r as { s?: unknown; e?: unknown; h?: unknown; title?: unknown };
    if (s === null || typeof s !== "object" || e === null || typeof e !== "object") return null;
    return {
      start: s as Record<string, unknown>,
      end: e as Record<string, unknown>,
      hud: typeof h === "string" ? h : "",
      stuckOnTitle: typeof title === "number" ? title : 0,
    };
  } catch {
    return null;
  }
};

/**
 * A bot that plays one check's scenario and reports what the game showed; it
 * judges nothing. It waits for the probe, records the start state, asks for the
 * setup state, plays the input in game time, lets the game settle, then reports
 * the named keys at start and end and the HUD text. A bot run keeps only a short
 * note, so the report holds just what the expectation reads.
 */
export const checkBot = (spec: {
  readonly what: string;
  readonly from: CheckStart;
  readonly setup: string | null;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly input: ReadonlyArray<CheckInput>;
  readonly keys: ReadonlyArray<string>;
  readonly needles: ReadonlyArray<string>;
}): string => `// Generated by Kurambit from a ladder check. Edit the ladder's check, not this file.
export const goal = ${JSON.stringify(`Check: ${spec.what}`)};
export const tempo = 10;
export const switchMargin = 0;
export const stallSeconds = ${Math.ceil(inputMs(spec.input) / 1000) + 30};
const from = ${JSON.stringify(spec.from)};
const setup = ${JSON.stringify(spec.setup)};
const values = ${JSON.stringify(spec.values ?? {})};
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
    if (setup !== null) api.setState(setup, values);
    phase = "setup";
    since = t;
  }
  if (phase === "setup" && t - since >= (setup === null ? 0 : 0.6)) {
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
const pick = (state) => {
  const out = {};
  for (const key of keys) {
    const v = read(state, key);
    if (v !== null) out[key] = typeof v === "string" ? v.slice(0, 60) : v;
  }
  return out;
};
export function status(obs) {
  if (obs.phase !== "report") return { state: "running", note: \`stopped at \${obs.phase}\${obs.phase === "input" ? \` step \${step + 1} of \${input.length}\` : ""}\` };
  const lines = hud.split("\\n").filter((l) => needles.some((n) => l.toLowerCase().includes(n)));
  const h = (lines.length > 0 ? lines.join("\\n") : hud).slice(0, 200);
  return { state: "done", note: JSON.stringify({ s: pick(start), e: pick(end), h, title: onTitleAtStart ? titlePresses : 0 }) };
}
`;
