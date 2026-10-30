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

What the player does, and why it is fun, in two or three sentences. Start from the brief's own words and keep them verbatim in BRIEF.md; the wording and exclusions are ground truth. Reason from the requested feeling to as many fitting choices as the brief needs, noting fit, trade-offs and constraints, then the plain observable behavior. Name any technique plainly as a hypothesis, never as an extra requirement; selected fits may become acceptance promises, retrieved ideas stay optional.

## Core loop

The repeating 30 seconds: what the player does, what changes, and what pulls them forward. Tie each choice to this loop and cut anything outside it; suggestions never add systems. Selected fits may become acceptance promises; do not promote every retrieved idea.

## Controls

The player's actions and how to trigger them (keys, pointer or gamepad), including
movement or camera only when the game has them.

## Win & lose

How a run ends in success and in failure, and what retrying costs. A game without a win
or without an end says so here and writes only the endings it promises. If this game truly
has no lose state, say so here and write that promise in Acceptance as a \`lose\` criterion
with \`"noLoseState": true\` and no observe.

## Content

Levels, enemies and pickups, with counts and names. Say what the starter template
provides and what this game adds.

## Acceptance

The build is judged against these, not against a summary. Write a fenced block tagged
\`acceptance\` with 5 to 12 concrete criteria. Every criterion needs a slug id, a kind and the
promise in plain language. Split bundled claims: one behaviour per criterion (for example jump, coyote-time and input-buffer are three criteria, not one); a single \`jumps >= 1\` never proves timing. Except for \`presentation\` claims and a \`lose\` criterion marked
\`"noLoseState": true\`, each carries an \`observe\` of a GameState autoload property the
player changes
(\`state\`, \`won\`, \`collected\`, \`score\`, \`lives\`, \`health\`, \`level_index\`, \`jumps\`) using
\`==V\`, \`>=N\`, \`<=N\` or \`changes\`. The observed value has to be false when play starts and
become true later: observe what the player achieves, not a boot constant or a world total. Test the actual behaviour the text promises (a lit counter does not prove an illuminated surface; a jump count does not prove coyote or buffering): name the concrete subject and prove timing with its own observe and scenario route. A new named counter alone is not physical proof; it must move with the behaviour in its route. For grace windows, add an expired-window negative (a press after the window does nothing) and separate held input from fresh presses.
Content counts are proven by collecting or visiting them (\`collected >= 5\`), never by a world
total such as \`total == 5\`. A \`win\` observes the template's \`won\` flag (\`won == 1\`), not a
\`state\` enum value that pausing could also reach; a \`lose\` that ends a run observes the value
the run ends at (\`lives <= 0\`), not \`changes\`. \`presentation\` claims and a declared no-lose
criterion carry no observe. Review compares visible improvements but does not
certify every presentation claim.
The block needs at least one \`control\`, one \`mechanic\` and one \`lose\`: a real loss, or, when
the game has no losing state, a \`lose\` criterion with \`"noLoseState": true\` and no observe.
Cover every control and content count the game promises, and
add a \`win\` only when the game actually ends in one. Never invent an ending the game does
not have. A game with no player node marks play with a typed \`state\` (0/false before play,
another value once play starts), so the scenario runner and playtest can find the gameplay
baseline.

Examples (write 5 to 12 total for this game, not one of each; two per kind shown):
- control: \`{ "id": "jump", "kind": "control", "text": "Space jumps", "observe": { "key": "jumps", "expect": ">=1" } }\`
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
\`{ "id": "no-lose", "kind": "lose", "text": "A run never ends in failure", "noLoseState": true }\`
with no \`observe\`, and say so under "Win & lose".

\`\`\`acceptance
[
  { "id": "jump", "kind": "control", "text": "Space jumps", "observe": { "key": "jumps", "expect": ">=1" } },
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

Write a 3–5 step build plan before building, strongest first. Each step names the
acceptance ids it proves and the proof you will run (a scenario id, a \`game_verify\` route,
a Web export and real-input playtest, or a visible frame). Make step 1 the core playable
loop and get a first playable checkpoint early: export the Web build, record a real-input
browser playtest of those bytes, and \`game_submit\` as soon as it boots without console
errors and responds to input. The starter's smoke test and the game's scenario routes are
complete-acceptance proof, not a gate on that submit; run the full \`game_verify\` once
before the final submission (it refreshes scenarios for approved acceptance). Add content in the middle steps and presentation
last. A step that only restates a section is not a step.

1. **Playable core** — the loop above running end to end; proof is a Web export, a real-input playtest of those bytes, and a \`game_submit\` once it boots without console errors and responds to input.
2. **Content** — the levels, enemies, callers or cards the design needs, with proof.
3. **Polish** — art, audio and the states a player expects, then the full \`game_verify\` once before the final submission.
`;

