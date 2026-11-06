import {
  GAME_TEMPLATES,
  gameTemplateForEngine,
  type GameCreateInput,
  type GameEngineId,
  type GameManifest,
  type GameStageKind,
} from "@kurambit/contracts";
import { engineProfile } from "./engineProfile.ts";
import { CHECK_BOT_DIR } from "./run/checkRunner.ts";

// Run notes and reports are harness output, never game content: ignoring them
// keeps the tree clean so build swaps never need a stash (T28 wedged on a
// half-applied stash pop). The list keeps the files earlier runs wrote
// (run.json, rounds.jsonl, stop, steer, profile, run.log), so an older game's leftovers
// never ride in a commit.
export const RUN_STATE_IGNORES = [
  ".studio/run.json",
  ".studio/rounds.jsonl",
  ".studio/stop",
  ".studio/steer.jsonl",
  ".studio/profile",
  ".studio/run.log",
  ".studio/bot-results.jsonl",
  ".studio/player-report.md",
  ".studio/pick.txt",
  ".studio/next.md",
  ".studio/ship.md",
  ".studio/art-review.md",
  ".studio/ladder.json",
  `${CHECK_BOT_DIR}/`,
  ".studio/rung-change.json",
  ".studio/exports.json",
  ".studio/final-video.json",
  ".studio/tester-*.md",
  ".studio/reviewer-*.md",
  ".studio/worktrees/",
  ".studio/comparisons/",
  ".studio/saves/",
  // The creator's saved videos and images (gameSavedMedia.ts).
  "saved/",
  ".studio/play-*.md",
  ".studio/proto-*.md",
  ".studio/proto-*-frames.jpg",
  ".studio/round-state.json",
  "PICK-NOTES.md",
  "JUDGE-NOTES.md",
] as const;

/** What every engine generates in the game folder, beside the run's own files. */
const GENERATED_IGNORES = [
  "builds/",
  "godot/.godot/",
  "unity/[Ll]ibrary/",
  "unity/[Tt]emp/",
  "unity/[Ll]ogs/",
  "unity/[Uu]ser[Ss]ettings/",
  "unity/[Oo]bj/",
  "unity/*.csproj",
  "unity/*.sln",
  "*.blend1",
];

/** The engine a create request builds for. Omitted means the Godot native lane. */
export const createEngine = (input: GameCreateInput): GameEngineId => input.engine ?? "godot";

/** The manifest a new game starts from; the template names the gameplay scene. */
export function scaffoldManifest(input: GameCreateInput): GameManifest {
  const engine = createEngine(input);
  const template = gameTemplateForEngine(engine);
  const templateEntry = GAME_TEMPLATES.find((entry) => entry.id === template);
  return {
    schemaVersion: 1,
    name: input.name.trim(),
    brief: input.brief,
    artDirection: input.artDirection ?? "",
    template,
    ...(templateEntry?.gameplayScene === undefined
      ? {}
      : { gameplayScene: templateEntry.gameplayScene }),
    ...(templateEntry?.probe === true ? { probe: true } : {}),
    engine: { name: engine, version: engineProfile(engine).scaffold.version },
    project: engineProfile(engine).projectDirectory,
    // The same folder under its legacy key, for one release, so an older installed Kurambit still opens the game.
    godotProject: engineProfile(engine).projectDirectory,
    assets: [],
  };
}

/**
 * The creator's own session and a live production run share this folder; the
 * run's builder edits it and the run restores builds into it, which would
 * overwrite the session's edits.
 */
