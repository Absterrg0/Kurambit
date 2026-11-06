import type { GameBuild, GameBuildsResult } from "@kurambit/contracts";

/**
 * A chat turn's build as its changed-files card shows it, with what the list
 * says about the folder: enough to offer Play, Undo, Redo or Go back.
 */
export interface TurnBuildView {
  readonly build: GameBuild;
  /** The game's latest turn build: the one Undo belongs to. */
  readonly latest: boolean;
  readonly restore: GameBuildsResult["restore"];
  readonly current: GameBuildsResult["current"];
  readonly folderEdited: GameBuildsResult["folderEdited"];
}

/**
 * PURE. One turn's build from a page of the Builds list, by the T3 run that
 * made it, or the game's latest turn build when `runId` is null. Null for a
 * turn the page does not hold.
 */
export const selectTurnBuild = (
  list: GameBuildsResult,
  runId: string | null,
): TurnBuildView | null => {
  const latest = list.builds.find((build) => build.source._tag === "turn");
  const build =
    runId === null
      ? latest
      : list.builds.find((entry) => entry.source._tag === "turn" && entry.source.runId === runId);
  return build === undefined
    ? null
    : {
        build,
        latest: build.id === latest?.id,
        restore: list.restore,
        current: list.current,
        folderEdited: list.folderEdited,
      };
};
