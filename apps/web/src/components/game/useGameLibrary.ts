import type { EnvironmentId, GameSummary } from "@kurambit/contracts";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { sortGameSummaries } from "./gameLibrary.logic";

export interface GameLibraryEntry extends GameSummary {
  readonly environmentId: EnvironmentId;
}

/** The one batched games read both the sidebar and the home grid share. */
export function useGameLibrary() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : gameEnvironment.list({ environmentId, input: {} }),
  );
  const games =
    environmentId === null
      ? []
      : sortGameSummaries(query.data?.map((game) => ({ ...game, environmentId })) ?? []);
  return {
    environmentId,
    games,
    isLoading: environmentId !== null && query.isPending && query.data === null,
    error: query.error,
    refresh: query.refresh,
  };
}

/** Refresh the library after creating, opening, or approving a game. */
export function useGameLibraryRefresh(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : gameEnvironment.list({ environmentId, input: {} }),
  ).refresh;
}