/**
 * Whether the game's instruction stack is the minimal switch. Gated on the
 * explicit opt-in so the default path stays byte-identical.
 */
export const isMinimalBuilder = (input: Pick<GameCreateInput, "builder">): boolean =>
  input.builder === "minimal";

/** Reduced AGENTS.md for the minimal switch: no steps, milestones, recipes or budget. */
export const minimalAgentsDocument = (): string => `# Game Studio project

BRIEF.md describes the game to build. godot/ is the Godot 4.7 (GDScript, Compatibility) project.

Keep scripts/studio_probe.gd autoload; extend GameState.

Use game_check, game_export, game_web_playtest, game_verify, game_submit, game_art_search, game_art_import, game_art_frames, game_library_search, game_library_get, game_library_import_model and game_library_import_material to check, export and playtest the game.

When you are finished, run game_verify and game_submit once.
`;

/**
 * The first message of a game's thread. A reviewed design ends that turn at
 * DESIGN.md; otherwise the agent writes DESIGN.md and builds in the same turn.
 */
export function initialGamePrompt(input: GameCreateInput): string {
  if (isMinimalBuilder(input)) {
    const brief = `${input.brief}\n\nArt direction: ${input.artDirection ?? ""}`;
    return `${brief}\n\nBuild this game in Godot 4.7 in ./godot. Use the game_* tools to check, export and playtest the game. AGENTS.md lists the available tools. Nobody will answer questions.`;
  }
  const template = input.template ?? DEFAULT_GAME_TEMPLATE;
  const templateName = GAME_TEMPLATES.find((entry) => entry.id === template)?.name ?? template;
  const brief = `${input.brief}${input.artDirection ? `\n\nArt direction:\n${input.artDirection}` : ""}`;
  if (input.planFirst === false)
    return `${brief}\n\nRead AGENTS.md and TEMPLATE.md, then build the game by following AGENTS.md's steps. Keep the brief's words and exclusions verbatim as ground truth; reason from the requested feeling to as many fitting choices as the brief needs with trade-offs, propose techniques as hypotheses never as extra requirements, and prove timing with positive and expired-window checks. Selected fits may become acceptance promises; do not promote every retrieved idea.`;
  const next =
    input.reviewDesign === true
      ? "Do not build anything yet. When DESIGN.md is ready, ask me to review it on the Design tab."
      : "Nobody has to approve it: as soon as DESIGN.md is written, build the game in this same turn by following AGENTS.md's steps.";
  return `${brief}\n\nRead AGENTS.md and TEMPLATE.md. Write this game's design in DESIGN.md: one page, concrete, and built on the ${templateName} template's existing systems — say what is reused, adapted or cut for this design and what is new. Keep the scaffold's section headings and fill each one; do not delete, rename or merge them. Make Art direction specific to this game's brief; the starter's look is a placeholder, not a requirement. Reason from the brief's player experience to as many fitting choices as the brief needs with fit, trade-offs and constraints; keep the brief verbatim as ground truth, explain behaviour plainly, and tie each choice to observable behaviour including negative controls where timing or state matters. Favour plain behaviour and causal proof over jargon or proxy counters. Recipe suggestions are proposals, never extra requirements or overrides of the brief's exclusions; selected fits may become explicit acceptance promises, retrieved ideas stay optional. In Milestones, write a 3–5 step build plan: each step names the acceptance ids it proves and the proof you will run; make the core loop playable first and get a first playable checkpoint early by exporting the Web build, recording a real-input browser playtest of that export, and submitting once it boots without console errors and responds to input. Then add content and presentation. Run the full game_verify once for complete acceptance before the final submit, not before the first playable (it refreshes scenarios for approved acceptance). Preserve alternatives and optional actions from the creator's brief; do not turn them into extra acceptance requirements. Fill the Acceptance section with 5 to 12 concrete criteria in the fenced acceptance block: at least one control, one mechanic and one lose — a real loss, or, when the game has no losing state, a \`lose\` criterion with "noLoseState": true and no observe — covering every control and content count; add a win only when the game actually ends in one and never invent an ending the game does not have. Every control/mechanic/content/win/lose criterion needs an observe of a GameState property the player changes after play starts, except a declared no-lose criterion, which carries no observe; content counts are proven by collecting (collected >= N), not a world total, and a win observes the template's won flag (won == 1), a real loss the value a losing run ends at (lives <= 0), never "changes". Presentation claims carry no observe. ${next}`;
}

