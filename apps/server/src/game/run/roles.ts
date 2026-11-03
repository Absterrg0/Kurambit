// Every prompt the loop sends, built from facts. About 150 words of rules; names no game,
// genre or mechanic. Builders write; the harness plays.
import { GAME_EXPLORE_BOUNDS } from "@kurambit/contracts";

// Role threads have no local engine binaries and must never look for any:
// the game_* MCP tools are the only way to check, play, export, bot-test or model.
// The game's AGENTS.md also speaks to the creator's own session; a role follows its prompt.
const TOOL_RULE =
  "You are one role in this game's production run; where AGENTS.md says otherwise, follow this prompt. You have no local Godot, Blender or Unity binaries and must never look for any. Check, play, export, bot-test and model ONLY with the game_* MCP tools (game_check, game_explore_start/act/close, game_bot_run, game_bot_view, game_export, game_blender_*, game_unity_* in a Unity game, game_assets_*, game_status). ";
const SKILL_LINE = "Read the skill files in ./studio-skills first and follow them. ";
const PLAYTEST_LINE = "Read ./studio-skills/playtest.md before you play. ";
const B = GAME_EXPLORE_BOUNDS;
const CALL_S = B.maxSequenceMsPerCall / 1000;
const SESSION_S = B.maxTotalNominalMs / 1000;
/** Each blind player's in-game input across all its sessions; more voids the sample. */
export const SAMPLE_INPUT_MS = 120_000;
const SAMPLE_S = SAMPLE_INPUT_MS / 1000;
const SAMPLE_SESSIONS = Math.ceil(SAMPLE_INPUT_MS / B.maxTotalNominalMs);
// Slow models spend ~10 s per call, so one short step per call reaches only the opening.
// Every number here is a bound the explore service rejects past.
const BATCH = `Batch your input: a session allows ${B.maxCalls} game_explore_act calls, ${B.maxTotalSteps} steps and ${SESSION_S} seconds of input, so one short step per call runs out of calls long before input. Learn a control's response with one short hold, then send 2-3 held steps per call (keys for combinations), at most ${CALL_S} seconds of input per call in total and at most ${B.maxStepsPerCall} steps. Study the frame after each batch. `;
const PLAYBOOK = `${TOOL_RULE}Play first with the game_explore_* tools (default target) and study every frame. The code says what should happen, playing shows what does, and playing wins. ${BATCH}`;

/** Where a lane's art lives, as a game-relative path: Unity imports only what sits under Assets/. */
export const laneAssets = (lane: string): string =>
  lane === "unity" ? "unity/Assets" : `${lane}/assets`;

/** Where library packs land under the lane's asset dir. */
export const laneLibrary = (lane: string): string =>
  `${laneAssets(lane)}/${lane === "unity" ? "Library" : "library"}`;

/** Bot runs play Godot and three.js games; Unity games are played through explore only. */
export const laneBots = (lane: string): boolean => lane !== "unity";

export const CONTINUE = "Continue where you left off. Reply briefly, then keep working.";

const buildRule = (lane: string) =>
  `${TOOL_RULE}Make the smallest change that fixes this block's named top flaw. Follow its cause even when it needs a deeper rule or system change. Keep the game bootable; avoid filler and length targets. Use game_check for boot checks and focused play when needed to understand or verify the flaw. The harness independently plays and judges your build afterwards. Work under ${lane}/; changes only to notes, bots or skills do not count. Finish when the direction is addressed and report what changed and what remains unverified.`;

// Rounds fix one named flaw; prototypes and the first full build make a
// playable whole, so they get their own rule instead of the round's.
const wholeBuildRule = (lane: string) =>
  `${TOOL_RULE}Build what this direction asks as one playable whole, not a sketch. Keep the game bootable as you go; use game_check for boot checks and focused play to verify what you built. The harness independently plays and judges your build afterwards. Work under ${lane}/; changes only to notes, bots or skills do not count. Finish when the direction is built and report what changed and what remains unverified.`;

