import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { GameRecipeCatalogEntry } from "@t3tools/contracts";
import * as GameRecipes from "./GameRecipes.ts";

const decodeCatalog = Schema.decodeUnknownSync(Schema.Array(GameRecipeCatalogEntry));

const bufferCode = [
  "extends Node2D",
  "",
  "var _queued := false",
  "",
  "func _unhandled_input(event: InputEvent) -> void:",
  '\tif event.is_action_pressed("jump"):',
  "\t\t_queued = true",
  "",
].join("\n");

const coyoteCode = [
  "extends Node2D",
  "",
  "var _grace_ms := 0",
  "",
  "func _physics_process(delta: float) -> void:",
  "\t_grace_ms = maxi(_grace_ms - roundi(delta * 1000.0), 0)",
  "",
].join("\n");

const silhouetteCode = [
  "extends Node2D",
  "",
  "func _ready() -> void:",
  "\tposition = Vector2(120, 240)",
  "",
].join("\n");

const adapter = (referenceCode: string, press: string) => ({
  engine: "godot",
  engineVersion: "4.7.2",
  setup: "Attach the script to an empty Node2D, run the scene, then stop and run it again.",
  referenceCode,
  tryInput: { steps: [{ press }, { waitMs: 400 }], captureEveryMs: 200 },
});

const rawCatalog = [
  {
    recipe: {
      id: "feel.buffer",
      version: 1,
      title: "Buffer an early jump press",
      genres: ["platformer"],
      mechanics: ["jump", "input-buffer"],
      defects: ["unresponsive-jump", "dropped-input"],
      aliases: ["jump buffering", "input buffering"],
      intent: "Remember a jump pressed slightly before the character can jump.",
      why: "Players press early near landing and read the ignored press as unresponsive controls.",
      failure: "A jump that only accepts the exact frame leaves the character standing still.",
      restyle: "Keep the mechanism and choose this game's jump feel and presentation.",
      verificationQuestion: "Without a second press, does the character jump once on landing?",
      source: {
        kind: "write-original",
        license: "MIT",
        reference: "review-r4/findings.md:21",
      },
    },
    adapters: [adapter(bufferCode, "Space")],
  },
  {
    recipe: {
      id: "feel.coyote",
      version: 1,
      title: "Allow a short post-ledge jump",
      genres: ["platformer"],
      mechanics: ["jump", "coyote-time"],
      defects: ["late-jump"],
      aliases: ["coyote time", "ledge grace"],
      intent: "Accept a jump just after leaving a ledge.",
      why: "A strict ledge edge reads as a missed input rather than a fair mistake.",
      failure: "A late press is dropped even though the character looks like it can still jump.",
      restyle: "Keep the grace period and choose this game's forgiveness budget.",
      verificationQuestion: "Does an immediate late press jump while an expired one does not?",
      source: {
        kind: "write-original",
        license: "MIT",
        reference: "review-r4/findings.md:22",
      },
    },
    adapters: [adapter(coyoteCode, "Space")],
  },
  {
    recipe: {
      id: "read.silhouette",
      version: 2,
      title: "Separate actors from hazards by outline",
      genres: ["platformer", "top-down"],
      mechanics: ["readability", "silhouette"],
      defects: ["indistinct-silhouette", "low-contrast"],
      aliases: ["low visibility", "outline contrast"],
      intent: "Make an actor readable at gameplay scale.",
      why: "A silhouette that blends into the floor hides the player's position during motion.",
      failure: "The player loses track of its character in a busy scene.",
      restyle: "Keep the contrast rule and choose this game's own shapes and palette.",
      verificationQuestion: "At gameplay scale, can the actor be identified in one frame?",
      source: {
        kind: "write-original",
        license: "MIT",
        reference: "t50d/verdict.md:102",
      },
    },
    adapters: [adapter(silhouetteCode, "Space")],
  },
];

const fixtureCatalog = decodeCatalog(rawCatalog);

