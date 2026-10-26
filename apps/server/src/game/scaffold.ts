import {
  DEFAULT_GAME_PRODUCTION_MINUTES,
  DEFAULT_GAME_TEMPLATE,
  DEFAULT_GAME_TEST_SUITE,
  GAME_TEMPLATES,
  type GameCreateInput,
  type GameManifest,
} from "@t3tools/contracts";

export const designSkeleton = (name: string) => `# ${name} — design

One page. Keep these headings and replace every hint with a concrete decision.

## Pitch

What the player does, and why it is fun, in two or three sentences.

## Core loop

The repeating 30 seconds: what the player does, what changes, and what pulls them forward.

## Controls

The player's actions and how to trigger them (keys, pointer or gamepad), including
movement or camera only when the game has them.

## Win & lose

How a run ends in success and in failure, and what retrying costs. A game without a win
or without an end says so here and writes only the endings it promises. If this game truly
has no lose state, say "no lose state" here and write that promise in Acceptance as a
\`lose\` criterion with the text "No lose state" and no observe.

## Content

Levels, enemies and pickups, with counts and names. Say what the starter template
provides and what this game adds.

## Acceptance

The build is judged against these, not against a summary. Write a fenced block tagged
\`acceptance\` with 5 to 12 concrete criteria. Every criterion needs a slug id, a kind and the
promise in plain language. Except for \`presentation\` claims and the declared no-lose-state
criterion, each carries an \`observe\` of a GameState autoload property the player changes
(\`state\`, \`won\`, \`collected\`, \`score\`, \`lives\`, \`health\`, \`level_index\`, \`jumps\`) using
\`==V\`, \`>=N\`, \`<=N\` or \`changes\`. The observed value has to be false when play starts and
become true later: observe what the player achieves, not a boot constant or a world total.
Content counts are proven by collecting or visiting them (\`collected >= 5\`), never by a world
total such as \`total == 5\`. A \`win\` observes the template's \`won\` flag (\`won == 1\`), not a
\`state\` enum value that pausing could also reach; a \`lose\` that ends a run observes the value
the run ends at (\`lives <= 0\`), not \`changes\`. \`presentation\` claims and the declared
no-lose-state criterion carry no observe. Review compares visible improvements but does not
certify every presentation claim.
The block needs at least one \`control\`, one \`mechanic\` and one \`lose\`: a real loss, or, when
the "Win & lose" section declares no lose state, a \`lose\` criterion with the text
"No lose state" and no observe. Cover every control and content count the game promises, and
add a \`win\` only when the game actually ends in one. Never invent an ending the game does
not have. A game with no player node marks play with a typed \`state\` (0/false before play,
another value once play starts), so the scenario runner and playtest can find the gameplay
baseline.

Examples (write 5 to 12 total for this game, not one of each; two per kind shown):
- control: \`{ "id": "move-and-jump", "kind": "control", "text": "A and D move and Space jumps", "observe": { "key": "jumps", "expect": ">=1" } }\`
- control: \`{ "id": "reach-the-next-roof", "kind": "control", "text": "Running right reaches the next roof", "observe": { "key": "level_index", "expect": ">=1" } }\`
- mechanic: \`{ "id": "lantern-lights", "kind": "mechanic", "text": "Touching a lantern lights it", "observe": { "key": "collected", "expect": ">=1" } }\`
- mechanic: \`{ "id": "lava-hurts", "kind": "mechanic", "text": "Standing in lava costs health", "observe": { "key": "health", "expect": "<=95" } }\`
- content: \`{ "id": "collect-every-coin", "kind": "content", "text": "The player collects every coin in level one", "observe": { "key": "collected", "expect": ">=12" } }\`
- content: \`{ "id": "collect-every-relic", "kind": "content", "text": "The player collects all five relics", "observe": { "key": "collected", "expect": ">=5" } }\`
- win: \`{ "id": "reach-the-summit", "kind": "win", "text": "The run ends at the summit spire", "observe": { "key": "won", "expect": "==1" } }\`
- win: \`{ "id": "unlock-the-gate", "kind": "win", "text": "Walking into the open gate wins the run", "observe": { "key": "won", "expect": "==1" } }\`
- lose: \`{ "id": "out-of-lives", "kind": "lose", "text": "Losing all three lives ends the run", "observe": { "key": "lives", "expect": "<=0" } }\`
- lose: \`{ "id": "lava-ends-the-run", "kind": "lose", "text": "Falling in lava ends the run", "observe": { "key": "state", "expect": "==4" } }\`
- presentation: \`{ "id": "lantern-glow", "kind": "presentation", "text": "Lit lanterns cast a warm glow" }\`
- presentation: \`{ "id": "wind-audio", "kind": "presentation", "text": "Wind rises as the player climbs" }\`

When the game declares no lose state, write it as
\`{ "id": "no-lose", "kind": "lose", "text": "No lose state" }\` with no \`observe\`, and say
so under "Win & lose".

\`\`\`acceptance
[
  { "id": "move-and-jump", "kind": "control", "text": "A and D move and Space jumps", "observe": { "key": "jumps", "expect": ">=1" } },
  { "id": "lantern-lights", "kind": "mechanic", "text": "Touching a lantern lights it", "observe": { "key": "collected", "expect": ">=1" } },
  { "id": "collect-the-coins", "kind": "content", "text": "The player collects the level's coins", "observe": { "key": "collected", "expect": ">=3" } },
  { "id": "reach-the-summit", "kind": "win", "text": "The run ends at the summit spire", "observe": { "key": "won", "expect": "==1" } },
  { "id": "out-of-lives", "kind": "lose", "text": "Losing every life ends the run", "observe": { "key": "lives", "expect": "<=0" } }
]
\`\`\`

## Art direction

This game's look and sound in its own terms: the visual idea the brief asks for, how the
player, hazards, pickups and the goal read at gameplay scale, and which assets or effects
carry it. Say what changes from the starter template.

## Audio

Music, ambience and the sound effects that have to exist.

## Scope

- **Must have** — the smallest game that is worth playing.
- **Nice to have** — only if the core lands.
- **Cut** — what this game deliberately does not do.

## Milestones

1. **Playable core** — the loop above running end to end.
2. **Content** — the levels, enemies and pickups the design needs.
3. **Polish** — art, audio and the states a player expects.
`;

