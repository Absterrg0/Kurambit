import type {
  GameAsset,
  GameLastPlaytest,
  GamePlaytestFrame,
  GameSummary,
} from "@t3tools/contracts";

/** The run's final frame, the fallback when no probe state proves gameplay. */
const AFTER_STEPS_FRAME = "after-steps";

/**
 * The frame that represents the game: readLastPlaytest already picked a cover
 * from the latest qualifying run's persisted per-frame probe state (an observed
 * moment of play), so captions say nothing here. That frame can be older than
 * the newest run when the newest run failed to qualify; the last real play
 * still represents the game better than a failed attempt's menu screen. A run
 * that left no provable gameplay frame falls back to its final frame, but only
 * when the run itself was sound.
 */
export const gameCoverFrame = (lastPlaytest: GameLastPlaytest | null): GamePlaytestFrame | null => {
  if (lastPlaytest === null) return null;
  if (lastPlaytest.coverFrame !== null && lastPlaytest.coverFrame !== undefined)
    return lastPlaytest.coverFrame;
  if (!lastPlaytest.success || !lastPlaytest.responded) return null;
  return lastPlaytest.frames.findLast((frame) => frame.label === AFTER_STEPS_FRAME) ?? null;
};

/**
 * The covers a game can show, most representative first: gameplay from the
 * newest successful playtest, then each asset's rendered thumbnail. Callers
 * keep the first candidate that exists on disk; the client falls back to the
 * starter template's own frame.
 */
export const gameCoverCandidates = (input: {
  readonly lastPlaytest: GameLastPlaytest | null;
  readonly assets: readonly GameAsset[];
}): readonly string[] => {
  const frame = gameCoverFrame(input.lastPlaytest);
  return [
    ...(frame === null ? [] : [frame.path]),
    ...input.assets.flatMap((asset) => (asset.thumbnail ? [asset.thumbnail] : [])),
  ];
};

/** Newest activity first, then name, so equal timestamps stay deterministic. */
export const sortGameSummaries = (games: readonly GameSummary[]): GameSummary[] =>
  [...games].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.name.localeCompare(right.name),
  );

/** A game's activity is whichever of its project and latest thread moved last. */
export const latestGameActivity = (
  projectUpdatedAt: string,
  threadUpdatedAt: string | null,
): string => {
  if (threadUpdatedAt === null) return projectUpdatedAt;
  const projectTime = Date.parse(projectUpdatedAt);
  const threadTime = Date.parse(threadUpdatedAt);
  if (Number.isNaN(threadTime)) return projectUpdatedAt;
  if (Number.isNaN(projectTime) || threadTime > projectTime) return threadUpdatedAt;
  return projectUpdatedAt;
};
