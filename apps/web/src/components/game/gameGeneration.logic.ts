import {
  GAME_ART_PROVIDERS,
  type GameArtLane,
  type GameArtLaneChoice,
  type GameArtLaneChoices,
  type GameArtProviderId,
  type GameArtProvidersResult,
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
} as const satisfies Record<GameArtLane, string>;

export const GAME_ART_LANES = Object.keys(GAME_ART_LANE_LABELS) as ReadonlyArray<GameArtLane>;

const THREE_D_LANES: ReadonlySet<GameArtLane> = new Set(["character", "creature", "model"]);
const AUDIO_LANES: ReadonlySet<GameArtLane> = new Set(["sfx", "music", "voice"]);

/** What the card shows of a delivered file: a picture, a model chip, or a sound. */
export const laneMedium = (lane: GameArtLane): "image" | "model" | "audio" =>
  THREE_D_LANES.has(lane) ? "model" : AUDIO_LANES.has(lane) ? "audio" : "image";

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
  const chosen =
    generation.chosen === null ? undefined : generation.candidates[generation.chosen]?.preview;
  if (chosen !== undefined) return chosen;
  if (generation.candidates.length === 1) return generation.candidates[0]!.preview;
  if (laneMedium(generation.lane) !== "image") return null;
  return generation.files.find((file) => /\.(png|jpe?g|webp)$/i.test(file)) ?? null;
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
 * Whether a tool call is the agent's game_generate or game_generate_wait, as
 * any provider names it (`mcp__kurambit__game_generate`, `kurambit.game_generate`,
 * `kurambit-<thread>_game_generate_wait`).
 */
export const isGameGenerationTool = (toolName: string | null | undefined): boolean =>
  toolName != null && /(?:^|[_.:/\s-])game_generate(?:_wait)?$/i.test(toolName.trim());

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

/** Settings' lane choices with one lane set; auto is stored as the lane left out. */
export const withLaneChoice = (
  choices: GameArtLaneChoices,
  lane: GameArtLane,
  choice: GameArtLaneChoice,
): GameArtLaneChoices => {
  const next = { ...choices };
  if (choice === "auto") delete next[lane];
  else next[lane] = choice;
  return next;
};
