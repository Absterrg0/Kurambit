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
}

/** One row of the Art list: a file of the game, or a model made in code. */
export type GameArtEntry =
  | { readonly kind: "file"; readonly asset: GameArtAsset }
  | GameArtCodeModel;

export const CODE_MODEL_PREFIX = "thing:";
export const entryKey = (entry: GameArtEntry) =>
  entry.kind === "file" ? entry.asset.path : `${CODE_MODEL_PREFIX}${entry.id}`;

export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const GROUPS: ReadonlyArray<{ readonly kind: GameArtAssetKind; readonly label: string }> = [
  { kind: "model", label: "Models" },
  { kind: "texture", label: "Textures and sprites" },
  { kind: "audio", label: "Sounds" },
  { kind: "font", label: "Fonts" },
];

export const ROUTE_WORDS: Record<GameArtAssetRoute, string> = {
  code: "Code",
  blender: "Blender",
  generated: "Generated",
  library: "Library",
  unrecorded: "Not recorded",
};

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
    models.push({ kind: "code-model", id: thing.id, name: base });
  }
  return models;
};

export type GameArtRow =
  | {
      readonly type: "heading";
      readonly key: string;
      readonly label: string;
      readonly count: number;
    }
  | { readonly type: "entry"; readonly key: string; readonly entry: GameArtEntry };

const matches = (words: ReadonlyArray<string>, haystack: string) =>
  words.every((word) => haystack.includes(word));

/** The list's rows: each kind's heading, then its entries, filtered by every word searched. */
export const artRows = (
  assets: ReadonlyArray<GameArtAsset>,
  code: ReadonlyArray<GameArtCodeModel>,
  search: string,
): ReadonlyArray<GameArtRow> => {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const rows: GameArtRow[] = [];
  for (const group of GROUPS) {
    const entries: GameArtEntry[] = [
      ...(group.kind === "model" ? code : []).filter((model) =>
        matches(words, `${model.name} code`.toLowerCase()),
      ),
      ...assets
        .filter(
          (asset) =>
            asset.kind === group.kind &&
            matches(
              words,
              `${asset.path} ${ROUTE_WORDS[asset.route]} ${asset.credit ?? ""} ${asset.pack ?? ""}`.toLowerCase(),
            ),
        )
        .map((asset) => ({ kind: "file" as const, asset })),
    ];
    if (entries.length === 0) continue;
    rows.push({
      type: "heading",
      key: `heading:${group.kind}`,
      label: group.label,
      count: entries.length,
    });
    for (const entry of entries) rows.push({ type: "entry", key: entryKey(entry), entry });
  }
  return rows;
};

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

/** The row's second line: where it came from, its licence and its cost. */
export const assetSummary = (asset: GameArtAsset) =>
  [
    ROUTE_WORDS[asset.route],
    asset.credit ?? null,
    asset.triangles === undefined ? null : countWords(asset.triangles, "triangle", "triangles"),
    bytesWords(asset.bytes),
  ]
    .filter((part) => part !== null)
    .join(" · ");

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
