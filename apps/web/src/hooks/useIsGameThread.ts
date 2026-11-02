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
  return useIsGameThreadStatus(threadRef).data !== null;
}

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
