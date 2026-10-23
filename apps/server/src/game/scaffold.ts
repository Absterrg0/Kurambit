import {
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

Six palette roles as hex values, each with a job: background, playfield, player, hazard,
pickup, goal. Say which is darkest and which is brightest and keep that value order.
Name the goal landmark: what it looks like, what light or shape makes it read from the
start of the level, and how the player first sees it. Give one telegraph for every
hazard. Say what the starter template's presentation kit already provides and what this
game changes about it.

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
  return `${brief}\n\nRead AGENTS.md and TEMPLATE.md. Write this game's design in DESIGN.md: one page, concrete, and built on the ${templateName} template's existing systems — say what is reused and what is new. Keep the scaffold's section headings and fill each one; do not delete, rename or merge them. In Art direction, give the six palette roles as hex values with their jobs (background, playfield, player, hazard, pickup, goal), say which value is darkest and which is brightest, and name the goal landmark: how it reads from a distance and how the player first sees it. Fill the Acceptance section with 5 to 12 concrete criteria in the fenced acceptance block: at least one control, one mechanic, one win and one lose, covering every control and content count. Every control/mechanic/content/win/lose criterion needs an observe of a GameState property the player changes after play starts; content counts are proven by collecting (collected >= N), not a world total, and a win observes the template's won flag (won == 1, lives <= 0 for a loss), never "changes". Presentation claims carry no observe. ${next}`;
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
      ? "\n\nDESIGN.md is your plan. Keep its section headings. When scope changes, update it and ask the creator to re-approve it on the Design tab; building waits until then."
      : "\n\nDESIGN.md is your plan. Keep its section headings. When scope changes, update it; the server records each revision and nobody has to approve it.";
  const manifest = scaffoldManifest(input);
  return {
    "game.json": JSON.stringify(manifest, null, 2) + "\n",
    "BRIEF.md": `# ${manifest.name}\n\n${manifest.brief}\n\n## Art direction\n\n${manifest.artDirection}\n`,
    ...(planFirst ? { "DESIGN.md": designSkeleton(manifest.name) } : {}),
    "AGENTS.md": `# Game Studio project

Build the game in BRIEF.md with Godot 4.7 (GDScript, Compatibility renderer). The engine project is godot/; game.json is the studio manifest. TEMPLATE.md describes the **${templateName}** starter you inherit: reuse what fits, restyle or replace the rest.${designLine}

## Steps

1. **Core loop first.** Make the main action playable, run game_godot_check until it reports zero errors, then game_export (target Web).
2. **Show the state.** Every value the brief names (score, lives, turn, laps, timer...) is on-screen text that updates when it changes, and lives in GameState when the template has one. Win and lose end on a result screen with the totals.
3. **Playtest and look.** Run game_web_playtest with steps that play the core loop, then open the screenshots it returns and look at them. It also reports GameState keys that are "not on screen".
4. **Check core play**: report broken or unreadable behaviour honestly. Do not start an open-ended repair loop. The server owns bounded review after your turn ends.
5. **Submit and end your turn.** When the core loop is playable, call game_submit with a one-line note on what the game is, then summarize with the game_preview URL. The studio reviews and repairs it; do not start your own improvement loop.

## Rules that prevent breakage

- Do engine work with the Game Studio tools: game_status, game_godot_import after asset or engine changes, game_godot_check, game_godot_test, game_export, game_web_playtest, game_submit, game_preview. Never run godot from the shell; those runs are not recorded.
- If the template ships scripts/studio_probe.gd, keep it and its autoload, and extend GameState instead of replacing it: the playtest reads both.
- Godot imports models only as GLB under godot/assets/models/. Make them with game_blender_run; .blend sources stay in art/blender/, never inside godot/.
- builds/ and godot/.godot/ are generated; do not edit them.
- If a tool is missing, tell the user to install it in Settings > General > Game tools.

Certification, not completion: game_godot_test runs tests/smoke_test.gd; game_scenarios_run replays godot/tests/scenarios/*.json. Missing reads as missing, not failed.
`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": "builds/\ngodot/.godot/\n*.blend1\n",
  };
}
