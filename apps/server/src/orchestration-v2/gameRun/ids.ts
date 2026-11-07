// Identities the run derives instead of storing: a step's message names its
// step and attempt, so the turn's T3 run says which step it is, and a re-run
// of a step's job reuses the message the first try sent.
import { CommandId, GameRunId, GameRunStepId, MessageId, RunId } from "@kurambit/contracts";

const STEP_TURN = "message:game-run-step:";

/** A step's message: one per step attempt, however often it is sent. */
export const stepTurnMessageId = (stepId: GameRunStepId, attempt: number): MessageId =>
  MessageId.make(`${STEP_TURN}${attempt}:${stepId}`);

export const stepTurnCommandId = (messageId: MessageId): CommandId =>
  CommandId.make(`server:${messageId}`);

export interface StepTurn {
  readonly stepId: GameRunStepId;
  readonly runId: GameRunId;
  readonly attempt: number;
}

/** The step a message is, or null for any other message (a person's). */
export const parseStepTurn = (messageId: string): StepTurn | null => {
  if (!messageId.startsWith(STEP_TURN)) return null;
  const rest = messageId.slice(STEP_TURN.length);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const attempt = Number(rest.slice(0, colon));
  const stepId = rest.slice(colon + 1);
  const at = stepId.lastIndexOf(":step:");
  if (!Number.isInteger(attempt) || attempt < 1 || at <= 0) return null;
  return {
    stepId: GameRunStepId.make(stepId),
    runId: GameRunId.make(stepId.slice(0, at)),
    attempt,
  };
};

/** The interrupt a step turn's cap sends: its receipt is how the turn's end reads as capped. */
export const stepCapCommandId = (stepId: GameRunStepId, attempt: number, t3RunId: RunId) =>
  CommandId.make(`server:game-run-step-cap:${stepId}:attempt:${attempt}:${t3RunId}`);

/** The commandId of GameBuilds.restore for a step's undo: a repeat is the same restore. */
export const stepUndoCommandId = (stepId: GameRunStepId, attempt: number) =>
  `server:game-run-step-undo:${stepId}:attempt:${attempt}`;

/**
 * Who a run's own game operations belong to. A chat's Stop game cancels only
 * its own thread's work, so the run's measures must never carry the chat's id.
 */
export const gameRunOperationOwner = (runId: string) => `game-run:${runId}`;
export const isGameRunOperationOwner = (owner: string) => owner.startsWith("game-run:");
