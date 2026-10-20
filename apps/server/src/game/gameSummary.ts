import type { GameAsset, GameLastPlaytest, GameSummary } from "@t3tools/contracts";

/**
 * The covers a game can show, most representative first: the newest playtest
 * frame, then each asset's rendered thumbnail. Callers keep the first candidate
 * that exists on disk.
 */
export const gameCoverCandidates = (input: {
  readonly lastPlaytest: GameLastPlaytest | null;
  readonly assets: readonly GameAsset[];
}): readonly string[] => [
  ...(input.lastPlaytest?.frames.slice(0, 1).map((frame) => frame.path) ?? []),
  ...input.assets.flatMap((asset) => (asset.thumbnail ? [asset.thumbnail] : [])),
];

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
