import {
  ownsUndo,
  type GameBuild,
  type GameBuildId,
  type GameBuildsResult,
} from "@kurambit/contracts";

/**
 * A chat turn's build as its changed-files card shows it, with what the list
 * says about the folder: enough to offer Play, Undo, Redo or Go back.
 */
export interface TurnBuildView {
  readonly build: GameBuild;
  /** The game's latest build Undo belongs to (a turn's, or a person's kept edit). */
  readonly latest: boolean;
  readonly restore: GameBuildsResult["restore"];
  readonly current: GameBuildsResult["current"];
  readonly folderEdited: GameBuildsResult["folderEdited"];
  /**
   * A change reversed alone (History's Undo on one build) and not taken back: the undo build
   * whose own undo is the Redo, and the name of the build that Redo brings back (null when the
   * page does not hold it). Set on the undone build, and on that undo while it is the latest.
   */
  readonly redo: { readonly undo: GameBuildId; readonly name: string | null } | null;
}

/**
 * PURE. Each build of a page whose change an undo reversed alone, to that undo. Undoing an undo
 * is its Redo, so an undo a later one reversed no longer counts, and one whose Redo was itself
 * undone counts again. A page lists the newest first: each undo is read after any that reversed it.
 */
export const undoneAlone = (
  builds: ReadonlyArray<GameBuild>,
): ReadonlyMap<GameBuildId, GameBuildId> => {
  const undone = new Map<GameBuildId, GameBuildId>();
  for (const build of builds)
    if (build.undid !== undefined && !undone.has(build.id)) undone.set(build.undid, build.id);
  return undone;
};

/** PURE. One build's view in a page, `latest` when it is the build Undo belongs to. */
export const turnBuildView = (
  list: GameBuildsResult,
  build: GameBuild,
  latest: boolean,
): TurnBuildView => {
  const undone = undoneAlone(list.builds);
  const by = undone.get(build.id);
  // The latest is an undo of one build, and not a Redo (an undo of an undo): its own undo is Redo.
  const undid = latest ? build.undid : undefined;
  const reversed = undid === undefined ? undefined : list.builds.find((each) => each.id === undid);
  const plainUndo =
    undid !== undefined && undone.get(undid) === build.id && reversed?.undid === undefined;
  return {
    build,
    latest,
    restore: list.restore,
    current: list.current,
    folderEdited: list.folderEdited,
    redo:
      by !== undefined
        ? { undo: by, name: build.name }
        : plainUndo
          ? { undo: build.id, name: reversed?.name ?? null }
          : null,
  };
};

/**
 * PURE. One turn's build from a page of the Builds list, by the T3 run that
 * made it, or the game's latest turn build when `runId` is null. Null for a
 * turn the page does not hold.
 */
export const selectTurnBuild = (
  list: GameBuildsResult,
  runId: string | null,
): TurnBuildView | null => {
  const latest = list.builds.find((build) => ownsUndo(build.source));
  const build =
    runId === null
      ? latest
      : list.builds.find(
          (entry) =>
            // A try's turn is the version it kept.
            (entry.source._tag === "turn" ||
              (entry.source._tag === "version" && entry.source.kept)) &&
            entry.source.runId === runId,
        );
  return build === undefined ? null : turnBuildView(list, build, build.id === latest?.id);
};
