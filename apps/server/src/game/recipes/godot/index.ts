import type { GameRecipeAdapter } from "@t3tools/contracts";
import type { GodotRecipeReference } from "./reference.ts";
import { feelBuffer } from "./feel.buffer.ts";
import { feelCoyote } from "./feel.coyote.ts";
import { feelHitStop } from "./feel.hit-stop.ts";
import { feelPickup } from "./feel.pickup.ts";
import { feelShake } from "./feel.shake.ts";

/**
 * The engine pin these references were written and verified against. It is kept
 * here rather than read from the toolchain so the catalog stays a pure data
 * module; the integration test asserts it still matches the installed pin.
 */
export const GODOT_RECIPE_ENGINE_VERSION = "4.7.2";

const adapter = (reference: GodotRecipeReference): GameRecipeAdapter => ({
  engine: "godot",
  engineVersion: GODOT_RECIPE_ENGINE_VERSION,
  ...reference,
});

/**
 * The Godot variants, keyed by recipe id. A recipe with no entry here is a
 * catalog mistake the test catches, not a runtime fallback.
 */
export const godotRecipeAdapters: ReadonlyMap<string, GameRecipeAdapter> = new Map([
  ["feel.buffer", adapter(feelBuffer)],
  ["feel.coyote", adapter(feelCoyote)],
  ["feel.hit-stop", adapter(feelHitStop)],
  ["feel.pickup", adapter(feelPickup)],
  ["feel.shake", adapter(feelShake)],
]);
