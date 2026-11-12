import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import type { ScopedThreadRef } from "@kurambit/contracts";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { GameBuildStill, GameNowPicture } from "./GameBuildStill";
import { useStageStill } from "./gameStageBridge";
import { buildCaption, buildName, checksLine, formatBuildTime } from "./gameBuilds.logic";

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
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-4">
      {/* The Log is the agent's turns; with none yet it says so first, and the game's builds
          follow as context, under their own heading, never in the turns' place. */}
      <Empty variant="well">
        <EmptyHeader>
          <EmptyTitle>No turns in this Log yet</EmptyTitle>
          <EmptyDescription>
            Tell your game what to change and your agent's work shows here, turn by turn.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
      {builds.length > 0 || loading ? (
        <section className="flex flex-col gap-2">
          <div className="flex min-h-6 items-center gap-2">
            <Text variant="meta" tone="strong" emphasis render={<h2 />}>
              Builds so far
            </Text>
            <Text variant="meta" tone="muted">
              Newest first
            </Text>
          </div>
          {loading ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((n) => (
                <Skeleton key={n} shape="card" className="h-14 w-full" />
              ))}
            </div>
          ) : (
            <ul
              role="list"
              className="surface-card-settings flex flex-col divide-y divide-border overflow-hidden rounded-lg"
            >
              {changedSince === null ? null : (
                <li className="flex items-center gap-3 px-3 py-2">
                  {/* The strip's Now picture, so Now looks the same wherever it shows. */}
                  <GameNowPicture
                    still={still}
                    gameName={gameName}
                    fallback={changedSince}
                    threadRef={threadRef}
                    className="aspect-video w-16 shrink-0 rounded-sm ring-1 ring-border ring-inset"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Text variant="meta" tone="default" truncate>
                      Now
                    </Text>
                    <Text variant="meta" tone="muted" truncate>
                      Changed · not measured
                    </Text>
                  </span>
                </li>
              )}
              {builds.map((build) => {
                const caption = buildCaption(build);
                return (
                  <li key={build.id}>
                    <button
                      type="button"
                      onClick={() => open(build)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent"
                    >
                      <GameBuildStill
                        threadRef={threadRef}
                        gameName={gameName}
                        build={build}
                        className="aspect-video w-16 shrink-0 rounded-sm ring-1 ring-border ring-inset"
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <Text variant="meta" tone="default" truncate>
                          {caption === buildName(build)
                            ? caption
                            : `${buildName(build)} · ${caption}`}
                        </Text>
                        <Text variant="meta" tone="muted" numeric truncate>
                          {/* When and how it measured: what tells builds apart. Its files are
                              in the build itself, one click away. */}
                          {[formatBuildTime(build.at), checksLine(build.facts)]
                            .filter((part) => part !== null)
                            .join(" · ")}
                        </Text>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
