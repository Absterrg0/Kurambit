import {
  GAME_ART_PROVIDERS,
  type GameArtLane,
  type GameArtProviderId,
  type GameArtProvidersResult,
  type GameBuildsResult,
  type GameGeneration,
} from "@kurambit/contracts";

export const GAME_ART_LANE_LABELS = {
  image: "Image",
  character: "Character",
  creature: "Creature",
  model: "Model",
  texture: "Texture",
  sfx: "Sound effect",
  music: "Music",
  voice: "Voice",
  motion: "Motion",
} as const satisfies Record<GameArtLane, string>;

export const GAME_ART_LANES = Object.keys(GAME_ART_LANE_LABELS) as ReadonlyArray<GameArtLane>;

/** Lanes that make the generated route's characters and props (a motion adds clips to them). */
const THREE_D_LANES: ReadonlySet<GameArtLane> = new Set(["character", "creature", "model"]);
const AUDIO_LANES: ReadonlySet<GameArtLane> = new Set(["sfx", "music", "voice"]);

/**
 * Lanes whose files reach the game as delivered (game_import copies them), so a build that ships
 * none of their bytes does not have them. A 3D lane's model is exported through Blender, which
 * rewrites the bytes: it joins through its export's sidecar, and a miss (an export from before
 * sidecars named generations) says nothing.
 */
const AS_DELIVERED: ReadonlySet<GameArtLane> = new Set([
  "image",
  "texture",
  "sfx",
  "music",
  "voice",
]);

/**
 * Whether a finished generation is in the game, from the newest build whose asset use was
 * measured: joined by identical bytes, "in" only once a play loaded it. Null when unknown.
 */
export const inGameLine = (
  generation: GameGeneration,
  latestUse: Pick<NonNullable<GameBuildsResult["latestUse"]>, "generations"> | null,
): "In the game" | "Not in the game yet" | null => {
  if (generation.state !== "done" || generation.filesUndone === true || latestUse === null)
    return null;
  const joined = latestUse.generations.find((entry) => entry.id === generation.id);
  if (joined !== undefined) return joined.loaded ? "In the game" : "Not in the game yet";
  return AS_DELIVERED.has(generation.lane) ? "Not in the game yet" : null;
};

/**
 * What the card shows of a delivered file when it has no picture: a model chip, a motion chip (a
 * landed motion shows its strip instead), a sound, or the image itself.
 */
export const laneMedium = (lane: GameArtLane): "image" | "model" | "motion" | "audio" =>
  lane === "motion"
    ? "motion"
    : THREE_D_LANES.has(lane)
      ? "model"
      : AUDIO_LANES.has(lane)
        ? "audio"
        : "image";

const isImage = (path: string) => /\.(png|jpe?g|webp)$/i.test(path);

export const providerLabel = (provider: GameArtProviderId): string =>
  GAME_ART_PROVIDERS[provider].label;