// The Unity lane imports models from Assets/; its prompt otherwise matches the Godot one.
const UNITY_ART =
  "A 3D game needs real 3D models as GLB, from the library or made with the game_blender_* tools and exported under unity/Assets/Blender (glTFast imports both), textures and sprites as PNG under unity/Assets/Art, then game_import and game_check; code-built primitives are placeholders, same as 2D. ";

export const stage = (name: "vision" | "plan" | "art", lane: string): string => {
  if (name === "vision")
    return `${TOOL_RULE}Read the brief in BRIEF.md and make it yours. Write VISION.md in this folder in your own words: the player's fantasy, the 30-second loop, what makes this one special. Look through the CC0 asset library (game_assets_search with no query and no kind lists every pack and its style); when one pack fits the brief, make it the game's style source and name it in VISION.md, so the whole game keeps that one look. Then render one key-art PNG the finished game must live up to with game_blender_code, in that pack's style when you chose one (see ./studio-skills/art-pipeline.md for a working render setup; your own image tools are fine if you have them), look at it, and name it in VISION.md. Do not write game code yet. Work only in this folder. Do not use subagents. Never commit.`;
  // No content list, no length target: quality of what exists is the goal,
  // and adding levels is the creator's job, not the loop's.
  if (name === "plan")
    return `${TOOL_RULE}${SKILL_LINE}Play the base build first with game_explore_start (default target). Then write PLAN.md: the game's structure, with rules and state separate from presentation so later passes can change it safely; the asset list; what makes the core experience good (how it should play, feel and look); and what done means for the scope the brief asks for. Concrete and short. Plan the depth the core needs; avoid filler and length targets. More content is the creator's choice. Do not write game code. Do not use subagents. Do not commit.`;
  return `${TOOL_RULE}${SKILL_LINE}Read VISION.md and look at the key art named there. Make the game's asset set as files in ${laneAssets(lane)} (every character, object, tile, background, UI piece and effect the plan needs, with animation frames where things move), plus sound effects and a music loop as audio files, all held to the look of the key art. Take what fits the key art from the CC0 library (game_assets_search, look at its contact sheet, then game_assets_add), starting with the pack VISION.md names if it names one, and render the rest to match: one consistent style for the whole game. Render sprites and animation frames from Blender models with game_blender_render_sprites (a pixel-art style pack goes in as its palette), never with your own camera or render code. ${lane === "unity" ? "" : `Also save the key art, 16:9, as ${laneAssets(lane)}/ui/title_bg.png: the title screen shows it behind the menu${lane === "godot" ? "" : `; also add, inside :root in ${lane}/style.css, --title-art: linear-gradient(rgb(0 0 0 / 0.55), rgb(0 0 0 / 0.55)), url("assets/ui/title_bg.png"); (this one CSS line is allowed)`}. `}${lane === "unity" ? UNITY_ART : lane === "godot" ? "A 3D game needs real 3D models as GLB, library or Blender models (game_blender_* tools; rigged characters where they move), then imported and checked in the engine; code-built primitives are placeholders, same as 2D. " : "Models are GLB, library or Blender models (game_blender_* tools, exported under web/assets), sprites and textures as rendered PNGs; code-built primitives are placeholders. The export is a static copy, so everything the game loads must be a file under web/. "}Record each file's intended use and source in ASSETS.md as a file-to-use map (one line per file: path, what it depicts, where the game loads it, source and licence). Do not write game code yet. Do not use subagents. Do not commit.`;
};

// The art stage's first render is judged by a fresh session, never by its maker.
export const artReview = (lane: string): string =>
  `${TOOL_RULE}You are the art director for this game's asset set. Read VISION.md and ./studio-skills/art-director.md. Open the key-art image VISION.md names and look at it, then read ASSETS.md and open every image file it lists under ${laneAssets(lane)} (for 3D models, look at a render made with the game_blender_* tools). If VISION.md names a style-source library pack, look at it with game_assets_search (pack: that id) and judge the set's style against it; a different rendering style (smooth renders against pixel art) is a cohesion defect. Judge the key art and the set against VISION.md: cohesion with the key art, readability at play size, glaring defects, and anything that looks placeholder or code-drawn (flat shapes, plain dots, missing light, glow or shading, a crowded composition, animation frames that barely differ, a flat background). Write .studio/art-review.md: a short list of concrete defects, one line each naming the file, what is wrong and what would fix it. Then end the file with exactly one line, ART: KEEP or ART: REDO, alone on that line. REDO only when a listed defect makes the game look worse than its vision promises. You may only write .studio/art-review.md; change no other file. Do not use subagents.`;

