import type { GameRecipeAdapter } from "@t3tools/contracts";
import type { GodotRecipeReference } from "./reference.ts";
import { audioFeedback } from "./audio.feedback.ts";
import { feelBuffer } from "./feel.buffer.ts";
import { feelCoyote } from "./feel.coyote.ts";
import { feelHitStop } from "./feel.hit-stop.ts";
import { feelPickup } from "./feel.pickup.ts";
import { feelShake } from "./feel.shake.ts";
import { loopCard } from "./loop.card.ts";
import { loopDialogue } from "./loop.dialogue.ts";
import { loopFirstPerson } from "./loop.first-person.ts";
import { loopPlatformer } from "./loop.platformer.ts";
import { loopPuzzle } from "./loop.puzzle.ts";
import { loopRacing } from "./loop.racing.ts";
import { loopTopDown } from "./loop.top-down.ts";
import { loopTower } from "./loop.tower.ts";
import { lookLighting2d } from "./look.lighting-2d.ts";
import { readHud } from "./read.hud.ts";
import { readOnboarding } from "./read.onboarding.ts";
import { readSilhouette } from "./read.silhouette.ts";
import { stateWorld } from "./state.world.ts";

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
  ["audio.feedback", adapter(audioFeedback)],
  ["feel.buffer", adapter(feelBuffer)],
  ["feel.coyote", adapter(feelCoyote)],
  ["feel.hit-stop", adapter(feelHitStop)],
  ["feel.pickup", adapter(feelPickup)],
  ["feel.shake", adapter(feelShake)],
  ["loop.card", adapter(loopCard)],
  ["loop.dialogue", adapter(loopDialogue)],
  ["loop.first-person", adapter(loopFirstPerson)],
  ["loop.platformer", adapter(loopPlatformer)],
  ["loop.puzzle", adapter(loopPuzzle)],
  ["loop.racing", adapter(loopRacing)],
  ["loop.top-down", adapter(loopTopDown)],
  ["loop.tower", adapter(loopTower)],
  ["look.lighting-2d", adapter(lookLighting2d)],
  ["read.hud", adapter(readHud)],
  ["read.onboarding", adapter(readOnboarding)],
  ["read.silhouette", adapter(readSilhouette)],
  ["state.world", adapter(stateWorld)],
]);
