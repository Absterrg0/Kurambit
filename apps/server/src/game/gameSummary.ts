import type { GameSummary } from "@kurambit/contracts";

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
