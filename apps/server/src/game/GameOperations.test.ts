import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as GameOperations from "./GameOperations.ts";

it.effect("review invalidations stay small and leave engine-operation status alone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const operations = yield* GameOperations.GameOperations;
      const queue = yield* operations.events.pipe(Stream.toQueue({ capacity: 8 }));
      yield* Effect.yieldNow;
      const operation = {
        name: "Web export",
        state: "running" as const,
        message: "Exporting",
        at: "2026-10-23T00:00:00Z",
      };
      yield* operations.record("/game", operation, "running");
      yield* operations.changed("/game", "Reviewing frames");
      yield* operations.changed("/game", "Build retained");
      const events = yield* Queue.takeAll(queue);
      expect(operations.current("/game")).toEqual(operation);
      expect(events.map((event) => event.revision)).toEqual([1, 2, 3]);
      expect(events[1]?.name).toBe("review");
      expect(events.every((event) => JSON.stringify(event).length < 250)).toBe(true);
      expect(events.every((event) => !("frames" in event) && !("rounds" in event))).toBe(true);
    }),
  ).pipe(Effect.provide(GameOperations.layer)),
);
