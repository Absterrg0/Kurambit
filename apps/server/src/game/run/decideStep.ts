// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- The decide step's native boundary: it checks evidence files on disk and keeps the wall-clock deadline.
// A Guided run's decide step: wake the creator's chat the way T3 wakes a parent
// thread for a delegated task's question, then wait for the answer or the default.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { CommandId, MessageId, type ThreadId } from "@kurambit/contracts";
import { findKeyArt } from "../keyArt.ts";
import * as Policy from "./policy.ts";
import { PRESENTING, SUMMARY, wakeText } from "./decisionText.ts";
import { LADDER_FILE } from "./roles.ts";
import type { RoleDeps } from "./roleRunner.ts";
import type { DecideStep, Decided, Decision } from "./state.ts";

export type Answer = {
  readonly answer: string;
  readonly notes: string;
  readonly by: Decided["by"];
};

// How often a question queued behind a busy chat checks whether it reached the agent.
const DELIVERY_CHECK = Duration.seconds(5);

const keys = (runId: string, decision: Decision) => {
  const key = `${runId}:${decision.id}`;
  return {
    commandId: CommandId.make(`server:game-run-decision:${key}`),
    messageId: MessageId.make(`message:game-run-decision:${key}`),
  };
};

/** The decision's evidence that exists on disk, with the vision's key art for a style call. */
export const presentable = async (root: string, lane: string, decision: Decision) => {
  const art = decision.kind === "style" ? await findKeyArt(root, lane, "vision") : null;
  const all = [...(art === null ? [] : [{ label: "Key art", path: art }]), ...decision.evidence];
  const kept: Array<Decision["evidence"][number]> = [];
  for (const entry of all) {
    const info = await NodeFSP.stat(NodePath.join(root, entry.path)).catch(() => null);
    if (info?.isFile() === true && info.size > 0) kept.push(entry);
  }
  return kept;
};

export const decideStep = (
  deps: RoleDeps,
  ctx: {
    readonly root: string;
    readonly lane: string;
    readonly runId: string;
    readonly creator: ThreadId;
    readonly answer: Deferred.Deferred<Answer>;
    readonly log: (line: string) => Effect.Effect<void>;
    /** Persists the step as it moves on, so a resume waits only what is left. */
    readonly update: (step: DecideStep) => Effect.Effect<void>;
  },
  step: DecideStep,
): Effect.Effect<Policy.StepResult> => {
  const { commandId, messageId } = keys(ctx.runId, step.decision);
  const fallback: Answer = { answer: step.decision.fallback, notes: "", by: "default" };

  // The user can answer only once the agent has finished presenting: its turn
  // reading the decision and building the visual takes a minute or two, so the
  // wait counts from that turn's end, not its start. A run not yet visible (or a
  // failed read) is not delivered: counting it so started the clock before the
  // agent had even begun. DECISION_DELIVERY_MS bounds this wait.
  const delivered = deps.threads.getThreadRecords(ctx.creator, ["runs"]).pipe(
    Effect.map(({ runs }) => runs.find((run) => run.userMessageId === messageId)),
    Effect.map((run) => run !== undefined && !PRESENTING.has(run.status)),
    Effect.orElseSucceed(() => false),
  );

  const wait = Effect.gen(function* () {
    let current = step;
    const update = (next: DecideStep) => {
      current = next;
      return ctx.update(next);
    };
    for (;;) {
      const now = Date.now();
      const at = Policy.decisionWait(current, now);
      if (at.kind === "default") return fallback;
      if (at.kind === "wait") {
        yield* Effect.sleep(Duration.millis(at.ms));
        continue;
      }
      if (at.kind === "deliver") {
        if (yield* delivered) {
          yield* update({ ...current, deadline: Date.now() + current.decision.waitMs });
          yield* ctx.log(
            `decision ${current.decision.id}: the creator's agent presented the question`,
          );
        } else yield* Effect.sleep(DELIVERY_CHECK);
        continue;
      }
      const evidence = yield* Effect.promise(() =>
        presentable(ctx.root, ctx.lane, current.decision),
      );
      if (evidence.length === 0 && current.decision.kind !== "ladder") {
        yield* ctx.log(
          `decision ${current.decision.id}: nothing on disk to show; taking the default`,
        );
        return fallback;
      }
      // Saved before the wake, so the agent's first game_run_status shows the evidence.
      yield* update({ ...current, decision: { ...current.decision, evidence } });
      const woke = yield* deps.threads
        .dispatch({
          type: "message.dispatch",
          commandId,
          threadId: ctx.creator,
          messageId,
          text: wakeText(current.decision),
          notification: {
            source: { kind: "game_run" },
            outcome: "updated",
            summary: SUMMARY[current.decision.kind],
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.as(null),
          Effect.catchCause((cause) => Effect.succeed(String(cause).slice(0, 300))),
        );
      if (woke !== null) {
        yield* ctx.log(
          `decision ${current.decision.id}: the creator's chat could not be woken (${woke}); taking the default`,
        );
        return fallback;
      }
      yield* update({ ...current, sent: Date.now() });
    }
  });

  // An answer that arrives first leaves a still-queued question with nothing to ask.
  const dropQueued = deps.threads.getThreadRecords(ctx.creator, ["runs"]).pipe(
    Effect.flatMap(({ runs }) => {
      const queued = runs.find((run) => run.status === "queued" && run.userMessageId === messageId);
      return queued === undefined
        ? Effect.void
        : deps.threads.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`${commandId}:cancel`),
            threadId: ctx.creator,
            runId: queued.id,
          });
    }),
    Effect.ignore,
  );

  // The deferred is the one record of what was decided: a default that loses to an
  // answer arriving at the same moment gives way to it, so game_run_decide never lies.
  const settle = wait.pipe(
    Effect.flatMap((answer) => Deferred.succeed(ctx.answer, answer)),
    Effect.andThen(Deferred.await(ctx.answer)),
  );
  // The run holds an edited ladder in its state; the file is what the creator and
  // every role read, so it shows the same ladder. game_run_decide validated it.
  const mirrorLadder = (answer: Answer) =>
    step.decision.kind === "ladder" && answer.answer === "edit"
      ? Effect.tryPromise(() =>
          NodeFSP.writeFile(NodePath.join(ctx.root, LADDER_FILE), answer.notes),
        ).pipe(Effect.ignore)
      : Effect.void;
  return Effect.raceFirst(Deferred.await(ctx.answer), settle).pipe(
    Effect.tap(() => dropQueued),
    Effect.tap(mirrorLadder),
    Effect.map((answer): Policy.StepResult => ({ kind: "decided", ...answer })),
  );
};
