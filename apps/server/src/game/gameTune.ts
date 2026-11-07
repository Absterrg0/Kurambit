// PURE. The Stage bridge's values file (web/tune.json for three.js): one
// object per thing id, each its values by key. Keep as a build merges the
// person's values into it after checking them against the ranges the game
// registered, so a file the game reads at boot never holds a value its own
// sliders could not reach.
import type { GameKeepValuesThing } from "@kurambit/contracts";

export type TuneFile = Record<string, Record<string, number | boolean>>;

// Names that would reach an object's prototype once parsed back by a game.
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The file as parsed (null when there is none) with the things' values merged in, or why not. */
export const tuneFileWith = (
  file: string,
  existing: unknown,
  things: ReadonlyArray<GameKeepValuesThing>,
): { readonly file: TuneFile; readonly summary: string } | { readonly refusal: string } => {
  if (existing !== null && !isRecord(existing))
    return {
      refusal: `${file} is not a JSON object of values by thing id: fix or remove it, then keep again.`,
    };
  const next: TuneFile = {};
  for (const [id, values] of Object.entries(existing ?? {})) {
    if (!isRecord(values) || UNSAFE.has(id))
      return { refusal: `${file} holds ${JSON.stringify(id)}, which is not an object of values.` };
    next[id] = { ...(values as Record<string, number | boolean>) };
  }
  const seen = new Set<string>();
  const said: string[] = [];
  for (const thing of things) {
    if (UNSAFE.has(thing.id)) return { refusal: `${JSON.stringify(thing.id)} is not a thing id.` };
    if (seen.has(thing.id)) return { refusal: `${thing.id} is listed twice.` };
    seen.add(thing.id);
    const kept = { ...next[thing.id] };
    const keys = new Set<string>();
    for (const value of thing.values) {
      const where = `${thing.id} ${value.key}`;
      if (value.key.length === 0 || value.key.length > 120 || UNSAFE.has(value.key))
        return { refusal: `${where} is not a value name.` };
      if (keys.has(value.key)) return { refusal: `${where} is listed twice.` };
      keys.add(value.key);
      if (typeof value.value === "number") {
        if (!Number.isFinite(value.value)) return { refusal: `${where} is not a finite number.` };
        if (value.min !== undefined && value.max !== undefined && value.min > value.max)
          return { refusal: `${where}'s range ${value.min} to ${value.max} is empty.` };
        if (value.min !== undefined && value.value < value.min)
          return { refusal: `${where} = ${value.value} is below its minimum ${value.min}.` };
        if (value.max !== undefined && value.value > value.max)
          return { refusal: `${where} = ${value.value} is above its maximum ${value.max}.` };
      }
      kept[value.key] = value.value;
    }
    next[thing.id] = kept;
    said.push(
      `${thing.id} ${thing.values.map((value) => `${value.key} ${String(value.value)}`).join(", ")}`,
    );
  }
  const summary = said.join("; ");
  return { file: next, summary: summary.length > 240 ? `${summary.slice(0, 239)}…` : summary };
};

export const tuneFileText = (file: TuneFile) => `${JSON.stringify(file, null, 2)}\n`;
