// @effect-diagnostics nodeBuiltinImport:off -- A pure, synchronous hash makes a role thread's id from its step; no Effect service is needed for it.
// Identities the run derives instead of storing: a role turn's message names
// its step and attempt, so the turn's run says which step it finishes, and a
// re-run of a step's job reuses the thread and messages the first try made.
import * as NodeCrypto from "node:crypto";
import { CommandId, GameRunId, GameRunStepId, MessageId, ThreadId } from "@kurambit/contracts";

/** Why a role turn was sent: its first prompt, a resume, a resend after an instant failure, after memory. */
export type RoleTurnKind = "turn" | "continue" | "retry" | "memory";
const ROLE_TURN_KINDS: ReadonlySet<string> = new Set(["turn", "continue", "retry", "memory"]);

const ROLE_TURN = "message:game-run-role:";

export const roleTurnMessageId = (
  stepId: GameRunStepId,
  attempt: number,
  kind: RoleTurnKind,
  n: number,
): MessageId => MessageId.make(`${ROLE_TURN}${attempt}:${kind}:${n}:${stepId}`);

export const roleTurnCommandId = (messageId: MessageId): CommandId =>
  CommandId.make(`server:${messageId}`);

export interface RoleTurn {
  readonly stepId: GameRunStepId;
  readonly runId: GameRunId;
  readonly attempt: number;
  readonly kind: RoleTurnKind;
  readonly n: number;
}

const isRoleTurnKind = (kind: string): kind is RoleTurnKind => ROLE_TURN_KINDS.has(kind);

export const parseRoleTurn = (messageId: string): RoleTurn | null => {
  if (!messageId.startsWith(ROLE_TURN)) return null;
  const [attempt, kind, n, ...rest] = messageId.slice(ROLE_TURN.length).split(":");
  const stepId = rest.join(":");
  const at = stepId.lastIndexOf(":step:");
  if (kind === undefined || !isRoleTurnKind(kind) || at <= 0) return null;
  const parsed = { attempt: Number(attempt), n: Number(n) };
  if (!Number.isInteger(parsed.attempt) || !Number.isInteger(parsed.n)) return null;
  return {
    stepId: GameRunStepId.make(stepId),
    runId: GameRunId.make(stepId.slice(0, at)),
    kind,
    ...parsed,
  };
};

// Thread ids reach file names (explore evidence, worktrees), so a role's own is
// uuid-shaped and safe on every OS. Each attempt of a step has its own, and a
// game-folder role that its reused thread fails at once moves once to a fresh one.
export const roleThreadId = (
  stepId: GameRunStepId,
  attempt: number,
  variant: "own" | "fresh" = "own",
): ThreadId => {
  const hex = NodeCrypto.createHash("sha256")
    .update(`game-run-role:${stepId}:attempt:${attempt}:${variant}`)
    .digest("hex");
  return ThreadId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
};

/**
 * Who a run's own game operations belong to. A chat's Stop game cancels only
 * its own thread's work while a run holds the game, so the run's boot checks
 * and exports must never carry the creator chat's id.
 */
export const gameRunOperationOwner = (runId: string) => `game-run:${runId}`;

/** The interrupt a role turn's cap sends: its receipt is how the turn's end reads as capped. */
export const roleCapCommandId = (stepId: GameRunStepId, attempt: number, runId: string) =>
  CommandId.make(`server:game-run-role-cap:${stepId}:attempt:${attempt}:${runId}`);

const DECISION_WAKE = "message:game-run-decision:";

/**
 * The creator chat's wake for one decision of one step attempt: one message,
 * however often it is sent, and a new one when a resume asks the question again.
 */
export const decisionWakeIds = (runId: GameRunId, decisionId: string, attempt: number) => ({
  commandId: CommandId.make(`server:game-run-decision:${runId}:${decisionId}:attempt:${attempt}`),
  messageId: MessageId.make(`${DECISION_WAKE}${runId}:${decisionId}:attempt:${attempt}`),
});

export const isDecisionWake = (messageId: string): boolean => messageId.startsWith(DECISION_WAKE);
