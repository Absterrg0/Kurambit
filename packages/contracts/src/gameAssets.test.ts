import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { GameManifest } from "./game.ts";
import {
  GAME_ASSET_INVENTORY_BOUNDS,
  GameAssetFamily,
  GameAssetsInspectInput,
  GameAssetsInspectResult,
} from "./gameAssets.ts";

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(GameManifest));
const decodeFamily = Schema.decodeUnknownSync(GameAssetFamily);
const decodeInput = Schema.decodeUnknownSync(GameAssetsInspectInput);

const legacyManifest = {
  schemaVersion: 1,
  name: "Old Game",
  brief: "Collect coins.",
  artDirection: "",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};

describe("game asset families", () => {
  it("keeps decoding games created before families existed", () => {
    const manifest = decodeManifest(JSON.stringify(legacyManifest));
    expect(manifest.families).toBeUndefined();
  });

  it("records and re-encodes authored families", () => {
    const manifest = decodeManifest(
      JSON.stringify({
        ...legacyManifest,
        families: [
          {
            name: "hero",
            kind: "character",
            paths: ["res://scenes/hero.tscn"],
            role: "Playable courier.",
            targetHeight: 1.8,
            pivot: "ground",
            animations: [{ name: "idle", loop: true }],
            transitions: [{ from: "idle", to: "run" }],
            collision: "required",
            provenance: "required",
          },
        ],
      }),
    );
    expect(manifest.families).toHaveLength(1);
    expect(manifest.families?.[0]?.name).toBe("hero");
  });

  it("rejects family names, paths and promises outside the authored bounds", () => {
    const base = {
      name: "hero",
      kind: "character",
      paths: ["res://scenes/hero.tscn"],
    };
    expect(() => decodeFamily({ ...base, name: "Hero" })).toThrow();
    expect(() => decodeFamily({ ...base, name: "" })).toThrow();
    expect(() =>
      decodeFamily({
        ...base,
        paths: Array.from({ length: 17 }, (_, index) => `res://a${index}.tscn`),
      }),
    ).toThrow();
    expect(() => decodeFamily({ ...base, pivot: "top-left" })).toThrow();
    expect(() => decodeFamily({ ...base, collision: "sometimes" })).toThrow();
    expect(() =>
      decodeFamily({
        ...base,
        animations: Array.from({ length: 17 }, (_, index) => ({ name: `a${index}` })),
      }),
    ).toThrow();
  });

  it("rejects more than 16 families on the manifest", () => {
    expect(() =>
      decodeManifest(
        JSON.stringify({
          ...legacyManifest,
          families: Array.from({ length: 17 }, (_, index) => ({
            name: `family-${index}`,
            kind: "prop",
            paths: [],
          })),
        }),
      ),
    ).toThrow();
  });
});

describe("game assets inspect input", () => {
  it("defaults to the native pass with no path filter", () => {
    expect(decodeInput({})).toEqual({});
  });

  it("rejects more than 32 native paths", () => {
    expect(() =>
      decodeInput({ paths: Array.from({ length: 33 }, (_, index) => `res://a${index}.tscn`) }),
    ).toThrow();
  });
});

describe("game assets inspect result", () => {
  it("keeps exported usage unknown by construction", () => {
    const fields = GameAssetsInspectResult.fields;
    expect(fields.exportedUsage.literals).toEqual(["unknown"]);
    expect(GAME_ASSET_INVENTORY_BOUNDS.maxResources).toBe(300);
    expect(GAME_ASSET_INVENTORY_BOUNDS.timeoutMs).toBe(60_000);
  });
});
