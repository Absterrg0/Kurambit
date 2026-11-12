import { useAtomValue } from "@effect/atom-react";
import { GAME_ENGINES, type ScopedThreadRef } from "@kurambit/contracts";
import { FastForwardIcon, CornerDownRightIcon } from "lucide-react";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { gameEnvironment, stagePlayTarget } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameKeepGoingMenuContent } from "./GameKeepGoingControl";
import { keepGoingControlView } from "./keepGoing.logic";
import { useKeepGoing } from "./useKeepGoing";

/**
 * The row under a game's composer, on its edges: what the next message changes,
 * and Keep going, the other way to move the game on. A person directing the
 * game reads both where they write.
 */
export function GameComposerTray({ threadRef }: { threadRef: ScopedThreadRef }) {
  const status = useIsGameThreadStatus(threadRef).data;
  const list = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const copy = useAtomValue(stagePlayTarget(threadRef));
  const keepGoing = useKeepGoing(threadRef);
  const keepGoingView = keepGoingControlView({
    status: keepGoing.status,
    error: keepGoing.error,
    threadId: threadRef.threadId,
    canOperate: keepGoing.canOperate,
    sending: keepGoing.sending,
    chosenBudget: keepGoing.chosenBudget,
  });
  if (status === null || status === undefined) return null;
  const current = list?.builds.find((build) => build.id === list.current) ?? null;
  // What the next message does, plainly: the top bar already says what the game changed since.
  // The agent always changes the game folder, so a copy on the Stage stays as it is, and that
  // is the one qualification worth a second line.
  const sentence =
    copy !== null
      ? "Your next message changes the current game, not the build you're playing."
      : "Your next message changes the current game.";
  const canKeepGoing =
    GAME_ENGINES[status.manifest.engine.name].status === "active" && current !== null;
  return (
    <div className="flex min-h-9 items-center gap-2 pt-1.5" data-game-composer-tray="">
      <CornerDownRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <TraySentence>{sentence}</TraySentence>
      {canKeepGoing ? (
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      size="compact"
                      variant="secondary"
                      aria-label="Keep going"
                      aria-pressed={keepGoingView.pressed}
                      data-game-keep-going=""
                    />
                  }
                />
              }
            >
              <FastForwardIcon className="size-3.5" aria-hidden="true" />
              {keepGoingView.label}
            </TooltipTrigger>
            {/* Hangs from the button's top edge, so two lines never touch the composer above. */}
            <TooltipPopup side="left" align="start" sideOffset={6}>
              {keepGoingView.tooltip}
            </TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <GameKeepGoingMenuContent threadRef={threadRef} />
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}

/** The tray's sentence; a new one fades in on the popup clock instead of swapping in a frame. */
function TraySentence({ children }: { children: string }) {
  return (
    <span className="min-w-0 flex-1">
      <Text
        key={children}
        variant="meta"
        tone="muted"
        render={
          <span className="line-clamp-2 motion-popup transition-opacity starting:opacity-0" />
        }
      >
        {children}
      </Text>
    </span>
  );
}
