import { useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { ChevronRightIcon, HistoryIcon } from "lucide-react";
import {
  gameRunRoleLabel,
  type EnvironmentId,
  type GameRunComparison,
  type GameRunPickDetail,
  type GameRunPickHow,
  type GameRunPickRef,
  type GameRunRoundDetail,
  type GameRunRoundOutcome,
  type GameRunRoundRef,
  type ScopedThreadRef,
} from "@kurambit/contracts";

import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { resolveAssetUrl } from "../../assets/assetUrls";
import { requestConfirmDialog } from "../../confirmDialog";
import { cn } from "../../lib/utils";
import { gameEnvironment, noteRunRestored } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { exposureLine, formatRunDuration, pickSideLabel } from "./gameRunView.logic";

const OUTCOME: Record<
  GameRunRoundOutcome,
  { label: string; variant: "success" | "warning" | "error" | "outline" }
> = {
  kept: { label: "Kept", variant: "success" },
  inconclusive: { label: "Inconclusive", variant: "warning" },
  rejected: { label: "Rejected", variant: "error" },
  unjudged: { label: "Unjudged", variant: "outline" },
};

// The move is the reviewer's markdown; its first prose line says what the round tried.
const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#")) ?? text.trim();

/** A text that starts clamped and opens in place. */
function LongText({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 320 || text.split("\n").length > 4;
  return (
    <div className="space-y-0.5">
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-2xs text-muted-foreground",
          long && !expanded && "line-clamp-4",
          className,
        )}
      >
        {text}
      </p>
      {long ? (
        <Button size="micro" variant="link" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}

function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <h4 className="text-2xs font-medium text-foreground">{title}</h4>
      {children}
    </div>
  );
}

const asIs = (text: string): string => text;

/** A blind comparison's evidence: the comparators, the players' reports with their frames, the bots. */
function ComparisonFields({
  environmentId,
  comparison,
  name = asIs,
  judgeLabel = asIs,
  onSheetLoad,
  onSheetError,
}: {
  environmentId: EnvironmentId;
  comparison: GameRunComparison;
  /** How a build is named to the reader ("A" → "A · Prototype 2"). */
  name?: (build: string) => string;
  judgeLabel?: (order: string) => string;
  onSheetLoad: () => void;
  onSheetError: () => void;
}) {
  const connection = usePreparedConnection(environmentId);
  return (
    <>
      {comparison.gate ? (
        <p className="text-2xs text-warning-foreground">
          Comparison stopped early: {comparison.gate}
        </p>
      ) : null}
      {comparison.judges.some((judge) => judge.reasoning.length > 0) ? (
        <Field title="Blind comparators">
          <ul className="space-y-1.5">
            {comparison.judges.map((judge) => (
              <li key={judge.order} className="space-y-0.5">
                <p className="text-2xs">
                  <span className="font-mono text-muted-foreground">{judgeLabel(judge.order)}</span>{" "}
                  → <span className="font-medium">{name(judge.verdict)}</span>
                </p>
                {judge.reasoning ? <LongText text={judge.reasoning} /> : null}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
      {comparison.reports.length > 0 ? (
        <Field
          title={
            comparison.sheets.length > 0 && !comparison.sheetsShown
              ? "Blind play reports (frame sheets were not shown to the judges)"
              : "Blind play reports"
          }
        >
          <ul className="space-y-1.5">
            {comparison.reports.map((report) => {
              const sheet = comparison.sheets.find((each) => each.build === report.build);
              const sheetUrl =
                sheet?.url != null && connection._tag === "Some"
                  ? resolveAssetUrl(connection.value.httpBaseUrl, sheet.url)
                  : null;
              return (
                <li key={report.build} className="space-y-0.5">
                  <p className="text-2xs font-medium capitalize">{name(report.build)}</p>
                  {report.exposure !== null ? (
                    <p className="text-2xs text-muted-foreground">
                      Saw {exposureLine(report.exposure)}
                    </p>
                  ) : null}
                  <LongText text={report.text} />
                  {sheetUrl !== null ? (
                    <a href={sheetUrl} target="_blank" rel="noreferrer">
                      <img
                        src={sheetUrl}
                        alt={`Frames from the ${name(report.build)} player's own play`}
                        loading="lazy"
                        width={1612}
                        height={758}
                        className="h-auto w-full rounded-md"
                        onLoad={onSheetLoad}
                        onError={onSheetError}
                      />
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Field>
      ) : null}
      {comparison.bots.length > 0 || comparison.botWithheld ? (
        <Field title="Bot facts">
          <ul className="space-y-0.5">
            {comparison.bots.map((bot) => (
              <li key={bot.build} className="text-2xs text-muted-foreground">
                <span className="font-medium text-foreground capitalize">{name(bot.build)}</span>:
                ended {bot.ending} after {bot.seconds.toFixed(0)}s{bot.note ? ` (${bot.note})` : ""}{" "}
                · {JSON.stringify(bot.final)}
              </li>
            ))}
          </ul>
          {comparison.botWithheld ? (
            <p className="text-2xs text-muted-foreground">
              Withheld from the comparators: {comparison.botWithheld}
            </p>
          ) : null}
        </Field>
      ) : null}
    </>
  );
}

function RoundDetail({
  threadRef,
  round,
  rung,
  live,
}: {
  threadRef: ScopedThreadRef;
  round: number;
  rung: GameRunRoundRef["rung"];
  live: boolean;
}) {
  const query = useEnvironmentQuery(
    gameEnvironment.runRound({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, round },
    }),
  );
  const connection = usePreparedConnection(threadRef.environmentId);
  const canRestore = useAtomValue(
    gameEnvironment.runRestore.permissionAtom(threadRef.environmentId),
  );
  const runRestore = useAtomCommand(gameEnvironment.runRestore, { reportFailure: false });
  const [restoring, setRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // The signed video URL lasts an hour; one refetch per failure mints a new one,
  // and a video that loaded may retry again later.
  const [videoRetried, setVideoRetried] = useState(false);
  const detail: GameRunRoundDetail | null = query.data;
  if (detail === null)
    return (
      <p className="px-3 pb-3 text-2xs text-muted-foreground">
        {query.error ?? "Loading the round's evidence…"}
      </p>
    );

  const videoUrl =
    detail.video?.url != null && connection._tag === "Some"
      ? resolveAssetUrl(connection.value.httpBaseUrl, detail.video.url)
      : null;
  const comparison = detail.comparison;

  const restore = async () => {
    if (restoring) return;
    const confirmed = await requestConfirmDialog(
      `Restore round ${round}'s build?\nThe engine project, art/ and ASSETS.md go back to this round's kept build with a new commit, so later work stays in git history. Notes, PLAN.md, VISION.md, bots and run records stay as they are. Uncommitted changes block the restore; nothing is discarded.`,
    );
    if (confirmed !== true) return;
    setRestoring(true);
    setRestoreError(null);
    const result = await runRestore({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, round },
    });
    setRestoring(false);
    if (result._tag === "Failure") {
      setRestoreError(String(squashAtomCommandFailure(result)));
      return;
    }
    setRestoreMessage(result.value.message);
    noteRunRestored(threadRef.environmentId);
  };

  return (
    <div className="space-y-3 border-t border-border px-3 py-3">
      <Field title="Move">
        <LongText text={detail.move} />
      </Field>
      {detail.steer.length > 0 ? (
        <Field title="You asked">
          <ul className="space-y-0.5">
            {detail.steer.map((asked, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- notes may repeat and never reorder
              <li key={index} className="text-2xs text-foreground">
                {asked}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
      {detail.note ? <p className="text-2xs text-warning-foreground">{detail.note}</p> : null}

      {rung !== null ? (
        <Field title="Checks">
          <ul className="space-y-1">
            {rung.checks.map((check, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- checks keep the rung's order
              <li key={index} className="space-y-0.5">
                <p className="text-2xs">
                  <span className="font-medium">{check.pass ? "Pass" : "Fail"}</span> · {check.what}
                </p>
                {check.evidence ? <LongText text={check.evidence} /> : null}
              </li>
            ))}
          </ul>
          {rung.why ? <p className="text-2xs text-muted-foreground">{rung.why}</p> : null}
        </Field>
      ) : null}

      {detail.verdicts.length > 0 ? (
        <Field title="Verdicts">
          <ul className="space-y-1.5">
            {detail.verdicts.map((verdict) => (
              <li key={verdict.order} className="space-y-0.5">
                <p className="text-2xs">
                  <span className="font-mono text-muted-foreground">{verdict.order}</span> →{" "}
                  <span className="font-medium">{verdict.verdict}</span>
                </p>
                {verdict.reason ? <LongText text={verdict.reason} /> : null}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}

      {comparison !== null ? (
        <ComparisonFields
          environmentId={threadRef.environmentId}
          comparison={comparison}
          onSheetLoad={() => setVideoRetried(false)}
          onSheetError={() => {
            // Signed links last an hour, like the video's.
            if (videoRetried) return;
            setVideoRetried(true);
            query.refresh();
          }}
        />
      ) : null}

      {detail.testerNote ? (
        <Field title="Tester">
          <LongText text={detail.testerNote} />
        </Field>
      ) : null}
      {detail.reviewerNotes ? (
        <Field title="Reviewer">
          <LongText text={detail.reviewerNotes} />
        </Field>
      ) : null}
      {detail.direction ? (
        <Field title="Next direction">
          <LongText text={detail.direction} />
        </Field>
      ) : null}

      {detail.botRuns.length > 0 ? (
        <Field title="Bot runs">
          <ul className="space-y-0.5">
            {detail.botRuns.map((run) => (
              <li key={run.runId} className="truncate text-2xs text-muted-foreground">
                <span className="font-mono">{run.file || run.runId.slice(0, 8)}</span> · {run.mode}{" "}
                · {run.ending} after {run.seconds.toFixed(0)}s
                {run.findings > 0 ? ` · ${run.findings} findings` : ""}
              </li>
            ))}
          </ul>
          {videoUrl !== null ? (
            <video
              controls
              preload="none"
              src={videoUrl}
              className="w-full rounded-md bg-black"
              onLoadedMetadata={() => setVideoRetried(false)}
              onError={() => {
                if (videoRetried) return;
                setVideoRetried(true);
                query.refresh();
              }}
            />
          ) : null}
        </Field>
      ) : null}

      {detail.restorable ? (
        <div className="flex flex-wrap items-center gap-2">
          {detail.current ? (
            <p className="text-2xs text-muted-foreground">
              This round is the game's current build.
            </p>
          ) : (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={live || restoring || !canRestore}
                onClick={() => void restore()}
              >
                <HistoryIcon aria-hidden="true" />
                {restoring ? "Restoring…" : "Restore this round"}
              </Button>
              {live ? (
                <p className="text-2xs text-muted-foreground">
                  Stop the run before restoring a round.
                </p>
              ) : null}
            </>
          )}
          {restoreMessage ? (
            <p className="text-2xs text-muted-foreground">{restoreMessage}</p>
          ) : null}
          {restoreError ? (
            <p role="alert" className="text-2xs text-destructive-foreground">
              {restoreError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One round: a one-line summary that opens to the round's evidence, read only when opened. */
export function GameRunRoundRow({
  threadRef,
  round,
  live,
}: {
  threadRef: ScopedThreadRef;
  round: GameRunRoundRef;
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const outcome = OUTCOME[round.outcome];
  return (
    <li className="rounded-lg border border-border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")}
            aria-hidden="true"
          />
          <span className="shrink-0 text-xs font-medium">Round {round.round}</span>
          <Badge size="sm" variant={outcome.variant}>
            {outcome.label}
          </Badge>
          {round.steer.length > 0 ? (
            <Badge size="sm" variant="info">
              Steered
            </Badge>
          ) : null}
          {round.rung !== null ? (
            <Badge size="sm" variant={round.rung.outcome === "landed" ? "success" : "outline"}>
              Checks {round.rung.checks.filter((check) => check.pass).length}/
              {round.rung.checks.length}
              {round.rung.outcome === "set-aside" ? " · set aside" : ""}
            </Badge>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {firstLine(round.move)}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground">
            {formatRunDuration(round.durationMs)}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          {open ? (
            <RoundDetail threadRef={threadRef} round={round.round} rung={round.rung} live={live} />
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

function PickDetail({ threadRef }: { threadRef: ScopedThreadRef }) {
  const query = useEnvironmentQuery(
    gameEnvironment.runPick({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  // One refetch per failure mints fresh sheet links; a sheet that loaded may retry later.
  const [retried, setRetried] = useState(false);
  const detail: GameRunPickDetail | null = query.data;
  if (detail === null)
    return (
      <p className="px-3 pb-3 text-2xs text-muted-foreground">
        {query.error ?? "Loading the pick's evidence…"}
      </p>
    );
  const name = (build: string) => pickSideLabel(build, detail.sides);
  return (
    <div className="space-y-3 border-t border-border px-3 py-3">
      {detail.sides.length > 0 ? (
        <Field title="Blind labels">
          <p className="text-2xs text-muted-foreground">
            {detail.sides.map((side) => name(side.build)).join(", ")}. The players and comparators
            saw only the letters.
          </p>
        </Field>
      ) : null}
      {detail.chosen !== null ? (
        <p className="text-2xs">
          The game continued from{" "}
          <span className="font-medium">{gameRunRoleLabel(detail.chosen)}</span>.
        </p>
      ) : null}
      {detail.note ? <p className="text-2xs text-muted-foreground">{detail.note}</p> : null}
      {detail.comparison !== null ? (
        <ComparisonFields
          environmentId={threadRef.environmentId}
          comparison={detail.comparison}
          name={name}
          judgeLabel={() => "Comparator"}
          onSheetLoad={() => setRetried(false)}
          onSheetError={() => {
            if (retried) return;
            setRetried(true);
            query.refresh();
          }}
        />
      ) : detail.note === null ? (
        <p className="text-2xs text-muted-foreground">
          The blind players' reports and the comparator's reasoning appear here once the pick is
          judged.
        </p>
      ) : null}
    </div>
  );
}

const PICK_HOW: Record<GameRunPickHow, string> = {
  won: "won",
  selected: "selected after a tie",
  "only-booted": "adopted, the only one that booted",
  creator: "picked by you",
};

const PICK_PHASE: Record<GameRunPickRef["phase"], string> = {
  prototypes: "Building prototypes",
  comparing: "Blind comparison",
  done: "Picked",
};

/** The prototype pick, shaped like a round: a summary line that opens to its evidence. */
export function GameRunPickRow({
  threadRef,
  pick,
}: {
  threadRef: ScopedThreadRef;
  pick: GameRunPickRef;
}) {
  const [open, setOpen] = useState(false);
  const summary =
    pick.chosen !== null
      ? `${gameRunRoleLabel(pick.chosen)} ${PICK_HOW[pick.how ?? "won"]}`
      : pick.phase === "done"
        ? "No adopted prototype recorded"
        : "Two prototypes, played blind";
  return (
    <li className="rounded-lg border border-border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")}
            aria-hidden="true"
          />
          <span className="shrink-0 text-xs font-medium">Prototype pick</span>
          <Badge
            size="sm"
            variant={pick.phase !== "done" ? "info" : pick.chosen !== null ? "success" : "outline"}
          >
            {pick.phase === "done" && pick.chosen === null
              ? "Not recorded"
              : PICK_PHASE[pick.phase]}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>
          {pick.durationMs !== null ? (
            <span className="shrink-0 text-2xs text-muted-foreground">
              {formatRunDuration(pick.durationMs)}
            </span>
          ) : null}
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          {open ? <PickDetail threadRef={threadRef} /> : null}
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}
