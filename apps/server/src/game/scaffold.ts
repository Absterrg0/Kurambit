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
\`presentation\` claims carry no observe because the visual stage owns them, and that stage
is not implemented yet.
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
 * The first message of a game's thread. A plan-first game spends that turn on
 * DESIGN.md; a skip-planning game goes straight to today's build prompt.
 */
export function initialGamePrompt(input: GameCreateInput): string {
  const template = input.template ?? DEFAULT_GAME_TEMPLATE;
  const templateName = GAME_TEMPLATES.find((entry) => entry.id === template)?.name ?? template;
  const brief = `${input.brief}${input.artDirection ? `\n\nArt direction:\n${input.artDirection}` : ""}`;
  if (input.planFirst === false)
    return `${brief}\n\nRead AGENTS.md. Restyle through the template's presentation kit first (TEMPLATE.md, "Presentation kit"). Build a playable game, run a headless gameplay test, and finish with a working web preview using the Game Studio tools.`;
  return `${brief}\n\nRead AGENTS.md and TEMPLATE.md. Write this game's design in DESIGN.md: one page, concrete, and built on the ${templateName} template's existing systems — say what is reused and what is new. Keep the scaffold's section headings and fill each one; do not delete, rename or merge them. In Art direction, give the six palette roles as hex values with their jobs (background, playfield, player, hazard, pickup, goal), say which value is darkest and which is brightest, and name the goal landmark: how it reads from a distance and how the player first sees it. Fill the Acceptance section with 5 to 12 concrete criteria in the fenced acceptance block: at least one control, one mechanic, one win and one lose, covering every control and content count. Every control/mechanic/content/win/lose criterion needs an observe of a GameState property the player changes after play starts; content counts are proven by collecting (collected >= N), not a world total, and a win observes the template's won flag (won == 1, lives <= 0 for a loss), never "changes". Presentation claims carry no observe. Do not build anything yet. When DESIGN.md is ready, ask me to review it on the Design tab.`;
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
  const manifest = scaffoldManifest(input);
  return {
    "game.json": JSON.stringify(manifest, null, 2) + "\n",
    "BRIEF.md": `# ${manifest.name}\n\n${manifest.brief}\n\n## Art direction\n\n${manifest.artDirection}\n`,
    ...(planFirst ? { "DESIGN.md": designSkeleton(manifest.name) } : {}),
    "AGENTS.md": `# Game Studio project

Build the game described in BRIEF.md. Use GDScript and Godot 4.7 Compatibility rendering. Keep scope focused on a playable core loop.

## Starter template

This game started from the **${templateName}** starter template. Read TEMPLATE.md at the project root first: it describes the scenes, systems, conventions and tests you inherit. Extend the template's systems instead of replacing them, and keep its tests passing.

## Presentation

The starter template ships a tested presentation kit and a value hierarchy. Restyle through that kit first: change the palette roles and the shared material parameters, keep the value order (background darkest, playfield mid, player, hazards, pickups and goal brightest), and keep the templates' silhouettes and goal landmark. Add new art in the same roles; do not repaint the game with ad-hoc colour literals or a second look. Read the template's "Presentation kit" and "Level layout recipe" before building levels: teach a mechanic safely, vary it, then test it, and keep the goal or a signpost visible early.

## Design first

game.json's design section decides what this turn may do, but only the server's approval record can release the build. When the design is still a draft, this is a design turn: write or update DESIGN.md only. Keep the scaffold's section headings (Pitch, Core loop, Controls, Win & lose, Content, Acceptance, Art direction, Audio, Scope, Milestones) and replace every hint with a concrete decision; do not delete, rename or merge them. Make it one page and concrete, and ground it in the systems the starter template already has (read TEMPLATE.md); say what is reused and what is new. Fill Acceptance with 5 to 12 concrete criteria in the fenced acceptance block: at least one control, one mechanic, one win and one lose, plus every control and content count the game promises. Criteria carry a slug id, a kind (control, mechanic, content, win, lose or presentation), plain text and (except presentation) an observe of a GameState property the player changes after play starts. Observe what the player achieves, not a boot constant: content counts are proven with collected >= N rather than total == N, and a win observes the template's won flag (won == 1) while a loss observes the value a losing run ends at (lives <= 0), never changes. Do not create Blender assets, edit the Godot project, or start building while the design is a draft. End the turn by asking the creator to review it on the Design tab.

When the creator has approved the design, build to its milestones one at a time. The approved revision and its acceptance bind every build: implement every criterion, and never remove or weaken one silently. If scope has to change, update DESIGN.md and tell the creator it needs re-approval on the Design tab; staging stays locked until they approve the new revision.

Chat messages stay free-form: small fixes, copy, tuning questions and reporting need no contract. But when a chat request adds or changes a mechanic, a control or a piece of scope, the approved design no longer describes the game: update DESIGN.md to describe the change and adjust its acceptance criteria to prove it (keep every existing criterion unless the request removes that feature — if it does, say so under a "Removed:" line naming the criterion id), then end your turn and ask the creator to approve the revision on the Design tab. Never build a scope change from chat alone; the server locks staging until the revision is approved, and a silent change leaves the approval record untouched. When the creator sends a change request, that turn rewrites DESIGN.md only: end the turn for review, and wait for the approval that tells you to implement it.

## Layout

This root is the git repository. game.json is the studio manifest. The engine project is godot/. Editable Blender sources live in art/blender/, production scripts in art/scripts/, and thumbnails in art/previews/. Godot imports only GLB files under godot/assets/models/. builds/ and godot/.godot/ are ignored.

## Tools

Call game_status first for readiness, asset usage, scenes, builds and logs. If tools are missing, tell the user to install them in Settings > General > Game tools.

Use game_blender_run with a stable asset id and bpy script to create or revise an asset. The tool opens the existing .blend on revisions, runs your script, saves the source and script, exports GLB with modifiers, and renders a thumbnail unless disabled. For revisions, edit existing objects by name, or pass reset=true with a complete rebuild script to start from an empty scene at the same source/export paths. Re-running an object-creation script without reset duplicates objects. Keep the .blend sources. Re-export revisions to the same path so scene references remain valid. Do not put .blend files inside godot/.

Use game_godot_import after each asset transfer or engine change. Assemble scenes and GDScript files using your normal file tools. Fix every import and GDScript parse error. Use game_godot_check for a fast static and boot check: it loads every script and scene, runs the main scene and the gameplay scene named by the game's verification policy (game.json mirrors it) for 120 physics frames each, and reports errors with file:line. It also fails a player in the \`player\` group that has no direct, enabled CollisionShape with a shape. Use game_scene_inspect to dump a scene's node tree when wiring is wrong.

Write a headless GDScript smoke test under godot/tests/ extending SceneTree. Simulate the core gameplay loop, assert observable outcomes, and quit with a nonzero exit code on failure. Run it with game_godot_test using a project-relative script path such as tests/smoke_test.gd. The game's server-owned verification policy names the canonical suite (res://tests/smoke_test.gd; game.json mirrors it, editing it does not change the policy); only a pass of that suite records the test stage that qualification reads, so other scripts are diagnostics and cannot qualify the game. A screenshot is not a gameplay test.

Write route files under godot/tests/scenarios/*.json that play the game from its main menu with normal input: press, hold and wait steps using actions from project.godot's InputMap. Routes are the server-owned exam; cover every level through to the win (collect every required item, reach the finish) under real physics, and add a second route that loses the run through normal input (hazards or falls) so the lose criterion is proven. Run them with game_scenarios_run. It grades the approved DESIGN.md observations from the first sample after the route's first input, so a value already true at play start or a wait-only route proves nothing, and records the state stage with coverage per kind; no scenario, teleport or state setter can pass it. Keep routes as data; do not call game functions or set GameState from them.

Use game_export with target Web or Linux for real builds and real import/export errors. Use game_web_playtest for the final web check: it loads the real export in a headless browser, runs your steps, compares the boot and after-steps frames, and returns a verdict, screenshots, evidence and console errors. Give the run screenshot steps at the core interaction, at one hazard hit that costs health or a life without ending the run (the frame shows the telegraph and the feedback, and the probe's health or lives value drops), and at the finish; the independent visual judge reads those frames and cannot pass a game with a lose criterion on frames that never show the hazard or the end. A design that declares "No lose state" has no hazard hit to show. Use game_run_native for an interactive native run and game_stop to terminate only this game's managed processes and preview server. Each tool returns real output or an actionable error with a log path.

## Visual review and repair

After a playtest that qualifies mechanically, the server sends the run's frames to an independent visual judge. Its result lists a 0–4 score per dimension and, when it fails, at most three repair requests naming the frame to fix. Follow them literally: change only what the requests name, through the template's palette roles and presentation kit or the camera, then run game_export and game_web_playtest once more and stop. You get one repair round per approved design revision. If the second review still fails, or the result says no rounds are left, report the scores and the remaining problems to the creator instead of restyling on your own judgement.

## Definition of done

During a design turn, done is a one-page DESIGN.md and the review request; the bar below applies to build turns.

Finish every build turn to this bar, then report to the user and end the turn:

1. game_godot_check returns ok with zero errors.
2. game_godot_test passes with your smoke test.
3. game_scenarios_run passes every control, mechanic, content, win and lose criterion after play starts, with the player actually moving; one route starts from the menu and wins under normal input, and a second route loses the run through normal input (hazards or falls) so the lose criterion is proven. A value that is already true when the route starts proves nothing; presentation criteria are graded by the visual stage, not by a scenario.
4. A web build exists for the final sources (game_web_playtest exports one when the build is stale).
5. game_web_playtest succeeds with steps that exercise the core loop and prove the game responded (responded=true). The templates ship a read-only StudioProbe, so the playtest must also see the player move or a GameState value change; keep the probe and extend GameState instead of replacing it. Deleting scripts/studio_probe.gd or its autoload entry fails the playtest stage outright for a template game.
6. game_status reports qualification "qualified": check, test, export, playtest, state and visual all passed for the current sources. A failed visual result comes with at most three repair requests; fix only those, re-run the export and one playtest, and stop after that round. Any edit after a stage makes that stage stale, so rerun it; never edit game files after the final playtest.
7. game_preview returns the playable URL; report it with the test results.

Playtest screenshots and builds/playtests/ are your only visual check; never build custom browser, screenshot, or HTTP tooling. At most 3 export/playtest rounds for cosmetic fixes.
`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": "builds/\ngodot/.godot/\n*.blend1\n",
  };
}
