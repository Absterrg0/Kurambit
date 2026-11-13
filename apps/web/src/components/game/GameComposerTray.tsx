import { GAME_ENGINES, type ScopedThreadRef } from "@kurambit/contracts";
import { FastForwardIcon } from "lucide-react";

import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { useQuietThreadShell } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameKeepGoingMenuContent } from "./GameKeepGoingControl";
import { keepGoingControlView } from "./keepGoing.logic";
import { useKeepGoing } from "./useKeepGoing";

/**
 * The row under a game's composer: Keep going, the other way to move the game on.
 */
export function GameComposerTray({ threadRef }: { threadRef: ScopedThreadRef }) {
  const status = useIsGameThreadStatus(threadRef).data;
  const list = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  // While a turn runs Keep going waits.
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
  // Keep going waits to know the game's engine.
  const canKeepGoing =
    status != null &&
    GAME_ENGINES[status.manifest.engine.name].status === "active" &&
    current !== null &&
    !working;
  return (
    <div className="flex min-h-9 items-center gap-2 pt-1.5" data-game-composer-tray="">
      {/* The row keeps its height either way, so the Stage above never moves. */}
      <span className="flex-1" />
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
      ) : status == null ? (
        // The chip's place while the game is read, so it does not arrive after its row.
        <Skeleton className="h-6 w-24" />
      ) : null}
    </div>
  );
}
