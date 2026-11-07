import { ArrowUpRightIcon, HistoryIcon, PlayIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import type { GameBuild, RunId, ScopedThreadRef } from "@kurambit/contracts";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { Button } from "../ui/button";
import { GameBuildFactChips } from "./GameBuildFacts";
import { turnBuildIsFolder } from "./gameTurnBuild.logic";
import { stepLine } from "./keepGoing.logic";
import { useTurnUndo } from "./useBuildActions";

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
  const view = undo.view;
  if (view === null) return <OpenTurnBuild threadRef={threadRef} runId={runId} />;
  const build = view.build;
  // The Stage plays it: the folder's own game when the folder is this build, else a copy.
  const play = () =>
    useGameWorkspaceStore
      .getState()
      .requestStage(
        turnBuildIsFolder(view)
          ? { kind: "live" }
          : { kind: "play", build: { _tag: "build", build: build.id } },
      );
  const action = undo.writer ? undo.action : null;
  const label = action === null ? null : RESTORE_LABEL[action.kind];
  const step = build.source._tag === "turn" ? build.source.step : null;
  return (
    <div data-game-turn-build={build.id} className="mt-1.5 space-y-1">
      {step === null ? null : <StepLine step={step} />}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Never narrower than its widest chip: the buttons wrap below instead. */}
        <span className="flex-1">
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
          disabled={!build.available || build.noPlay !== null}
          onClick={play}
        >
          <PlayIcon className="fill-current" aria-hidden="true" />
          Play
        </Button>
        {action?.kind === "redo" && step?.verdict !== "undone" ? (
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
    </div>
  );
}

type Step = NonNullable<Extract<GameBuild["source"], { _tag: "turn" }>["step"]>;

/** A keep-going step's verdict and why (design §7.4). */
function StepLine({ step }: { step: Step }) {
  return (
    <p data-game-step={step.verdict ?? "measuring"} className="text-2xs text-muted-foreground">
      {stepLine(step)}
    </p>
  );
}

/** The turn's build on the timeline, its detail open: facts in full, compare, its diff. */
function OpenTurnBuild({ threadRef, runId }: { threadRef: ScopedThreadRef; runId: RunId }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() =>
        useGameWorkspaceStore.getState().requestStage({
          kind: "detail",
          build: { _tag: "turn", threadId: threadRef.threadId, runId },
        })
      }
    >
      <ArrowUpRightIcon aria-hidden="true" />
      Open build
    </Button>
  );
}