export const CREATOR_HEADING = "## The creator's session and the production run";
export const CREATOR_SESSION_SECTION = `${CREATOR_HEADING}

This section is for the creator's own session on this game. A session the production run launched for one of its roles follows its prompt instead.

A production run may be working on this game; game_run_status says whether one is live and what it is doing. While one is live, do not edit the game's files: the run is changing them and restores its builds into the folder, which would overwrite your edits. Pass the creator's requests to the run with game_run_steer and tell them the run's next round takes it up. When no run is live, work on the game directly as usual. A run ends once its ladder is done and the ship check has played the game; it does not polish on its own. When the creator wants the run to polish something, pass their request with game_run_steer: the run comes back for one round on it, then stops.

A run is Guided or on Autopilot. A Guided run asks the creator at its decision points (the vision's look, which prototype to keep, the ladder of what to build) by sending a message to this chat. When one arrives, read the decision with game_run_status and present it:

- Show the evidence as a visual reply: an HTML render with the images by their local paths (key art, each prototype's frame sheet), and the pitches or the ladder as short text.
- Say in a few plain lines what differs or what to look at; no jargon about the run.
- Ask, and invite an answer in the creator's own words. They may combine ("the first one's movement with the second one's camera"), change things, or let the run decide.
- Say what the run does by itself if nobody answers, and when (game_run_status gives the time).

Record the answer with game_run_decide: choose the answer that fits what they said and put their words in notes. A refused answer comes back with the reason; fix it and call again. Do not answer for the creator; if nobody answers, the run takes its default by itself.

The creator can ask at any time to start or resume the run (game_run_start), stop it (game_run_stop), switch it between Guided and Autopilot (game_run_profile), steer it (game_run_steer) or put the game back to a kept round (game_run_restore).
`;

const EVERY_TURN_HEADING = "## Every turn";

const PLAYTEST_LINE =
  "- Do not play-test with `game_explore_*` or bots to see whether the game works: the harness measures every build. Explore only when the person asks or a fact says something you cannot see in the code. Read `game_facts` when the person reports a problem.";
const UNDO_LINE =
  "- The person can undo any turn. When files you wrote are back to an earlier state, they undid it on purpose (`game_builds` shows the restore). Do not put the change back unless they ask.";

/**
 * How a chat turn ends where Kurambit plays and measures every turn's build
 * (engineProfile turnLoop), by how the Stage shows the game; the other
 * engines' agents keep checking their own work.
 */
const EVERY_TURN_SECTIONS: Partial<Record<GameStageKind, string>> = {
  // The Stage serves the folder and reloads it on every save (GamePreview.live).
  live: `## Every turn

- **One visible change per turn.** The person watches your work live: Kurambit serves the game folder on their Stage and reloads it each time you save. A turn is one change they can see when they play, about five minutes of work, \`game_check\` clean, then end the turn. If the request needs more, do the first visible part and put the rest in \`Next:\`.
- **Keep the game booting between saves.** Every save reloads the person's game. Write a new module before the line that imports it, and keep \`main.js\` loadable at each save. A save that breaks the page shows the person the error.
${PLAYTEST_LINE}
${UNDO_LINE}
- **End every reply with one line,** \`Next: <the one change that would most improve this game>\`, or \`Next: none\` when the brief is done. The person can send your \`Next:\` with one click, so make it a request they could have typed: one change, in their words, not a plan.
`,
  // The Stage plays a Web export the turn loop rebuilds when the turn ends.
  export: `## Every turn

- A turn that changes the game becomes a build. When your turn ends, Kurambit plays it on the person's Stage and measures its facts: whether it boots, an idle, a random and a skilled bot, frozen frames, input response. Ending the turn is how the person sees your work, so keep turns short: one visible improvement, \`game_check\` clean, then end. Do not export to show it; the build is made for you.
${PLAYTEST_LINE}
${UNDO_LINE}
- End every reply with one line: \`Next: <the one change that would most improve this game>\`, or \`Next: none\` when the brief is done.
`,
};
const everyTurnSection = (engine: GameEngineId): string | undefined => {
  const profile = engineProfile(engine);
  return profile.turnLoop ? EVERY_TURN_SECTIONS[profile.stage] : undefined;
};

/** A new game's first turn, per engine; an engine without one gets the brief alone. */
const FIRST_TURN_SECTIONS: Partial<Record<GameEngineId, string>> = {
  three: `## The first turn

Goal: the person plays the brief's core loop on the Stage within ten minutes, with library art, not primitives.

1. Read \`BRIEF.md\`, the "Shortest path" in \`TEMPLATE.md\` and the recipe for your view in \`studio-skills/three.md\`. Write no plan or design document, make no key art, and do not open Blender. The comment block at the top of each kit is enough; do not read the shell's code.
2. Choose the look: \`game_assets_search\` with no words lists the library by style family. Pick one that fits the brief and write \`STYLE.json\` (family, view, packs, rig; \`studio-skills/art-pipeline.md\`). Add the player character and one or two threats or props with \`game_assets_add\`, and name them in \`ASSETS\`: the shell loads them, and compiles what draws them, behind its loading screen. Keep the default look (\`LOOK\` as it is, no lights besides \`ctx.look.sun\`): builds are played in a software renderer, where bloom and extra lights stall the start. Glows are a later turn. When no pack has the brief's exact subject, take the closest character and say so in your reply; a model of its own is a later turn.
3. Replace the starter's gameplay in \`web/main.js\` (its sphere and beacon are placeholders) with the brief's core loop: the player moves (the recipe), the one main verb, the threat, a win and a lose through \`GameState.win\` and \`lose\`, the HUD through \`ctx.ui\`, and \`Juice\` on every action.
4. Run \`game_check\` and fix until it is clean. The person has watched the starter turn into your game; end the turn as soon as the core loop plays. End it with what the person can do now, plus your \`Next:\` line.

More waves and levels, menu art, music and polish are later turns.
`,
};

