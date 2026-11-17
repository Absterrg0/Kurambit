import type {
  GameArtAsset,
  GameArtAssetKind,
  GameArtAssetRoute,
  GameAssetUse,
  GameThing,
  GameThingValue,
} from "@kurambit/contracts";

/** A model the game builds in its code: a named thing with a body and no file behind it. */
export interface GameArtCodeModel {
  readonly kind: "code-model";
  readonly id: string;
  readonly name: string;
  readonly thingKind: GameThing["kind"];
  /** The game's own word for its kind ("player"), when it gave one the Stage knows. */
  readonly kindWord: string | null;
  /** It has values to tune (ctx.tune by its name). */
  readonly tunable: boolean;
  /** A part: the thing it is built into, by id, and where it sits ("Island › Cabin"). */
  readonly parent: string | null;
  readonly path: string | null;
  /** How many copies of it the game draws (a scattered part: "Trees × 240"). */
  readonly copies: number | null;
}

/** A look the model viewer puts over a file: its part's path below the thing ([] for the thing). */
export interface ViewerLook {
  readonly part: ReadonlyArray<string>;
  readonly values: Readonly<Record<string, number | boolean>>;
}

/**
 * The look edits the running game holds for a thing and its parts, as the model viewer applies
 * them to the file the thing is a copy of: the thing's first, then its parts' in the game's order,
 * each with only the values that differ from the game's own.
 */
export const viewerLooks = (
  thingId: string,
  partIds: ReadonlyArray<string>,
  looks: Readonly<
    Record<string, { readonly values: ReadonlyArray<GameThingValue> } | null | undefined>
  >,
): ReadonlyArray<ViewerLook> =>
  [thingId, ...partIds].flatMap((id) => {
    const changed = (looks[id]?.values ?? []).filter(
      (value) => value.default !== undefined && value.default !== value.value,
    );
    if (changed.length === 0) return [];
    return [
      {
        part: id === thingId ? [] : id.slice(`${thingId} › `.length).split(" › "),
        values: Object.fromEntries(changed.map((value) => [value.key, value.value])),
      },
    ];
  });

/** A code model's name as a tile and a list say it: a scattered part with its count. */
export const modelName = (model: GameArtCodeModel) =>
  model.copies === null ? model.name : `${model.name} × ${model.copies.toLocaleString("en-US")}`;

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
 * copies ("Slime 2") are one model. A thing's parts follow it, in the game's order.
 */
export const codeModels = (things: ReadonlyArray<GameThing>): ReadonlyArray<GameArtCodeModel> => {
  const seen = new Set<string>();
  const models: GameArtCodeModel[] = [];
  const partsOf = new Map<string, GameThing[]>();
  for (const thing of things)
    if (thing.parent !== undefined)
      partsOf.set(thing.parent, [...(partsOf.get(thing.parent) ?? []), thing]);
  const model = (thing: GameThing, name: string): GameArtCodeModel => ({
    kind: "code-model",
    id: thing.id,
    name,
    thingKind: thing.kind,
    kindWord: thing.kindWord ?? null,
    tunable: (thing.values?.length ?? 0) > 0,
    parent: thing.parent ?? null,
    path: thing.path ?? null,
    copies:
      thing.parent !== undefined && thing.instances !== undefined && thing.instances > 1
        ? thing.instances
        : null,
  });
  const withParts = (thing: GameThing) => {
    for (const part of partsOf.get(thing.id) ?? []) {
      models.push(model(part, part.name));
      withParts(part);
    }
  };
  for (const thing of things) {
    if (thing.parent !== undefined) continue;
    if (thing.asset !== undefined || !MODEL_KINDS.has(thing.kind)) continue;
    if (thing.instance !== undefined) continue;
    const base = thing.name.replace(/ \d+$/, "");
    if (seen.has(base)) continue;
    seen.add(base);
    models.push(model(thing, base));
    withParts(thing);
  }
  return models;
};

/** A thing and its parts, as the grid groups them; one group without a title for the rest. */
export interface ArtPictureGroup {
  readonly title: string | null;
  readonly entries: ReadonlyArray<GameArtEntry>;
}

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
  const shownCode = (filter === "all" || filter === "model" ? code : []).filter((model) =>
    matches(words, `${model.name} ${model.path ?? ""}`.toLowerCase()),
  );
  // A thing with parts is a group of its own, its tile first; everything else shares one.
  const rootOf = (model: GameArtCodeModel): string => {
    let at = model;
    while (at.parent !== null) {
      const parent = code.find((each) => each.id === at.parent);
      if (parent === undefined) break;
      at = parent;
    }
    return at.id;
  };
  const holders = new Set(code.flatMap((model) => (model.parent === null ? [] : [rootOf(model)])));
  const loose: GameArtEntry[] = [];
  const grouped = new Map<string, GameArtEntry[]>();
  for (const model of shownCode) {
    const root = rootOf(model);
    if (!holders.has(root)) loose.push(model);
    else grouped.set(root, [...(grouped.get(root) ?? []), model]);
  }
  const pictures: ReadonlyArray<ArtPictureGroup> = [
    {
      title: null,
      entries: [
        ...loose,
        ...files("model").map((asset) => ({ kind: "file" as const, asset })),
        ...files("texture").map((asset) => ({ kind: "file" as const, asset })),
      ],
    },
    ...[...grouped].map(([root, entries]) => ({
      title: code.find((model) => model.id === root)?.name ?? null,
      entries,
    })),
  ].filter((group) => group.entries.length > 0);
  return {
    pictures,
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
