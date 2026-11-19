import { scopeProjectRef } from "@kurambit/client-runtime/environment";
import { threadRuntimeCanArchive } from "@kurambit/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@kurambit/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, isGameChat } from "@kurambit/contracts";
import { useRouter } from "@tanstack/react-router";

import { useGameArrivalStore } from "../../gameArrivalStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { refreshArchivedThreadsForEnvironment } from "../../lib/archivedThreadsState";
import { readLocalApi } from "../../localApi";
import { readThreadShells, useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { shellEnvironment } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { GameLibraryEntry } from "./useGameLibrary";
import { useGameLibraryRefresh } from "./useGameLibrary";
import { useNewChat } from "./useNewGameChat";

type Game = Pick<GameLibraryEntry, "environmentId" | "projectId" | "root" | "name">;

const failed = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

/** The game's chats still listed: what archiving puts away and deleting takes along. */
const chatsOf = (game: Game) => {
  const threads = readThreadShells();
  const live = new Set(
    threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
  );
  return threads.filter(
    (thread) =>
      thread.environmentId === game.environmentId &&
      thread.projectId === game.projectId &&
      thread.archivedAt === null &&
      isGameChat(thread, live),
  );
};

/**
 * What can be done with a game as a whole, the same from its own screen, its card on Home and a
 * chat's row: a new chat, its folder, putting it away and deleting it. Renaming is in place, by
 * whoever shows the name.
 */
export function useGameActions() {
  const router = useRouter();
  const serverConfigs = useServerConfigs();
  const copiesArrived = useGameArrivalStore((state) => state.met.includes("copies"));
  const newChat = useNewChat(useNewThreadHandler());
  const archiveChat = useOrchestrationCommand(threadEnvironment.archive, { reportFailure: false });
  const removeProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: true });
  const refreshLibrary = useGameLibraryRefresh(usePrimaryEnvironmentId());

  /** Home, when the chat on screen is one of the game's: its screen is going away. */
  const leave = (game: Game) => {
    const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    const target = resolveThreadRouteTarget(params);
    if (target?.kind !== "server") return;
    const open = readThreadShells().find(
      (thread) =>
        thread.id === target.threadRef.threadId &&
        thread.environmentId === target.threadRef.environmentId,
    );
    if (open?.projectId === game.projectId) void router.navigate({ to: "/" });
  };

  return {
    canOperate: (game: Game) =>
      readEnvironmentScope(game.environmentId, AuthOrchestrationOperateScope),
    /** A new chat may start in a copy once the person has met copies. */
    offersCopy: copiesArrived,
    /** The machine has a file manager to show the folder in. */
    canOpenFolder: (game: Game) =>
      serverConfigs.get(game.environmentId)?.availableEditors.includes("file-manager") === true,
    /** Archiving waits for the game's chats to stop working; a game with none has nothing to archive. */
    canArchive: (game: Game) => {
      const chats = chatsOf(game);
      return chats.length > 0 && chats.every((chat) => threadRuntimeCanArchive(chat.runtime));
    },
    newChat: (game: Game, place: { readonly inCopy: boolean } = { inCopy: false }) =>
      void newChat(
        scopeProjectRef(game.environmentId, game.projectId),
        place.inCopy ? { inCopy: true } : undefined,
      ),
    openFolder: (game: Game) =>
      void openInEditor({
        environmentId: game.environmentId,
        input: { cwd: game.root, editor: "file-manager" },
      }),
    /** Every chat of the game is archived: it leaves the list and Home for the Archived shelf. */
    archive: async (game: Game) => {
      for (const chat of chatsOf(game)) {
        const result = await archiveChat({
          environmentId: chat.environmentId,
          input: { threadId: chat.id },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failed(`Could not archive ${game.name}`, squashAtomCommandFailure(result));
          break;
        }
      }
      refreshArchivedThreadsForEnvironment(game.environmentId);
      if (chatsOf(game).length === 0) leave(game);
    },
    remove: async (game: Game) => {
      const api = readLocalApi();
      if (!api) return;
      const count = chatsOf(game).length;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            `Delete ${game.name} from Kurambit?`,
            `Its ${count === 1 ? "chat goes" : `${count} chats go`} with it. The game's folder stays on disk: ${game.root}`,
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
      const result = await removeProject({
        environmentId: game.environmentId,
        input: { projectId: game.projectId, force: true },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          failed(`Could not delete ${game.name}`, squashAtomCommandFailure(result));
        return;
      }
      refreshLibrary();
      leave(game);
    },
  };
}
