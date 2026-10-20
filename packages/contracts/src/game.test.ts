import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { DEFAULT_GAME_TEMPLATE, GAME_TEMPLATES, GameCreateInput, GameManifest } from "./game.ts";

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(GameManifest));
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(GameManifest));
const decodeCreateInput = Schema.decodeUnknownSync(GameCreateInput);

// The shape scaffold.ts wrote before starter templates existed.
const legacyManifest = {
  schemaVersion: 1,
  name: "Old Game",
  brief: "Collect coins.",
  artDirection: "",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};

describe("game manifest starter template", () => {
  it("keeps decoding games created before templates existed", () => {
    const manifest = decodeManifest(JSON.stringify(legacyManifest));
    expect(manifest.template).toBeUndefined();
    expect(encodeManifest(manifest)).not.toContain("template");
  });

  it("records and re-encodes the starter template", () => {
    const manifest = decodeManifest(JSON.stringify({ ...legacyManifest, template: "blank" }));
    expect(manifest.template).toBe("blank");
    expect(encodeManifest(manifest)).toContain('"template":"blank"');
  });

  it("rejects an unknown starter template", () => {
    expect(() =>
      decodeManifest(JSON.stringify({ ...legacyManifest, template: "topdown-2d" })),
    ).toThrow();
  });
});

describe("game manifest design phase", () => {
  it("keeps decoding games created before the design step existed", () => {
    const manifest = decodeManifest(JSON.stringify(legacyManifest));
    expect(manifest.design).toBeUndefined();
    expect(encodeManifest(manifest)).not.toContain("design");
  });

  it("records a draft and its approval time", () => {
    const draft = decodeManifest(
      JSON.stringify({ ...legacyManifest, design: { status: "draft" } }),
    );
    expect(draft.design).toEqual({ status: "draft" });
    const approved = decodeManifest(
      JSON.stringify({
        ...legacyManifest,
        design: { status: "approved", approvedAt: "2026-10-20T10:00:00.000Z" },
      }),
    );
    expect(encodeManifest(approved)).toContain('"approvedAt":"2026-10-20T10:00:00.000Z"');
  });

  it("rejects an unknown design status", () => {
    expect(() =>
      decodeManifest(JSON.stringify({ ...legacyManifest, design: { status: "reviewing" } })),
    ).toThrow();
  });
});

describe("game template registry", () => {
  it("offers unique named templates including the default", () => {
    const ids = GAME_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_GAME_TEMPLATE);
    expect(
      GAME_TEMPLATES.every(
        (template) => template.name.length > 0 && template.description.length > 0,
      ),
    ).toBe(true);
  });

  it("leaves the template optional on create input", () => {
    const base = {
      name: "Game",
      parentDirectory: "/games",
      brief: "Go",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    };
    expect(decodeCreateInput(base).template).toBeUndefined();
    expect(decodeCreateInput(base).planFirst).toBeUndefined();
    expect(decodeCreateInput({ ...base, planFirst: false }).planFirst).toBe(false);
    expect(() => decodeCreateInput({ ...base, template: "nope" })).toThrow();
  });
});
