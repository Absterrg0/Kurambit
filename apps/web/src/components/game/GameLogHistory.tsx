import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import type { ScopedThreadRef } from "@kurambit/contracts";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { GameBuildStill } from "./GameBuildStill";
import { buildCaption, buildName, formatBuildTime } from "./gameBuilds.logic";

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
  const builds = list.data?.builds ?? [];
  const loading = list.data === null && list.error === null;
  const open = (build: (typeof builds)[number]) => {
    const store = useGameWorkspaceStore.getState();
    store.inspectBuild({ threadKey: scopedThreadKey(threadRef), build: build.id, snapshot: build });
    store.showInspectorTab("build");
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-col gap-1">
        <Text variant="label" tone="default" render={<h2 />}>
          {builds.length > 0 ? "Before this chat" : "Nothing in the Log yet"}
        </Text>
        <Text variant="caption" tone="muted" render={<p />}>
          {builds.length > 0
            ? "This chat hasn't changed the game yet. Its builds so far:"
            : "Your agent's work on this game shows here, turn by turn. Tell it what to change below the game."}
        </Text>
      </div>
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
                        build.facts.good + build.facts.bad > 0
                          ? `${build.facts.good} pass${build.facts.bad > 0 ? ` · ${build.facts.bad} to look at` : ""}`
                          : null,
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
