// Generated art: one service for every lane (images, characters, creatures, models, textures,
// audio). Each lane goes to a provider adapter (art/providers/<id>.ts), chosen by the person's
// Settings (auto: GAME_ART_LANE_ORDER, their own keys first). A generation is a durable record
// (game_art_generations): it survives a restart and resumes polling its provider. Files land in
// the game under art/generated/<lane>/<name>/, stamped with their source, AI flag and cost, and
// then go through the same pipeline as everything else (conform, style pass, review, export).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  GameOperationError,
  type GameArtProvidersResult,
  type GameGenerateInput,
  type GameGenerateResult,
  type GameGenerateWaitInput,
  type GameGenerationChangeResult,
  type GameGenerationsResult,
  type ThreadId,
} from "@kurambit/contracts";

export class GameArt extends Context.Service<
  GameArt,
  {
    /** Starts a generation and answers at once with its record (state making). */
    readonly generate: (
      root: string,
      threadId: ThreadId,
      input: GameGenerateInput,
    ) => Effect.Effect<GameGenerateResult, GameOperationError>;
    /** Until done, choosing (the person's pick), failed or cancelled, or `seconds` pass. */
    readonly wait: (
      root: string,
      input: GameGenerateWaitInput,
    ) => Effect.Effect<GameGenerateResult, GameOperationError>;
    readonly list: (root: string) => Effect.Effect<GameGenerationsResult, GameOperationError>;
    /** The person's pick of a candidate; Keep going's autopilot takes the first on its own. */
    readonly choose: (
      root: string,
      id: string,
      candidate: number,
    ) => Effect.Effect<GameGenerationChangeResult, GameOperationError>;
    readonly cancel: (
      root: string,
      id: string,
    ) => Effect.Effect<GameGenerationChangeResult, GameOperationError>;
    readonly providers: Effect.Effect<GameArtProvidersResult, GameOperationError>;
  }
>()("kurambit/game/art/GameArt") {}

const notBuilt = (operation: string) =>
  Effect.fail(
    new GameOperationError({
      operation,
      path: "",
      reason: "tool-missing",
      detail: "Generated art is not built yet.",
    }),
  );

/** The foundation's stand-in: every call says it is not built. Builder G1 replaces it. */
export const layer = Layer.succeed(
  GameArt,
  GameArt.of({
    generate: () => notBuilt("art-generate"),
    wait: () => notBuilt("art-wait"),
    list: () => notBuilt("art-list"),
    choose: () => notBuilt("art-choose"),
    cancel: () => notBuilt("art-cancel"),
    providers: notBuilt("art-providers"),
  }),
);
