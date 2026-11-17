import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import type { GameBuildsResult, GameThing, ScopedThreadRef } from "@kurambit/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { type GameTool, useArrivalDot, useGameArrivalStore } from "../../gameArrivalStore";
import { useProjects, useThreadSentCount } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";
import { codeModels } from "./gameArt.logic";
import { useThreadStageBridge } from "./gameStageBridge";
import { useGameLatestNext } from "./useGameLatestNext";

/**
 * A tool's place on screen: shown once it has arrived, with a dot until it is first opened, when
 * it is the one tool whose turn it is to say so (useArrivalDot).
 */
export interface GameArrival {
  readonly shown: boolean;
  readonly dot: boolean;
}

/**
 * One tool's arrival. `fact` says the game has something for it now; the first time it does, the
 * person meets the tool, and it stays shown from then on, in every game. Nothing reorders: a
 * tool only goes from absent to shown, and its dot from on to off.
 */
export function useArrival(tool: GameTool, fact: boolean): GameArrival {
  const met = useGameArrivalStore((state) => state.met.includes(tool));
  const dot = useArrivalDot() === tool;
  useEffect(() => {
    if (fact && !met) useGameArrivalStore.getState().meet(tool);
  }, [fact, met, tool]);
  return { shown: met || fact, dot };
}

type BuildsRead = AsyncResult.AsyncResult<GameBuildsResult, unknown>;

/** Some build of the game has been measured. */
const anyMeasured = (result: BuildsRead) =>
  AsyncResult.isSuccess(result) &&
  result.value.builds.some(
    (build) => build.facts.state === "measured" || build.facts.state === "incomplete",
  );

const currentLead = (result: BuildsRead) =>
  AsyncResult.isSuccess(result)
    ? result.value.builds.find((build) => build.id === result.value.current)?.facts.lead
    : undefined;

/** The build in the folder starts. */
const currentBoots = (result: BuildsRead) =>
  currentLead(result)?.passing?.includes("boots") === true;

/** The build in the folder was measured on phone and widescreen, and fails there. */
const currentScreensFail = (result: BuildsRead) => {
  const lead = currentLead(result);
  return lead?.measured?.includes("screens") === true && lead.passing?.includes("screens") !== true;
};

const hasValues = (thing: GameThing) => (thing.values?.length ?? 0) > 0;
const NO_THINGS: ReadonlyArray<GameThing> = [];

/**
 * When each Workbench section and the composer's ways to send arrive for one game, from what the
 * game already says: a build measured (Checks), a tuned value exposed (Tune), a model in the
 * scene (Art), a booting build whose reply ends in a `Next:` line (Keep going), the third message
 * (Try N ways), a phone or widescreen problem (Responsive view). Test plays arrive at the Stage's
 * bar, when a run first ends.
 */
export function useGameArrivals(threadRef: ScopedThreadRef | null) {
  const threadKey = threadRef === null ? "" : scopedThreadKey(threadRef);
  const builds =
    threadRef === null
      ? null
      : gameEnvironment.builds({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        });
  const measured = useEnvironmentQuerySelector(builds, anyMeasured) === true;
  const boots = useEnvironmentQuerySelector(builds, currentBoots) === true;
  const screensFail = useEnvironmentQuerySelector(builds, currentScreensFail) === true;
  const things = useThreadStageBridge(threadKey, (state) => state.things, NO_THINGS);
  const next = useGameLatestNext(threadRef) !== null;
  const sent = useThreadSentCount(threadRef);
  const tunable = things.some(hasValues);
  const modelled =
    codeModels(things).length > 0 || things.some((thing) => thing.asset !== undefined);
  return {
    tune: useArrival("tune", tunable),
    art: useArrival("art", modelled),
    checks: useArrival("checks", measured),
    keepGoing: useArrival("keep-going", next && boots),
    tryWays: useArrival("try-ways", sent >= 3),
    responsive: useArrival("responsive", screensFail),
  };
}

/** The Library arrives with a second game. */
export function useLibraryArrival(): GameArrival {
  return useArrival("library", useProjects().length >= 2);
}