// GameRun appends this at launch: the facts come from disk and the policy stays pure.
// Only ASSETS.md against the disk: the code is not wired to the new art yet, so which files
// it references says nothing about the art.
export const artFacts = (facts: string, sprites: string): string =>
  `\n\nFile facts on the asset set (static scan of ASSETS.md against the files on disk): ${facts}${spriteBlock(sprites)}`;

/** Measured pixel facts, given to the art director and to the redo that answers it. The redo is
 * told the numbers predate it, so it fixes the director's defects instead of chasing each one. */
export const spriteBlock = (sprites: string, redo = false): string =>
  sprites.length === 0
    ? ""
    : redo
      ? `\n\nMeasured image facts, measured before your redo (pixels decoded from the files; numbers, not verdicts). Fix only the listed defects; a number here is not a defect unless the list names it:\n${sprites}`
      : `\n\nMeasured image facts (pixels decoded from the files; numbers, not verdicts; look at the files yourself):\n${sprites}`;

// Works as a follow-up on the art thread and as a fresh art role alike.
export const artRedo = (defects: string, lane: string): string =>
  `${TOOL_RULE}${SKILL_LINE}An independent art director reviewed the key art and the asset set and asked for one redo. Its defect list:\n${defects}\n\nFix every listed defect: re-render the named files (the key art VISION.md names, files under ${laneAssets(lane)}) held to the look VISION.md describes, keep each file's path, and update ASSETS.md where a file changed. Look at each new render before you finish. This is the only redo. Do not write game code. Do not use subagents. Do not commit.`;

// Games made from the Godot starter carry a demo shell; older ones do not, so the line defers to TEMPLATE.md.
const shellLine = (lane: string): string =>
  lane === "godot"
    ? "When TEMPLATE.md describes the demo shell, use it: gameplay goes in godot/scenes/game.tscn, a run ends with GameState.win or GameState.lose, every player action gets an answer through Juice, values that must survive a retry go in KEEP_ACROSS_RUNS, and you build no menus of your own. "
    : lane === "web"
      ? "When TEMPLATE.md describes the demo shell, use it: gameplay goes in web/main.js (start, update, stop on the ctx the shell passes), a run ends with GameState.win or GameState.lose, every player action gets an answer through Juice, values that must survive a retry go in KEEP_ACROSS_RUNS, and you build no menus or render loop of your own. "
      : "";

export const proto = (lane: string): string =>
  `${wholeBuildRule(lane)}${SKILL_LINE}Read the brief first. Build the smallest playable core loop in ./${lane} on this branch with placeholder art only: something winnable and losable. ${shellLine(lane)}Keep the boot clean. Do not use subagents. Do not commit.`;

export const firstDirection = (lane: string): string =>
  `Read VISION.md and PLAN.md first. Continue from what is on main (the picked prototype where one was merged): extend its code, do not restart from blank. Build the most important playable part: the full loop, a way to win and lose, sound from the start, using the files in ${laneAssets(lane)} for every visual and sound. Load every visual and sound through the ASSETS.md file-to-use map so each file lands where it was made for. Organize as a normal small project a stranger can read and continue: domain scenes/scripts beside presentation, rules and state separate. ${shellLine(lane)}End with something a player notices in the first minute; game files under ${lane}/ only.`;

const concreteAsk = (lane: string) =>
  `Make the smallest change that fixes the named top play flaw, including a deeper rule or system change when needed. Avoid filler and length targets. Work in game files under ${lane}/; notes, bots and skill files do not count.`;

