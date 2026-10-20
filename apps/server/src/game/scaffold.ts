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

How a run ends in success and in failure, and what retrying costs.

## Content

Levels, enemies and pickups, with counts and names. Say what the starter template
provides and what this game adds.

## Acceptance

The build is judged against these, not against a summary. Write a fenced block tagged
\`acceptance\` with 5 to 12 concrete criteria. Each needs a slug id, a kind (\`mechanic\`,
\`content\`, \`end\` or \`control\`), the promise in plain language, and optionally an
\`observe\` of a GameState autoload property (\`state\`, \`won\`, \`collected\`, \`total\`, \`score\`,
\`lives\`, \`health\`, \`level_index\`) using \`==V\`, \`>=N\`, \`<=N\` or \`changes\`. Cover every
control, the core mechanic, the content counts, how the game is won and how it is lost.
An \`end\` criterion should observe \`state\` reaching the won value (3 in both templates) or
\`won ==1\`.

\`\`\`acceptance
[
  { "id": "light-all-lanterns", "kind": "mechanic", "text": "Lighting every lantern opens the chimney", "observe": { "key": "collected", "expect": ">=1" } },
  { "id": "reach-the-summit", "kind": "end", "text": "The run ends at the summit spire", "observe": { "key": "state", "expect": "==3" } }
]
\`\`\`

## Art direction

Palette, shapes, materials and camera framing.

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
    return `${brief}\n\nRead AGENTS.md. Build a playable game, run a headless gameplay test, and finish with a working web preview using the Game Studio tools.`;
  return `${brief}\n\nRead AGENTS.md and TEMPLATE.md. Write this game's design in DESIGN.md: one page, concrete, and built on the ${templateName} template's existing systems — say what is reused and what is new. Keep the scaffold's section headings and fill each one; do not delete, rename or merge them. Fill the Acceptance section with 5 to 12 concrete criteria in the fenced acceptance block, covering every control, the core mechanic, the content counts, and how the game is won and lost. Do not build anything yet. When DESIGN.md is ready, ask me to review it on the Design tab.`;
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
  const manifest: GameManifest = {
    schemaVersion: 1,
    name: input.name.trim(),
    brief: input.brief,
    artDirection: input.artDirection ?? "",
    template,
    testSuite: templateEntry?.testSuite ?? DEFAULT_GAME_TEST_SUITE,
    ...(templateEntry?.gameplayScene === undefined
      ? {}
      : { gameplayScene: templateEntry.gameplayScene }),
    design: planFirst ? { status: "draft" } : { status: "approved" },
    engine: { name: "godot", version: "4.7.2" },
    godotProject: "godot",
    assets: [],
  };
  return {
    "game.json": JSON.stringify(manifest, null, 2) + "\n",
    "BRIEF.md": `# ${manifest.name}\n\n${manifest.brief}\n\n## Art direction\n\n${manifest.artDirection}\n`,
    ...(planFirst ? { "DESIGN.md": designSkeleton(manifest.name) } : {}),
    "AGENTS.md": `# Game Studio project

Build the game described in BRIEF.md. Use GDScript and Godot 4.7 Compatibility rendering. Keep scope focused on a playable core loop.

## Starter template

This game started from the **${templateName}** starter template. Read TEMPLATE.md at the project root first: it describes the scenes, systems, conventions and tests you inherit. Extend the template's systems instead of replacing them, and keep its tests passing.

## Design first

game.json's design section decides what this turn may do, but only the server's approval record can release the build. When the design is still a draft, this is a design turn: write or update DESIGN.md only. Keep the scaffold's section headings (Pitch, Core loop, Controls, Win & lose, Content, Acceptance, Art direction, Audio, Scope, Milestones) and replace every hint with a concrete decision; do not delete, rename or merge them. Make it one page and concrete, and ground it in the systems the starter template already has (read TEMPLATE.md); say what is reused and what is new. Fill Acceptance with 5 to 12 concrete criteria in the fenced acceptance block: each control, the core mechanic, content counts, and how the game is won and lost. Criteria carry a slug id, a kind (mechanic, content, end or control), plain text and optionally an observe of a GameState property. Do not create Blender assets, edit the Godot project, or start building while the design is a draft. End the turn by asking the creator to review it on the Design tab.

When the creator has approved the design, build to its milestones one at a time. The approved revision and its acceptance bind every build: implement every criterion, and never remove or weaken one silently. If scope has to change, update DESIGN.md and tell the creator it needs re-approval on the Design tab; staging stays locked until they approve the new revision.

## Layout

This root is the git repository. game.json is the studio manifest. The engine project is godot/. Editable Blender sources live in art/blender/, production scripts in art/scripts/, and thumbnails in art/previews/. Godot imports only GLB files under godot/assets/models/. builds/ and godot/.godot/ are ignored.

## Tools

Call game_status first for readiness, asset usage, scenes, builds and logs. If tools are missing, tell the user to install them in Settings > General > Game tools.

Use game_blender_run with a stable asset id and bpy script to create or revise an asset. The tool opens the existing .blend on revisions, runs your script, saves the source and script, exports GLB with modifiers, and renders a thumbnail unless disabled. For revisions, edit existing objects by name, or pass reset=true with a complete rebuild script to start from an empty scene at the same source/export paths. Re-running an object-creation script without reset duplicates objects. Keep the .blend sources. Re-export revisions to the same path so scene references remain valid. Do not put .blend files inside godot/.

Use game_godot_import after each asset transfer or engine change. Assemble scenes and GDScript files using your normal file tools. Fix every import and GDScript parse error. Use game_godot_check for a fast static and boot check: it loads every script and scene, runs the main scene and the scene game.json's gameplayScene names (the one the menu starts) for 120 physics frames each, and reports errors with file:line. It also fails a player in the \`player\` group that has no direct, enabled CollisionShape with a shape. Use game_scene_inspect to dump a scene's node tree when wiring is wrong.

Write a headless GDScript smoke test under godot/tests/ extending SceneTree. Simulate the core gameplay loop, assert observable outcomes, and quit with a nonzero exit code on failure. Run it with game_godot_test using a project-relative script path such as tests/smoke_test.gd. game.json's testSuite names the canonical suite (res://tests/smoke_test.gd); only a pass of that suite records the test stage that qualification reads, so other scripts are diagnostics and cannot qualify the game. A screenshot is not a gameplay test.

Write route files under godot/tests/scenarios/*.json that play the game from its main menu with normal input: press, hold and wait steps using actions from project.godot's InputMap. Routes are the server-owned exam; cover every level through to the win (collect every required item, reach the finish) under real physics. Run them with game_scenarios_run. It grades the approved DESIGN.md observations and records the state stage; no scenario, teleport or state setter can pass it. Keep routes as data; do not call game functions or set GameState from them.

Use game_export with target Web or Linux for real builds and real import/export errors. Use game_web_playtest for the final web check: it loads the real export in a headless browser, runs your steps, compares the boot and after-steps frames, and returns a verdict, screenshots, evidence and console errors. Use game_run_native for an interactive native run and game_stop to terminate only this game's managed processes and preview server. Each tool returns real output or an actionable error with a log path.

## Definition of done

During a design turn, done is a one-page DESIGN.md and the review request; the bar below applies to build turns.

Finish every build turn to this bar, then report to the user and end the turn:

1. game_godot_check returns ok with zero errors.
2. game_godot_test passes with your smoke test.
3. game_scenarios_run passes every observable acceptance criterion and at least one \`end\` criterion, with the player actually moving; every route starts from the menu and wins under normal input.
4. A web build exists for the final sources (game_web_playtest exports one when the build is stale).
5. game_web_playtest succeeds with steps that exercise the core loop and prove the game responded (responded=true). The templates ship a read-only StudioProbe, so the playtest must also see the player move or a GameState value change; keep the probe and extend GameState instead of replacing it.
6. game_status reports qualification "qualified": check, test, export, playtest and state all passed for the current sources. Any edit after a stage makes that stage stale, so rerun it; never edit game files after the final playtest.
7. game_preview returns the playable URL; report it with the test results.

Playtest screenshots and builds/playtests/ are your only visual check; never build custom browser, screenshot, or HTTP tooling. At most 3 export/playtest rounds for cosmetic fixes.
`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": "builds/\ngodot/.godot/\n*.blend1\n",
  };
}
