import type { ScopedThreadRef } from "@kurambit/contracts";

import { gameEnvironment } from "../state/game";
import { useEnvironmentQuery } from "../state/query";

/**
 * Whether a thread is a game thread: the one way the web client asks. The
 * server answers game status only for threads whose project is a game, so a
 * successful answer is the signal. The game stage reads the same query atom,
 * which keeps a game thread at one request instead of one per surface.
 *
 * Pass `null` on routes with no thread (home, drafts).
 */
export function useIsGameThread(threadRef: ScopedThreadRef | null): boolean {
  const status = useIsGameThreadStatus(threadRef);
  return status.data !== null || isGameStatusFailure(status.failure);
}

/**
 * A status read that failed for a game (unreadable, busy, a tool) is still a
 * game thread, shown with its error; only "not a game" answers are not.
 */
export const isGameStatusFailure = (failure: unknown): boolean =>
  typeof failure === "object" &&
  failure !== null &&
  "_tag" in failure &&
  failure._tag === "GameOperationError" &&
  "reason" in failure &&
  failure.reason !== "project-not-found" &&
  failure.reason !== "invalid-project";

/**
 * The game status query every game surface shares. Callers that need the
 * details (the stage) read this instead of mounting a second query.
 */
export function useIsGameThreadStatus(threadRef: ScopedThreadRef | null) {
  return useEnvironmentQuery(
    threadRef === null
      ? null
      : gameEnvironment.status({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
}
