import type { GameBuildsResult, ScopedThreadRef } from "@kurambit/contracts";
import { AsyncResult } from "effect/reactivity";

import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";

// A list not read yet says nothing is pending.
const hasPendingTurn = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) =>
  AsyncResult.isSuccess(result) && result.value.pendingTurn !== undefined;

/**
 * Between a turn's end and its build being listed, the build is being saved: the Stage, the
 * strip, the top bar and the Inspector all say so, so nothing steps back to the build before or
 * says there is none. The builds list names the chat's turn that has not settled
 * (`pendingTurn`), in the same read that lists its build; while the turn is still active it is
 * being made, not saved.
 */
export function useTurnLanding(threadRef: ScopedThreadRef | null, turnActive: boolean): boolean {
  const pending = useEnvironmentQuerySelector(
    threadRef === null
      ? null
      : gameEnvironment.builds({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
    hasPendingTurn,
  );
  return pending && !turnActive;
}
