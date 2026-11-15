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
  GameModelSheetTool,
  GameMoreTool,
  GameToolkit,
  GameUnityScreenshotTool,
} from "../mcp/toolkits/game/tools.ts";
import { firstTurnMessage, gameTurnRules, scaffoldFiles } from "./scaffold.ts";

/** The model choices whose first turns differ. */
const CHOICES = {
  code: { characters: "code", library: false },
  "code with the library": { characters: "code", library: true },
  generated: { characters: "generated", library: false },
} as const satisfies Record<string, { characters: GameCharacterRoute; library: boolean }>;
/**
 * Bytes a new three.js game's first turn reads, by model choice: its first message (the first
 * turn's steps), the turn rules the harness sends, AGENTS.md, three.md, the bridge contract
 * (TEMPLATE.md) the message sends it to, the art-pipeline sections they name and the kit comment
 * blocks the message names. Set about 10% over what they were on 2026-11-16, once a new game started
 * from an empty page with no starter or recipe: code reads 10,301, the library 10,386 and generated
 * 15,267.
 */
const FIRST_TURN_BUDGET: Readonly<Record<keyof typeof CHOICES, number>> = {
  code: 11_500,
  "code with the library": 11_500,
  generated: 17_000,
};
/**
 * Bytes of tool descriptions a three.js chat is handed every turn, by route. Code and generated
 * keep the Blender tools behind game_more (10,918 on 2026-11-08); the Blender route lists them
 * (21,513 on 2026-11-15), with about 5% over.
 */
const LISTED_TOOLS_BUDGET: Readonly<Record<GameCharacterRoute, number>> = {
  code: 12_000,
  generated: 12_000,
  blender: 22_500,
};

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

const firstTurnBytes = (choice: (typeof CHOICES)[keyof typeof CHOICES]) => {
  const files = scaffoldFiles({
    name: "Budget",
    parentDirectory: "/games",
    brief: "A knight clears a dungeon of skeletons.",
    engine: "three",
    ...choice,
    modelSelection: { instanceId: "codex", model: "gpt-5" },
  } as GameCreateInput);
  const agents = files["AGENTS.md"]!;
  const message = firstTurnMessage(JSON.parse(files["game.json"]!) as GameManifest);
  return {
    "first message": bytes(message),
    "turn rules": bytes(gameTurnRules("three") ?? ""),
    "AGENTS.md": bytes(agents),
    "three.md": bytes(template("studio/three.md")),
    // The bridge contract the first message sends the agent to.
    "TEMPLATE.md": message.includes("`TEMPLATE.md`")
      ? bytes(template("blank-three/TEMPLATE.md"))
      : 0,
    "art-pipeline.md (named sections)": namedSkillBytes(`${message}\n${agents}`, "art-pipeline.md"),
    // A kit the first message sends the agent to read, by its comment block.
    "model.js (comment block)": message.includes("shell/model.js`")
      ? bytes(template("runtime/three/1/shell/model.js").split("\nimport ")[0]!)
      : 0,
  };
};

const GAME_TOOLS = [
  ...Object.values(GameToolkit.tools),
  GameBlenderLookTool,
  GameAnimateTool,
  GameBlenderRenderSpritesTool,
  GameAssetsSearchTool,
  GameModelSheetTool,
  GameUnityScreenshotTool,
  GameMoreTool,
];

/** Each tool the MCP server would list for a three.js chat on this route, by its own EnabledWhen. */
const listedTools = (route: GameCharacterRoute) =>
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
      gameModels: { route, library: false },
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
    [keyof typeof CHOICES, number]
  >) {
    const parts = firstTurnBytes(CHOICES[route]);
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

it.effect("keeps the tool descriptions a three.js chat lists within its route's budget", () =>
  Effect.gen(function* () {
    for (const [route, budget] of Object.entries(LISTED_TOOLS_BUDGET) as Array<
      [GameCharacterRoute, number]
    >) {
      const tools = yield* listedTools(route);
      const parts = Object.fromEntries(tools.map((tool) => [tool.name, tool.bytes]));
      const total = tools.reduce((sum, tool) => sum + tool.bytes, 0);
      expect(
        total,
        over(
          `The ${route} route's ${tools.length} listed tools' descriptions`,
          parts,
          budget,
          "Cut what a skill or another tool already says, or keep the tool for the moment it is asked for (placement.ts `asked`), rather than raising the budget.",
        ),
      ).toBeLessThanOrEqual(budget);
    }
  }),
);
