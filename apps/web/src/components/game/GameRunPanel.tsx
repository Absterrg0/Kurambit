import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { PlayIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import type { GameRunStatusResult, ScopedThreadRef, ThreadId } from "@kurambit/contracts";

import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

/** The smallest working surface for a production run: start, status, stop. */
export function GameRunPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const statusQuery = useEnvironmentQuery(
    gameEnvironment.runStatus({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const canRun = useAtomValue(gameEnvironment.runStart.permissionAtom(threadRef.environmentId));
  const runStart = useAtomCommand(gameEnvironment.runStart, { reportFailure: false });
  const runStop = useAtomCommand(gameEnvironment.runStop, { reportFailure: false });
  const [brief, setBrief] = useState("");
  const [budgetMinutes, setBudgetMinutes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status: GameRunStatusResult | null = statusQuery.data ?? null;
  const active = status?.active ?? false;

  const start = async () => {
    if (busy || brief.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const budget = budgetMinutes.trim() === "" ? undefined : Number(budgetMinutes);
    const result = await runStart({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        brief: brief.trim(),
        ...(budget === undefined || !Number.isFinite(budget) || budget <= 0
          ? {}
          : { budgetMinutes: budget }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else statusQuery.refresh();
  };
  const stop = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runStop({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else statusQuery.refresh();
  };
  const openThread = (id: string) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadRef.environmentId, threadId: id as ThreadId },
    });
  };

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">Production run</h3>
          <span
            className={`rounded-full border px-2 py-0.5 text-2xs ${
              active
                ? "border-success/40 bg-secondary text-success-foreground"
                : "border-border bg-muted text-muted-foreground"
            }`}
          >
            {active ? "Running" : (status?.ending ?? "Not started")}
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            aria-label="Refresh run status"
            onClick={() => statusQuery.refresh()}
          >
            <RefreshCwIcon className="size-3" aria-hidden="true" />
            Refresh
          </Button>
        </div>
        {status !== null && status.runId !== null ? (
          <p className="text-xs text-muted-foreground">{status.message}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Start a run to build, play, judge and keep improving this game until the budget ends.
          </p>
        )}
        {error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
        {!active ? (
          <div className="space-y-2">
            <Textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              rows={3}
              placeholder="One-line brief: what the player does and what winning looks like."
              disabled={busy || !canRun}
              aria-label="Run brief"
            />
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Budget (minutes, optional)
                <Input
                  value={budgetMinutes}
                  onChange={(event) => setBudgetMinutes(event.target.value)}
                  inputMode="numeric"
                  placeholder="30"
                  disabled={busy || !canRun}
                  className="h-8 w-20"
                  aria-label="Budget in minutes"
                />
              </label>
              <Button
                size="sm"
                disabled={busy || !canRun || brief.trim().length === 0}
                onClick={() => void start()}
              >
                <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
                {busy ? "Starting…" : "Start run"}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !canRun}
            onClick={() => void stop()}
          >
            <SquareIcon className="size-3.5" aria-hidden="true" />
            {busy ? "Stopping…" : "Stop run"}
          </Button>
        )}
      </section>

      {(status?.rounds.length ?? 0) > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Rounds</h3>
          <ul className="space-y-2">
            {status?.rounds.map((round) => (
              <li
                key={round.round}
                className="space-y-1 rounded-lg border border-border bg-card p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium">Round {round.round}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-2xs ${
                      round.kept
                        ? "border-success/40 bg-secondary text-success-foreground"
                        : "border-border bg-muted text-muted-foreground"
                    }`}
                  >
                    {round.kept ? "Kept" : "Not kept"}
                  </span>
                  <span className="ml-auto text-2xs text-muted-foreground">
                    {Math.round(round.durationMs / 1000)}s
                    {round.linesChanged > 0 ? ` · ${round.linesChanged} lines` : ""}
                  </span>
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">{round.move}</p>
                {round.verdicts.length > 0 ? (
                  <ul className="space-y-0.5">
                    {round.verdicts.map((verdict) => (
                      <li
                        key={`${verdict.order}:${verdict.verdict}:${verdict.reason.slice(0, 24)}`}
                        className="text-2xs text-muted-foreground"
                      >
                        <span className="font-mono">{verdict.order}</span> →{" "}
                        <span className="font-medium text-foreground">{verdict.verdict}</span>
                        {verdict.reason ? ` — ${verdict.reason}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {round.testerNote ? (
                  <p className="line-clamp-3 text-2xs text-muted-foreground">
                    Tester: {round.testerNote}
                  </p>
                ) : null}
                {round.note ? (
                  <p className="text-2xs text-warning-foreground">{round.note}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {(status?.threads.length ?? 0) > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Role threads</h3>
          <ul className="space-y-1">
            {status?.threads.map((thread) => (
              <li key={`${thread.role}:${thread.threadId}`}>
                <button
                  type="button"
                  onClick={() => openThread(thread.threadId)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-left text-xs hover:border-foreground/25"
                >
                  <span className="font-medium">{thread.role}</span>
                  <span className="truncate font-mono text-2xs text-muted-foreground">
                    {thread.threadId}
                  </span>
                  <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                    {thread.startedAt ? new Date(thread.startedAt).toLocaleString() : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
