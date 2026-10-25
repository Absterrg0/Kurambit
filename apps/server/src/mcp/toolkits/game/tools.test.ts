import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { McpSchema, Tool } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  GameArtToolkit,
  GamePlaytestToolkit,
  GameRecipeToolkit,
  GameReviewAnswerToolkit,
  GameToolkit,
  GameTryInputTool,
  GameVerifyTool,
  GameWebPlaytestTool,
} from "./tools.ts";

interface AdvertisedInput {
  readonly properties?: Record<string, unknown>;
  readonly required?: ReadonlyArray<string>;
}

const reviewScope = (
  gameReviewRole: "critic" | "ballot" | null,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-tool-visibility-test"),
  requestNamespace: "request-tool-visibility-test",
  thread: {
    threadId: ThreadId.make("thread-tool-visibility-test"),
    providerSessionId: "provider-session-tool-visibility-test",
    providerInstanceId: ProviderInstanceId.make("opencode"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
  gameReviewRole,
});

/** Evaluate the same `tools/list` gate the MCP transport applies. */
const visible = (tool: Tool.Any, role: "critic" | "ballot" | null) =>
  Effect.gen(function* () {
    const enabledWhen = Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen);
    if (enabledWhen === undefined) return true;
    return yield* Effect.sync(() =>
      enabledWhen({
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: undefined,
      }),
    );
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, reviewScope(role)));

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

it.effect(
  "offers the builder toolkit to builders and repairs but never to a critic or ballot",
  () =>
    Effect.gen(function* () {
      for (const tool of Object.values(GameToolkit.tools)) {
        expect(
          yield* visible(tool, null),
          `${tool.name} must stay available to builders and repairs`,
        ).toBe(true);
        expect(yield* visible(tool, "critic"), `${tool.name} must be hidden from critics`).toBe(
          false,
        );
        expect(yield* visible(tool, "ballot"), `${tool.name} must be hidden from ballots`).toBe(
          false,
        );
      }
    }),
);

it.effect("offers review children only the evidence tools their role can use", () =>
  Effect.gen(function* () {
    for (const tool of Object.values(GameRecipeToolkit.tools)) {
      expect(yield* visible(tool, "critic"), `${tool.name} must stay available to critics`).toBe(
        true,
      );
      expect(yield* visible(tool, "ballot"), `${tool.name} must be hidden from ballots`).toBe(
        false,
      );
    }
    expect(yield* visible(GameArtToolkit.tools.game_art_search, "critic")).toBe(true);
    expect(yield* visible(GameArtToolkit.tools.game_art_get, "critic")).toBe(true);
    expect(yield* visible(GameArtToolkit.tools.game_art_import, "critic")).toBe(false);
    expect(yield* visible(GameArtToolkit.tools.game_art_search, "ballot")).toBe(false);
    expect(yield* visible(GameTryInputTool, "critic")).toBe(true);
    expect(yield* visible(GameTryInputTool, "ballot")).toBe(false);
    expect(yield* visible(GameWebPlaytestTool, "critic")).toBe(true);
    expect(yield* visible(GameWebPlaytestTool, "ballot")).toBe(false);
    expect(yield* visible(GameReviewAnswerToolkit.tools.game_critic_report, "critic")).toBe(true);
    expect(yield* visible(GameReviewAnswerToolkit.tools.game_critic_report, "ballot")).toBe(false);
    expect(yield* visible(GameReviewAnswerToolkit.tools.game_ballot, "ballot")).toBe(true);
    expect(yield* visible(GameReviewAnswerToolkit.tools.game_ballot, "critic")).toBe(false);
  }),
);

it.effect("advertises exactly the review tools each role may use", () =>
  Effect.gen(function* () {
    const all = [
      ...Object.values(GameToolkit.tools),
      ...Object.values(GamePlaytestToolkit.tools),
      ...Object.values(GameRecipeToolkit.tools),
      ...Object.values(GameArtToolkit.tools),
      ...Object.values(GameReviewAnswerToolkit.tools),
    ];
    const names = (role: "critic" | "ballot" | null) =>
      Effect.gen(function* () {
        const visibleNames: string[] = [];
        for (const tool of all) if (yield* visible(tool, role)) visibleNames.push(tool.name);
        return visibleNames.sort();
      });
    expect(yield* names("critic")).toEqual([
      "game_art_get",
      "game_art_search",
      "game_critic_report",
      "game_recipe_get",
      "game_recipe_search",
      "game_try_input",
      "game_web_playtest",
    ]);
    expect(yield* names("ballot")).toEqual(["game_ballot"]);
    const builder = yield* names(null);
    expect(builder).toHaveLength(all.length - 2);
    expect(builder).not.toContain("game_critic_report");
    expect(builder).not.toContain("game_ballot");
  }),
);
