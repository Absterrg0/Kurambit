import {
  DEFAULT_GAME_TEMPLATE,
  GAME_TEMPLATES,
  type GameCreateInput,
  type GameManifest,
} from "@t3tools/contracts";

/**
 * Files the studio owns for every game. The starter template supplies the
 * `godot/` tree and TEMPLATE.md; see templates.ts.
 */
export function scaffoldFiles(input: GameCreateInput): Record<string, string> {
  const template = input.template ?? DEFAULT_GAME_TEMPLATE;
  const templateName = GAME_TEMPLATES.find((entry) => entry.id === template)?.name ?? template;
  const manifest: GameManifest = {
    schemaVersion: 1,
    name: input.name.trim(),
    brief: input.brief,
    artDirection: input.artDirection ?? "",
    template,
    engine: { name: "godot", version: "4.7.2" },
    godotProject: "godot",
    assets: [],
  };
  return {
    "game.json": JSON.stringify(manifest, null, 2) + "\n",
    "BRIEF.md": `# ${manifest.name}\n\n${manifest.brief}\n\n## Art direction\n\n${manifest.artDirection}\n`,
    "AGENTS.md": `# Game Studio project

Build the game described in BRIEF.md. Use GDScript and Godot 4.7 Compatibility rendering. Keep scope focused on a playable core loop.

## Starter template

This game started from the **${templateName}** starter template. Read TEMPLATE.md at the project root first: it describes the scenes, systems, conventions and tests you inherit. Extend the template's systems instead of replacing them, and keep its tests passing.

## Layout

This root is the git repository. game.json is the studio manifest. The engine project is godot/. Editable Blender sources live in art/blender/, production scripts in art/scripts/, and thumbnails in art/previews/. Godot imports only GLB files under godot/assets/models/. builds/ and godot/.godot/ are ignored.

## Tools

Call game_status first for readiness, asset usage, scenes, builds and logs. If tools are missing, tell the user to install them in Settings > General > Game tools.

Use game_blender_run with a stable asset id and bpy script to create or revise an asset. The tool opens the existing .blend on revisions, runs your script, saves the source and script, exports GLB with modifiers, and renders a thumbnail unless disabled. For revisions, edit existing objects by name, or pass reset=true with a complete rebuild script to start from an empty scene at the same source/export paths. Re-running an object-creation script without reset duplicates objects. Keep the .blend sources. Re-export revisions to the same path so scene references remain valid. Do not put .blend files inside godot/.

Use game_godot_import after each asset transfer or engine change. Fix every import and GDScript parse error. Assemble scenes and GDScript files using your normal file tools.

Write a headless GDScript smoke test under godot/tests/ extending SceneTree. Simulate the core gameplay loop, assert observable outcomes, and quit with a nonzero exit code on failure. Run it with game_godot_test using a project-relative script path such as tests/smoke_test.gd. A screenshot is not a gameplay test.

Use game_export with target Web or Linux for real builds and real import/export errors. Use game_web_playtest for the final web check: it loads the real export in a headless browser and returns screenshots and console errors. Use game_run_native for an interactive native run and game_stop to terminate only this game's managed processes and preview server. Each tool returns real output or an actionable error with a log path.

## Definition of done

Finish every turn to this bar, then report to the user and end the turn:

1. game_godot_test passes with your smoke test.
2. game_web_playtest boots without console errors, and its after-steps screenshot shows the game responding to your steps.
3. game_preview returns the playable URL; report it with the test results.

Playtest screenshots are your only visual check; never build custom browser, screenshot, or HTTP tooling. At most 3 export/playtest rounds for cosmetic fixes.
`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": "builds/\ngodot/.godot/\n*.blend1\n",
  };
}
