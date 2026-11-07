// The static assets tier of a build's facts: every GLB under the engine's assets folder,
// outside library/, read from its JSON and its sidecar. Never plays and never runs Blender.
import * as Effect from "effect/Effect";
import { type GameAssetFacts, type GameEngineId, GameOperationError } from "@kurambit/contracts";

export const measureAssets = (
  copyRoot: string,
  _engine: GameEngineId,
  _project: string,
): Effect.Effect<GameAssetFacts> =>
  Effect.die(
    new GameOperationError({
      operation: "Measure assets",
      path: copyRoot,
      reason: "invalid-input",
      detail: "not built",
    }),
  );