/** The manifest a new game starts from; the creation record also reads its probe flag. */
export function scaffoldManifest(input: GameCreateInput): GameManifest {
  const minimal = isMinimalBuilder(input);
  const template = minimal ? "blank" : (input.template ?? DEFAULT_GAME_TEMPLATE);
  const templateEntry = GAME_TEMPLATES.find((entry) => entry.id === template);
  const planFirst = minimal ? false : input.planFirst !== false;
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
  const minimal = isMinimalBuilder(input);
  const template = minimal ? "blank" : (input.template ?? DEFAULT_GAME_TEMPLATE);
  const templateEntry = GAME_TEMPLATES.find((entry) => entry.id === template);
  const templateName = templateEntry?.name ?? template;
  const planFirst = minimal ? false : input.planFirst !== false;
  const designLine = !planFirst
    ? ""
    : input.reviewDesign === true
      ? "\n\nDESIGN.md is your plan. Keep its section headings. Scope changes need the creator to re-approve them on the Design tab."
      : "\n\nDESIGN.md is your plan. Keep its section headings and update it when scope changes; nobody has to approve it.";
  const manifest = scaffoldManifest(input);
  if (minimal)
    return {
      "game.json": JSON.stringify(manifest, null, 2) + "\n",
      "BRIEF.md": `# ${manifest.name}\n\n${manifest.brief}\n\n## Art direction\n\n${manifest.artDirection}\n`,
      "AGENTS.md": minimalAgentsDocument(),
      "CLAUDE.md": "@AGENTS.md\n",
      ".gitignore": "builds/\ngodot/.godot/\n*.blend1\n",
    };
  return {
    "game.json": JSON.stringify(manifest, null, 2) + "\n",
    "BRIEF.md": `# ${manifest.name}\n\n${manifest.brief}\n\n## Art direction\n\n${manifest.artDirection}\n`,
    ...(planFirst ? { "DESIGN.md": designSkeleton(manifest.name) } : {}),
    "AGENTS.md": `# Game Studio project

Build BRIEF.md's game in Godot 4.7 (GDScript, Compatibility). godot/ is the project. TEMPLATE.md describes the **${templateName}** starter: reuse what fits, restyle or replace the rest.${designLine}

## Steps

1. **Recipes first.** game_recipe_search the brief; game_recipe_get and adapt. Use as many recipes as the brief needs, or none. Keep the brief verbatim; promote only selected fits to acceptance.
2. **Playable core.** Follow DESIGN.md's plan. game_check, game_export Web, real-input game_web_playtest, then game_submit once controls work without console errors: first playable checkpoint, not the end.
3. **Show state.** Keep brief values visible in GameState. Do not invent endings or counters.
4. **Produce.** game_status shows the production budget. Deepen content, feedback, presentation. Use game_try_input. game_verify each iteration; submit improvements. Refusal preserves the live build and identifies the failed check.
5. **Complete acceptance.** Before final submit, adapt harness and routes to DESIGN.md keeping meaningful coverage; game_verify refreshes approved scenarios. game_scenarios_run is diagnosis only. Inspect frames. game_web_playtest exactSize:true adds window-shape evidence. Submit the verified build.
6. **Finish.** Passing game_verify means the game works, not that it is good; spend the rest of the budget on look, sound and play. End when the budget expires or the brief is realised. Review starts on the last accepted submit; do not start another repair loop.

A focused request is not a redesign; preserve working features. Never claim a check you did not run.

## Rules

- Use game_* tools, not shell Godot. game_godot_api gives engine APIs. Neutral names preferred, game_godot_* aliased. Keep scripts/studio_probe.gd autoload; extend GameState.
- Use game_art_search/game_art_import for 2D kits; game_art_frames builds animations.
- game_library_search/get finds CC0 models/materials for game_library_import_model/material. Check style, scale, triangles, size; share materials and retain credit.
- game_blender_run makes custom models: keep art/blender sources and godot/assets/models/*.glb. Share artProfile; inspect the contact sheet. Scale warnings do not judge visual quality. Pass model/texture inputs as ASSET_INPUTS[name]; names record sources, never prove use.
- builds/ and godot/.godot/ are generated. Missing tools: Settings > General > Game tools.

Certification: game_verify (scenarios included when approved).
`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": "builds/\ngodot/.godot/\n*.blend1\n",
  };
}
