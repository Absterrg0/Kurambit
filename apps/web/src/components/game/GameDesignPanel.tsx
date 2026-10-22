import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  FilePlusIcon,
  FileTextIcon,
  PencilIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { GameAcceptanceCriterion, GameStatus, ScopedThreadRef } from "@t3tools/contracts";
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
  const requestChange = useAtomCommand(gameEnvironment.requestChange, { reportFailure: false });
  const approveRevisionCmd = useAtomCommand(gameEnvironment.approveRevision, {
    reportFailure: false,
  });
  const discardRevisionCmd = useAtomCommand(gameEnvironment.discardRevision, {
    reportFailure: false,
  });
  const refreshLibrary = useGameLibrary().refresh;
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestText, setRequestText] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [discarding, setDiscarding] = useState(false);

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
  const revisionPending = designState === "revision-pending";
  // A game created without design review records each revision itself.
  const autoRevision = status.design.autoRevision;
  const auto = autoRevision !== undefined;
  const approvable = !auto && (draft || changed);
  const warnings = status.design.warnings ?? [];
  const approvedLabel = approvedOn(status.design.approvedAt ?? undefined);
  const designPath = status.designPath;
  const contents = status.design.document?.trim() ?? "";
  const briefContents = brief.data?.contents.trim() ?? "";
  const acceptance = status.design.acceptance;
  const issues = status.design.issues;
  const currentHash = status.design.currentHash;
  const pendingRevision = status.design.pendingRevision;
  const revisionDiff = status.design.revisionDiff;
  // What the acceptance set covers, by kind: the creator should be able to see
  // the shape of the promise before approving it, not just its individual lines.
  const coverage = (["control", "mechanic", "content", "win", "lose", "presentation"] as const)
    .map((kind) => ({
      kind,
      count: acceptance.filter((criterion) => criterion.kind === kind).length,
    }))
    .filter((entry) => entry.count > 0);
  const canApprove =
    canOperate &&
    !turnRunning &&
    !approving &&
    status.design.document !== null &&
    !status.design.documentTruncated &&
    currentHash !== null &&
    issues.length === 0;
  const canResolveRevision = canApprove && revisionPending;

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

  const approveRevisionAction = async () => {
    if (!canResolveRevision || currentHash === null) return;
    setApproving(true);
    setError(null);
    const result = await approveRevisionCmd({
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

  const discardRequest = async () => {
    if (!canOperate || turnRunning || discarding) return;
    setDiscarding(true);
    setError(null);
    const result = await discardRevisionCmd({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setDiscarding(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    onRefresh();
  };

  const sendRequest = async () => {
    const text = requestText.trim();
    if (!canOperate || turnRunning || requesting || text === "") return;
    setRequesting(true);
    setError(null);
    const result = await requestChange({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, text },
    });
    setRequesting(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setRequestText("");
    setRequestOpen(false);
    refreshLibrary();
    onRefresh();
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-start gap-3 px-6 pt-5">
        <div className="min-w-0 flex-1">
          {revisionPending ? (
            <>
              <p className="flex items-center gap-2 text-sm font-medium">
                Change requested — review &amp; approve
                <span className="rounded-full border border-border px-1.5 py-0.5 text-2xs font-normal text-muted-foreground">
                  building locked
                </span>
              </p>
              <p className="mt-0.5 max-w-lg text-xs text-muted-foreground">
                The agent is rewriting DESIGN.md for this request. Export, preview, playtest and
                Blender stay locked until you approve the change.
              </p>
            </>
          ) : draft ? (
            <>
              <p className="flex items-center gap-2 text-sm font-medium">
                Design draft
                <span className="rounded-full border border-border px-1.5 py-0.5 text-2xs font-normal text-muted-foreground">
                  not built yet
                </span>
              </p>
              <p className="mt-0.5 max-w-lg text-xs text-muted-foreground">
                {auto
                  ? "The agent writes DESIGN.md and builds right away; nothing waits for approval."
                  : turnRunning
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
          ) : approved && auto ? (
            <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
              <CheckIcon className="size-3.5 text-success" aria-hidden="true" />
              {`Revision ${autoRevision} recorded${approvedLabel ? ` ${approvedLabel}` : ""} · edits become new revisions`}
            </p>
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
          {revisionPending && pendingRevision ? (
            <div className="mt-2 max-w-xl rounded-md border border-border bg-muted/40 px-3 py-2">
              <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Requested change
              </p>
              <p className="mt-1 whitespace-pre-wrap text-xs">{pendingRevision.text}</p>
            </div>
          ) : null}
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
          {warnings.length > 0 ? (
            <div className="mt-2 max-w-xl rounded-md border border-border px-3 py-2">
              <p className="text-xs font-medium">Unfinished hints (not blocking)</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
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
            disabled={approving || requesting || discarding}
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
          {approved && !auto && !revisionPending ? (
            <Button
              size="sm"
              variant="outline"
              disabled={turnRunning || requesting}
              onClick={() => setRequestOpen((open) => !open)}
            >
              <FilePlusIcon className="size-3.5" aria-hidden="true" />
              Request change
            </Button>
          ) : null}
          {approvable ? (
            <Button size="sm" disabled={!canApprove} onClick={() => void approve()}>
              {approving ? "Approving…" : changed ? "Re-approve design" : "Approve & build"}
            </Button>
          ) : null}
          {revisionPending ? (
            <>
              <Button
                size="sm"
                disabled={!canResolveRevision}
                onClick={() => void approveRevisionAction()}
              >
                {approving ? "Approving…" : "Approve change & build"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canOperate || turnRunning || discarding || approving}
                onClick={() => void discardRequest()}
              >
                {discarding ? "Discarding…" : "Discard request"}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {requestOpen && approved && !revisionPending ? (
        <div className="mx-auto w-full max-w-4xl px-6">
          <div className="ml-auto max-w-xl rounded-md border border-border p-3">
            <label htmlFor="game-change-request" className="text-xs font-medium">
              Describe the change you want
            </label>
            <textarea
              id="game-change-request"
              value={requestText}
              onChange={(event) => setRequestText(event.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="e.g. Add a double jump and make the owls slower."
              className="mt-2 w-full resize-y rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-ring"
            />
            <p className="mt-1 text-2xs text-muted-foreground">
              This locks staging until you approve the revised design. Chat stays free-form for
              anything else.
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={requesting}
                onClick={() => setRequestOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                disabled={requesting || requestText.trim() === ""}
                onClick={() => void sendRequest()}
              >
                {requesting ? "Requesting…" : "Send request"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
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
              ? auto
                ? "DESIGN.md appears here when the agent saves it."
                : "DESIGN.md appears here when the agent saves it. Ask for changes in chat, then review it here before building."
              : "This game has no DESIGN.md yet. Ask the agent to write one in chat."}
          </p>
          <Button size="xs" variant="ghost" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      )}
      {revisionPending && pendingRevision && !revisionDiff ? (
        <section className="mx-auto w-full max-w-4xl border-t border-border px-6 py-4">
          <h3 className="text-sm font-medium">Acceptance</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The criteria cannot be compared with the approved set until DESIGN.md parses cleanly;
            fix the issues above first.
          </p>
        </section>
      ) : null}
      {revisionDiff && pendingRevision ? (
        <section className="mx-auto w-full max-w-4xl border-t border-border px-6 py-4">
          <h3 className="text-sm font-medium">Acceptance — revision review</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            What the pending DESIGN.md changes about the approved set. Approving binds the new set
            and starts the change's build turn; every criterion the change removes must stay
            acknowledged under a &quot;Removed:&quot; line in DESIGN.md.
          </p>
          <div className="mt-3 space-y-3">
            <AcceptanceDiffGroup
              label="Added"
              criteria={revisionDiff.added}
              empty="No added criteria."
            />
            <AcceptanceDiffGroup
              label="Changed"
              criteria={revisionDiff.changed}
              empty="No edited criteria."
            />
            <AcceptanceDiffGroup
              label="Removed"
              criteria={revisionDiff.removed}
              empty="No removed criteria."
            />
          </div>
        </section>
      ) : null}
      {acceptance.length > 0 && !revisionPending ? (
        <section className="mx-auto w-full max-w-4xl border-t border-border px-6 py-4">
          <h3 className="text-sm font-medium">Acceptance</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {approved && auto
              ? "The latest recorded revision's criteria."
              : approved
                ? "The approved revision binds the build to these."
                : changed && issues.length > 0
                  ? "These were bound by the last approval. Fix DESIGN.md and re-approve to bind its current criteria."
                  : "These are the criteria in DESIGN.md. Approve the design to bind them."}
          </p>
          <p className="mt-1 text-2xs text-muted-foreground">
            Coverage: {coverage.map((entry) => `${entry.count} ${entry.kind}`).join(" · ")}
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

/** One id-diff group of the revision review: every criterion keeps its id. */
function AcceptanceDiffGroup({
  label,
  criteria,
  empty,
}: {
  label: string;
  criteria: readonly GameAcceptanceCriterion[];
  empty: string;
}) {
  return (
    <div>
      <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {criteria.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {criteria.map((criterion) => (
            <li key={criterion.id} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 shrink-0 rounded-full border border-border px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted-foreground">
                {criterion.kind}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block">{criterion.text}</span>
                <span className="block text-2xs text-muted-foreground">
                  {criterion.id}
                  {criterion.observe
                    ? ` · ${criterion.observe.key} ${criterion.observe.expect}`
                    : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