/**
 * An existing game's AGENTS.md with its engine's "Every turn" section, added
 * once before the creator section, so a game made before the turn loop learns
 * that its turns are played and can be undone. Pure; unchanged when present.
 */
export const withEveryTurn = (agents: string, engine: GameEngineId): string => {
  const section = everyTurnSection(engine);
  if (section === undefined || agents.includes(EVERY_TURN_HEADING)) return agents;
  const at = agents.indexOf(CREATOR_HEADING);
  if (at < 0) return `${agents.trimEnd()}\n\n${section}`;
  return `${agents.slice(0, at)}${section}\n${agents.slice(at)}`;
};

/**
 * The game chat's first message: the brief, sent as the person's own, so they
 * see exactly what the agent was told. It names AGENTS.md because some
 * providers (Grok, Antigravity) do not load it by themselves.
 */
export const firstTurnMessage = (manifest: GameManifest): string => {
  const lead =
    FIRST_TURN_SECTIONS[manifest.engine.name] === undefined
      ? "Make this game. Read AGENTS.md first."
      : 'Make this game. Follow "The first turn" in AGENTS.md.';
  const art = manifest.artDirection.trim();
  return `${lead}\n\n${manifest.brief.trim()}${art === "" ? "" : `\n\nArt direction: ${art}`}`;
};

/**
 * Files the studio owns for every game. The starter template's project tree
 * supplies the engine sources; see templates.ts.
 */
export function scaffoldFiles(input: GameCreateInput): Record<string, string> {
  const manifest = scaffoldManifest(input);
  const engine = createEngine(input);
  const projectLine =
    engine === "unity"
      ? `# Kurambit project

Build BRIEF.md's game in Unity 6 (C#, Input System). unity/ is the project inside a demo shell (TEMPLATE.md): gameplay goes in unity/Assets/Scenes/Game.unity, built by unity/Assets/Editor/BuildGame.cs, game code in unity/Assets/Scripts; unity/Assets/Kurambit stays as shipped.

Use the game_* tools to check, play, export and package the game, and the game_unity_* tools to edit scenes in the live editor; never run Unity yourself. Keep builds/ and unity/Library, Temp, Logs, UserSettings generated.
`
      : engine === "three"
        ? `# Kurambit project

Build BRIEF.md's game with three.js (vendored in web/vendor, no install step). web/ is the static project: web/index.html, web/main.js, web/style.css, web/assets for every visual and sound. A new game's first turn follows "The first turn" below.

Use the game_* tools to check, play, export and package the game; never launch your own browser. Keep builds/ generated.
`
        : `# Kurambit project

Build BRIEF.md's game in Godot 4.7 (GDScript; Forward+ natively, Compatibility on Web). godot/ is the project.

Use the game_* tools to check, play, export and package the game; never run Godot yourself. Keep builds/ and godot/.godot/ generated.
`;
  return {
    "game.json": JSON.stringify(manifest, null, 2) + "\n",
    "BRIEF.md": `# ${manifest.name}\n\n${manifest.brief}\n\n## Art direction\n\n${manifest.artDirection}\n`,
    "AGENTS.md": [
      projectLine,
      everyTurnSection(engine),
      FIRST_TURN_SECTIONS[engine],
      CREATOR_SESSION_SECTION,
    ]
      .filter((section) => section !== undefined)
      .join("\n"),
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": `${[...GENERATED_IGNORES, ...RUN_STATE_IGNORES].join("\n")}\n`,
  };
}
