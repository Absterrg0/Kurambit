import type {
  GameArtAsset,
  GameArtAssetKind,
  GameArtAssetRoute,
  GameAssetUse,
  GameThing,
} from "@kurambit/contracts";

/** A model the game builds in its code: a named thing with a body and no file behind it. */
export interface GameArtCodeModel {
  readonly kind: "code-model";
  readonly id: string;
  readonly name: string;
  readonly thingKind: GameThing["kind"];
  /** It has values to tune (ctx.tune by its name). */
  readonly tunable: boolean;
}

/** One row of the Art list: a file of the game, or a model made in code. */
export type GameArtEntry =
  | { readonly kind: "file"; readonly asset: GameArtAsset }
  | GameArtCodeModel;

export const CODE_MODEL_PREFIX = "thing:";
export const entryKey = (entry: GameArtEntry) =>
  entry.kind === "file" ? entry.asset.path : `${CODE_MODEL_PREFIX}${entry.id}`;

export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export const ROUTE_WORDS: Record<GameArtAssetRoute, string> = {
  code: "Code",
  blender: "Blender",
  generated: "Generated",
  library: "Library",
  unrecorded: "unrecorded",
};

/** The segmented filter over the list; fonts show under All only. */
export type ArtFilter = "all" | "model" | "texture" | "audio";

/** Things a game names that have a body worth looking at alone; rules and interface are not art. */
const MODEL_KINDS: ReadonlySet<GameThing["kind"]> = new Set([
  "character",
  "creature",
  "prop",
  "level",
  "effect",
  "other",
]);

/**
 * The models the running game made in code, one per name: a thing with no asset behind it. Its
 * copies ("Slime 2") are one model.
 */
export const codeModels = (things: ReadonlyArray<GameThing>): ReadonlyArray<GameArtCodeModel> => {
  const seen = new Set<string>();
  const models: GameArtCodeModel[] = [];
  for (const thing of things) {
    if (thing.asset !== undefined || !MODEL_KINDS.has(thing.kind)) continue;
    if (thing.instance !== undefined) continue;
    const base = thing.name.replace(/ \d+$/, "");
    if (seen.has(base)) continue;
    seen.add(base);
    models.push({
      kind: "code-model",
      id: thing.id,
      name: base,
      thingKind: thing.kind,
      tunable: (thing.values?.length ?? 0) > 0,
    });
  }
  return models;
};

const matches = (words: ReadonlyArray<string>, haystack: string) =>
  words.every((word) => haystack.includes(word));

/**
 * What the list shows under a filter and a search (every word must match): the pictures (models,
 * the code's first, then textures) as a grid, the sounds and the fonts as lists.
 */
export const artSections = (
  assets: ReadonlyArray<GameArtAsset>,
  code: ReadonlyArray<GameArtCodeModel>,
  search: string,
  filter: ArtFilter,
) => {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const files = (kind: GameArtAssetKind) =>
    filter !== "all" && filter !== kind
      ? []
      : assets.filter(
          (asset) =>
            asset.kind === kind &&
            matches(
              words,
              `${asset.path} ${asset.route} ${asset.credit ?? ""} ${asset.pack ?? ""}`.toLowerCase(),
            ),
        );
  const models: ReadonlyArray<GameArtEntry> = [
    ...(filter === "all" || filter === "model" ? code : []).filter((model) =>
      matches(words, model.name.toLowerCase()),
    ),
    ...files("model").map((asset) => ({ kind: "file" as const, asset })),
    ...files("texture").map((asset) => ({ kind: "file" as const, asset })),
  ];
  return {
    pictures: models,
    sounds: files("audio"),
    fonts: filter === "all" ? files("font") : [],
  };
};

/** The build's plays never loaded it (a sound: never played it); false when they did not say. */
export const isUnused = (asset: GameArtAsset, use: GameAssetUse | null) =>
  use !== null &&
  (use.unused.includes(asset.path) || (asset.kind === "audio" && use.silent.includes(asset.path)));

/** Whether the build's plays used a file, in a few words; null when its plays did not measure it. */
export const inPlayWords = (
  asset: GameArtAsset,
  use: GameAssetUse | null,
  onStage: boolean,
): string | null => {
  // The use fact leaves library packs out; a model the game on the Stage holds is in use.
  if (use === null) return onStage ? "On the Stage" : null;
  if (asset.kind === "audio") {
    if (use.played.includes(asset.path)) return "Played";
    if (use.silent.includes(asset.path)) return "Never played";
  }
  if (use.used.includes(asset.path)) return "Used";
  if (use.unused.includes(asset.path)) return "Not loaded";
  // Past the fact's caps, a file is counted but not named.
  return onStage ? "On the Stage" : null;
};

export const bytesWords = (bytes: number) =>
  bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

export const countWords = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** The Stage thing showing this file, if the game on the Stage has one: the first copy. */
export const thingOfAsset = (things: ReadonlyArray<GameThing>, asset: GameArtAsset) =>
  things.find(
    (thing) =>
      thing.asset !== undefined &&
      (thing.asset.path === asset.path ||
        (asset.sidecar !== undefined && thing.asset.sidecar === asset.sidecar)),
  ) ?? null;

/** Seconds as the clip scrubber says them: "0.6 s", "12.4 s", "1:05.2". */
export const clipTime = (seconds: number) => {
  const whole = Math.max(0, seconds);
  if (whole < 60) return `${whole.toFixed(1)} s`;
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole - minutes * 60).toFixed(1).padStart(4, "0")}`;
};
