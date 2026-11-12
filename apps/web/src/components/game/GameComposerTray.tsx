import { useAtomValue } from "@effect/atom-react";
import { GAME_ENGINES, type ScopedThreadRef } from "@kurambit/contracts";
import { FastForwardIcon, GitCommitHorizontalIcon } from "lucide-react";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { gameEnvironment, stagePlayTarget } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildName } from "./gameBuilds.logic";
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
  // The agent always changes the game folder: a copy on the Stage is only being looked at.
  const target =
    current === null
      ? "Your next message changes the game"
      : list?.folderEdited === true
        ? `Builds on Now, changed since ${buildName(current)}`
        : `Builds on ${buildName(current)}`;
  const canKeepGoing =
    GAME_ENGINES[status.manifest.engine.name].status === "active" && current !== null;
  return (
    <div className="flex min-h-8 items-center gap-2 px-1 pt-1.5" data-game-composer-tray="">
      <GitCommitHorizontalIcon
        className="size-3.5 shrink-0 text-dim-foreground"
        aria-hidden="true"
      />
      <Text variant="caption" tone="muted" truncate render={<span className="min-w-0 flex-1" />}>
        {target}
        {copy !== null ? " · the copy on the Stage stays as it is" : ""}
      </Text>
      {canKeepGoing ? (
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      size="xs"
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
            <TooltipPopup side="top" align="end">
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
