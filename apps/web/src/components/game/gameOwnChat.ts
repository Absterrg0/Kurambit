import { scopeProjectRef } from "@kurambit/client-runtime/environment";
import type { EnvironmentThreadShell } from "@kurambit/client-runtime/state/models";
import type { ScopedThreadRef } from "@kurambit/contracts";

import {
  readThreadShells,
  useQuietThreadShell,
  useThreadShellsForProjectRefs,
} from "../../state/entities";
import { partitionGameChats } from "../Sidebar.logic";

/**
 * A game's own chat is the one it was made in: the game's row in the sidebar. It never settles,
 * since settling is for a piece of work done on the game; archiving the game puts it away.
 */
const ownChatOf = (threads: ReadonlyArray<EnvironmentThreadShell>, ref: ScopedThreadRef) => {
  const chat = threads.find(
    (thread) => thread.id === ref.threadId && thread.environmentId === ref.environmentId,
  );
  if (chat === undefined) return null;
  const live = new Set(
    threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
  );
  return partitionGameChats(
    threads.filter(
      (thread) =>
        thread.environmentId === chat.environmentId && thread.projectId === chat.projectId,
    ),
    live,
  ).main;
};

/** Whether the chat is its game's own chat, read when a key or a menu asks. */
export const readIsGameOwnChat = (ref: ScopedThreadRef): boolean =>
  ownChatOf(readThreadShells(), ref)?.id === ref.threadId;

/** The game's own chat for a chat of that game; null until its shells are known. */
export function useGameOwnChat(ref: ScopedThreadRef): EnvironmentThreadShell | null {
  const shell = useQuietThreadShell(ref);
  const threads = useThreadShellsForProjectRefs(
    shell === null ? NO_PROJECTS : [scopeProjectRef(shell.environmentId, shell.projectId)],
  );
  return ownChatOf(threads, ref);
}
const NO_PROJECTS: ReadonlyArray<ReturnType<typeof scopeProjectRef>> = [];