const withRecipes = <A, E>(
  catalog: ReadonlyArray<GameRecipeCatalogEntry>,
  body: (recipes: GameRecipes.GameRecipes["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const recipes = yield* GameRecipes.GameRecipes;
    return yield* body(recipes);
  }).pipe(Effect.provide(Layer.succeed(GameRecipes.GameRecipes, GameRecipes.make(catalog))));

const ids = (result: { readonly recipes: ReadonlyArray<{ readonly id: string }> }) =>
  result.recipes.map((recipe) => recipe.id);

it.effect("empty filters browse the whole catalog in id order", () =>
  withRecipes(fixtureCatalog, (recipes) =>
    Effect.gen(function* () {
      const page = yield* recipes.search({});

      expect(ids(page)).toEqual(["feel.buffer", "feel.coyote", "read.silhouette"]);
      expect(page.recipes[0]?.engines).toEqual(["godot"]);
      expect(page.recipes[0]?.matchingTags).toEqual([]);
      expect(page.nextCursor).toBeNull();
    }),
  ),
);

it.effect("ranks by matching field count, then id", () =>
  withRecipes(fixtureCatalog, (recipes) =>
    Effect.gen(function* () {
      const tied = yield* recipes.search({ mechanic: "jump" });
      expect(ids(tied)).toEqual(["feel.buffer", "feel.coyote"]);

      const ranked = yield* recipes.search({ genre: "platformer", defect: "low visibility" });
      expect(ids(ranked)).toEqual(["read.silhouette", "feel.buffer", "feel.coyote"]);
      expect(ranked.recipes[0]?.matchingTags).toEqual(["platformer", "low visibility"]);

      const twoFields = yield* recipes.search({
        mechanic: "jump",
        defect: "unresponsive-jump",
      });
      expect(ids(twoFields)).toEqual(["feel.buffer", "feel.coyote"]);
      expect(twoFields.recipes[0]?.matchingTags).toEqual(["jump", "unresponsive-jump"]);

      // Fields union, so a mechanic-only match still surfaces below a genre match.
      const union = yield* recipes.search({ genre: "racing", mechanic: "jump" });
      expect(ids(union)).toEqual(["feel.buffer", "feel.coyote"]);
      expect(union.recipes[0]?.matchingTags).toEqual(["jump"]);
    }),
  ),
);

it.effect("compares tags and aliases case-folded, but never guesses related tags", () =>
  withRecipes(fixtureCatalog, (recipes) =>
    Effect.gen(function* () {
      const foldedTag = yield* recipes.search({ genre: "PLATFORMER" });
      expect(ids(foldedTag)).toEqual(["feel.buffer", "feel.coyote", "read.silhouette"]);

      const foldedAlias = yield* recipes.search({ mechanic: "Input Buffering" });
      expect(ids(foldedAlias)).toEqual(["feel.buffer"]);
      expect(foldedAlias.recipes[0]?.matchingTags).toEqual(["input buffering"]);

      const related = yield* recipes.search({ mechanic: "jumping" });
      expect(related).toEqual({ recipes: [], nextCursor: null });
    }),
  ),
);

it.effect("searches text as a literal, case-folded substring of aliases only", () =>
  withRecipes(fixtureCatalog, (recipes) =>
    Effect.gen(function* () {
      const buffered = yield* recipes.search({ text: "BUFFERING" });
      expect(ids(buffered)).toEqual(["feel.buffer"]);
      expect(buffered.recipes[0]?.matchingTags).toEqual(["jump buffering", "input buffering"]);

      // "jump" is a mechanic of both feel recipes but only an alias of feel.buffer.
      const jump = yield* recipes.search({ text: "jump" });
      expect(ids(jump)).toEqual(["feel.buffer"]);

      const none = yield* recipes.search({ text: "boost pad" });
      expect(none).toEqual({ recipes: [], nextCursor: null });
    }),
  ),
);

it.effect("returns an empty page when a filter matches nothing", () =>
  withRecipes(fixtureCatalog, (recipes) =>
    Effect.gen(function* () {
      const page = yield* recipes.search({ genre: "racing", mechanic: "boosting" });
      expect(page).toEqual({ recipes: [], nextCursor: null });
    }),
  ),
);

it.effect("pages through every ranked recipe exactly once", () => {
  const paginationCatalog = decodeCatalog(
    Array.from({ length: 6 }, (_, index) => ({
      ...rawCatalog[2],
      recipe: {
        ...rawCatalog[2]!.recipe,
        id: `test.recipe-${index + 1}`,
        title: `Synthetic recipe ${index + 1}`,
      },
    })),
  );
  return withRecipes(paginationCatalog, (recipes) =>
    Effect.gen(function* () {
      const first = yield* recipes.search({});
      expect(ids(first)).toEqual([
        "test.recipe-1",
        "test.recipe-2",
        "test.recipe-3",
        "test.recipe-4",
        "test.recipe-5",
      ]);
      expect(first.nextCursor).toBe("5");

      const second = yield* recipes.search({ cursor: first.nextCursor! });
      expect(ids(second)).toEqual(["test.recipe-6"]);
      expect(second.nextCursor).toBeNull();

      const discovered = [...ids(first), ...ids(second)];
      expect(new Set(discovered).size).toBe(6);
    }),
  );
});

it.effect("rejects a cursor that is not a page offset", () =>
  withRecipes(fixtureCatalog, (recipes) =>
    Effect.gen(function* () {
      for (const cursor of ["next", "-1", "01", "1.0"]) {
        const error = yield* recipes.search({ cursor }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(GameRecipes.GameRecipeInvalidCursorError);
        expect(error.message).toBe(
          `Invalid recipe cursor '${cursor}'. Pass the nextCursor value from a previous search, or omit cursor to start at the first page.`,
        );
      }

      const past = yield* recipes.search({ cursor: "99" });
      expect(past).toEqual({ recipes: [], nextCursor: null });
    }),
  ),
);

it.effect("names the unknown id and the alternatives", () =>
  withRecipes(fixtureCatalog, (recipes) =>
    Effect.gen(function* () {
      const error = yield* recipes.get({ id: "feel.nope" }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(GameRecipes.GameRecipeUnknownIdError);
      expect(error.message).toBe(
        "No recipe with id 'feel.nope'. Available ids: feel.buffer, feel.coyote, read.silhouette.",
      );
    }),
  ),
);

it.effect("rejects an engine with no adapter and lists the available ones", () =>
  withRecipes(fixtureCatalog, (recipes) =>
    Effect.gen(function* () {
      const error = yield* recipes.get({ id: "feel.buffer", engine: "unity" }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(GameRecipes.GameRecipeUnsupportedEngineError);
      expect(error.message).toBe(
        "Recipe 'feel.buffer' has no adapter for engine 'unity'. Available engines: godot.",
      );

      const guidanceOnly = yield* recipes
        .get({ id: "feel.buffer", engine: "unity", includeReference: false })
        .pipe(Effect.flip);
      expect(guidanceOnly).toBeInstanceOf(GameRecipes.GameRecipeUnsupportedEngineError);
    }),
  ),
);

it.effect("defaults to Godot and returns the complete reference byte for byte", () =>
  withRecipes(fixtureCatalog, (recipes) =>
    Effect.gen(function* () {
      const first = yield* recipes.get({ id: "feel.buffer" });
      const again = yield* recipes.get({ id: "feel.buffer", engine: "godot" });

      expect(first.engine).toBe("godot");
      expect(first.adapter?.referenceCode).toBe(bufferCode);
      expect(first.adapter?.setup).toContain("run it again");
      expect(first.recipe.version).toBe(1);
      expect(first.recipe.source).toEqual({
        kind: "write-original",
        license: "MIT",
        reference: "review-r4/findings.md:21",
      });
      expect(JSON.stringify(first)).toBe(JSON.stringify(again));
    }),
  ),
);

it.effect("returns guidance, version, and provenance without a reference", () =>
  withRecipes(fixtureCatalog, (recipes) =>
    Effect.gen(function* () {
      const guidance = yield* recipes.get({ id: "read.silhouette", includeReference: false });

      expect(guidance.adapter).toBeNull();
      expect(guidance.engine).toBe("godot");
      expect(guidance.recipe.version).toBe(2);
      expect(guidance.recipe.intent).toBe(rawCatalog[2]!.recipe.intent);
      expect(guidance.recipe.source.reference).toBe("t50d/verdict.md:102");
    }),
  ),
);

it.effect("serves only the injected catalog", () =>
  withRecipes([], (recipes) =>
    Effect.gen(function* () {
      const page = yield* recipes.search({});
      expect(page).toEqual({ recipes: [], nextCursor: null });

      const error = yield* recipes.get({ id: "feel.buffer" }).pipe(Effect.flip);
      expect(error.message).toBe("No recipe with id 'feel.buffer'. Available ids: none.");
    }),
  ),
);
