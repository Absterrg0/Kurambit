import { scopeThreadRef } from "@kurambit/client-runtime/environment";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import type { ScopedProjectRef } from "@kurambit/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShells, waitForThreadShell } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/** The game a project is, from the games library already read; null for any other project. */
const gameOf = (projectRef: ScopedProjectRef) => {
  const library = appAtomRegistry.get(
    gameEnvironment.list({ environmentId: projectRef.environmentId, input: {} }),
  );
  if (!AsyncResult.isSuccess(library)) return null;
  return library.value.find((game) => game.projectId === projectRef.projectId) ?? null;
};

/** A new game chat's choice: in a copy of the game's newest build instead of the game itself. */
export interface NewGameChatPlace {
  readonly inCopy: true;
}
const inCopy = <Options>(options: Options | NewGameChatPlace): options is NewGameChatPlace =>
  typeof options === "object" && options !== null && "inCopy" in options && options.inCopy === true;

/**
 * New chat for any project: in a game it opens the game's screen on an empty chat, a thread the
 * server makes (or the empty one it already has), since a game's screen needs its thread on the
 * server; T3's draft screen is for code projects. Other projects take `handleNewThread`.
 */
export function useNewChat<Options, Opened>(
  handleNewThread: (projectRef: ScopedProjectRef, options?: Options) => Promise<Opened>,
) {
  const open = useAtomCommand(gameEnvironment.open, { reportFailure: false });
  const runInCopy = useAtomCommand(gameEnvironment.runInCopy, { reportFailure: false });
  const navigate = useNavigate();
  return async (
    projectRef: ScopedProjectRef,
    options?: Options | NewGameChatPlace,
  ): Promise<Opened | null> => {
    const copy = options !== undefined && inCopy(options);
    const passOn = options === undefined || inCopy(options) ? undefined : options;
    const game = gameOf(projectRef);
    // The game keeps the model its chats use.
    const newest = readThreadShells()
      .filter(
        (thread) =>
          thread.environmentId === projectRef.environmentId &&
          thread.projectId === projectRef.projectId,
      )
      .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    if (game === null || newest === undefined) return handleNewThread(projectRef, passOn);
    const result = await open({
      environmentId: projectRef.environmentId,
      input: { path: game.root, modelSelection: newest.modelSelection, newChat: true },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not start a new chat",
        description: String(squashAtomCommandFailure(result)),
      });
      return null;
    }
    const threadRef = scopeThreadRef(projectRef.environmentId, result.value.threadId);
    // The thread route sends a thread this client has not received yet back home.
    await waitForThreadShell(threadRef);
    if (copy) {
      const moved = await runInCopy({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (moved._tag === "Failure")
        toastManager.add({
          type: "error",
          title: "The new chat works in the game",
          description: String(squashAtomCommandFailure(moved)),
        });
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
    });
    return null;
  };
}
