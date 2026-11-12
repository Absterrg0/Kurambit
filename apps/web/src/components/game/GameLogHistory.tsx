import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import type { ScopedThreadRef } from "@kurambit/contracts";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { GameBuildStill } from "./GameBuildStill";
import { useStageStill } from "./gameStageBridge";
import { buildCaption, buildName, checksPhrase, formatBuildTime } from "./gameBuilds.logic";

/**
 * A game's Log before its chat has any turns: the game's builds so far, newest
 * first, each opening its detail. A game opened from a folder, or a new chat on
 * an old game, still has a history worth reading here.
 */
export function GameLogHistory({ threadRef }: { threadRef: ScopedThreadRef }) {
  const list = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const gameName = useIsGameThreadStatus(threadRef).data?.manifest.name ?? "";
  const still = useStageStill(scopedThreadKey(threadRef));
  const builds = list.data?.builds ?? [];
  const current = builds.find((build) => build.id === list.data?.current);
  // The folder changed since its last build: the strip's Now, said here too.
  const changedSince = list.data?.folderEdited === true && current !== undefined ? current : null;
  const loading = list.data === null && list.error === null;
  const open = (build: (typeof builds)[number]) => {
    const store = useGameWorkspaceStore.getState();
    store.inspectBuild({ threadKey: scopedThreadKey(threadRef), build: build.id, snapshot: build });
    store.showInspectorTab("build");
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      {builds.length > 0 || loading ? (
        <div className="flex flex-col gap-1">
          <Text variant="label" tone="default" render={<h2 />}>
            Builds
          </Text>
          <Text variant="caption" tone="muted" render={<p />}>
            Newest first. Your agent's turns in this Log show here as it works.
          </Text>
        </div>
      ) : (
        <Empty variant="well">
          <EmptyHeader>
            <EmptyTitle>Nothing in the Log yet</EmptyTitle>
            <EmptyDescription>
              Your agent's work on this game shows here, turn by turn.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} shape="card" className="h-14 w-full" />
          ))}
        </div>
      ) : builds.length > 0 ? (
        <ul
          role="list"
          className="surface-card-settings flex flex-col divide-y divide-border overflow-hidden rounded-lg"
        >
          {changedSince === null ? null : (
            <li className="flex items-center gap-3 px-3 py-2">
              {still === null ? (
                <span className="surface-well aspect-video w-16 shrink-0 rounded-sm" />
              ) : (
                <img
                  src={still}
                  alt=""
                  className="aspect-video w-16 shrink-0 rounded-sm object-cover ring-1 ring-border ring-inset"
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Text variant="meta" tone="default" truncate>
                  Now · changed since {buildName(changedSince)}
                </Text>
                <Text variant="caption" tone="muted" truncate>
                  Not measured yet
                </Text>
              </span>
            </li>
          )}
          {builds.map((build) => {
            const additions = build.files.reduce((sum, file) => sum + file.additions, 0);
            const deletions = build.files.reduce((sum, file) => sum + file.deletions, 0);
            const files = build.fileCount ?? build.files.length;
            const caption = buildCaption(build);
            return (
              <li key={build.id}>
                <button
                  type="button"
                  onClick={() => open(build)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent"
                >
                  <GameBuildStill
                    threadRef={threadRef}
                    gameName={gameName}
                    build={build}
                    className="aspect-video w-16 shrink-0 rounded-sm ring-1 ring-border ring-inset"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Text variant="meta" tone="default" truncate>
                      {caption === buildName(build) ? caption : `${buildName(build)} · ${caption}`}
                    </Text>
                    <Text variant="caption" tone="muted" numeric truncate>
                      {[
                        formatBuildTime(build.at),
                        files > 0
                          ? `${files === 1 ? "1 file" : `${files} files`} +${additions} −${deletions}`
                          : null,
                        checksPhrase(build.facts),
                      ]
                        .filter((part) => part !== null)
                        .join(" · ")}
                    </Text>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
