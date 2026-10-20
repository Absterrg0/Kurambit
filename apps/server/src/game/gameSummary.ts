import type { GameAsset, GameLastPlaytest, GameSummary } from "@t3tools/contracts";

/** The two frames every run captures, neither of which shows the game being played. */
const BOOT_FRAME = "booted";
const AFTER_STEPS_FRAME = "after-steps";

/**
 * The frame that represents the game: a screenshot the agent took after the
 * first step of a successful run, then the after-steps frame. The boot frame is
 * a menu or a loading screen and never becomes a cover.
 */
export const gameCoverFrame = (
  lastPlaytest: GameLastPlaytest | null,
): GameLastPlaytest["frames"][number] | null => {
  if (lastPlaytest === null || !lastPlaytest.success || !lastPlaytest.responded) return null;
  const gameplay = lastPlaytest.frames.find(
    (frame) => frame.label !== BOOT_FRAME && frame.label !== AFTER_STEPS_FRAME,
  );
  if (gameplay !== undefined) return gameplay;
  return lastPlaytest.frames.find((frame) => frame.label === AFTER_STEPS_FRAME) ?? null;
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
