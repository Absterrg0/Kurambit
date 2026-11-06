import { useState } from "react";
import { ArrowUpRightIcon, HistoryIcon, PlayIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import type { RunId, ScopedThreadRef } from "@kurambit/contracts";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { setStagePlayTarget } from "../../state/game";
import { Button } from "../ui/button";
import { GameBuildFactChips } from "./GameBuildFacts";
import { buildName } from "./gameBuilds.logic";
import { turnBuildIsFolder } from "./gameTurnBuild.logic";
import { useBuildPlay, useTurnUndo } from "./useBuildActions";

const RESTORE_LABEL = {
  undo: { idle: "Undo", busy: "Undoing…", Icon: Undo2Icon },
  redo: { idle: "Redo", busy: "Redoing…", Icon: Redo2Icon },
  "go-back": { idle: "Go back to this build", busy: "Going back…", Icon: HistoryIcon },
} as const;

/**
 * A changing chat turn's build, under its changed files: its facts, Play, and
 * the one restore it offers (Undo on the latest turn, then Redo; Go back on an
 * older one). A turn the Builds list's first page does not hold keeps a link.
 */
export function GameTurnBuild({ threadRef, runId }: { threadRef: ScopedThreadRef; runId: RunId }) {
  const undo = useTurnUndo(threadRef, runId);
  const plays = useBuildPlay(threadRef);
  const [windowMessage, setWindowMessage] = useState<string | null>(null);
  const view = undo.view;
  if (view === null) return <OpenTurnBuild threadRef={threadRef} runId={runId} />;
  const build = view.build;
  const ref = { _tag: "build", build: build.id } as const;
  const play = async () => {
    const stage = useGameWorkspaceStore.getState();
    // The folder is this build: the Stage's own game is it, so no copy starts.
    if (turnBuildIsFolder(view)) {
      setStagePlayTarget(threadRef, null);
      stage.showStageTab("play");
      return;
    }
    const result = await plays.send(ref);
    if (result === null) return;
    if (result._tag === "window") {
      setWindowMessage(result.message);
      return;
    }
    setStagePlayTarget(threadRef, { build: build.id, label: buildName(build), result });
    stage.showStageTab("play");
  };
  const action = undo.writer ? undo.action : null;
  const label = action === null ? null : RESTORE_LABEL[action.kind];
  return (
    <div data-game-turn-build={build.id} className="mt-1.5 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1">
          {build.facts.state === "never" ? (
            <span className="text-2xs text-muted-foreground">
              {build.noPlay === null
                ? "Not measured yet: opening the build measures it"
                : `Not measured: ${build.noPlay}`}
            </span>
          ) : (
            <GameBuildFactChips summary={build.facts} />
          )}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={
            !build.available || build.noPlay !== null || !plays.canPlay || plays.playing(ref)
          }
          onClick={() => void play()}
        >
          <PlayIcon className="fill-current" aria-hidden="true" />
          {plays.playing(ref) ? "Starting…" : "Play"}
        </Button>
        {action?.kind === "redo" ? (
          <span className="text-2xs text-muted-foreground">Undone</span>
        ) : null}
        {action !== null && label !== null ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={action.blocked !== null || !undo.canRestore || undo.pending}
            onClick={() => void undo.send()}
          >
            <label.Icon aria-hidden="true" />
            {undo.restoring ? label.busy : label.idle}
          </Button>
        ) : null}
        <OpenTurnBuild threadRef={threadRef} runId={runId} />
      </div>
      {action !== null && action.kind !== "go-back" && action.blocked !== null ? (
        <p className="text-2xs text-muted-foreground">{action.blocked}</p>
      ) : null}
      {undo.error !== null ? (
        <p role="alert" className="text-2xs text-destructive-foreground">
          {undo.error}
        </p>
      ) : null}
      {plays.error(ref) ? (
        <p role="alert" className="text-2xs text-destructive-foreground">
          {plays.error(ref)}
        </p>
      ) : null}
      {windowMessage !== null ? (
        <p className="text-2xs text-muted-foreground">{windowMessage}</p>
      ) : null}
    </div>
  );
}

/** The turn's build on the Builds tab: its facts in full, compare, and history. */
function OpenTurnBuild({ threadRef, runId }: { threadRef: ScopedThreadRef; runId: RunId }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() =>
        useGameWorkspaceStore.getState().showStageTab("builds", {
          open: { _tag: "turn", threadId: threadRef.threadId, runId },
        })
      }
    >
      <ArrowUpRightIcon aria-hidden="true" />
      Open build
    </Button>
  );
}
