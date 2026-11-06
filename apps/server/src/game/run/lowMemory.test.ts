import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { GameOperationError } from "@kurambit/contracts";
import { handBackOnLowMemory, memoryEnded } from "./lowMemory.ts";

const refusal = (reason: "low-memory" | "busy") =>
  new GameOperationError({ operation: "Bot run", path: "/g", reason, detail: "needs 1.5 GB" });

it.effect("hands a low-memory refusal back while waits are left, and fails through after", () =>
  Effect.gen(function* () {
    const short = Effect.fail(refusal("low-memory"));
    const handed = yield* Effect.flip(handBackOnLowMemory(short, "bot run", true));
    expect(handed._tag).toBe("GameRunMemoryShort");
    const last = yield* Effect.flip(handBackOnLowMemory(short, "bot run", false));
    expect(last._tag === "GameOperationError" && last.reason).toBe("low-memory");
    const busy = yield* Effect.flip(handBackOnLowMemory(Effect.fail(refusal("busy")), "x", true));
    expect(busy._tag === "GameOperationError" && busy.reason).toBe("busy");
    expect(memoryEnded(refusal("low-memory"))).toEqual({
      kind: "ended",
      ending: "low-memory",
      reason: "memory short: needs 1.5 GB",
    });
  }),
);
