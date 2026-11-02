import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { PlayIcon, RefreshCwIcon, SendIcon, SquareIcon } from "lucide-react";
import {
  gameRunRoleLabel,
  type GameRunStatusResult,
  type ModelSelection,
  type ScopedThreadRef,
  type ThreadId,
} from "@kurambit/contracts";

import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

/** The smallest working surface for a production run: start, status, steer, stop. */
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
  const canSteer = useAtomValue(gameEnvironment.runSteer.permissionAtom(threadRef.environmentId));
  const runSteer = useAtomCommand(gameEnvironment.runSteer, { reportFailure: false });
  const [note, setNote] = useState("");
  const [steerMessage, setSteerMessage] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [budgetMinutes, setBudgetMinutes] = useState("");
  const [busy, setBusy] = useState(false);
  // The run's agent: the game chat's own model unless the creator picks
  // another one here, so a run can use a different provider than the chat.
  const shell = useThreadShell(threadRef);
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const providers = useEnvironmentProviders().get(threadRef.environmentId) ?? [];
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const runModel = picked ?? shell?.modelSelection ?? null;
  const [error, setError] = useState<string | null>(null);
  const status: GameRunStatusResult | null = statusQuery.data ?? null;
  const active = status?.active ?? false;
  // Run progress has no push event; a slow read keeps the stage, rounds and
  // verdicts current while a run is live, and stops when it ends.
  const refreshStatus = statusQuery.refresh;
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(refreshStatus, 15_000);
    return () => window.clearInterval(interval);
  }, [active, refreshStatus]);

  // A run record that is not live can be resumed without a new brief.
  const resumable = status !== null && status.runId !== null && status.ending !== "ready";
  const start = async () => {
    if (busy || (brief.trim().length === 0 && !resumable)) return;
    setBusy(true);
    setError(null);
    const budget = budgetMinutes.trim() === "" ? undefined : Number(budgetMinutes);
    const result = await runStart({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        brief: brief.trim(),
        ...(picked === null ? {} : { provider: picked.instanceId, model: picked.model }),
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
  const steer = async () => {
    if (busy || note.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const result = await runSteer({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, text: note.trim() },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setNote("");
    setSteerMessage(result.value.message);
    statusQuery.refresh();
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
              placeholder={
                resumable
                  ? "Optional: a new brief. Leave empty to resume with the run's own brief."
                  : "One-line brief: what the player does and what winning looks like."
              }
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
              {runModel !== null ? (
                <ProviderModelPicker
                  environmentId={threadRef.environmentId}
                  activeInstanceId={runModel.instanceId}
                  model={runModel.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={getCustomModelOptionsByInstance(
                    settings,
                    providers,
                    runModel.instanceId,
                    runModel.model,
                  )}
                  disabled={busy || !canRun}
                  onInstanceModelChange={(instanceId, model) => setPicked({ instanceId, model })}
                />
              ) : null}
              <Button
                size="sm"
                disabled={busy || !canRun || (brief.trim().length === 0 && !resumable)}
                onClick={() => void start()}
              >
                <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
                {busy ? "Starting…" : resumable ? "Resume run" : "Start run"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void steer();
              }}
            >
              <Input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Steer the next round: what should change?"
                disabled={busy || !canSteer}
                aria-label="Steer the next round"
                className="min-w-0 flex-1"
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={busy || !canSteer || note.trim().length === 0}
              >
                <SendIcon className="size-3.5" aria-hidden="true" />
                Steer
              </Button>
            </form>
            {steerMessage ? <p className="text-2xs text-muted-foreground">{steerMessage}</p> : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canRun}
              onClick={() => void stop()}
            >
              <SquareIcon className="size-3.5" aria-hidden="true" />
              {busy ? "Working…" : "Stop run"}
            </Button>
          </div>
        )}
      </section>

      {(status?.steer.length ?? 0) > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Waiting for the next round</h3>
          <ul className="space-y-1 rounded-lg border border-border bg-card p-3">
            {status?.steer.map((pending, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- notes may repeat and never reorder
              <li key={index} className="text-xs text-muted-foreground">
                You asked: {pending}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
                {round.steer.length > 0 ? (
                  <ul className="space-y-0.5">
                    {round.steer.map((asked, index) => (
                      // oxlint-disable-next-line react/no-array-index-key -- notes may repeat and never reorder
                      <li key={index} className="text-2xs text-foreground">
                        You asked: {asked}
                      </li>
                    ))}
                  </ul>
                ) : null}
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
                  <span className="truncate font-medium">{gameRunRoleLabel(thread.role)}</span>
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
