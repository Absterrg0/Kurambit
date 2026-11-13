import type { GameBuild, GameBuildsResult, ScopedThreadRef } from "@kurambit/contracts";

import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { refOf } from "./gameBuildRef";
import { changedReadings, factsSettled, type CompareRow } from "./gameBuilds.logic";

/**
 * What a build changed in the readings since the build it was made from: the change a turn
 * made, for the Build tab's line and the folded Inspector's label. Null until both builds are
 * measured, so nothing being measured is ever said to differ.
 */
export function useChangedSinceBase(
  threadRef: ScopedThreadRef,
  build: GameBuild | null,
  list: GameBuildsResult | null,
): { readonly base: GameBuild; readonly changed: ReadonlyArray<CompareRow> } | null {
  const base =
    build === null || build.base === null || list === null
      ? null
      : (list.builds.find((each) => each.id === build.base) ?? null);
  const ready =
    build !== null &&
    base !== null &&
    base.available &&
    factsSettled(base.facts) &&
    factsSettled(build.facts);
  const compared = useEnvironmentQuery(
    ready
      ? gameEnvironment.buildCompare({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, a: refOf(base), b: refOf(build) },
        })
      : null,
  ).data;
  return !ready || compared === null ? null : { base, changed: changedReadings(compared) };
}