/** The round's base direction: the last review, else the pick's findings, else the plan. */
export const roundBase = (next: string, pickNotes: string, lane: string): string =>
  next.length > 0
    ? next
    : pickNotes.length > 0
      ? `No review yet. The blind pick of the prototypes reported real play issues; fix the most important one in how the game plays, feels or looks:\n${pickNotes}\n${concreteAsk(lane)}`
      : `Read PLAN.md and improve the biggest quality gap in what exists: how it plays, feels and looks, working systems, no bugs. Play weakness first. ${concreteAsk(lane)}`;

/** The creator's own notes lead the round; the review's direction follows as far as it fits. */
export const steered = (notes: ReadonlyArray<string>, base: string): string =>
  `The creator asked for this; it comes first this round:\n${notes.map((note) => `- ${note}`).join("\n")}\nThen, where it fits alongside that, the last direction:\n${base}`;

export const roundDirection = (base: string, repeating: boolean, lane: string): string =>
  repeating
    ? `The last review wrote no new direction, so this round repeats the previous one:\n${base}\n${concreteAsk(lane)}`
    : base;

export const retryDirection = (direction: string, lane: string): string =>
  `The last block changed no game files under ${lane}/. Address the named top flaw now: ${direction} ${concreteAsk(lane)} Verify with game_check. No subagents. No commits.`;

export const builderFirst = (whole: boolean, lane: string, direction: string): string =>
  `${whole ? wholeBuildRule(lane) : buildRule(lane)}${SKILL_LINE}\n\nThis block's direction (follow it exactly; play weakness first):\n${direction}\nNote learnings in NOTES.md. Do not use subagents. Never commit, never reset git.`;

// A builder that finished the direction early otherwise spends its follow-ups
// rewriting NOTES.md until the no-change limit ends the block.
export const builderMore = (minutes: number, direction: string): string =>
  `${minutes} minutes left in this block. Keep going with what's still undone from this block's direction:\n${direction}\nIf it is all done, play your build for a minute with game_explore_start/act/close: first replay what the direction changed and keep it working, then fix a problem outside it that you saw in play, in small changes. If play shows nothing worth changing, say so and stop; notes alone end the block. Do not redo what works. No subagents. No commits.`;

// The service records every bot run itself in .studio/bot-results.jsonl, so
// the tester never appends there. With a Jev key the tester also explores.
export const testerPlay = (n: number, jev: boolean, lane: string): string => {
  const bots = !laneBots(lane)
    ? "Bot runs do not play this game's engine; your play with the game_explore_* tools is the evidence."
    : jev
      ? "Write TWO bots under .studio/bot/: a win bot (goal: win or reach the ending; decider jev when the game suits fast decisions, else policy; run it with game_bot_run, seconds 60) and an exploration bot (goal: try everything; options covering the mechanics broadly, preferring what has not been tried, edge cases and limits; no goal of winning; see the run types in .studio/bot/kit/KIT-GUIDE.md; run it with game_bot_run mode explore, decider jev, seconds 40, runs 3). The service records every run and writes .studio/player-report.md; do not append to .studio/bot-results.jsonl yourself. A note without bot runs does not count."
      : "You must also write or update a bot file under .studio/bot/ for this game and run it at least once with game_bot_run (decider policy unless the game needs jev). The service records every run in .studio/bot-results.jsonl; do not append there yourself. A note without a bot run does not count.";
  return `${PLAYBOOK}${PLAYTEST_LINE}Play the game in this folder freely: start it with game_explore_start (default target), get past the menu, push as far as you can, try to win and to lose. ${bots} Play roughly, not gently. After every couple of plays, append what you did and felt to .studio/tester-${n}.md, main complaint first. You may only write that notes file${laneBots(lane) ? " and .studio/bot/ files" : ""}; do not change game files. Do not use subagents.`;
};

export const testerWrite = (n: number, move: string): string =>
  `Stop playing, now write it. Read .studio/tester-${n}.md. Rewrite the notes file so it states what you did and felt in your own words: decisions, fail, boredom, wanting another go, and your main complaint first. Prior flaw for this round: ${move} State whether it is fixed, partly fixed, or unchanged, with what you did and the furthest state you reached. You may only write that notes file.`;

