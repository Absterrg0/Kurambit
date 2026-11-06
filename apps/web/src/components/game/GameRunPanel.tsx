import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  ChevronRightIcon,
  PlayIcon,
  RefreshCwIcon,
  SendIcon,
  SquareIcon,
} from "lucide-react";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import {
  GAME_RUN_STAGES,
  GameOperationError,
  gameRunRoleLabel,
  type GameRunDecision,
  type GameRunProfile,
  type GameRunRungRef,
  type GameRunStatusResult,
  type GameRunThreadRef,
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
import { cn, randomUUID } from "../../lib/utils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameElapsed } from "./GameElapsed";
import { GameKeyArt } from "./GameKeyArt";
import { GameRunPickRow, GameRunRoundRow, GameRunSavedBuilds } from "./GameRunRounds";
import { GAME_RUN_PROFILE_HINT, GameRunProfileToggle } from "./GameRunProfileToggle";
import { formatRunDuration, groupRoleThreads } from "./gameRunView.logic";
import { useGameLibrary } from "./useGameLibrary";

const isGameOperationError = Schema.is(GameOperationError);

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
  const canSwitch = useAtomValue(
    gameEnvironment.runProfile.permissionAtom(threadRef.environmentId),
  );
  const runProfile = useAtomCommand(gameEnvironment.runProfile, { reportFailure: false });
  const [startProfile, setStartProfile] = useState<GameRunProfile | null>(null);
  const [note, setNote] = useState("");
  const steerKey = useRef<{ readonly text: string; readonly id: string } | null>(null);
  const [steerMessage, setSteerMessage] = useState<string | null>(null);
  // What the last start did, in one line (a resume, a fresh run, an earlier run not carried over).
  const [startMessage, setStartMessage] = useState<string | null>(null);
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
  // The run pushes a game event on every step change, which rereads this
  // status; nothing polls while a run is live.
  const game = useGameLibrary().games.find((entry) => entry.projectId === shell?.projectId) ?? null;
  const startedAt = status?.startedAt == null ? Number.NaN : Date.parse(status.startedAt);

  // The server says whether the run continues without a new brief.
  const resumable = status?.resumable === true;
  // A resume keeps the run's own profile unless the creator picks another; a new run is Guided.
  const profile = startProfile ?? (resumable ? status.profile : null) ?? "guided";
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
        profile,
        ...(picked === null ? {} : { provider: picked.instanceId, model: picked.model }),
        ...(budget === undefined || !Number.isFinite(budget) || budget <= 0
          ? {}
          : { budgetMinutes: budget }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setStartMessage(null);
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setStartMessage(result.value.message);
    statusQuery.refresh();
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
    const text = note.trim();
    if (busy || text.length === 0) return;
    // Sending the same note again after a failure is a retry of the same
    // command, so a note that did land is not added twice.
    if (steerKey.current?.text !== text) steerKey.current = { text, id: randomUUID() };
    setBusy(true);
    setError(null);
    const result = await runSteer({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, text, commandId: steerKey.current.id },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      // The run refused the note ("finishing… try again"): that answer is its
      // receipt, so a retry must be a new command to be taken at all.
      if (isGameOperationError(failure) && failure.runReason !== undefined) steerKey.current = null;
      setError(String(failure));
      return;
    }
    steerKey.current = null;
    setNote("");
    setSteerMessage(result.value.message);
    statusQuery.refresh();
  };
  const switchProfile = async (next: GameRunProfile) => {
    if (busy || next === status?.profile) return;
    setBusy(true);
    setError(null);
    const result = await runProfile({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, profile: next },
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
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          {game?.keyArt != null ? (
            <span className="relative block aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-muted">
              <GameKeyArt
                environmentId={threadRef.environmentId}
                root={game.root}
                path={game.keyArt}
              />
            </span>
          ) : null}
          <h3 className="text-sm font-medium">Production run</h3>
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge
                  size="sm"
                  variant={active ? "success" : status?.ending === "failed" ? "error" : "outline"}
                />
              }
            >
              {active
                ? "Running"
                : status?.runId != null
                  ? endingLabel(status.ending)
                  : "Not started"}
            </TooltipTrigger>
            {status?.runId != null ? <TooltipPopup>Run {status.runId}</TooltipPopup> : null}
          </Tooltip>
          {status?.profile != null ? (
            <Badge size="sm" variant="outline">
              {status.profile === "guided" ? "Guided" : "Autopilot"}
            </Badge>
          ) : null}
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
          <>
            {active ? (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{status.step ?? status.stage}</span>
                {Number.isFinite(startedAt) ? (
                  <>
                    {" · "}
                    <GameElapsed since={startedAt} />
                    {" in"}
                  </>
                ) : null}
                {status.progress?.next != null ? ` · next: ${status.progress.next}` : ""}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{status.message}</p>
            )}
            {active && status.decision !== null ? (
              <DecisionLine decision={status.decision} />
            ) : null}
            {status.progress !== null ? (
              <RunPipeline
                stage={status.progress.stage}
                finished={status.ending === "ready"}
                live={active}
              />
            ) : null}
          </>
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
        {startMessage ? <p className="text-2xs text-muted-foreground">{startMessage}</p> : null}
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
              <GameRunProfileToggle
                value={profile}
                onChange={setStartProfile}
                disabled={busy || !canRun}
              />
              <span className="text-2xs text-muted-foreground">
                {GAME_RUN_PROFILE_HINT[profile]}
              </span>
            </div>
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
                {busy
                  ? "Starting…"
                  : resumable && brief.trim().length === 0
                    ? "Resume run"
                    : "Start run"}
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
            {status?.profile != null ? (
              <div className="flex flex-wrap items-center gap-2">
                <GameRunProfileToggle
                  value={status.profile}
                  onChange={(next) => void switchProfile(next)}
                  disabled={busy || !canSwitch}
                />
                <span className="text-2xs text-muted-foreground">
                  {GAME_RUN_PROFILE_HINT[status.profile]}
                </span>
              </div>
            ) : null}
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

      {(status?.ladder.length ?? 0) > 0 ? <RunLadder rungs={status?.ladder ?? []} /> : null}

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

      {(status?.rounds.length ?? 0) > 0 || status?.pick != null ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Timeline</h3>
          <ul className="space-y-2">
            {status?.pick != null ? (
              <GameRunPickRow threadRef={threadRef} pick={status.pick} />
            ) : null}
            {status?.rounds.map((round) => (
              <GameRunRoundRow
                key={round.round}
                threadRef={threadRef}
                round={round}
                live={active}
                latestRestore={status?.restore ?? null}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {!active && (status?.builds.length ?? 0) > 0 ? (
        <GameRunSavedBuilds
          threadRef={threadRef}
          builds={status?.builds ?? []}
          latestRestore={status?.restore ?? null}
        />
      ) : null}

      {(status?.threads.length ?? 0) > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Role threads</h3>
          <div className="space-y-1">
            {groupRoleThreads(status?.threads ?? []).map((group, index, groups) => (
              <RoleThreadGroup
                // oxlint-disable-next-line react/no-array-index-key -- groups only grow at the end
                key={`${index}:${group.label}`}
                threadRef={threadRef}
                label={group.label}
                threads={group.threads}
                defaultOpen={index === groups.length - 1}
                onOpen={openThread}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

const DECISION: Record<GameRunDecision["kind"], string> = {
  style: "the vision and look",
  prototype: "which prototype to keep",
  ladder: "the ladder",
};

/** What a Guided run waits for. Static: the deadline is a time of day, not a countdown. */
function DecisionLine({ decision }: { decision: GameRunDecision }) {
  const deadline = decision.deadline === null ? Number.NaN : Date.parse(decision.deadline);
  return (
    <p className="text-xs text-foreground">
      Waiting for your call on {DECISION[decision.kind]}: answer in the chat.
      {Number.isFinite(deadline)
        ? ` If you don't, the run goes on with its own choice at ${new Date(deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
        : ""}
    </p>
  );
}

const ENDING: Record<string, string> = {
  ready: "Ready",
  stopped: "Stopped",
  budget: "Budget spent",
  failed: "Failed",
  stalled: "Stalled",
  "no-ladder": "No ladder",
  done: "Done",
  "usage-limit": "Usage limit",
  "provider-down": "Provider down",
  "low-memory": "Memory short",
  busy: "Machine busy",
};
const endingLabel = (ending: string | null): string =>
  ending === null ? "Paused" : (ENDING[ending] ?? ending);

const RUNG_STATUS: Record<GameRunRungRef["status"], string> = {
  todo: "",
  done: "Landed",
  "set-aside": "Set aside",
};

/** The demo ladder in build order: landed rungs checked, the one being built marked. */
function RunLadder({ rungs }: { rungs: ReadonlyArray<GameRunRungRef> }) {
  const landed = rungs.filter((rung) => rung.status === "done").length;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">
        Ladder{" "}
        <span className="text-xs font-normal text-muted-foreground">
          {landed} of {rungs.length} landed
        </span>
      </h3>
      <ol className="space-y-1 rounded-lg border border-border bg-card p-3">
        {rungs.map((rung, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- a rung's place is its identity here
          <li key={index} className="flex items-start gap-2 text-xs">
            <span className="flex size-4 shrink-0 items-center justify-center">
              {rung.status === "done" ? (
                <CheckIcon className="size-3 text-success" aria-hidden />
              ) : rung.current ? (
                <span className="size-1.5 rounded-full bg-info" aria-hidden />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  rung.status === "done" && "text-muted-foreground",
                  rung.current && "font-medium",
                  rung.status === "set-aside" && "text-muted-foreground line-through",
                )}
              >
                {index + 1}. {rung.is}
              </span>
              {rung.why.length > 0 ? (
                <span className="block text-2xs text-muted-foreground">
                  {rung.status === "set-aside" ? "Set aside: " : "Added by the reviewer: "}
                  {rung.why}
                </span>
              ) : null}
            </span>
            {RUNG_STATUS[rung.status].length > 0 ? (
              <Badge size="sm" variant={rung.status === "done" ? "success" : "warning"}>
                {RUNG_STATUS[rung.status]}
              </Badge>
            ) : rung.current ? (
              <Badge size="sm" variant="info">
                Building
              </Badge>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The run's stages in order: done ones checked, the current one marked. */
function RunPipeline({
  stage,
  finished,
  live,
}: {
  stage: number;
  finished: boolean;
  live: boolean;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-2xs" aria-label="Run stages">
      {GAME_RUN_STAGES.map((label, index) => {
        const done = finished || index < stage;
        const current = !finished && index === stage;
        return (
          <li
            key={label}
            aria-current={current ? "step" : undefined}
            className={cn(
              "flex items-center gap-1",
              done && "text-muted-foreground",
              current && "font-medium text-foreground",
              !done && !current && "text-muted-foreground/60",
            )}
          >
            {index > 0 ? <ChevronRightIcon className="size-3 opacity-50" aria-hidden /> : null}
            {done ? <CheckIcon className="size-3 text-success" aria-hidden /> : null}
            {current ? (
              <span
                className={cn("size-1.5 rounded-full", live ? "bg-info" : "bg-muted-foreground")}
                aria-hidden
              />
            ) : null}
            {label}
          </li>
        );
      })}
    </ol>
  );
}

function RoleThreadGroup({
  threadRef,
  label,
  threads,
  defaultOpen,
  onOpen,
}: {
  threadRef: ScopedThreadRef;
  label: string;
  threads: ReadonlyArray<GameRunThreadRef>;
  defaultOpen: boolean;
  onOpen: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-1 text-left text-2xs font-medium text-muted-foreground">
        <ChevronRightIcon className={cn("size-3", open && "rotate-90")} aria-hidden />
        {label}
        <span className="font-normal">· {threads.length}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        {open ? (
          <ul className="space-y-1 pb-1">
            {threads.map((thread) => (
              <RoleThreadRow
                key={`${thread.role}:${thread.threadId}`}
                threadRef={threadRef}
                thread={thread}
                onOpen={onOpen}
              />
            ))}
          </ul>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** One role thread, with its live state from the thread shell the client already holds. */
function RoleThreadRow({
  threadRef,
  thread,
  onOpen,
}: {
  threadRef: ScopedThreadRef;
  thread: GameRunThreadRef;
  onOpen: (threadId: string) => void;
}) {
  const shell = useThreadShell({
    environmentId: threadRef.environmentId,
    threadId: thread.threadId as ThreadId,
  });
  const running = threadRuntimeIsActive(shell?.runtime);
  const latest = shell?.latestRun ?? null;
  const started = Date.parse(thread.startedAt);
  const ended = latest?.completedAt == null ? Number.NaN : Date.parse(latest.completedAt);
  const state = running
    ? ({ label: "Running", variant: "info" } as const)
    : latest?.status === "completed"
      ? ({ label: "Done", variant: "success" } as const)
      : latest?.status === "failed"
        ? ({ label: "Failed", variant: "error" } as const)
        : latest?.status === "interrupted" || latest?.status === "cancelled"
          ? ({ label: "Interrupted", variant: "warning" } as const)
          : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(thread.threadId)}
        aria-current={running ? "step" : undefined}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-left text-xs hover:border-foreground/25",
          running ? "border-info/50" : "border-border",
        )}
      >
        <span className="truncate font-medium">{gameRunRoleLabel(thread.role)}</span>
        {state !== null ? (
          <Badge size="sm" variant={state.variant}>
            {state.label}
          </Badge>
        ) : null}
        <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
          {running && Number.isFinite(started) ? (
            <GameElapsed since={started} />
          ) : Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? (
            formatRunDuration(ended - started)
          ) : Number.isFinite(started) ? (
            new Date(started).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          ) : null}
        </span>
      </button>
    </li>
  );
}
