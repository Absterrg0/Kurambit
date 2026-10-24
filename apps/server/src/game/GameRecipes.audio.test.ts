import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { GameRecipeCatalogEntry } from "@t3tools/contracts";
import * as GameRecipes from "./GameRecipes.ts";
import { gameRecipeCatalog } from "./recipeCatalog.ts";

const decodeCatalog = Schema.decodeUnknownSync(Schema.Array(GameRecipeCatalogEntry));
const recipesLayer = Layer.succeed(GameRecipes.GameRecipes, GameRecipes.make(gameRecipeCatalog));

const searchIds = (input: Parameters<GameRecipes.GameRecipes["Service"]["search"]>[0]) =>
  Effect.gen(function* () {
    const recipes = yield* GameRecipes.GameRecipes;
    const page = yield* recipes.search(input);
    return page.recipes.map((recipe) => recipe.id);
  }).pipe(Effect.provide(recipesLayer));

/** The words a novice reaches for when an event makes no sound. */
const AUDIO_QUERIES = ["sound", "audio feedback", "silent pickup", "sound cues"];

it.effect("a novice finds the audio recipe with sound words and defect tags", () =>
  Effect.gen(function* () {
    for (const query of AUDIO_QUERIES)
      expect(yield* searchIds({ query }), `query '${query}'`).toEqual(["audio.feedback"]);

    // Field filters stay exact tags; both spellings a builder is likely to use
    // for this defect exist in the metadata. feel.pickup also carries the tag.
    const defectIds = yield* searchIds({ defect: "silent-pickup" });
    expect(defectIds).toContain("audio.feedback");
    expect(defectIds[0]).toBe("audio.feedback");
    expect(yield* searchIds({ mechanic: "audio-feedback" })).toEqual(["audio.feedback"]);
    expect(yield* searchIds({ text: "AUDIO FEEDBACK" })).toEqual(["audio.feedback"]);
  }),
);

it.effect("keeps the shipped catalog decodable and the existing recipes reachable", () =>
  Effect.gen(function* () {
    expect(() => decodeCatalog(gameRecipeCatalog)).not.toThrow();
    const recipes = yield* GameRecipes.GameRecipes;

    const first = yield* recipes.search({});
    const discovered = [...first.recipes];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = yield* recipes.search({ cursor });
      discovered.push(...page.recipes);
      cursor = page.nextCursor;
    }
    const ids = discovered.map((recipe) => recipe.id);
    expect(ids).toContain("audio.feedback");
    for (const id of ["feel.pickup", "look.lighting-2d", "loop.platformer", "read.hud"])
      expect(ids, `${id} is still discoverable`).toContain(id);

    for (const id of ["audio.feedback", "feel.pickup", "look.lighting-2d"]) {
      const entry = yield* recipes.get({ id });
      expect(entry.adapter, `${id} has a runnable Godot variant`).not.toBeNull();
      expect(entry.adapter?.engine).toBe("godot");
    }
  }).pipe(Effect.provide(recipesLayer)),
);

it.effect("ships one concise engine-neutral audio recipe with a runnable reference", () =>
  Effect.gen(function* () {
    const recipes = yield* GameRecipes.GameRecipes;
    const entry = yield* recipes.get({ id: "audio.feedback" });
    const adapter = entry.adapter!;
    const code = adapter.referenceCode.replace(/\n$/, "");

    expect(entry.recipe.version).toBe(1);
    expect(entry.recipe.defects).toContain("silent-pickup");
    expect(code.split("\n").length).toBeLessThanOrEqual(110);
    // Engine-neutral metadata: Godot names live only in the adapter.
    const metadata = JSON.stringify(entry.recipe);
    for (const engineWord of ["godot", "audiostream", "gdscript", "res://"])
      expect(metadata.toLowerCase()).not.toContain(engineWord);
    expect(adapter.setup.length).toBeGreaterThan(20);
    expect(adapter.tryInput.steps.length).toBeLessThanOrEqual(12);
  }).pipe(Effect.provide(recipesLayer)),
);