// T28's testers ran zero bots each; one plain follow-up asks for the run.
export const BOT_DUTY =
  "You ended your turn without running any bot, so there is no play evidence. Write or update a bot file under .studio/bot/ for this game now (goal, observe, options, status; see .studio/bot/kit/KIT-GUIDE.md) and run it at least once with game_bot_run, then append what the run showed to your notes file. A note without a bot run does not count.";

export const PICK_QUESTION =
  "Which core loop is better to play and worth building on? Consider decisions, meaningful failure, control, boredom and wanting another go.";

export const roundQuestion = (direction: string): string =>
  `The prior reviewer named this unresolved play weakness and direction, not a claim about either build: ${direction}. Is it better handled, and is the game better to play overall?`;

// Weak players spent ~1.6 s per act and hit the act cap at 13-30 s per
// session; a per-act number is what they follow.
const PACE_S = Math.round(B.maxTotalNominalMs / B.maxCalls / 1000);

export const samplePlay = (question: string, notes: string): string =>
  `${PLAYBOOK}${PLAYTEST_LINE}You are independently playing one game build. You do not know its identity or another sample's result. Use real input with game_explore_start/act/close. You have the same six-minute wall allowance and ${SAMPLE_S}-second total in-game input budget as the other player. Aim to use that input budget to investigate the named flaw. Your sessions share those ${SAMPLE_S} seconds and one session holds at most ${SESSION_S} of them, so use at most ${SAMPLE_SESSIONS} sessions and open the next only when the current one is spent; input past ${SAMPLE_S} seconds in total voids your sample. A session's ${SESSION_S} seconds span only ${B.maxCalls} act calls, so carry about ${PACE_S} seconds of input in every act (holds of 1-2 seconds, or presses with waits to watch what they do) or the acts run out first; each act result says the input left and the seconds per act that spend it. Keep playing until the budget is nearly spent, and once an act result shows about ${SAMPLE_S} s across your sessions, close and stop: never open another session then. Do not substitute screenshots or bots for hands-on play. Shared question: ${question} Append what you actually did, reached and felt to ${notes}. Include uncertainty and what you did not reach. Judge from play, without reading source files, Git history or earlier reviews. Do not change game files. Do not use subagents.`;

// The more turn only follows a play turn under policy.ts's PLAY_FLOOR_MS (60 s)
// and the role runner closes its sessions, so one new session stays within
// SAMPLE_INPUT_MS.
export const sampleMore = (usedSeconds: number, notes: string): string =>
  `You used about ${usedSeconds} seconds of your ${SAMPLE_S}-second input budget, so your evidence covers only the opening. Keep playing this build with real input (game_explore_start/act/close), about ${PACE_S} seconds of input in every act call (holds of 1-2 seconds, longer for controls you already know, or presses with waits to watch what they do; at most ${CALL_S} seconds per call), or the acts run out first; each act result says the input left and the seconds per act that spend it. Your earlier sessions are closed, so open exactly one new session; it holds at most ${SESSION_S} seconds and ${B.maxTotalSteps} steps, and a second new one could push you past ${SAMPLE_S} seconds in total, which voids your sample. Push toward an ending, a win or a loss, or the furthest state you can reach, and try an approach you have not tried yet. Append what you did and reached to ${notes}. Same rules as before: judge from play only, change no game files, no subagents.`;

export const sampleWrite = (notes: string): string =>
  `Stop playing, now write it. Rewrite ${notes} with your actual actions, decisions, failures, boredom, desire to replay, and the furthest state reached. Address the shared question with observations, separating facts from uncertainty. Do not compare to an unseen build or declare a winner. You may only write ${notes}.`;

// Reports are anonymous and in random order; the file carries a neutral id, so
// nothing on disk tells the comparator which build is which while it works.
// Bot facts reach the comparator only when the bot ran on both builds, so an
// error never points at one of them.
const BOT_FACTS =
  "Each report ends with bot facts: the same scripted bot played each build for the same real time, and its ending and the game's final probe values are recorded. The tester wrote that bot against one of these two builds, so how far it gets is a fact about scripted play on each build, not a verdict on either; it measures what scripted play reaches, not how play feels. Weigh bot facts as facts next to the play report. ";

