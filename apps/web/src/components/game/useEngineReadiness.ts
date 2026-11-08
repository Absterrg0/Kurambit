import {
  ACTIVE_GAME_ENGINES,
  DEFAULT_GAME_ENGINE,
  GAME_ENGINES,
  type EnvironmentId,
  type GameEngineId,
} from "@kurambit/contracts";

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
 * ready active engine that plays every turn (the lane being built), else any
 * ready active one. A parked engine is never chosen.
 */
export function chooseEngine(
  chosen: GameEngineId | null,
  ready: (id: GameEngineId) => boolean,
): GameEngineId {
  if (chosen !== null && ACTIVE_GAME_ENGINES.includes(chosen) && ready(chosen)) return chosen;
  return (
    ACTIVE_GAME_ENGINES.find((id) => GAME_ENGINES[id].turnLoop && ready(id)) ??
    ACTIVE_GAME_ENGINES.find((id) => ready(id)) ??
    DEFAULT_GAME_ENGINE
  );
}
