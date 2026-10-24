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

Movement, camera and actions, with keyboard and gamepad bindings.

## Win & lose

How a run ends in success and in failure, and what retrying costs. If this game truly
has no lose state, say "no lose state" here and write that promise in Acceptance as a
\`lose\` criterion with the text "No lose state" and no observe.

## Content

Levels, enemies and pickups, with counts and names. Say what the starter template
provides and what this game adds.

## Acceptance

The build is judged against these, not against a summary. Write a fenced block tagged
\`acceptance\` with 5 to 12 concrete criteria. Every criterion needs a slug id, a kind, the
promise in plain language, and — except presentation — an \`observe\` of a GameState autoload
property the player changes (\`state\`, \`won\`, \`collected\`, \`score\`, \`lives\`, \`health\`,
\`level_index\`, \`jumps\`) using \`==V\`, \`>=N\`, \`<=N\` or \`changes\`. The observed value has to
be false when play starts and become true later: observe what the player achieves, not a
boot constant or a world total. Content counts are proven by collecting or visiting them
(\`collected >= 5\`), never by a world total such as \`total == 5\`. A \`win\` observes the
template's \`won\` flag (\`won == 1\`), not a \`state\` enum value that pausing could also
reach; a \`lose\` observes the value a losing run ends at (\`lives <= 0\`), not \`changes\`.
\`presentation\` claims carry no observe. Review compares visible improvements but does not
certify every presentation claim.
The block needs at least one \`control\`, one \`mechanic\`, one \`win\` and one \`lose\`; cover every
control and content count the game promises.

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
  return `${brief}\n\nRead AGENTS.md and TEMPLATE.md. Write this game's design in DESIGN.md: one page, concrete, and built on the ${templateName} template's existing systems — say what is reused and what is new. Keep the scaffold's section headings and fill each one; do not delete, rename or merge them. Make Art direction specific to this game's brief; the starter's look is a placeholder, not a requirement. Fill the Acceptance section with 5 to 12 concrete criteria in the fenced acceptance block: at least one control, one mechanic, one win and one lose, covering every control and content count. Every control/mechanic/content/win/lose criterion needs an observe of a GameState property the player changes after play starts; content counts are proven by collecting (collected >= N), not a world total, and a win observes the template's won flag (won == 1, lives <= 0 for a loss), never "changes". Presentation claims carry no observe. ${next}`;
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

Build BRIEF.md's game in Godot 4.7 (GDScript, Compatibility). godot/ is the engine project; game.json the manifest. TEMPLATE.md describes the **${templateName}** starter: reuse what fits, restyle or replace the rest.${designLine}

## Steps

1. **Recipes first.** Before building the core loop, game_recipe_search your genre and core mechanic; game_recipe_get what fits and adapt it.
2. **Core loop first.** Make the main action playable, then run one game_verify with a real input route (press, hold, key/keys, click, drag or mouseMove). It checks, runs the canonical suite, exports Web and records a playtest of those exact bytes; it stops at the first failing stage. Use game_godot_check or game_godot_test alone for a narrower fix or diagnostic.
3. **Show the state.** Every brief value (score, lives, turn, timer...) is visible on screen and updates, and in GameState when it has one. Win and lose end with totals.
4. **First playable.** Inspect game_verify's frames; test what is still uncertain with game_try_input. Then game_submit with a one-line note: the build is live on Play at once, the first playable, not the end of your turn. A submit needs a recorded playtest that dispatched real input at least once; waits and screenshots do not count, so give game_verify a route that actually drives the game rather than guessing one from prose.
5. **Produce.** game_status shows the production budget: 45 minutes after first playable by default; game.json's productionMinutes sets it, and the server never cuts you short. Deepen it toward BRIEF.md and its art direction — content, feedback, juice, presentation, fitting any window — with recipes and game_try_input. Optional art: game_art_search, game_art_import. Use game_verify for each complete iteration, targeted game_* tools for a fix, and game_submit each improved build; a refused submit keeps the live build and gives the exact failed check.
6. **Finish.** End the turn when the budget is used or the game fully realises the brief; do not start your own repair loop. Review starts on the last accepted submit.

A focused request is not a redesign; keep the rest working. Never claim a check you did not run.

## Rules that prevent breakage

- Use the game_* tools for engine work; never run godot from the shell.
- Keep scripts/studio_probe.gd and its autoload; extend GameState, do not replace it.
- Make models with game_blender_run: art/blender sources, godot/assets/models/*.glb exports.
- builds/ and godot/.godot/ are generated; do not edit them.
- Missing tool: install it in Settings > General > Game tools.

Certification: game_godot_test runs tests/smoke_test.gd; game_scenarios_run replays scenarios/*.json.
`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": "builds/\ngodot/.godot/\n*.blend1\n",
  };
}