// Pixels are equal-format evidence where a weak player's words are not.
const sheets = (s: { readonly a: string; readonly b: string }, aFirst: boolean) =>
  `Each build also has one frame sheet: frames from that player's own play, evenly sampled across all of it and labelled with session and act. Open and look at both images before you judge: ${aFirst ? `Build A's is ${s.a} and Build B's is ${s.b}` : `Build B's is ${s.b} and Build A's is ${s.a}`}. Judge looks, juice and readability from the pixels as well as the report, and weigh how much of the game each sheet and report actually covers. `;

export const compare = (
  question: string,
  a: string,
  b: string,
  aFirst: boolean,
  file: string,
  bots: boolean,
  frames: { readonly a: string; readonly b: string } | null = null,
) =>
  `Compare these two independent play reports. Shared question: ${question} Which build better handles that flaw, and is better to play overall? Consider uncertainty and unequal observed exposure. The players may have made different choices or mistakes; an outcome difference alone does not prove different game behavior. ${bots ? BOT_FACTS : ""}${frames === null ? "" : sheets(frames, aFirst)}TIE means no demonstrated preference. Reports are anonymous and their presentation order is randomized; do not prefer a label or position. Use only these reports${frames === null ? "" : " and the two frame sheets"}, not the game folder, sources or Git. Write ${file}. Put exactly one declaration, COMPARE: A or COMPARE: B or COMPARE: TIE, alone on its own line without any other text. Put play-based reasons in a separate paragraph after that line. Do not play or use subagents.\n\n${aFirst ? `Build A. ${a}\n\nBuild B. ${b}` : `Build B. ${b}\n\nBuild A. ${a}`}`;

export const correct = (file: string): string =>
  `Correct only the format of ${file}, using the reports already provided. Put your declaration COMPARE: A or COMPARE: B or COMPARE: TIE alone on its own line. Put reasons in a separate paragraph below it. Do not play again or collect new evidence.`;

// A selection on a tied pick, never a quality verdict.
export const SELECT =
  "The comparison is a tie with no demonstrated preference either way. For continuation only, not a quality verdict: which prototype should the first build extend, A or B, and in what direction? Put exactly one line SELECT: A or SELECT: B alone on its own line, then reasons in a separate paragraph below it. Do not replay or collect new evidence.";

// Quality of what exists only: never a push for more levels or length.
export const reviewerPlay = (n: number, reviewed: string, facts: string): string =>
  `${PLAYBOOK}${SKILL_LINE}Play the game in this folder briefly (a few minutes at most): ${reviewed}. Read PLAN.md and .studio/tester-${n}.md. Code facts: ${facts} After every couple of plays, append what you did and felt to .studio/reviewer-${n}.md. You may only write that notes file. Do not change game files. Do not use subagents.`;

export const reviewerWrite = (n: number, move: string, verdicts: string, facts: string) =>
  `Stop playing, now write it. Read .studio/reviewer-${n}.md. Rewrite the notes file with what you did and felt, then write .studio/next.md with: the biggest weakness in how the game plays, feels or looks; the most important bug or rough edge; how to raise the feel and look; the smallest change that fixes the top flaw, including a deeper rule or system change if needed, without filler or length targets; a DO NOT REGRESS list; the furthest state you reached and what blocked further progress; and as the very last line STATUS: continue or STATUS: ready (ready only if a stranger could pay for this demo today). Prior round worked from: ${move} Verdicts ${verdicts}. State whether that prior flaw is fixed, partly fixed, or unchanged, with what action reached which state. Code facts: ${facts} Play weakness first. You may only write .studio/reviewer-${n}.md and .studio/next.md.`;

export const SHIP_PLAY = `${PLAYBOOK}${PLAYTEST_LINE}Play the game in this folder to the end if you can. After every couple of plays, append what you did and felt to .studio/ship.md. Do not change files. Do not use subagents.`;
export const SHIP_WRITE =
  "Stop playing, now write it. Read .studio/ship.md. Rewrite the notes file with what you did and felt, then name the furthest late state actually reached (ending? win or loss? which levels or systems?) and what remains unverified, then end with exactly one line SHIP: YES or SHIP: NO and the reasons. You may only write .studio/ship.md.";
