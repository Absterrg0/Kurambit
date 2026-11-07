import {
  RESTORE_BEFORE_LABEL,
  type GameBuild,
  type GameBuildsResult,
  type GameFactTone,
} from "@kurambit/contracts";

const isRestoreBefore = (build: GameBuild) =>
  build.source._tag === "saved" && build.source.label === RESTORE_BEFORE_LABEL;

/**
 * A mark's short name: the turn number, a keep-going step's number (its mark
 * adds a step glyph), `R<n>` for a stage-era round, "Before" for the folder a
 * restore replaced, another saved build's first word.
 */
export const markLabel = (build: GameBuild): string => {
  const source = build.source;
  switch (source._tag) {
    case "turn":
      return String(source.step?.n ?? source.turn);
    case "round":
      return `R${source.round}`;
    case "saved":
      return isRestoreBefore(build) ? "Before" : (source.label.split(/\s+/)[0] ?? "Saved");
  }
};

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

/** PURE. The worst tone among a build's chips: one bad fact marks it, then a good one; else none. */
export const markTone = (build: GameBuild): GameFactTone => {
  const tones = new Set(build.facts.chips.map((chip) => chip.tone));
  return tones.has("bad") ? "bad" : tones.has("good") ? "good" : "neutral";
};

/**
 * PURE. Builds a restore moved the folder away from: made before the latest
 * restore and after the build it put back, so they are not in the game now. A
 * saved build is the folder parked by a restore, never an undone change.
 */
export const isUndone = (build: GameBuild, list: GameBuildsResult): boolean => {
  const restore = list.restore;
  if (restore === null || restore.outcome?.restored !== true || build.source._tag === "saved")
    return false;
  const target = list.builds.find((entry) => entry.id === restore.target);
  return (
    target !== undefined &&
    build.id !== list.current &&
    build.at > target.at &&
    build.at < restore.requestedAt
  );
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