/**
 * The first message of a game's thread. A reviewed design ends that turn at
 * DESIGN.md; otherwise the agent writes DESIGN.md and builds in the same turn.
 */
export function initialGamePrompt(input: GameCreateInput): string {
  const template = input.template ?? DEFAULT_GAME_TEMPLATE;
  const templateName = GAME_TEMPLATES.find((entry) => entry.id === template)?.name ?? template;
  const brief = `${input.brief}${input.artDirection ? `\n\nArt direction:\n${input.artDirection}` : ""}`;
  if (input.planFirst === false)
    return `${brief}\n\nRead AGENTS.md and TEMPLATE.md, then build the game by following AGENTS.md's steps.`;
  const next =
    input.reviewDesign === true
      ? "Do not build anything yet. When DESIGN.md is ready, ask me to review it on the Design tab."
      : "Nobody has to approve it: as soon as DESIGN.md is written, build the game in this same turn by following AGENTS.md's steps.";
  return `${brief}\n\nRead AGENTS.md and TEMPLATE.md. Write this game's design in DESIGN.md: one page, concrete, and built on the ${templateName} template's existing systems — say what is reused and what is new. Keep the scaffold's section headings and fill each one; do not delete, rename or merge them. Make Art direction specific to this game's brief; the starter's look is a placeholder, not a requirement. Fill the Acceptance section with 5 to 12 concrete criteria in the fenced acceptance block: at least one control, one mechanic and one lose — a real loss, or, when the design's "Win & lose" section declares no lose state, a \`lose\` criterion with the text "No lose state" and no observe — covering every control and content count; add a win only when the game actually ends in one and never invent an ending the game does not have. Every control/mechanic/content/win/lose criterion needs an observe of a GameState property the player changes after play starts, except the declared no-lose-state criterion, which carries no observe; content counts are proven by collecting (collected >= N), not a world total, and a win observes the template's won flag (won == 1), a real loss the value a losing run ends at (lives <= 0), never "changes". Presentation claims carry no observe. ${next}`;
}