/** Dollars as a person reads a bill: cents below a dollar keep two places, tiny sums say so. */
export const formatUsd = (usd: number): string =>
  usd > 0 && usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`;

/** The generation's price line: what it cost once known, else what it is expected to cost. */
export const generationCostLine = (generation: GameGeneration): string | null => {
  if (generation.costUsd !== null)
    return generation.costUsd === 0 ? "Free" : `Cost ${formatUsd(generation.costUsd)}`;
  if (generation.estimateUsd === null) return null;
  const settled =
    generation.state === "done" ||
    generation.state === "failed" ||
    generation.state === "cancelled";
  return generation.estimateUsd === 0
    ? "Free"
    : `${settled ? "Estimated" : "Estimate"} ${formatUsd(generation.estimateUsd)}`;
};

/** The picture a settled generation shows: its kept candidate's preview, else its first image file. */
export const generationResultImage = (generation: GameGeneration): string | null => {
  // A model with no preview picture names its GLB as the preview: that is a chip, not a picture.
  const chosen =
    generation.chosen === null ? undefined : generation.candidates[generation.chosen]?.preview;
  if (chosen !== undefined && isImage(chosen)) return chosen;
  const only = generation.candidates.length === 1 ? generation.candidates[0]!.preview : undefined;
  if (only !== undefined && isImage(only)) return only;
  if (laneMedium(generation.lane) !== "image") return null;
  return generation.files.find(isImage) ?? null;
};

export const fileName = (path: string): string => path.replace(/^.*\//, "");

/** The candidate a keyboard arrow moves to in a grid of `columns`, clamped to the grid. */
export const stepCandidate = (
  index: number,
  count: number,
  columns: number,
  key: string,
): number | null => {
  const step =
    key === "ArrowRight"
      ? 1
      : key === "ArrowLeft"
        ? -1
        : key === "ArrowDown"
          ? columns
          : key === "ArrowUp"
            ? -columns
            : null;
  if (step === null) return null;
  const next = index + step;
  return next < 0 || next >= count ? index : next;
};

/**
 * Why the Generated character route cannot be used yet, or null when it can:
 * a 3D lane has a ready provider, or Codex is ready for images (characters are
 * then built in Blender from its sheets).
 */
export const generatedRouteBlocker = (providers: GameArtProvidersResult | null): string | null => {
  if (providers === null) return null;
  const threeD = [...THREE_D_LANES].some((lane) => providers.lanes[lane] !== null);
  const codex = providers.providers.some((entry) => entry.provider === "codex" && entry.ready);
  return threeD || codex ? null : "Set up an art provider in Settings";
};

/**
 * What the generated route can make now, when that is less than it promises: Codex alone makes
 * images (key art, concepts), not the 3D characters and props the route is chosen for.
 */
export const generatedRouteNote = (providers: GameArtProvidersResult | null): string | null => {
  if (providers === null || generatedRouteBlocker(providers) !== null) return null;
  const threeD = [...THREE_D_LANES].some((lane) => providers.lanes[lane] !== null);
  return threeD
    ? null
    : "Codex makes the key art and images; characters and props also need a Tripo or Meshy key.";
};

/** Generations started by one chat's agent, oldest first, as timeline card keys. */
export const chatGenerationCardKey = (
  generations: ReadonlyArray<GameGeneration>,
  threadId: string,
): string =>
  generations
    .filter((generation) => generation.threadId === threadId)
    .map((generation) => `${generation.id}\u0001${generation.createdAt}`)
    .join("\u0002");

/**
 * Whether a tool call is the agent's game_generate, game_image_edit or game_generate_wait, as
 * any provider names it (`mcp__kurambit__game_generate`, `kurambit.game_generate`,
 * `kurambit-<thread>_game_generate_wait`).
 */
export const isGameGenerationTool = (toolName: string | null | undefined): boolean =>
  toolName != null &&
  /(?:^|[_.:/\s-])game_(?:generate(?:_wait)?|image_edit)$/i.test(toolName.trim());

// The timeline compares anchored cards by identity, so one merged array per pair of inputs.
let lastMerge: {
  readonly a: ReadonlyArray<unknown>;
  readonly b: ReadonlyArray<unknown>;
  readonly merged: ReadonlyArray<unknown>;
} | null = null;
/** Two card lists as one, the same array while neither changed. */
export const mergeAnchoredCards = <T>(
  a: ReadonlyArray<T>,
  b: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  if (lastMerge?.a === a && lastMerge.b === b) return lastMerge.merged as ReadonlyArray<T>;
  const merged = [...a, ...b];
  lastMerge = { a, b, merged };
  return merged;
};

/** The person's pick, as the message the agent goes on from. */
export const pickMessage = (generation: GameGeneration, candidate: number): string =>
  awaitsModelLook(generation)
    ? `Rig ${generation.name}: the model looks right.`
    : `Use "${generation.candidates[candidate]?.label ?? `candidate ${candidate + 1}`}" for ${generation.name}.`;

/**
 * A character or creature waiting on the person's look at its model before the rig is bought.
 * The server puts a 3D lane in choosing for nothing else: its one candidate is "Rig this".
 */
export const awaitsModelLook = (generation: GameGeneration): boolean =>
  generation.state === "choosing" &&
  (generation.lane === "character" || generation.lane === "creature");

/** What the model cost, and what the rig would add, beside "Rig this" and Cancel. */
export const modelLookLine = (generation: GameGeneration): string => {
  const cost = generation.costUsd;
  const more =
    generation.estimateUsd === null || cost === null ? null : generation.estimateUsd - cost;
  return [
    cost === null ? null : `The model cost ${formatUsd(cost)}.`,
    more === null || more <= 0
      ? "Rigging and its clips cost more."
      : `Rigging and its clips add about ${formatUsd(more)}.`,
    "Cancel keeps only the model's cost.",
  ]
    .filter((part) => part !== null)
    .join(" ");
};

/**
 * The picture "Change…" names in a settled image or texture generation: the one the game kept
 * (an edit's "As it was" is the game's own file). Null where there is none to change.
 */
export const changeableImage = (generation: GameGeneration): string | null =>
  generation.state === "done" &&
  generation.filesUndone !== true &&
  (generation.lane === "image" || generation.lane === "texture")
    ? generationResultImage(generation)
    : null;

/** The person's "Change…", as their message to the agent, which makes the edit generation. */
export const changeMessage = (path: string, words: string): string =>
  `Change ${path}: ${words.trim()}\n\nEdit that image (game_image_edit) rather than making a new one, so I can pick between the change and the image as it was.`;
