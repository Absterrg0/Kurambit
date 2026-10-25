import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { GameToolkit, GameVerifyTool, GameWebPlaytestTool } from "./tools.ts";

interface AdvertisedInput {
  readonly properties?: Record<string, unknown>;
  readonly required?: ReadonlyArray<string>;
}

it("exports a top-level object input schema for every game tool", () => {
  for (const tool of Object.values(GameToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
  }
});

it("advertises a required gameplay route for game_verify", () => {
  const schema = Tool.getJsonSchema(GameVerifyTool) as AdvertisedInput;
  expect(schema.required).toContain("steps");
  expect(schema.properties?.steps).toMatchObject({ type: "array", minItems: 1 });
  expect(schema.properties).not.toHaveProperty("exactSize");
});

it("keeps the review-only exact layout on game_web_playtest", () => {
  const schema = Tool.getJsonSchema(GameWebPlaytestTool) as AdvertisedInput;
  expect(schema.properties).toHaveProperty("exactSize");
  expect(schema.required ?? []).not.toContain("steps");
});
