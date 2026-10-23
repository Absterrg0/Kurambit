import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { GameReviewHistory, ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAssetUrlState } from "../../assets/assetUrls";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function GameReviewPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [before, setBefore] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const status = useEnvironmentQuery(
    gameEnvironment.reviewStatus({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const history = useEnvironmentQuery(
    gameEnvironment.reviewHistory({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, ...(before === undefined ? {} : { before }) },
    }),
  );
  const canStop = useAtomValue(gameEnvironment.reviewStop.permissionAtom(threadRef.environmentId));
  const canRestore = useAtomValue(
    gameEnvironment.reviewRestore.permissionAtom(threadRef.environmentId),
  );
  const stop = useAtomCommand(gameEnvironment.reviewStop, { reportFailure: false });
  const restore = useAtomCommand(gameEnvironment.reviewRestore, { reportFailure: false });
  const act = async (kind: "stop" | "restore") => {
    setBusy(true);
    setMessage(null);
    const input = {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    };
    const result = kind === "stop" ? await stop(input) : await restore(input);
    setBusy(false);
    setMessage(
      result._tag === "Failure"
        ? String(squashAtomCommandFailure(result))
        : "message" in result.value
          ? result.value.message
          : "Review stopped.",
    );
    status.refresh();
    history.refresh();
  };
  const review = status.data;
  return (
    <section
      data-game-review={review?.loop?.status ?? "none"}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <h3 className="text-sm font-medium">Game review</h3>
      {status.error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {status.error}
        </p>
      ) : null}
      <p className="text-xs">{review?.phase ?? "Loading review…"}</p>
      {review?.loop ? (
        <>
          <p className="text-xs text-muted-foreground">
            {review.repairsLeft} repair rounds left · {Math.ceil(review.timeLeftMs / 60_000)}{" "}
            minutes left as of this update
          </p>
          <p className="text-xs text-muted-foreground">{review.loop.reason}</p>
          {review.loop.submissionNote ? (
            <p className="text-xs text-muted-foreground">Submitted: {review.loop.submissionNote}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Reviewer: {review.loop.reviewSelection.instanceId} / {review.loop.reviewSelection.model}
            . Builder: {review.loop.builderSelection.instanceId} /{" "}
            {review.loop.builderSelection.model}.
          </p>
          <p className="text-xs text-muted-foreground">
            Usage:{" "}
            {review.loop.usage.status === "unknown"
              ? "unknown"
              : `${review.loop.usage.providerTurns} turns, ${review.loop.usage.usedTokens} tokens`}
            .
          </p>
        </>
      ) : review ? (
        <p className="text-xs text-muted-foreground">
          A review starts after the agent submits a verified build, or after a turn ends with a
          verified export. Play remains on the selected build during review.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {review?.loop?.status === "running" || review?.held ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canStop || busy}
            onClick={() => void act("stop")}
          >
            Stop review
          </Button>
        ) : null}
        {review?.restoreOffered ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canRestore || busy || review.held}
            onClick={() => void act("restore")}
          >
            Restore previous version
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || status.isPending}
          onClick={() => {
            status.refresh();
            history.refresh();
          }}
        >
          Refresh review
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-xs">
          {message}
        </p>
      ) : null}
      {history.error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {history.error}
        </p>
      ) : null}
      {history.data?.rounds.map((entry) => (
        <ReviewRound key={entry.round.id} threadRef={threadRef} entry={entry} />
      ))}
      <div className="flex gap-2">
        {before !== undefined ? (
          <Button size="xs" variant="ghost" onClick={() => setBefore(undefined)}>
            Latest rounds
          </Button>
        ) : null}
        {history.data?.nextCursor ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={history.isPending}
            onClick={() => setBefore(history.data!.nextCursor!)}
          >
            Older rounds
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function ReviewRound({
  threadRef,
  entry,
}: {
  threadRef: ScopedThreadRef;
  entry: GameReviewHistory["rounds"][number];
}) {
  const { round, evidence } = entry;
  return (
    <article className="space-y-2 border-t border-border pt-3">
      <p className="text-xs font-medium">
        {new Date(round.startedAt).toLocaleString()} · {round.decision ?? round.status}
      </p>
      <p className="text-xs text-muted-foreground">{round.reason ?? "Review in progress."}</p>
      {round.submissionNote ? (
        <p className="text-xs text-muted-foreground">Repair note: {round.submissionNote}</p>
      ) : null}
      <ul className="space-y-2 text-xs">
        {round.defects?.map((defect) => (
          <li key={`${defect.frameId}-${defect.what}`}>
            <span className="font-medium">
              {defect.severity}: {defect.what}
            </span>
            <p className="text-muted-foreground">
              Fix: {defect.fix} · frame {defect.frameId}
            </p>
          </li>
        ))}
      </ul>
      {evidence.map((ref) => (
        <ReviewEvidence key={`${ref.role}-${ref.order}`} threadRef={threadRef} evidence={ref} />
      ))}
    </article>
  );
}
function ReviewEvidence({
  threadRef,
  evidence,
}: {
  threadRef: ScopedThreadRef;
  evidence: GameReviewHistory["rounds"][number]["evidence"][number];
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs">
        {evidence.role === "critic" ? "Review frames" : `Comparison ${evidence.order + 1} frames`}
      </summary>
      {open ? (
        <ul className="mt-2 flex flex-wrap gap-2">
          {evidence.frames.map((frame) => (
            <ReviewFrame key={frame.id} threadRef={threadRef} frame={frame} />
          ))}
        </ul>
      ) : null}
    </details>
  );
}
function ReviewFrame({
  threadRef,
  frame,
}: {
  threadRef: ScopedThreadRef;
  frame: { id: string; label: string; path: string };
}) {
  const asset = useAssetUrlState(threadRef.environmentId, {
    _tag: "media-file",
    threadId: threadRef.threadId,
    path: frame.path,
  });
  return (
    <li className="w-40">
      {asset._tag === "Success" ? (
        <a href={asset.url} target="_blank" rel="noreferrer" className="text-xs underline">
          <img
            src={asset.url}
            alt={`${frame.id}: ${frame.label}`}
            loading="lazy"
            className="aspect-video w-full rounded border border-border object-contain"
          />
          {frame.id}: {frame.label}
        </a>
      ) : (
        <span className="text-xs">{frame.id}: frame unavailable</span>
      )}
    </li>
  );
}
