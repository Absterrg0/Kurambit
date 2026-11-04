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
// uuid-shaped: the same for every try of the step, safe on every OS.
export const roleThreadId = (stepId: GameRunStepId): ThreadId => {
  const hex = NodeCrypto.createHash("sha256").update(`game-run-role:${stepId}`).digest("hex");
  return ThreadId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
};

const DECISION_WAKE = "message:game-run-decision:";

/** The creator chat's wake for one decision of one run: one message, however often it is sent. */
export const decisionWakeIds = (runId: GameRunId, decisionId: string) => ({
  commandId: CommandId.make(`server:game-run-decision:${runId}:${decisionId}`),
  messageId: MessageId.make(`${DECISION_WAKE}${runId}:${decisionId}`),
});

export const isDecisionWake = (messageId: string): boolean => messageId.startsWith(DECISION_WAKE);
