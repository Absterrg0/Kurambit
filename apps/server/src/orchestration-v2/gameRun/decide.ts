// PURE. Keep going as an orchestration domain: for each game-run command, the
// thread's game-run records in, the events, outbox effects or a typed refusal
// out. A run with `loop: "turns"` is keep going's; a run without it was made by
// an earlier Kurambit (the stage era) and is only read and stopped.
import {
  type GameRun,
  type GameRunEnding,
  type GameRunId,
  type GameRunRefusalReason,
  type GameRunRound,
  type GameRunStep,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2GameRunCommand,
  type ProjectId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import { STAGE_ERA_SENTENCE } from "../../game/run/runView.ts";
import type { OrchestrationEffectRequestV2 } from "../EffectOutbox.ts";

export interface GameRunRecords {
  readonly projectId: ProjectId;
  /** The game's latest run on any of its project's threads: the folder is the project's. */
  readonly projectRun: GameRun | null;
  /** The thread's runs, oldest first. */
  readonly runs: ReadonlyArray<GameRun>;
  /** The thread's rounds across its runs: a game's round numbers continue from run to run. */
  readonly rounds: ReadonlyArray<GameRunRound>;
  /** The latest run's step in flight, when it holds one. */
  readonly inFlight: GameRunStep | null;
  /** The thread was deleted: nothing resumes its runs. */
  readonly chatDeleted: boolean;
  /** The thread's step records, for a resume only; else empty. */
  readonly steps: ReadonlyArray<GameRunStep>;
}

interface GameRunInputs {
  readonly at: DateTime.Utc;
  /** Uniform in [0, 1). */
  readonly coin: number;
  /** Fresh and unguessable. */
  readonly id: string;
}

type GameRunEventType =
  | "game-run.created"
  | "game-run.updated"
  | "game-run-step.updated"
  | "game-run-round.recorded";
export type GameRunDomainEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: GameRunEventType }
>;
type WithoutId<E> = E extends unknown ? Omit<E, "id"> : never;
/** An event the orchestrator gives an id when it commits it. */
export type GameRunEvent = WithoutId<GameRunDomainEvent>;
type GameRunEffectRequest = Extract<
  OrchestrationEffectRequestV2,
  { readonly type: `game-run.${string}` }
>;
/** The effects a stop cancels: every live one keep going plans. */
export const GAME_RUN_EFFECT_TYPES = [
  "game-run.step.execute",
  "game-run.decision.deadline",
  "game-run.step.deadline",
  "game-run.step.resend",
  "game-run.step.wake",
] as const satisfies ReadonlyArray<GameRunEffectRequest["type"]>;

interface GameRunEffect {
  readonly request: GameRunEffectRequest;
  /** Epoch ms; absent runs at once. */
  readonly availableAt?: number;
}

export interface GameRunDecision {
  readonly events: ReadonlyArray<GameRunEvent>;
  readonly effects: ReadonlyArray<GameRunEffect>;
  /** A stop: the run's unsettled effects are cancelled in the same commit. */
  readonly cancelEffects: boolean;
}

interface GameRunRefusal {
  readonly reason: GameRunRefusalReason;
  readonly message: string;
}

/** Every ending resumes but `done` (design §4.3); stage-era endings never do. */
export const RESUMABLE: ReadonlySet<GameRunEnding> = new Set<GameRunEnding>([
  "stopped",
  "stalled",
  "budget",
  "failed",
  "usage-limit",
  "provider-down",
  "tool-failed",
]);

/** A run made by an earlier Kurambit: read, stopped when live, never continued. */
export const stageEra = (run: GameRun): boolean => run.loop !== "turns";

const refuse = (reason: GameRunRefusalReason, message: string) =>
  Result.fail<GameRunRefusal>({ reason, message });

// Phase 3's run core (builder R) replaces this with the turns cycle.
const notBuilt = (command: OrchestrationV2GameRunCommand) =>
  refuse("wrong-kind", `not built: keep going's ${command.type} is the run core's (phase 3, R).`);

interface Work {
  readonly command: OrchestrationV2GameRunCommand;
  readonly records: GameRunRecords;
  readonly input: GameRunInputs;
  readonly at: string;
}

const runEvent = (work: Work, payload: GameRun): GameRunEvent => ({
  type: "game-run.updated",
  threadId: work.command.threadId,
  occurredAt: work.input.at,
  payload,
});
const stepEvent = (work: Work, payload: GameRunStep): GameRunEvent => ({
  type: "game-run-step.updated",
  threadId: work.command.threadId,
  occurredAt: work.input.at,
  payload,
});

type Command<T extends OrchestrationV2GameRunCommand["type"]> = Extract<
  OrchestrationV2GameRunCommand,
  { readonly type: T }
>;

/** The command's run: the thread's latest, which the command must name. */
const current = (work: Work, runId: GameRunId) => {
  const run = work.records.runs.at(-1);
  if (run === undefined) return refuse("no-run", "This chat has no keep-going run.");
  if (run.id !== runId)
    return refuse("stale-run", `Run ${runId} is not this chat's current run (${run.id} is).`);
  return Result.succeed(run);
};

const inFlightOf = (work: Work, run: GameRun) =>
  run.inFlight !== null && work.records.inFlight?.seq === run.inFlight
    ? work.records.inFlight
    : null;

/**
 * Stops a live run of either era. The step in flight is cancelled; a turns
 * run's resume plans afresh, and a stage-era run never resumes.
 */
const stop = (work: Work, command: Command<"game-run.stop">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    if (run.status === "ended")
      return refuse("run-ended", `Run ${run.id} ended (${run.ending ?? "unknown"}).`);
    const inFlight = inFlightOf(work, run);
    const why = command.reason?.trim() ?? "";
    // The server's own stop for a tool that kept failing is a pause with its
    // reason, never the person's act.
    const paused = command.ending === "tool-failed";
    const line = paused ? `run paused: ${why}` : `run stopped${why.length > 0 ? `: ${why}` : ""}`;
    const steps =
      inFlight === null
        ? []
        : [
            {
              ...inFlight,
              status: "cancelled" as const,
              logs: [...inFlight.logs, line],
              completedAt: work.at,
            },
          ];
    const ended: GameRun = {
      ...run,
      status: "ended",
      ending: paused ? "tool-failed" : "stopped",
      lastFailure: why.length > 0 ? why.slice(0, 600) : run.lastFailure,
      inFlight: null,
      endedAt: work.at,
      updatedAt: work.at,
    };
    return Result.succeed<GameRunDecision>({
      events: [...steps.map((step) => stepEvent(work, step)), runEvent(work, ended)],
      effects: [],
      cancelEffects: true,
    });
  });

/** A stage-era run takes only a stop; everything else is refused with why. */
const stageEraRefusal = () => refuse("not-resumable", STAGE_ERA_SENTENCE);

export const decide = (
  command: OrchestrationV2GameRunCommand,
  records: GameRunRecords,
  input: GameRunInputs,
): Result.Result<GameRunDecision, GameRunRefusal> => {
  const work: Work = { command, records, input, at: DateTime.formatIso(input.at) };
  if (command.type === "game-run.stop") return stop(work, command);
  if (command.type === "game-run.start") return notBuilt(command);
  const latest = records.runs.at(-1);
  if (latest !== undefined && latest.id === command.runId && stageEra(latest))
    return stageEraRefusal();
  return notBuilt(command);
};
