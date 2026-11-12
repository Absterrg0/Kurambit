import { EnvironmentId } from "@kurambit/contracts";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { GamePicture } from "../game/GameBuildStill";
import { useGameLibrary } from "../game/useGameLibrary";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Text } from "../ui/text";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer } from "./settingsLayout";

export function ProjectsSettings() {
  const { search: value, scope } = useSettingsScope();
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
        />
      ) : scope.kind === "unavailable" ? (
        <SettingsPageContainer>
          <p className="text-sm text-muted-foreground">{scope.message}</p>
        </SettingsPageContainer>
      ) : (
        <GamePicker />
      )}
    </div>
  );
}

/** The sidebar's games, in the sidebar's order and with its pictures, each opening its settings. */
function GamePicker() {
  const { selectScope, groups } = useSettingsScope();
  const { games, isLoading } = useGameLibrary();
  const choices = games.flatMap((game) => {
    const group = groups.find((candidate) =>
      candidate.memberProjects.some(
        (member) => member.environmentId === game.environmentId && member.id === game.projectId,
      ),
    );
    return group === undefined ? [] : [{ game, group }];
  });
  return (
    <SettingsPageContainer description="Choose a game to change its name, icon, side copies and actions.">
      {choices.length === 0 ? (
        isLoading ? null : (
          <Empty variant="well">
            <EmptyHeader>
              <EmptyTitle>No games yet</EmptyTitle>
              <EmptyDescription>A game you start from Home shows up here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      ) : (
        <SettingsGroup>
          {choices.map(({ game, group }) => (
            <button
              key={`${game.environmentId}:${game.projectId}`}
              type="button"
              className={cn(
                ITEM_ROW_CLASSNAME,
                "flex w-full min-w-0 cursor-pointer items-center gap-3 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              )}
              onClick={() => selectScope({ project: group.projectKey })}
            >
              <GamePicture
                environmentId={game.environmentId}
                root={game.root}
                path={game.keyArt}
                gameName={group.displayName}
                className="size-7.5 shrink-0 rounded-md"
              />
              <span className="grid min-w-0 flex-1">
                <Text variant="label" truncate>
                  {group.displayName}
                </Text>
                <Text variant="meta" tone="muted" truncate>
                  {game.root}
                </Text>
              </span>
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </SettingsGroup>
      )}
    </SettingsPageContainer>
  );
}
