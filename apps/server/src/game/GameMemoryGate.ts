import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { GameOperationError } from "@kurambit/contracts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import { memoryShortfall } from "./liveProcess.ts";
import * as GameOperations from "./GameOperations.ts";
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
 *
 * The lock order is fixed here, once: a start that writes the game folder
 * (an import before a native session or bot) takes the game's operation lock
 * first, then the gate, against one budget; nothing takes the operation lock
 * while it holds the gate.
 */
export class GameMemoryGate extends Context.Service<
  GameMemoryGate,
  {
    /**
     * Runs `start` once there is room for `room`, waiting up to
     * {@link MEMORY_WAIT_MS}, else fails `low-memory` with what it needs
     * against what is available, or `busy` when the time went queueing
     * behind another start. It never frees memory itself: everything else on
     * the machine is someone's work.
     */
    readonly admit: <A, E, R>(
      operation: string,
      path: string,
      room: MemoryRoom,
      start: Effect.Effect<A, E, R>,
      onWaited?: (waitedMs: number, refused: "low-memory" | "busy" | null) => void,
      options?: {
        /** Hold the game's operation lock (`path`) around the gated start, as `name` for `owner`. */
        readonly lock?: { readonly name: string; readonly owner: string };
      },
    ) => Effect.Effect<A, E | GameOperationError, R>;
  }
>()("kurambit/game/GameMemoryGate") {}

const isGameOperationError = Schema.is(GameOperationError);

export const layer = Layer.effect(
  GameMemoryGate,
  Effect.gen(function* () {
    const memory = yield* HostResources.HostResources;
    const operations = yield* GameOperations.GameOperations;
    const gate = Semaphore.makeUnsafe(1);
    return GameMemoryGate.of({
      admit: (operation, path, room, start, onWaited = () => {}, options) =>
        Effect.gen(function* () {
          const enteredAt = yield* Clock.currentTimeMillis;
          let lockWaitedMs = 0;
          let reachedGate = false;
          const gated = Effect.gen(function* () {
            reachedGate = true;
            lockWaitedMs = (yield* Clock.currentTimeMillis) - enteredAt;
            return yield* admitWithMemory({
              gate,
              shortfall: memoryShortfall(memory, room.what, room.neededMb, room.env),
              // Time queued for the lock counts against the same bound.
              maxWaitMs: Math.max(0, MEMORY_WAIT_MS - lockWaitedMs),
              poll: MEMORY_POLL,
              refuse: (short, waitedMs) =>
                new GameOperationError({
                  operation,
                  path,
                  reason: short === null ? "busy" : "low-memory",
                  detail:
                    short === null
                      ? `Waiting for another start: another start on this machine that needs memory (an editor, an import, a bot run) held the way in for ${Math.round((waitedMs + lockWaitedMs) / 1000)} s, so this one did not start. Retry once it is done.`
                      : `${short} Waited ${Math.round((waitedMs + lockWaitedMs) / 1000)} s for memory to free.`,
                }),
              onWaited: (waitedMs, refused) => onWaited(waitedMs + lockWaitedMs, refused),
              start,
            });
          });
          const lock = options?.lock;
          if (lock === undefined) return yield* gated;
          return yield* operations
            .exclusive(path, lock.name, gated, lock.owner, {
              waitUntil: enteredAt + MEMORY_WAIT_MS,
            })
            .pipe(
              Effect.tapError((error) =>
                // Queued past the bound behind another operation on the game.
                !reachedGate && isGameOperationError(error) && error.reason === "busy"
                  ? Effect.map(Clock.currentTimeMillis, (now) => onWaited(now - enteredAt, "busy"))
                  : Effect.void,
              ),
            );
        }),
    });
  }),
);
