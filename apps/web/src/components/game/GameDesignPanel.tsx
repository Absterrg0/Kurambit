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
  onRefresh,
}: {
  threadRef: ScopedThreadRef;
  status: GameStatus;
  turnRunning: boolean;
  canOperate: boolean;
  onApproved: () => void;
  /** Refreshes the status snapshot this panel renders and approves. */
  onRefresh: () => void;
}) {
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

  const refreshBrief = brief.refresh;
  const previousTurnRunning = useRef(turnRunning);
  useEffect(() => {
    const wasRunning = previousTurnRunning.current;
    previousTurnRunning.current = turnRunning;
    if (!wasRunning || turnRunning) return;
    // The status query owns the design snapshot; the parent refreshes it when
    // the turn settles.
    refreshBrief();
  }, [turnRunning, refreshBrief]);

  const designState = status.design.state;
  const draft = designState === "draft";
  const changed = designState === "changed";
  const approved = designState === "approved";
  const approvable = draft || changed;
  const approvedLabel = approvedOn(status.design.approvedAt ?? undefined);
  const designPath = status.designPath;
  const contents = status.design.document?.trim() ?? "";
  const briefContents = brief.data?.contents.trim() ?? "";
  const acceptance = status.design.acceptance;
  const issues = status.design.issues;
  const currentHash = status.design.currentHash;
  const canApprove =
    canOperate &&
    !turnRunning &&
    !approving &&
    status.design.document !== null &&
    !status.design.documentTruncated &&
    currentHash !== null &&
    issues.length === 0;

  const approve = async () => {
    if (!canApprove || currentHash === null) return;
    setApproving(true);
    setError(null);
    const result = await approveDesign({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, expectedDesignHash: currentHash },
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
          ) : changed ? (
            <>
              <p className="text-sm font-medium">
                Design changed since approval — review &amp; re-approve
              </p>
              <p className="mt-0.5 max-w-lg text-xs text-muted-foreground">
                DESIGN.md no longer matches the revision you approved, so the game is unqualified
                and staging is locked. Review the new scope and re-approve it to continue.
              </p>
            </>
          ) : approved ? (
            <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
              <CheckIcon className="size-3.5 text-success" aria-hidden="true" />
              {approvedLabel
                ? `Approved ${approvedLabel} · scope changes need re-approval`
                : "Approved · scope changes need re-approval"}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              This game has no design contract: it was created before the design step or with
              planning skipped.
            </p>
          )}
          {approvable && issues.length > 0 ? (
            <div className="mt-2 max-w-xl rounded-md border border-border px-3 py-2">
              <p className="text-xs font-medium">Not ready to approve</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          ) : null}
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
              onRefresh();
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
          {approvable ? (
            <Button size="sm" disabled={!canApprove} onClick={() => void approve()}>
              {approving ? "Approving…" : changed ? "Re-approve design" : "Approve & build"}
            </Button>
          ) : null}
        </div>
      </div>
      {contents ? (
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
          <Button size="xs" variant="ghost" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      )}
      {acceptance.length > 0 ? (
        <section className="mx-auto w-full max-w-4xl border-t border-border px-6 py-4">
          <h3 className="text-sm font-medium">Acceptance</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {approved
              ? "The approved revision binds the build to these."
              : changed && issues.length > 0
                ? "These were bound by the last approval. Fix DESIGN.md and re-approve to bind its current criteria."
                : "These are the criteria in DESIGN.md. Approve the design to bind them."}
          </p>
          <ul className="mt-2 space-y-1.5">
            {acceptance.map((criterion) => (
              <li key={criterion.id} className="flex items-start gap-2 text-xs">
                <span className="mt-0.5 shrink-0 rounded-full border border-border px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted-foreground">
                  {criterion.kind}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">{criterion.text}</span>
                  {criterion.observe ? (
                    <span className="block text-2xs text-muted-foreground">
                      {criterion.observe.key} {criterion.observe.expect}
                    </span>
                  ) : criterion.kind === "presentation" ? (
                    <span className="block text-2xs text-muted-foreground">
                      Visual stage — not verified yet
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
