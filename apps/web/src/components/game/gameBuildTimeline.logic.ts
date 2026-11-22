import {
  RESTORE_BEFORE_LABEL,
  type GameBuild,
  type GameBuildId,
  type GameBuildsResult,
} from "@kurambit/contracts";

/**
 * PURE. What the Stage shows, as every part of the game screen must say it: the
 * build a copy plays, else the build the folder holds, else null for "Now",
 * the folder changed since its last build. The strip's ring and the
 * Inspector's "on the Stage" both read this, so they never disagree.
 */
export const stageBuildId = (
  list: Pick<GameBuildsResult, "current" | "folderEdited"> | null,
  playing: GameBuildId | null,
): GameBuildId | null => playing ?? (list?.folderEdited === true ? null : (list?.current ?? null));

const isRestoreBefore = (build: GameBuild) =>
  build.source._tag === "saved" && build.source.label === RESTORE_BEFORE_LABEL;

/**
 * PURE. The builds that get a mark, oldest first. Every undo and go-back saves
 * what the folder held, so only the newest of those (the one Go back reaches)
 * and the one the folder holds now keep a mark; older ones would stack up as
 * a row of identical "Before" marks.
 */
export const timelineMarks = (
  newestFirst: ReadonlyArray<GameBuild>,
  current: string | null,
): ReadonlyArray<GameBuild> => {
  const newestBefore = newestFirst.find(isRestoreBefore)?.id;
  return newestFirst
    .filter((build) => !isRestoreBefore(build) || build.id === newestBefore || build.id === current)
    .toReversed();
};

/**
 * PURE. The mark a step lands on, oldest to newest with "now" after the newest:
 * from the selected one (the newest build when none is), by one either way,
 * held at the oldest loaded.
 */
export const stepMark = (
  order: ReadonlyArray<string>,
  selected: string | null,
  by: -1 | 1,
): string | "now" => {
  const from =
    selected === null
      ? order.length - 1
      : selected === "now"
        ? order.length
        : order.indexOf(selected);
  const to = Math.max(0, (from === -1 ? order.length - 1 : from) + by);
  return to >= order.length ? "now" : (order[to] ?? "now");
};
