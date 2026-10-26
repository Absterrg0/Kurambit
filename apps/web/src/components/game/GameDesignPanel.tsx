import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  FilePlusIcon,
  FileTextIcon,
  PencilIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  isNoLoseStateCriterion,
  type GameAcceptanceCriterion,
  type GameStatus,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRightPanelStore } from "../../rightPanelStore";
import ChatMarkdown from "../ChatMarkdown";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Textarea } from "../ui/textarea";
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
  const stateTitle = revisionPending
    ? "Change requested"
    : draft
      ? "Design draft"
      : changed
        ? "Design changed"
        : approved
          ? "Design approved"
          : "No design contract";
  const stateBadge: { label: string; variant: "warning" | "success" | "secondary" } =
    revisionPending
      ? { label: "Building locked", variant: "warning" }
      : draft
        ? auto
          ? { label: "Auto revisions", variant: "secondary" }
          : { label: "Not approved", variant: "warning" }
        : changed
          ? { label: "Re-approval needed", variant: "warning" }
          : approved
            ? { label: "Approved", variant: "success" }
            : { label: "Planning skipped", variant: "secondary" };
  const stateDescription = revisionPending
    ? "The agent is rewriting DESIGN.md for this request. Export, preview, playtest and Blender stay locked until you approve the change."
    : draft
      ? auto
        ? "The agent writes DESIGN.md and builds right away; nothing waits for approval."
        : turnRunning
          ? "The agent is writing the design. It will keep this file current until you approve it."
          : "Ask for changes in chat, or edit DESIGN.md yourself. Approve it to start the build."
      : changed
        ? "DESIGN.md no longer matches the revision you approved, so the game is unqualified and staging is locked. Review the new scope and re-approve it to continue."
        : approved
          ? auto
            ? "Each DESIGN.md edit is recorded as a new revision."
            : "DESIGN.md matches the revision you approved. Scope changes need re-approval."
          : "This game has no design contract: it was created before the design step or with planning skipped.";
  const reviewedMeta = approved
    ? auto
      ? `Revision ${autoRevision}${approvedLabel ? ` · ${approvedLabel}` : ""}`
      : approvedLabel
        ? `Approved ${approvedLabel}`
        : "Approved"
    : designPath !== null
      ? designPath
      : "DESIGN.md";

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
    <div className="@container/design min-h-0 flex-1 overflow-auto scrollbar-gutter-both bg-background">
      <div className="mx-auto w-full max-w-5xl px-4 pb-14 pt-4 sm:px-6">
        <header className="rounded-xl border border-border/70 bg-card/40 p-4 shadow-xs @[48rem]/design:p-5">
          <div className="flex flex-col gap-4 @[48rem]/design:flex-row @[48rem]/design:items-start @[48rem]/design:justify-between">
            <div className="min-w-0 @[48rem]/design:max-w-2xl">
              <p className="text-2xs font-medium uppercase tracking-widest text-muted-foreground">
                Design review
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold tracking-tight">{stateTitle}</h2>
                <Badge size="sm" variant={stateBadge.variant}>
                  {stateBadge.label}
                </Badge>
              </div>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{stateDescription}</p>
              <p className="mt-2 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                {approved ? (
                  <CheckIcon className="size-3.5 shrink-0 text-success" aria-hidden="true" />
                ) : (
                  <FileTextIcon className="size-3.5 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">{reviewedMeta}</span>
              </p>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 @[48rem]/design:w-auto @[48rem]/design:shrink-0 @[48rem]/design:justify-end">
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
          <div className="mt-3 space-y-2">
            {revisionPending && pendingRevision ? (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Requested change
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{pendingRevision.text}</p>
              </div>
            ) : null}
            {approvable && issues.length > 0 ? (
              <div className="rounded-lg border border-warning/40 bg-warning-surface px-3 py-2.5">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-warning-foreground">
                  <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
                  Not ready to approve
                </p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-5 text-warning-foreground/85">
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {warnings.length > 0 ? (
              <Collapsible>
                <div className="rounded-lg border border-border/70 bg-background/50">
                  <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
                    <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
                    {warnings.length === 1
                      ? "1 scaffold hint (not blocking)"
                      : `${warnings.length} scaffold hints (not blocking)`}
                    <ChevronRightIcon
                      className="ml-auto size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90"
                      aria-hidden="true"
                    />
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <ul className="list-disc space-y-1 border-t border-border/60 px-3 py-2 pl-8 text-xs leading-5 text-muted-foreground">
                      {warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </CollapsiblePanel>
                </div>
              </Collapsible>
            ) : null}
            {error ? (
              <p
                role="alert"
                className="whitespace-pre-wrap rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs leading-5 text-destructive-foreground"
              >
                {error}
              </p>
            ) : null}
          </div>
        </header>
        {requestOpen && approved && !revisionPending ? (
          <section className="mt-4 rounded-xl border border-border/70 bg-card/40 p-4 shadow-xs">
            <label htmlFor="game-change-request" className="text-sm font-medium">
              Describe the change you want
            </label>
            <Textarea
              id="game-change-request"
              size="sm"
              value={requestText}
              onChange={(event) => setRequestText(event.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="e.g. Add a double jump and make the owls slower."
              className="mt-2"
            />
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              This locks staging until you approve the revised design. Chat stays free-form for
              anything else.
            </p>
            <div className="mt-3 flex justify-end gap-2">
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
          </section>
        ) : null}
        {contents ? (
          <article className="mt-4 overflow-hidden rounded-xl border border-border/70 bg-card/30">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5 @[48rem]/design:px-6">
              <h3 className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <FileTextIcon className="size-3.5 shrink-0" aria-hidden="true" />
                Design document
              </h3>
              <span className="hidden shrink-0 font-mono text-2xs text-muted-foreground/70 @[30rem]/design:inline">
                DESIGN.md
              </span>
            </div>
            <ChatMarkdown
              text={contents}
              cwd={status.root}
              imageBaseDir={status.root}
              threadRef={threadRef}
              className="mx-auto w-full max-w-3xl px-4 py-5 text-base leading-7 @[48rem]/design:px-8 @[48rem]/design:py-7"
            />
          </article>
        ) : (
          <div className="mt-4 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 bg-card/20 px-6 py-14 text-center">
            <FileTextIcon className="size-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">
              {draft ? "The agent is drafting the design" : "No design document"}
            </p>
            <p className="max-w-sm text-xs leading-5 text-muted-foreground">
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
          <section className="mx-auto mt-6 w-full max-w-3xl">
            <div className="rounded-xl border border-border/70 bg-card/30 p-4">
              <h3 className="text-sm font-semibold">Acceptance</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                The criteria cannot be compared with the approved set until DESIGN.md parses
                cleanly; fix the issues above first.
              </p>
            </div>
          </section>
        ) : null}
        {revisionDiff && pendingRevision ? (
          <section className="mx-auto mt-6 w-full max-w-3xl">
            <div className="border-b border-border/60 pb-2">
              <h3 className="text-sm font-semibold">Acceptance — revision review</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                What the pending DESIGN.md changes about the approved set. Approving binds the new
                set and starts the change&apos;s build turn; every criterion the change removes must
                stay acknowledged under a &quot;Removed:&quot; line in DESIGN.md.
              </p>
            </div>
            <div className="mt-3 space-y-4">
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
          <section className="mx-auto mt-6 w-full max-w-3xl">
            <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border/60 pb-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">Acceptance</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {approved && auto
                    ? "The latest recorded revision's criteria."
                    : approved
                      ? "The approved revision binds the build to these."
                      : changed && issues.length > 0
                        ? "These were bound by the last approval. Fix DESIGN.md and re-approve to bind its current criteria."
                        : "These are the criteria in DESIGN.md. Approve the design to bind them."}
                </p>
              </div>
              {coverage.length > 0 ? (
                <p className="text-2xs uppercase tracking-wide text-muted-foreground">
                  {coverage.map((entry) => `${entry.count} ${entry.kind}`).join(" · ")}
                </p>
              ) : null}
            </div>
            <ul className="mt-3 space-y-2">
              {acceptance.map((criterion) => (
                <AcceptanceCriterionRow key={criterion.id} criterion={criterion} />
              ))}
            </ul>
          </section>
        ) : null}
        {briefContents ? (
          <div className="mx-auto mt-6 w-full max-w-3xl border-t border-border/60 pt-3">
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 py-1 text-sm font-medium">
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
                  className="pt-3 text-sm leading-6"
                />
              </CollapsiblePanel>
            </Collapsible>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One acceptance criterion, with its verification key one disclosure away. */
function AcceptanceCriterionRow({
  criterion,
  showId = false,
}: {
  criterion: GameAcceptanceCriterion;
  showId?: boolean;
}) {
  return (
    <li className="rounded-lg border border-border/60 bg-card/30 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <Badge size="sm" variant="outline" className="mt-0.5 shrink-0">
          {criterion.kind}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-6 text-foreground/90">{criterion.text}</p>
          {criterion.observe ? (
            <details className="mt-1">
              <summary className="w-fit cursor-pointer text-2xs text-muted-foreground/80 hover:text-foreground">
                Verification key
              </summary>
              <p className="mt-1 break-words font-mono text-2xs leading-4 text-muted-foreground">
                {criterion.observe.key} {criterion.observe.expect}
              </p>
            </details>
          ) : criterion.kind === "presentation" ? (
            <p className="mt-1 text-2xs leading-4 text-muted-foreground">
              Visual stage — not verified yet
            </p>
          ) : isNoLoseStateCriterion(criterion) ? (
            <p className="mt-1 text-2xs leading-4 text-muted-foreground">
              Declared no losing state — no loss transition is verified, and this is not proof that
              the game cannot be lost.
            </p>
          ) : null}
          {showId ? (
            <p className="mt-1 break-all font-mono text-2xs leading-4 text-muted-foreground/70">
              {criterion.id}
            </p>
          ) : null}
        </div>
      </div>
    </li>
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
      <div className="flex items-center gap-2">
        <p className="text-2xs font-medium uppercase tracking-widest text-muted-foreground">
          {label}
        </p>
        <span className="text-2xs text-muted-foreground/70">{criteria.length}</span>
      </div>
      {criteria.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {criteria.map((criterion) => (
            <AcceptanceCriterionRow key={criterion.id} criterion={criterion} showId />
          ))}
        </ul>
      )}
    </div>
  );
}
