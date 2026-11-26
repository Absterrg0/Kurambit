import {
  CheckIcon,
  CircleDashedIcon,
  FileDiffIcon,
  Redo2Icon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";
import type { RunId, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import type { TurnDiffFileChange } from "../../types";
import { DiffStatLabel, hasNonZeroStat } from "../chat/DiffStatLabel";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { showWorkbench } from "./gameWorkbenchPanel";
import { checksLine, factsSettled } from "./gameBuilds.logic";
import { stepVerdictText } from "./keepGoing.logic";
import { useTurnUndo } from "./useBuildActions";

/**
 * A changing chat turn's build in the chat, on one line: its name, its checks, the files it
 * changed (their diff opens in the right panel) and Undo or Redo while it is the latest. The
 * name plays it on the Stage; the Workbench's Checks has everything else.
 */
export function GameTurnBuild({
  threadRef,
  runId,
  files,
  onOpenDiff,
}: {
  threadRef: ScopedThreadRef;
  runId: RunId;
  files: ReadonlyArray<TurnDiffFileChange>;
  onOpenDiff: () => void;
}) {
  const stat = summarizeTurnDiffStats(files);
  const filesButton =
    files.length === 0 ? null : (
      // A raised chip, as the files a turn touched read in any agent's log: count and +/-.
      <Button size="xs" variant="outline" onClick={onOpenDiff}>
        <FileDiffIcon aria-hidden="true" />
        {files.length === 1 ? "1 file" : `${files.length} files`}
        {hasNonZeroStat(stat) ? (
          <DiffStatLabel additions={stat.additions} deletions={stat.deletions} layout="inline" />
        ) : null}
      </Button>
    );
  const undo = useTurnUndo(threadRef, runId);
  const view = undo.view;
  const open = () => {
    if (view !== null)
      useGameWorkspaceStore
        .getState()
        .requestStage({ kind: "play", build: { _tag: "build", build: view.build.id } });
  };
  // The build is still being saved (or sits on an older page of the list): the row names no
  // build until it can say which, with its checks and Undo.
  if (view === null)
    return (
      <div data-game-turn-build="" className="mt-1.5 flex items-center gap-x-1.5">
        {filesButton}
      </div>
    );
  const build = view.build;
  const action = undo.action?.kind === "go-back" ? null : undo.action;
  const step = build.source._tag === "turn" ? build.source.step : null;
  return (
    <div data-game-turn-build={build.id} className="mt-1.5 flex flex-col gap-1">
      <div className="-ms-2 flex min-w-0 items-center gap-x-0.5">
        {step?.verdict === "undone" || undo.action?.kind === "redo" ? (
          // Undone: its checks, good or not, describe a game the folder no longer holds.
          <Undo2Icon className="ms-2 size-3.5 shrink-0 text-dim-foreground" aria-hidden="true" />
        ) : !factsSettled(build.facts) ? (
          <CircleDashedIcon
            className="ms-2 size-3.5 shrink-0 text-dim-foreground"
            aria-hidden="true"
          />
        ) : build.facts.bad > 0 ? (
          <TriangleAlertIcon className="ms-2 size-3.5 shrink-0 text-warning" aria-hidden="true" />
        ) : (
          <CheckIcon className="ms-2 size-3.5 shrink-0 text-success" aria-hidden="true" />
        )}
        <Button size="xs" variant="ghost" onClick={open} disabled={!build.available}>
          {build.name}
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          // The one part that gives way in a narrow lane, so the files and Undo stay in reach.
          className="min-w-0 shrink"
          disabled={!build.available}
          onClick={() => {
            useGameWorkspaceStore.getState().inspectBuild({
              threadKey: scopedThreadKey(threadRef),
              build: build.id,
              snapshot: build,
            });
            showWorkbench("checks");
          }}
        >
          <span className="truncate">
            {step?.verdict != null
              ? `${stepVerdictText(step)} · `
              : undo.action?.kind === "redo"
                ? "Undone · "
                : ""}
            {checksLine(build.facts)}
          </span>
        </Button>
        <span className="flex-1" />
        {filesButton}
        {action !== null ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={action.blocked !== null || !undo.canRestore || undo.pending}
            onClick={() => void undo.send()}
          >
            {action.kind === "undo" ? (
              <Undo2Icon aria-hidden="true" />
            ) : (
              <Redo2Icon aria-hidden="true" />
            )}
            {undo.restoring
              ? action.kind === "undo"
                ? "Undoing…"
                : "Redoing…"
              : action.kind === "undo"
                ? "Undo"
                : "Redo"}
          </Button>
        ) : null}
      </div>
      {undo.error !== null ? (
        <Text variant="caption" tone="destructive" render={<p role="alert" />}>
          {undo.error}
        </Text>
      ) : null}
    </div>
  );
}
