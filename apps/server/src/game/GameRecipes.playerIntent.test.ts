import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GameRecipes from "./GameRecipes.ts";
import { gameRecipeCatalog } from "./recipeCatalog.ts";

const recipesLayer = Layer.succeed(GameRecipes.GameRecipes, GameRecipes.make(gameRecipeCatalog));

const searchIds = (input: Parameters<GameRecipes.GameRecipes["Service"]["search"]>[0]) =>
  Effect.gen(function* () {
    const recipes = yield* GameRecipes.GameRecipes;
    const page = yield* recipes.search(input);
    return page.recipes.map((recipe) => recipe.id);
  }).pipe(Effect.provide(recipesLayer));

it.effect("finds forgiving jumping without naming the technique", () =>
  Effect.gen(function* () {
    const ids = yield* searchIds({ text: "Make jumping feel forgiving" });
    expect(ids.slice(0, 2)).toEqual(["feel.buffer", "feel.coyote"]);
  }),
);

it.effect("distinguishes early presses from late ledge presses in held-out words", () =>
  Effect.gen(function* () {
    const early = yield* searchIds({
      text: "I press jump a moment before landing and it ignores me",
    });
    expect(early[0]).toBe("feel.buffer");

    const late = yield* searchIds({ text: "I leap late off the edge and fall" });
    expect(late[0]).toBe("feel.coyote");
  }),
);

it.effect("excludes an explicitly negated technique and keeps the positive contrary", () =>
  Effect.gen(function* () {
    const negated = yield* searchIds({ text: "Make combat punchy without camera shake" });
    expect(negated).toContain("feel.hit-stop");
    expect(negated).not.toContain("feel.shake");

    const variant = yield* searchIds({ text: "Make combat punchy with no screen shake" });
    expect(variant).toContain("feel.hit-stop");
    expect(variant).not.toContain("feel.shake");

    const single = yield* searchIds({ text: "Make combat punchy without screenshake" });
    expect(single).not.toContain("feel.shake");

    // The positive contrary still reaches the shaken reference.
    const positive = yield* searchIds({ text: "Make combat punchy with camera shake" });
    expect(positive).toContain("feel.shake");
  }),
);

it.effect("documents the negation boundary: paraphrase is not exclusion", () =>
  Effect.gen(function* () {
    // "steady camera" names no explicit without/no/not target, so the shake
    // reference still surfaces. Honest limitation, not a silent filter.
    const paraphrase = yield* searchIds({
      text: "Make combat punchy with a steady camera",
    });
    expect(paraphrase).toContain("feel.shake");
  }),
);

it.effect("keeps a relaxing brief free of jump and combat references", () =>
  Effect.gen(function* () {
    const ids = yield* searchIds({
      text: "A relaxing garden game with no jumping and no combat",
    });
    for (const excluded of ["feel.buffer", "feel.coyote", "feel.hit-stop"]) {
      expect(ids, `must exclude ${excluded}`).not.toContain(excluded);
    }
    expect(ids).toContain("feel.pickup");
  }),
);

it.effect("finds onboarding from not-knowing words without ranking tower first", () =>
  Effect.gen(function* () {
    const ids = yield* searchIds({ text: "I do not know what I am meant to do next" });
    expect(ids[0]).toBe("read.onboarding");
  }),
);

it.effect("keeps weak-hit feedback ranked with its sound, not shake first", () =>
  Effect.gen(function* () {
    const ids = yield* searchIds({ text: "Hitting things feels weak and boring" });
    expect(ids[0]).toBe("feel.hit-stop");
    expect(ids).toContain("audio.feedback");
  }),
);

it.effect("keeps readability lookup on the actor, not jump grace", () =>
  Effect.gen(function* () {
    // Regression guard: guidance prose ("does the character jump") must not
    // outrank the silhouette reference for a lost-actor query.
    const ids = yield* searchIds({ text: "The character gets lost against the background" });
    expect(ids[0]).toBe("read.silhouette");
  }),
);

it.effect("leaves unrelated and stopword-only queries empty", () =>
  Effect.gen(function* () {
    for (const text of ["underwater stealth submarine sonar", "the and with", "a"]) {
      const ids = yield* searchIds({ text });
      expect(ids, `text '${text}'`).toEqual([]);
    }
  }),
);

it.effect("keeps technical exact lookups, union and pagination working", () =>
  Effect.gen(function* () {
    const recipes = yield* GameRecipes.GameRecipes;

    const jump = yield* searchIds({ mechanic: "jump" });
    expect(jump.slice(0, 2)).toEqual(["feel.buffer", "feel.coyote"]);

    const weak = yield* searchIds({ defect: "weak-impact" });
    expect(weak.slice(0, 2)).toEqual(["feel.hit-stop", "feel.shake"]);

    // Fields union: a mechanic-only match still surfaces below a genre match.
    const union = yield* searchIds({ genre: "racing", mechanic: "jump" });
    expect(union).toContain("feel.buffer");
    expect(union).toContain("loop.racing");

    const first = yield* recipes.search({});
    expect(first.recipes).toHaveLength(5);
    expect(first.nextCursor).not.toBeNull();
    const seen = first.recipes.map((recipe) => recipe.id);
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = yield* recipes.search({ cursor });
      seen.push(...page.recipes.map((recipe) => recipe.id));
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain("feel.buffer");
    expect(seen).toContain("read.onboarding");
    expect(seen).toContain("audio.feedback");
  }).pipe(Effect.provide(recipesLayer)),
);
