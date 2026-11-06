import { GAME_ENGINES, type EnvironmentId, type GameEngineId } from "@kurambit/contracts";

import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { toolchainReadyFor } from "./gameStageLogic";

/**
 * Whether each engine can start a game here. Until the toolchain answers,
 * every engine reads as ready so the form does not flicker; the dialog and
 * the home form share this so they never disagree about what is pickable.
 */
export function useEngineReadiness(environmentId: EnvironmentId) {
  const toolchain = useEnvironmentQuery(
    gameEnvironment.toolchain({ environmentId, input: {} }),
  ).data;
  const ready = (id: GameEngineId) => toolchain === null || toolchainReadyFor(toolchain, id);
  return { toolchain, ready };
}

/**
 * The engine a form submits: the user's pick while it is ready, else the first
 * ready engine that plays every turn (the lane being built), else any ready one.
 */
export function chooseEngine(
  chosen: GameEngineId | null,
  ready: (id: GameEngineId) => boolean,
): GameEngineId {
  if (chosen !== null && ready(chosen)) return chosen;
  const ids = Object.keys(GAME_ENGINES) as GameEngineId[];
  return (
    ids.find((id) => GAME_ENGINES[id].turnLoop && ready(id)) ??
    ids.find((id) => ready(id)) ??
    "three"
  );
}
