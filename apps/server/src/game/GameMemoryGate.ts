import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { GameOperationError } from "@kurambit/contracts";
import { memoryShortfall } from "./liveProcess.ts";
import { admitWithMemory } from "./memoryAdmission.ts";

/** Free memory a start needs, in MB, with the env override that changes it. */
export type MemoryRoom = { readonly what: string; readonly neededMb: number; readonly env: string };

// Memory a run's own other half or a closing tool gives back frees within a
// minute; past that, the refusal is the honest answer.
const MEMORY_WAIT_MS = 75_000;
const MEMORY_POLL = "5 seconds" as const;

/**
 * One gate for every start that allocates a lot at once (explore sessions,
 * bot runs). Blind samples and their bots start two at a time, and a check
 * made before the other half has allocated would pass both, so each start
 * holds the gate from its final memory check through its own peak (the
 * import, the boot) and the next check sees what the last start took.
 */
export class GameMemoryGate extends Context.Service<
  GameMemoryGate,
  {
    /**
     * Runs `start` once there is room for `room`, waiting up to
     * {@link MEMORY_WAIT_MS}, else fails `low-memory` with what it needs
     * against what is available. It never frees memory itself: everything
     * else on the machine is someone's work.
     */
    readonly admit: <A, E, R>(
      operation: string,
      path: string,
      room: MemoryRoom,
      start: Effect.Effect<A, E, R>,
      onWaited?: (waitedMs: number, refused: boolean) => void,
    ) => Effect.Effect<A, E | GameOperationError, R>;
  }
>()("kurambit/game/GameMemoryGate") {}

export const layer = Layer.sync(GameMemoryGate, () => {
  const gate = Semaphore.makeUnsafe(1);
  return GameMemoryGate.of({
    admit: (operation, path, room, start, onWaited = () => {}) =>
      admitWithMemory({
        gate,
        shortfall: Effect.promise(() => memoryShortfall(room.what, room.neededMb, room.env)),
        maxWaitMs: MEMORY_WAIT_MS,
        poll: MEMORY_POLL,
        refuse: (short, waitedMs) =>
          new GameOperationError({
            operation,
            path,
            reason: "low-memory",
            detail: `${short} Waited ${Math.round(waitedMs / 1000)} s for memory to free.`,
          }),
        onWaited,
        start,
      }),
  });
});
