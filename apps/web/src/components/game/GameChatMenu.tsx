import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@kurambit/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@kurambit/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  PencilIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { shortcutLabelForCommand } from "../../keybindings";
import { settleAndAdvance } from "../../settleAndAdvance";
import { useQuietThreadShell } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Text } from "../ui/text";
import { toastManager } from "../ui/toast";
import { GameNameInput } from "./GameName";
import { useGameOwnChat } from "./gameOwnChat";

/**
 * Which chat of the game is on screen, after the game's name, when it is not the game's own
 * chat: its title, and in its menu what can be done with it. Settle says its work is done: it
 * leaves the game's list for the Settled shelf (T3's settle, with its Undo), and its builds stay
 * in the game's History.
 */
export function GameChatMenu({ threadRef }: { threadRef: ScopedThreadRef }) {
  const shell = useQuietThreadShell(threadRef);
  const own = useGameOwnChat(threadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { settleThread, unsettleThread, confirmAndDeleteThread } = useThreadActions();
  const rename = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState(false);
  if (shell === null || own === null || own.id === shell.id) return null;
  const settled = shell.settledOverride === "settled";
  const canOperate = readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const said = (title: string) => (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });
  };
  const settleKey = shortcutLabelForCommand(keybindings, "thread.settle");
  return (
    <>
      <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-dim-foreground" />
      {renaming ? (
        <GameNameInput
          name={shell.title}
          onRename={(title) =>
            void rename({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, title },
            }).then(said("Could not rename the chat"))
          }
          onDone={() => setRenaming(false)}
          className="me-1 w-56"
        />
      ) : (
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="ghost"
                data-game-chat-menu=""
                aria-label={`${shell.title}, chat menu`}
                className="min-w-0 shrink"
              />
            }
          >
            <Text variant="label" tone="default" truncate>
              {shell.title}
            </Text>
            <ChevronDownIcon className="text-dim-foreground" aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem disabled={!canOperate} onClick={() => setRenaming(true)}>
              <PencilIcon />
              Rename
            </MenuItem>
            {settled ? (
              <MenuItem
                disabled={!canOperate}
                onClick={() =>
                  void unsettleThread(threadRef).then(said("Could not un-settle the chat"))
                }
              >
                <Undo2Icon />
                Un-settle
                {settleKey === null ? null : <MenuShortcut>{settleKey}</MenuShortcut>}
              </MenuItem>
            ) : (
              <MenuItem
                disabled={!canOperate}
                onClick={() => {
                  // The sidebar settles it and moves on to the game's own chat.
                  if (settleAndAdvance(threadRef)) return;
                  void settleThread(threadRef).then(said("Could not settle the chat"));
                }}
              >
                <CircleCheckIcon />
                Settle
                {settleKey === null ? null : <MenuShortcut>{settleKey}</MenuShortcut>}
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={!canOperate}
              onClick={() =>
                void confirmAndDeleteThread(threadRef).then(said("Could not delete the chat"))
              }
            >
              <Trash2Icon />
              Delete…
            </MenuItem>
          </MenuPopup>
        </Menu>
      )}
    </>
  );
}
