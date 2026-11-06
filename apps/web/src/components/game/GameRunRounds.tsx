import { useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, HistoryIcon } from "lucide-react";
import {
  GameOperationError,
  gameRunRoleLabel,
  type GameRunComparison,
  type GameRunPickDetail,
  type GameRunPickHow,
  type GameRunPickRef,
  type GameRunRoundDetail,
  type GameRunRoundOutcome,
  type GameRunRestoreRef,
  type GameRunRoundRef,
  type GameRunSavedBuild,
  type ScopedThreadRef,
} from "@kurambit/contracts";

import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { resolveAssetUrl } from "../../assets/assetUrls";
import { requestConfirmDialog } from "../../confirmDialog";
import { cn, randomUUID } from "../../lib/utils";
import { gameEnvironment, runRestoreSending, setRunRestoreSending } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SaveMediaButton } from "./GameSavedMedia";
import { exposureLine, formatRunDuration, pickSideLabel } from "./gameRunView.logic";

const OUTCOME: Record<
  GameRunRoundOutcome,
  { label: string; variant: "success" | "warning" | "error" | "outline" }
> = {
  kept: { label: "Kept", variant: "success" },
  inconclusive: { label: "Inconclusive", variant: "warning" },
  rejected: { label: "Rejected", variant: "error" },
  unjudged: { label: "Unjudged", variant: "outline" },
  abandoned: { label: "Abandoned", variant: "outline" },
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

const isGameOperationError = Schema.is(GameOperationError);

type RestoreTarget = { readonly round: number } | { readonly build: string };
const targetKey = (target: RestoreTarget) =>
  "round" in target ? `round:${target.round}` : `build:${target.build}`;

/**
 * Asks the run for a restore and follows it through the run's status: the
 * call returns once the request is recorded, and the push that lands the
 * outcome rereads the status. Asking again after a lost answer is a retry of
 * the same request, so it never restores twice.
 */
function useRunRestore(threadRef: ScopedThreadRef, latest: GameRunRestoreRef | null) {
  const canRestore = useAtomValue(
    gameEnvironment.runRestore.permissionAtom(threadRef.environmentId),
  );
  const runRestore = useAtomCommand(gameEnvironment.runRestore, { reportFailure: false });
  const key = useRef<{ readonly target: string; readonly id: string } | null>(null);
  const shared = useAtomValue(runRestoreSending(threadRef));
  const [sent, setSent] = useState<{ readonly target: string; readonly requestId: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // Sent by this client and not yet in the run's status, which moves past `since` once it is.
  const waiting = shared !== null && (latest?.requestId ?? null) === shared.since;
  const pending = waiting || (latest !== null && latest.outcome === null);
  const send = async (target: RestoreTarget, question: string) => {
    if (pending) return;
    if ((await requestConfirmDialog(question)) !== true) return;
    const name = targetKey(target);
    if (key.current?.target !== name) key.current = { target: name, id: randomUUID() };
    const since = latest?.requestId ?? null;
    setRunRestoreSending(threadRef, { target: name, since });
    setError(null);
    const result = await runRestore({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, commandId: key.current.id, ...target },
    });
    if (result._tag === "Failure") {
      setRunRestoreSending(threadRef, null);
      const failure = squashAtomCommandFailure(result);
      // The run's refusal is its answer to this id; asking again is a new request.
      if (isGameOperationError(failure) && failure.runReason !== undefined) key.current = null;
      setError(String(failure));
      return;
    }
    key.current = null;
    // A request answered earlier is already in the status; a new one makes it move.
    if (result.value.done || result.value.requestId === since)
      setRunRestoreSending(threadRef, null);
    setSent({ target: name, requestId: result.value.requestId });
  };
  // The outcome of the restore this view asked for, once the run's status holds it.
  const mine = sent !== null && latest?.requestId === sent.requestId ? latest : null;
  return {
    canRestore,
    pending,
    waiting,
    restoring: (target: RestoreTarget) =>
      (waiting && shared?.target === targetKey(target)) ||
      (pending && mine !== null && sent?.target === targetKey(target)),
    outcome: mine?.outcome ?? null,
    error,
    send,
  };
}

function RestoreOutcome({
  outcome,
  error,
  label,
}: {
  outcome: GameRunRestoreRef["outcome"];
  error: string | null;
  /** Names the restore when the outcome may be another client's or an agent's. */
  label?: string | undefined;
}) {
  if (error !== null)
    return (
      <p role="alert" className="text-2xs text-destructive-foreground">
        {error}
      </p>
    );
  if (outcome === null) return null;
  return (
    <p
      role={outcome.restored ? undefined : "alert"}
      className={cn(
        "text-2xs",
        outcome.restored ? "text-muted-foreground" : "text-destructive-foreground",
      )}
    >
      {label === undefined ? null : <span className="font-medium">Last restore, {label}: </span>}
      {outcome.message}
    </p>
  );
}

/** A blind comparison's evidence: the comparators, the players' reports with their frames, the bots. */
function ComparisonFields({
  threadRef,
  saveLabel,
  comparison,
  name = asIs,
  judgeLabel = asIs,
  onSheetLoad,
  onSheetError,
}: {
  threadRef: ScopedThreadRef;
  /** What a saved sheet's name starts with ("round 3"). */
  saveLabel: string;
  comparison: GameRunComparison;
  /** How a build is named to the reader ("A" → "A · Prototype 2"). */
  name?: (build: string) => string;
  judgeLabel?: (order: string) => string;
  onSheetLoad: () => void;
  onSheetError: () => void;
}) {
  const connection = usePreparedConnection(threadRef.environmentId);
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
                  {sheetUrl !== null && sheet !== undefined ? (
                    <SaveMediaButton
                      threadRef={threadRef}
                      source={sheet.file}
                      label={`${saveLabel} ${name(report.build)} frame sheet`}
                    />
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
  latestRestore,
}: {
  threadRef: ScopedThreadRef;
  round: number;
  rung: GameRunRoundRef["rung"];
  live: boolean;
  latestRestore: GameRunRestoreRef | null;
}) {
  const query = useEnvironmentQuery(
    gameEnvironment.runRound({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, round },
    }),
  );
  const connection = usePreparedConnection(threadRef.environmentId);
  const restores = useRunRestore(threadRef, latestRestore);
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

  const restore = () =>
    restores.send(
      { round },
      `Restore round ${round}'s build?\nThe engine project, art/ and ASSETS.md go back to this round's kept build; what the folder holds now is saved as a build first. Notes, PLAN.md, VISION.md, bots and run records stay as they are. A round the stopped run is in the middle of is abandoned, and a resume starts the next round from this build.`,
    );
  const restoring = restores.restoring({ round });

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
          threadRef={threadRef}
          saveLabel={`round ${round}`}
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
          {videoUrl !== null && detail.video !== null ? (
            <SaveMediaButton
              threadRef={threadRef}
              source={detail.video.file}
              label={`round ${round} bot run`}
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
                disabled={live || restores.pending || !restores.canRestore}
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
          <RestoreOutcome outcome={restores.outcome} error={restores.error} />
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
  latestRestore,
}: {
  threadRef: ScopedThreadRef;
  round: GameRunRoundRef;
  live: boolean;
  latestRestore: GameRunRestoreRef | null;
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
            <RoundDetail
              threadRef={threadRef}
              round={round.round}
              rung={round.rung}
              live={live}
              latestRestore={latestRestore}
            />
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
          threadRef={threadRef}
          saveLabel="prototype pick"
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

const savedAt = (at: string): string =>
  new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * The builds a stopped run keeps beside its kept rounds: the game as it left
 * it, unfinished work, the game before each restore. Restoring one brings it
 * back to the folder and leaves the run's best as it is.
 */
export function GameRunSavedBuilds({
  threadRef,
  builds,
  latestRestore,
}: {
  threadRef: ScopedThreadRef;
  builds: ReadonlyArray<GameRunSavedBuild>;
  latestRestore: GameRunRestoreRef | null;
}) {
  const restores = useRunRestore(threadRef, latestRestore);
  const restore = (build: GameRunSavedBuild) =>
    restores.send(
      { build: build.name },
      `Restore "${build.label}"?\nThe engine project, art/ and ASSETS.md go back to this build; what the folder holds now is saved as a build first. Notes, PLAN.md, VISION.md, bots and run records stay as they are. The run's best stays as it was, so a resume starts its next round from the best, and a round the stopped run is in the middle of is abandoned.`,
    );
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Saved builds</h3>
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {builds.map((build) => (
          <li key={build.name} className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-xs">{build.label}</span>
            <span className="shrink-0 text-2xs text-muted-foreground">{savedAt(build.at)}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={restores.pending || !restores.canRestore}
              onClick={() => void restore(build)}
            >
              <HistoryIcon aria-hidden="true" />
              {restores.restoring({ build: build.name }) ? "Restoring…" : "Restore"}
            </Button>
          </li>
        ))}
      </ul>
      {restores.waiting ? (
        <p className="text-2xs text-muted-foreground">Asking the run to restore…</p>
      ) : latestRestore !== null && latestRestore.outcome === null ? (
        <p className="text-2xs text-muted-foreground">Restoring {latestRestore.label}…</p>
      ) : null}
      {/* The latest restore's outcome, whoever asked for it: this view, a round, another client, an agent. */}
      <RestoreOutcome
        outcome={restores.waiting ? null : (latestRestore?.outcome ?? null)}
        error={restores.error}
        label={latestRestore?.label}
      />
    </section>
  );
}
