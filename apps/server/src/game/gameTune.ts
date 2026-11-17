// PURE. The Stage bridge's values file (web/tune.json for three.js): one
// object per thing id, each its values by key. A save merges the person's
// values into it after checking them against the ranges the game
// registered, so a file the game reads at boot never holds a value its own
// sliders could not reach.
import { gameLookId, type GameKeepValuesThing } from "@kurambit/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// A look's entry also holds the names the person gave its part and materials, as text.
export type TuneFile = Record<string, Record<string, number | boolean | string>>;
const LOOK = gameLookId("");
/** A name's key in a look: the part's own ("name") or a material's ("2:roof/name"). */
const isNameKey = (key: string) => key === "name" || key.endsWith("/name");

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
    next[id] = { ...(values as Record<string, number | boolean | string>) };
  }
  const seen = new Set<string>();
  const said: string[] = [];
  for (const thing of things) {
    if (UNSAFE.has(thing.id)) return { refusal: `${JSON.stringify(thing.id)} is not a thing id.` };
    if (seen.has(thing.id)) return { refusal: `${thing.id} is listed twice.` };
    seen.add(thing.id);
    const names = thing.names ?? [];
    if (thing.values.length === 0 && names.length === 0)
      return { refusal: `${thing.id} has no values or names to keep.` };
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
      // The file holds what differs from the code: a value back at its default leaves it, so
      // tuning put back leaves the file as it was and a default changed in code takes effect.
      if (value.default !== undefined && value.default === value.value) delete kept[value.key];
      else kept[value.key] = value.value;
    }
    for (const { key, name } of names) {
      const where = `${thing.id} ${key}`;
      if (!thing.id.startsWith(LOOK) || !isNameKey(key) || UNSAFE.has(key))
        return { refusal: `${where} is not a name a look keeps.` };
      if (keys.has(key)) return { refusal: `${where} is listed twice.` };
      keys.add(key);
      const words = name?.replace(/\s+/g, " ").trim() ?? "";
      if (words === "") delete kept[key];
      else kept[key] = words;
    }
    if (Object.keys(kept).length === 0) delete next[thing.id];
    else next[thing.id] = kept;
    said.push(
      `${thing.id} ${[
        ...thing.values.map((value) => `${value.key} ${String(value.value)}`),
        ...names.map(({ key, name }) => `${key} ${name === null ? "the game's own" : `"${name}"`}`),
      ].join(", ")}`,
    );
  }
  const summary = said.join("; ");
  return { file: next, summary: summary.length > 240 ? `${summary.slice(0, 239)}…` : summary };
};

export const tuneFileText = (file: TuneFile) => `${JSON.stringify(file, null, 2)}\n`;

/** Whether a merged file holds the same values as a parsed one (None: unreadable, never the same). */
export const sameTuneFile = (file: TuneFile, other: Option.Option<unknown>): boolean => {
  if (Option.isNone(other)) return false;
  const parsed = other.value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const ids = Object.keys(file);
  if (ids.length !== Object.keys(parsed).length) return false;
  return ids.every((id) => {
    const mine = file[id]!;
    const theirs = (parsed as Record<string, unknown>)[id];
    if (theirs === null || typeof theirs !== "object" || Array.isArray(theirs)) return false;
    const keys = Object.keys(mine);
    return (
      keys.length === Object.keys(theirs).length &&
      keys.every((key) => (theirs as Record<string, unknown>)[key] === mine[key])
    );
  });
};

/**
 * PURE. The values a patch of the tune file changes, as "key from → to" by thing. The file is
 * tuneFileText's (a thing per object at two spaces, its values at four), so a thing is named by
 * the nearest object line the patch shows above a value; a hunk that starts below it leaves the
 * thing null rather than guess.
 */
export const tuneChanges = (patch: string) => {
  const changes = new Map<
    string,
    { thing: string | null; key: string; from: string | null; to: string | null }
  >();
  let thing: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      thing = null;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const sign = line.charAt(0);
    const body = line.slice(1);
    const object = /^ {2}"((?:[^"\\]|\\.)+)": \{\s*\}?,?$/.exec(body);
    if (object !== null) {
      thing = JSON.parse(`"${object[1]}"`) as string;
      continue;
    }
    if (sign !== "+" && sign !== "-") continue;
    const value = /^ {4}"((?:[^"\\]|\\.)+)": (.+?),?$/.exec(body);
    if (value === null) continue;
    const key = JSON.parse(`"${value[1]}"`) as string;
    const id = `${thing ?? ""}\0${key}`;
    const change = changes.get(id) ?? { thing, key, from: null, to: null };
    if (sign === "-") change.from = value[2]!;
    else change.to = value[2]!;
    changes.set(id, change);
  }
  return [...changes.values()].filter((change) => change.from !== change.to);
};

type TuneValue = number | boolean | string;
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const tuneObject = (text: string | null): TuneFile | null => {
  if (text === null) return {};
  const parsed = Option.getOrNull(decodeJson(text));
  if (!isRecord(parsed)) return null;
  const file: TuneFile = {};
  for (const [id, values] of Object.entries(parsed)) {
    if (!isRecord(values) || UNSAFE.has(id)) return null;
    file[id] = values as Record<string, TuneValue>;
  }
  return file;
};

/**
 * Three versions of a tune file merged per value: a value one side changed from the base is
 * that side's, and only a value both sides changed differently is a conflict (it keeps ours').
 * Null when a version is not a tune file, which then stays git's conflict. Absent files are `null`.
 */
export const mergeTuneFiles = (
  base: string | null,
  ours: string | null,
  theirs: string | null,
): { readonly text: string | null; readonly conflicts: ReadonlyArray<string> } | null => {
  const [b, o, t] = [tuneObject(base), tuneObject(ours), tuneObject(theirs)];
  if (b === null || o === null || t === null) return null;
  const merged: TuneFile = {};
  const conflicts: string[] = [];
  const ids = new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(b)]);
  for (const id of ids) {
    const keys = new Set([
      ...Object.keys(o[id] ?? {}),
      ...Object.keys(t[id] ?? {}),
      ...Object.keys(b[id] ?? {}),
    ]);
    const values: Record<string, TuneValue> = {};
    for (const key of keys) {
      const [was, mine, other] = [b[id]?.[key], o[id]?.[key], t[id]?.[key]];
      const value = mine === other || other === was ? mine : mine === was ? other : mine;
      if (mine !== other && mine !== was && other !== was) conflicts.push(`${id} ${key}`);
      if (value !== undefined) values[key] = value;
    }
    if (Object.keys(values).length > 0) merged[id] = values;
  }
  return {
    // A file neither side kept stays absent.
    text:
      Object.keys(merged).length === 0 && ours === null && theirs === null
        ? null
        : tuneFileText(merged),
    conflicts,
  };
};
