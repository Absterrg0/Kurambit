// Identities the run derives instead of storing.

/**
 * Who a run's own game operations belong to. A chat's Stop game cancels only
 * its own thread's work, so the run's measures must never carry the chat's id.
 */
export const gameRunOperationOwner = (runId: string) => `game-run:${runId}`;
export const isGameRunOperationOwner = (owner: string) => owner.startsWith("game-run:");
