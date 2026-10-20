import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon, FileTextIcon, PencilIcon, RefreshCwIcon } from "lucide-react";
import type { GameStatus, ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRightPanelStore } from "../../rightPanelStore";
import ChatMarkdown from "../ChatMarkdown";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { useGameLibrary } from "./useGameLibrary";

const approvedOn = (approvedAt: string | undefined) => {
  if (!approvedAt) return null;
  const date = new Date(approvedAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
};

/**
 * The design document is the creator's contract with the agent: a draft is the
 * only thing a plan-first game may work on, and approving it is what starts the
 * build. BRIEF.md stays one disclosure away so the source brief is still
 * readable without competing with the design.
 */
export function GameDesignPanel({
  threadRef,
  status,
  turnRunning,
  canOperate,
  onApproved,
}: {
  threadRef: ScopedThreadRef;
  status: GameStatus;
  turnRunning: boolean;
  canOperate: boolean;
  onApproved: () => void;
}) {
  const design = useProjectFileQuery(
    threadRef.environmentId,
    status.root,
    status.designPath,
    status.designPath !== null,
  );
  const brief = useProjectFileQuery(
    threadRef.environmentId,
    status.root,
    status.briefPath,
    status.briefPath !== null,
  );
  const approveDesign = useAtomCommand(gameEnvironment.approveDesign, { reportFailure: false });
  const refreshLibrary = useGameLibrary().refresh;
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDesign = design.refresh;
  const refreshBrief = brief.refresh;
  const previousTurnRunning = useRef(turnRunning);
  useEffect(() => {
    const wasRunning = previousTurnRunning.current;
    previousTurnRunning.current = turnRunning;
    if (!wasRunning || turnRunning) return;
    refreshDesign();
    refreshBrief();
  }, [turnRunning, refreshDesign, refreshBrief]);

  const draft = status.design?.status === "draft";
  const approved = status.design?.status === "approved";
  const approvedLabel = approvedOn(status.design?.approvedAt);
  const designPath = status.designPath;
  const contents = design.data?.contents.trim() ?? "";
  const briefContents = brief.data?.contents.trim() ?? "";

  const approve = async () => {
    if (approving || turnRunning) return;
    setApproving(true);
    setError(null);
    const result = await approveDesign({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setApproving(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    refreshLibrary();
    onApproved();
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-start gap-3 px-6 pt-5">
        <div className="min-w-0 flex-1">
          {draft ? (
            <>
              <p className="flex items-center gap-2 text-sm font-medium">
                Design draft
                <span className="rounded-full border border-border px-1.5 py-0.5 text-2xs font-normal text-muted-foreground">
                  not built yet
                </span>
              </p>
              <p className="mt-0.5 max-w-lg text-xs text-muted-foreground">
                {turnRunning
                  ? "The agent is writing the design. It will keep this file current until you approve it."
                  : "Ask for changes in chat, or edit DESIGN.md yourself. Approve it to start the build."}
              </p>
            </>
          ) : approved ? (
            <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
              <CheckIcon className="size-3.5 text-success" aria-hidden="true" />
              {approvedLabel
                ? `Approved ${approvedLabel} · edits are fine, the agent keeps it current`
                : "Approved · edits are fine, the agent keeps it current"}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              This game was created before the design step, so there is no design contract.
            </p>
          )}
          {error ? (
            <p role="alert" className="mt-2 whitespace-pre-wrap text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 py-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh the design"
            disabled={approving}
            onClick={() => {
              design.refresh();
              brief.refresh();
            }}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden="true" />
          </Button>
          {designPath ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => useRightPanelStore.getState().openFile(threadRef, designPath)}
            >
              <PencilIcon className="size-3.5" aria-hidden="true" />
              Edit file
            </Button>
          ) : null}
          {draft ? (
            <Button
              size="sm"
              disabled={!canOperate || turnRunning || approving}
              onClick={() => void approve()}
            >
              {approving ? "Approving…" : "Approve & build"}
            </Button>
          ) : null}
        </div>
      </div>
      {design.isPending ? (
        <div className="mx-auto flex w-full max-w-4xl items-center gap-2 px-6 py-8 text-sm text-muted-foreground">
          <RefreshCwIcon
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Loading DESIGN.md…
        </div>
      ) : design.error ? (
        <div className="mx-auto flex w-full max-w-4xl flex-col items-start gap-2 px-6 py-8">
          <p className="text-sm text-destructive">{design.error}</p>
          <Button size="xs" variant="outline" onClick={design.refresh}>
            Retry
          </Button>
        </div>
      ) : contents ? (
        <ChatMarkdown
          text={contents}
          cwd={status.root}
          imageBaseDir={status.root}
          threadRef={threadRef}
          className="mx-auto max-w-4xl px-6 py-5"
        />
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 px-8 py-16 text-center">
          <FileTextIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">
            {draft ? "The agent is drafting the design" : "No design document"}
          </p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {draft
              ? "DESIGN.md appears here when the agent saves it. Ask for changes in chat, then review it here before building."
              : "This game has no DESIGN.md yet. Ask the agent to write one in chat."}
          </p>
          <Button size="xs" variant="ghost" onClick={design.refresh}>
            Refresh
          </Button>
        </div>
      )}
      {briefContents ? (
        <div className="mx-auto w-full max-w-4xl border-t border-border px-6 py-4">
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-sm font-medium">
              <ChevronRightIcon
                className="size-3.5 transition-transform group-data-panel-open:rotate-90"
                aria-hidden="true"
              />
              Brief
              <span className="text-xs font-normal text-muted-foreground">BRIEF.md</span>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <ChatMarkdown
                text={briefContents}
                cwd={status.root}
                imageBaseDir={status.root}
                threadRef={threadRef}
                className="pt-3"
              />
            </CollapsiblePanel>
          </Collapsible>
        </div>
      ) : null}
    </div>
  );
}
