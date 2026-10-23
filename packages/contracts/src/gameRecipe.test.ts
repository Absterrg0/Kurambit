import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  DEFAULT_GAME_RECIPE_ENGINE,
  GAME_RECIPE_PAGE_SIZE,
  GameRecipeAdapter,
  GameRecipeCatalogEntry,
  GameRecipeGetInput,
  GameRecipeGetResult,
  GameRecipeSearchInput,
  GameRecipeSearchResult,
} from "./gameRecipe.ts";

const decodeEntry = Schema.decodeUnknownSync(GameRecipeCatalogEntry);
const decodeAdapter = Schema.decodeUnknownSync(GameRecipeAdapter);
const decodeSearch = Schema.decodeUnknownSync(GameRecipeSearchInput);
const decodeGet = Schema.decodeUnknownSync(GameRecipeGetInput);
const decodeGetResult = Schema.decodeUnknownSync(GameRecipeGetResult);
const decodeSearchResult = Schema.decodeUnknownSync(GameRecipeSearchResult);

const referenceCode = [
  "extends Node2D",
  "",
  "var _queued := false",
  "",
  "func _unhandled_input(event: InputEvent) -> void:",
  '\tif event.is_action_pressed("jump"):',
  "\t\t_queued = true",
  "",
].join("\n");

const adapter = {
  engine: "godot",
  engineVersion: "4.7.2",
  setup: "Attach the script to an empty Node2D, run the scene, then stop and run it again.",
  referenceCode,
  tryInput: { steps: [{ press: "Space" }, { waitMs: 400 }], captureEveryMs: 200 },
};

const entry = {
  recipe: {
    id: "feel.buffer",
    version: 1,
    title: "Buffer an early jump press",
    genres: ["platformer"],
    mechanics: ["jump", "input-buffer"],
    defects: ["unresponsive-jump"],
    aliases: ["jump buffering", "input buffering"],
    intent: "Remember a jump pressed slightly before the character can jump.",
    why: "Players press early near landing and read the ignored press as unresponsive controls.",
    failure: "A jump that only accepts a press on the exact frame leaves the character grounded.",
    restyle: "Keep the mechanism and choose the game's own jump feel and presentation.",
    verificationQuestion: "Without a second press, does the character jump once on landing?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "review-r4/findings.md:21",
    },
  },
  adapters: [adapter],
} as const;

describe("recipe metadata", () => {
  it("decodes a complete entry without touching the reference code bytes", () => {
    const decoded = decodeEntry(entry);
    expect(decoded.recipe.id).toBe("feel.buffer");
    expect(decoded.adapters[0]?.referenceCode).toBe(referenceCode);
    expect(decoded.adapters[0]?.referenceCode.endsWith("\n")).toBe(true);
    expect(decoded.recipe.source).toEqual({
      kind: "write-original",
      license: "MIT",
      reference: "review-r4/findings.md:21",
    });
  });

  it("rejects identifiers and versions that cannot name a mechanism", () => {
    const withId = (id: string) => ({ ...entry, recipe: { ...entry.recipe, id } });
    expect(() => decodeEntry(withId("Feel.Buffer"))).toThrow();
    expect(() => decodeEntry(withId("feel"))).toThrow();
    expect(() => decodeEntry({ ...entry, recipe: { ...entry.recipe, version: 0 } })).toThrow();
  });

  it("rejects guidance that drops a provenance field", () => {
    expect(() =>
      decodeEntry({
        ...entry,
        recipe: { ...entry.recipe, source: { kind: "write-original", license: "MIT" } },
      }),
    ).toThrow();
    expect(() =>
      decodeEntry({
        ...entry,
        recipe: {
          ...entry.recipe,
          source: { ...entry.recipe.source, kind: "inspired-by" },
        },
      }),
    ).toThrow();
  });

  it("keeps the adapter on the existing try-input vocabulary and capture floor", () => {
    expect(decodeAdapter(adapter).tryInput.steps).toEqual(adapter.tryInput.steps);
    expect(() =>
      decodeAdapter({
        ...adapter,
        tryInput: { steps: [], captureEveryMs: 99 },
      }),
    ).toThrow();
  });
});

describe("retrieval contracts", () => {
  it("treats every search filter as optional, including the cursor", () => {
    const browse = decodeSearch({});
    expect(browse).toEqual({});
    expect(
      decodeSearch({
        genre: "platformer",
        mechanic: "jump",
        defect: "unresponsive-jump",
        text: "buffering",
        cursor: "5",
      }),
    ).toMatchObject({ cursor: "5" });
    expect(() => decodeSearch({ text: "x".repeat(201) })).toThrow();
  });

  it("defaults get's engine and reference after decoding, not in the caller", () => {
    const input = decodeGet({ id: "feel.buffer" });
    expect(input).toEqual({ id: "feel.buffer" });
    expect(DEFAULT_GAME_RECIPE_ENGINE).toBe("godot");
    expect(() => decodeGet({ id: "feel.buffer", engine: "Godot 4.7" })).toThrow();
  });

  it("carries provenance with guidance-only and complete responses", () => {
    const guidance = decodeGetResult({ recipe: entry.recipe, engine: "godot", adapter: null });
    expect(guidance.recipe.source.kind).toBe("write-original");
    const complete = decodeGetResult({ recipe: entry.recipe, engine: "godot", adapter });
    expect(complete.adapter?.referenceCode).toBe(referenceCode);
  });

  it("bounds a page and requires an explicit cursor answer", () => {
    const page = decodeSearchResult({
      recipes: [
        {
          id: "feel.buffer",
          title: entry.recipe.title,
          matchingTags: ["jump", "input buffering"],
          engines: ["godot"],
        },
      ],
      nextCursor: "5",
    });
    expect(GAME_RECIPE_PAGE_SIZE).toBe(5);
    expect(page.nextCursor).toBe("5");
    expect(() => decodeSearchResult({ recipes: [], nextCursor: null })).not.toThrow();
  });
});
