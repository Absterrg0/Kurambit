import { useAtomValue } from "@effect/atom-react";
import { GAME_ENGINES, type ScopedThreadRef } from "@kurambit/contracts";
import { FastForwardIcon, CornerDownRightIcon } from "lucide-react";

import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { useQuietThreadShell } from "../../state/entities";
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
  // While a turn runs a message queues behind it and Keep going waits; the line says so, so it
  // is there, and true, in every state.
  const working = threadRuntimeIsActive(useQuietThreadShell(threadRef)?.runtime);
  const keepGoing = useKeepGoing(threadRef);
  const keepGoingView = keepGoingControlView({
    status: keepGoing.status,
    error: keepGoing.error,
    threadId: threadRef.threadId,
    canOperate: keepGoing.canOperate,
    sending: keepGoing.sending,
    chosenBudget: keepGoing.chosenBudget,
  });
  const current = list?.builds.find((build) => build.id === list.current) ?? null;
  // What the next message does, plainly: the top bar already says what the game changed since.
  // The agent always changes the game folder, so a copy on the Stage stays as it is, and that
  // is the one qualification worth a second line.
  const sentence = working
    ? "Your next message waits for this turn, then changes the game."
    : copy !== null
      ? "Your next message changes the current game, not the build you're playing."
      : "Your next message changes the current game.";
  // The sentence needs nothing the game's own read brings, so it is there with the composer;
  // only Keep going waits to know the game's engine.
  const canKeepGoing =
    status != null &&
    GAME_ENGINES[status.manifest.engine.name].status === "active" &&
    current !== null &&
    !working;
  return (
    <div className="flex min-h-9 items-center gap-2 pt-1.5" data-game-composer-tray="">
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
    // The arrow and its sentence arrive together, so the line is never an arrow alone.
    <span
      key={children}
      className="flex min-w-0 flex-1 items-center gap-2 motion-popup transition-opacity starting:opacity-0"
    >
      <CornerDownRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Text variant="meta" tone="muted" render={<span className="line-clamp-2" />}>
        {children}
      </Text>
    </span>
  );
}