/** The manifest a new game starts from; the creation record also reads its probe flag. */
export function scaffoldManifest(input: GameCreateInput): GameManifest {
  const template = input.template ?? DEFAULT_GAME_TEMPLATE;
  const templateEntry = GAME_TEMPLATES.find((entry) => entry.id === template);
  const planFirst = input.planFirst !== false;
  return {
    schemaVersion: 1,
    name: input.name.trim(),
    brief: input.brief,
    artDirection: input.artDirection ?? "",
    template,
    testSuite: templateEntry?.testSuite ?? DEFAULT_GAME_TEST_SUITE,
    ...(templateEntry?.gameplayScene === undefined
      ? {}
      : { gameplayScene: templateEntry.gameplayScene }),
    ...(templateEntry?.probe === true ? { probe: true } : {}),
    design: planFirst ? { status: "draft" } : { status: "approved" },
    productionMinutes: DEFAULT_GAME_PRODUCTION_MINUTES,
    engine: { name: "godot", version: "4.7.2" },
    godotProject: "godot",
    assets: [],
  };
}

/**
 * Files the studio owns for every game. The starter template supplies the
 * `godot/` tree and TEMPLATE.md; see templates.ts.
 */
export function scaffoldFiles(input: GameCreateInput): Record<string, string> {
  const template = input.template ?? DEFAULT_GAME_TEMPLATE;
  const templateEntry = GAME_TEMPLATES.find((entry) => entry.id === template);
  const templateName = templateEntry?.name ?? template;
  const planFirst = input.planFirst !== false;
  const designLine = !planFirst
    ? ""
    : input.reviewDesign === true
      ? "\n\nDESIGN.md is your plan. Keep its section headings. Scope changes need the creator to re-approve them on the Design tab."
      : "\n\nDESIGN.md is your plan. Keep its section headings and update it when scope changes; nobody has to approve it.";
  const manifest = scaffoldManifest(input);
  return {
    "game.json": JSON.stringify(manifest, null, 2) + "\n",
    "BRIEF.md": `# ${manifest.name}\n\n${manifest.brief}\n\n## Art direction\n\n${manifest.artDirection}\n`,
    ...(planFirst ? { "DESIGN.md": designSkeleton(manifest.name) } : {}),
    "AGENTS.md": `# Game Studio project

Build BRIEF.md's game in Godot 4.7 (GDScript, Compatibility). godot/ is the project; game.json the manifest. TEMPLATE.md describes the **${templateName}** starter: reuse what fits, restyle or replace the rest.${designLine}

## Steps

1. **Recipes first.** Before building the core loop, game_recipe_search your genre and core mechanic, then game_recipe_get to adapt what fits.
2. **Playable core.** Make the main action playable, then game_verify with a real input route; it runs canonical checks and returns the exact failed check. Use game_godot_check or game_godot_test for narrower fixes.
3. **Show the state.** Every brief value (score, lives, timer...) is visible and updates on screen and in GameState when it has one; games without endings need no invented win/lose totals.
4. **First playable.** Inspect game_verify's frames; use game_try_input for what is still uncertain. Then game_submit: Play shows it at once, the first playable, not the end of your turn. A submit needs a recorded playtest that dispatched real input. After a current export, game_web_playtest exactSize:true checks another window shape as evidence only.
5. **Produce.** game_status shows the production budget: game.json's productionMinutes, 45 by default from first playable. Deepen toward BRIEF.md and its art direction (content, feedback, juice, presentation) with recipes and game_try_input. Optional art: game_art_search, game_art_import. game_verify each iteration, targeted game_* tools for fixes, game_submit each improved build; a refused submit keeps the live build and gives the exact failed check.
6. **Finish.** End when the budget is used or the game fully realises the brief; do not start your own repair loop. Review starts on the last accepted submit.

A focused request is not a redesign; keep the rest working. Never claim a check you did not run.

## Rules

- Use game_* tools; never run godot from the shell.
- Keep scripts/studio_probe.gd autoload; extend GameState, do not replace it.
- Models via game_blender_run; keep art/blender sources, godot/assets/models/*.glb exports.
- builds/ and godot/.godot/ are generated; do not edit.
- Missing tool: Settings > General > Game tools.

Certification: game_scenarios_run.
`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": "builds/\ngodot/.godot/\n*.blend1\n",
  };
}
