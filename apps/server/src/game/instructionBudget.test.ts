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
  GameAssetsTool,
  GameBlenderTool,
  GameCheckTool,
  GamePlayTool,
  GameToolkit,
} from "../mcp/toolkits/game/tools.ts";
import { firstTurnMessage, gameTurnRules, scaffoldFiles } from "./scaffold.ts";
import { publishedInputSchema } from "../mcp/McpHttpServer.ts";

/** The model choices whose first turns differ. */
const CHOICES = {
  any: { characters: "any", library: false },
  blender: { characters: "blender", library: false },
  code: { characters: "code", library: false },
  "code with the library": { characters: "code", library: true },
} as const satisfies Record<string, { characters: GameCharacterRoute; library: boolean }>;
/**
 * Bytes a new three.js game's first turn reads, by model choice: its first message (the first
 * turn's steps), the turn rules the harness sends, AGENTS.md, three.md, the bridge contract
 * (TEMPLATE.md) the message sends it to, the art-pipeline sections they name and the kit comment
 * blocks the message names. Set about 10% over what they were on 2026-11-16, once a new game started
 * from an empty page with no starter or recipe: code reads 10,301 and the library 10,386.
 * Blender, the default since 2026-11-17 (its route by kind of model), read 10,639 then.
 * On 2026-11-20 three.md sent the API to runtime.d.ts: Blender reads 11,071, code 10,759 and the
 * library 10,837. These left out studio-skills/AGENTS.md (745), which the
 * game's AGENTS.md points at; it is counted since it holds the recipe index (2026-11-20, 2,069
 * with all 24 recipes): Blender 13,140, code 12,828, the library 12,906. On 2026-11-21 the index
 * shrank to six notes and the default became the agent's choice ("any"), which reads 11,574.
 */
const FIRST_TURN_BUDGET: Readonly<Record<keyof typeof CHOICES, number>> = {
  any: 12_000,
  blender: 12_000,
  code: 12_000,
  "code with the library": 12_000,
};
/**
 * Bytes a three.js chat's agent reads of its game tools with every call, descriptions and input
 * schemas as published, by model choice. Code with the library off lists five tools (no Blender);
 * the routes that make models in Blender list game_blender too. Targets set 2026-11-16 at 10,000
 * and 18,000 (code read 18,398 over twelve tools before the tools took ops, Blender 34,611).
 * Code read exactly 10,000 on 2026-11-17; game_builds' undo, copies, bring_in and update (many
 * chats in one game) took it to 10,354, so its line is 10,400. The Blender listings read 17,680
 * until the carve and hero pointers left game_blender and its review took a reference (17,729).
 * On 2026-11-20 the ops went from 45 to 29 (the copy's ops moved to game_copy, listed only in a
 * copy): code reads 8,692 and the Blender listings 15,852.
 */
const LISTED_TOOLS_BUDGET: Readonly<Record<keyof typeof CHOICES, number>> = {
  any: 16_000,
  code: 8_800,
  "code with the library": 16_000,
  blender: 16_000,
};

/**
 * Bytes of the art skill every Blender tool names as its recipe, read whole by any chat that makes
 * a model. It was 36,030 (5,483 words, a recipe per craft helper) until 2026-11-20, when it became
 * the packs' rules, each naming the number the review reports for it (10,373). Later that day the
 * craft moved into the art recipes it indexes, read one or two at a time (7,627), and the index
 * moved to the studio AGENTS.md with every recipe's (6,994). On 2026-11-21 it became the method
 * that wins (reference, dense surfaces, rigid only what is rigid) with its notes read on demand
 * (4,617).
 */
const ART_SKILL_BUDGET = 5_000;

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
    // The skills index the game's AGENTS.md points at, with the recipe index the agent picks from.
    "studio-skills/AGENTS.md": bytes(template("studio/AGENTS.md")),
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

/** Registered without the `includeImage` switch: they answer no pictures (McpHttpServer). */
const NO_IMAGES = new Set(Object.keys(GameToolkit.tools));

const GAME_TOOLS = [
  ...Object.values(GameToolkit.tools),
  GameCheckTool,
  GamePlayTool,
  GameAssetsTool,
  GameBlenderTool,
];

/** Each tool the MCP server would list for a three.js chat with this model choice, by its own EnabledWhen. */
const listedTools = (models: { readonly route: GameCharacterRoute; readonly library: boolean }) =>
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
    ).map((tool) => ({
      name: tool.name,
      bytes:
        bytes(tool.description ?? "") +
        bytes(
          JSON.stringify(
            publishedInputSchema(tool, {
              defaultIncludeImage: true,
              images: !NO_IMAGES.has(tool.name),
            }),
          ),
        ),
    })),
  ).pipe(
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("budget"),
      gameEngine: "three",
      gameModels: models,
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

it("keeps the art skill a model's chat reads within its budget", () => {
  expect(
    bytes(template("studio/art-pipeline.md")),
    "The art skill grew past its budget: a rule is one sentence of craft and the number the review reports for it; how a tool works belongs in its result.",
  ).toBeLessThanOrEqual(ART_SKILL_BUDGET);
});

it.effect("keeps the game tools a three.js chat reads within its model choice's budget", () =>
  Effect.gen(function* () {
    for (const [choice, budget] of Object.entries(LISTED_TOOLS_BUDGET) as Array<
      [keyof typeof CHOICES, number]
    >) {
      const { characters, library } = CHOICES[choice];
      const tools = yield* listedTools({ route: characters, library });
      const parts = Object.fromEntries(tools.map((tool) => [tool.name, tool.bytes]));
      const total = tools.reduce((sum, tool) => sum + tool.bytes, 0);
      expect(tools.some((tool) => tool.name === "game_blender")).toBe(
        characters !== "code" || library,
      );
      expect(
        total,
        over(
          `The ${choice} choice's ${tools.length} listed tools`,
          parts,
          budget,
          "A field says what it is in a few words and an op what it gives in a sentence; how to use them belongs in the op's result or a skill. Cut there rather than raising the budget.",
        ),
      ).toBeLessThanOrEqual(budget);
    }
  }),
);
