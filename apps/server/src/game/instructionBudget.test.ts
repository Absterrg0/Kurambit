// @effect-diagnostics nodeBuiltinImport:off -- Reads the shipped templates as a new game gets them.
// A guard on what every three.js chat pays for before it does any work: the
// first turn's reading and the tool descriptions its agent is handed. Prose
// grows a paragraph at a time; this fails the paragraph that crosses the line.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { McpSchema } from "effect/ai";
import {
  EnvironmentId,
  type GameCharacterRoute,
  type GameCreateInput,
  type GameManifest,
} from "@kurambit/contracts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import {
  GameAnimateTool,
  GameAssetsSearchTool,
  GameBlenderLookTool,
  GameBlenderRenderSpritesTool,
  GameMoreTool,
  GameToolkit,
  GameUnityScreenshotTool,
} from "../mcp/toolkits/game/tools.ts";
import { firstTurnMessage, scaffoldFiles } from "./scaffold.ts";

/**
 * Bytes a new three.js game's first turn reads, by character route: its first message (the
 * first turn's steps), AGENTS.md, TEMPLATE.md, three.md and the art-pipeline sections they name.
 * About 10% over what they were on 2026-11-08 (library 23,981; generated 29,096).
 */
const FIRST_TURN_BUDGET: Readonly<Record<"library" | "generated", number>> = {
  library: 26_000,
  generated: 32_000,
};
/** Bytes of tool descriptions a library-route three.js chat is handed every turn (10,918 then). */
const LISTED_TOOLS_BUDGET = 12_000;

const template = (path: string) =>
  NodeFS.readFileSync(new URL(`../../templates/${path}`, import.meta.url), "utf8");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** The sections of a skill a text names as "(`studio-skills/<file>`, <Section>)"; the whole file when it names none. */
const namedSkillBytes = (agents: string, file: string) => {
  const skill = template(`studio/${file}`);
  const mentions = [
    ...agents.matchAll(
      new RegExp(`\`studio-skills/${file.replace(".", "\\.")}\`(?:, ([^)]+))?`, "g"),
    ),
  ];
  if (mentions.length === 0) return 0;
  if (mentions.some((mention) => mention[1] === undefined)) return bytes(skill);
  const sections = new Set(mentions.map((mention) => mention[1]!.trim()));
  return [...sections].reduce((total, heading) => {
    const start = skill.indexOf(`\n## ${heading}\n`);
    if (start < 0) return total;
    const end = skill.indexOf("\n## ", start + 1);
    return total + bytes(skill.slice(start, end < 0 ? undefined : end));
  }, 0);
};

const firstTurnBytes = (characters: GameCharacterRoute) => {
  const files = scaffoldFiles({
    name: "Budget",
    parentDirectory: "/games",
    brief: "A knight clears a dungeon of skeletons.",
    engine: "three",
    characters,
    modelSelection: { instanceId: "codex", model: "gpt-5" },
  } as GameCreateInput);
  const agents = files["AGENTS.md"]!;
  const message = firstTurnMessage(JSON.parse(files["game.json"]!) as GameManifest);
  return {
    "first message": bytes(message),
    "AGENTS.md": bytes(agents),
    "TEMPLATE.md": bytes(template("blank-three/TEMPLATE.md")),
    "three.md": bytes(template("studio/three.md")),
    "art-pipeline.md (named sections)": namedSkillBytes(`${message}\n${agents}`, "art-pipeline.md"),
  };
};

const GAME_TOOLS = [
  ...Object.values(GameToolkit.tools),
  GameBlenderLookTool,
  GameAnimateTool,
  GameBlenderRenderSpritesTool,
  GameAssetsSearchTool,
  GameUnityScreenshotTool,
  GameMoreTool,
];

/** Each tool the MCP server would list for a three.js chat on this route, by its own EnabledWhen. */
const listedTools = (characters: GameCharacterRoute) =>
  Effect.sync(() =>
    GAME_TOOLS.filter(
      (tool) =>
        Context.getOrUndefined(
          tool.annotations,
          McpSchema.EnabledWhen,
        )?.({
          protocolVersion: "2025-06-18",
          capabilities: {},
        }) ?? true,
    ).map((tool) => ({ name: tool.name, bytes: bytes(tool.description ?? "") })),
  ).pipe(
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("budget"),
      gameEngine: "three",
      gameCharacters: characters,
      blenderMissing: null,
      capabilities: new Set<never>(),
      issuedAt: 0,
      requestNamespace: "budget",
      thread: undefined,
      client: undefined,
    }),
  );

const over = (what: string, parts: Record<string, number>, budget: number, cut: string) => {
  const total = Object.values(parts).reduce((sum, part) => sum + part, 0);
  const largest = Object.entries(parts)
    .toSorted(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, size]) => `${name} ${size}`)
    .join(", ");
  return `${what} is ${total} bytes, over its ${budget}-byte budget (largest: ${largest}). ${cut}`;
};

it("keeps a three.js game's first-turn reading within its budget", () => {
  for (const [route, budget] of Object.entries(FIRST_TURN_BUDGET) as Array<
    [GameCharacterRoute, number]
  >) {
    const parts = firstTurnBytes(route);
    const total = Object.values(parts).reduce((sum, part) => sum + part, 0);
    expect(
      total,
      over(
        `The ${route} route's first-turn reading`,
        parts,
        budget,
        "Cut what code already enforces or a tool already says, or move it out of what the first turn reads, rather than raising the budget.",
      ),
    ).toBeLessThanOrEqual(budget);
  }
});

it.effect("keeps the tool descriptions a library-route three.js chat lists within its budget", () =>
  Effect.gen(function* () {
    const tools = yield* listedTools("library");
    const parts = Object.fromEntries(tools.map((tool) => [tool.name, tool.bytes]));
    const total = tools.reduce((sum, tool) => sum + tool.bytes, 0);
    expect(
      total,
      over(
        `The ${tools.length} listed tools' descriptions`,
        parts,
        LISTED_TOOLS_BUDGET,
        "Cut what a skill or another tool already says, or keep the tool for the moment it is asked for (placement.ts `asked`), rather than raising the budget.",
      ),
    ).toBeLessThanOrEqual(LISTED_TOOLS_BUDGET);
  }),
);
