// @effect-diagnostics nodeBuiltinImport:off -- The production run's files in the game folder: skill pack, bot kit, ignores.
// What a run puts in the game folder before and around its steps.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { GameOperationError, type GameEngineId } from "@kurambit/contracts";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import { ENGINE_SKILLS, engineProfile } from "./engineProfile.ts";
import { CHECK_BOT_DIR } from "./run/checkRunner.ts";
import { CREATOR_SESSION_SECTION } from "./scaffold.ts";
import * as Templates from "./templates.ts";

// Run notes and reports are harness output, never game content: ignoring them
// keeps every build the run captures free of them. The list keeps the files
// earlier runs wrote (run.json, rounds.jsonl, stop, steer, profile, run.log),
// so an older game's leftovers never ride in a build.
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

// The pack's own AGENTS.md is the one index, so this line cannot drift from the pack.
const SKILLS_HEADING = "## Studio skills (read the ones your role needs)";
const SKILLS_LINE = `\n\n${SKILLS_HEADING}\n\nCraft advice lives in ./studio-skills, indexed in ./studio-skills/AGENTS.md.\n`;
const STALE_SKILLS =
  /\n*## Studio skills \(read the ones your role needs\)\n\nSkill pack in \.\/studio-skills, one line each:[^\n]*\n/;

const readText = (path: string): Promise<string | null> =>
  NodeFSP.readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

/** A run's line for people, in the server log: the run's step records are its history. */
export const logLine = (root: string, line: string): Effect.Effect<void> =>
  Effect.logInfo(line).pipe(Effect.annotateLogs({ game: root }));

// A game made before the decision protocol has the older creator section; it is replaced whole.
const CREATOR_HEADING = "## The creator's session and the production run";
const withCreatorSection = (agents: string): string => {
  if (agents.includes("game_run_decide")) return agents;
  const at = agents.indexOf(CREATOR_HEADING);
  if (at < 0) return `${agents.trimEnd()}\n\n${CREATOR_SESSION_SECTION}`;
  const after = agents.indexOf("\n## ", at + CREATOR_HEADING.length);
  return `${agents.slice(0, at)}${CREATOR_SESSION_SECTION}${after < 0 ? "" : agents.slice(after)}`;
};

const ioError = (operation: string, path: string, cause: unknown) =>
  new GameOperationError({
    operation,
    path,
    reason: "io",
    detail: cause instanceof Error ? cause.message.slice(0, 500) : "the write failed",
    cause,
  });

/**
 * The engine's in-game play runner speaks this server's protocol, so a new
 * run brings it up to date before its base build captures the folder: the
 * base carries it, and no role's work does. A runner that cannot be copied
 * fails the capture: a build with a stale runner would be played wrong.
 */
export const refreshHarnessFiles = (
  root: string,
  engine: GameEngineId,
  project: string,
  log: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const owned = engineProfile(engine).run.harnessFiles;
    if (owned === null) return;
    const templates = yield* Templates.resolveTemplatesDirectory();
    const paths = owned.files.map((file) => NodePath.join(project, file));
    yield* Effect.tryPromise({
      try: async () => {
        for (const file of owned.files) {
          const to = NodePath.join(root, project, file);
          await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
          await NodeFSP.copyFile(NodePath.join(templates, owned.template, project, file), to);
        }
      },
      catch: (cause) => ioError("Refresh harness files", paths.join(", "), cause),
    });
    // The run's base build carries them; the run never commits them.
    yield* log(`harness files refreshed: ${paths.join(", ")}`);
  }).pipe(Effect.uninterruptible);

/**
 * Skill pack, bot kit and the run-state ignores, so every build the run keeps
 * has them. Only a new run refreshes the skills and the kit: a resume after a
 * server update would otherwise change them mid-run, and the next build would
 * carry harness text as its own work while earlier builds were made under
 * different guidance. A pack or kit that cannot be put in place fails the
 * start: roles told to read them would work without them.
 */
export const ensureScaffold = (
  root: string,
  engine: GameEngineId,
  fresh: boolean,
): Effect.Effect<void, GameOperationError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const templates = yield* Templates.resolveTemplatesDirectory();
    const io = <A>(what: string, path: string, work: () => Promise<A>) =>
      Effect.tryPromise({ try: work, catch: (cause) => ioError(what, path, cause) });
    yield* io("Run scaffold", ".studio/bot", () =>
      NodeFSP.mkdir(NodePath.join(root, ".studio", "bot"), { recursive: true }),
    );
    const copy = (from: string, to: string) =>
      io("Run scaffold", NodePath.relative(root, to), async () => {
        const present = await NodeFSP.access(to).then(
          () => true,
          () => false,
        );
        if (!fresh && present) return false;
        await NodeFSP.cp(from, to, { recursive: true, force: true });
        return true;
      });
    const skills = NodePath.join(root, "studio-skills");
    if (yield* copy(NodePath.join(templates, "studio"), skills))
      // A role told to read every skill must not get another engine's rules.
      yield* io("Run scaffold", "studio-skills", async () => {
        const own = engineProfile(engine).run.skill;
        const others = ENGINE_SKILLS.filter((name) => name !== own);
        await Promise.all(
          others.map((name) => NodeFSP.rm(NodePath.join(skills, `${name}.md`), { force: true })),
        );
        const index = NodePath.join(skills, "AGENTS.md");
        const text = await NodeFSP.readFile(index, "utf8");
        const kept = text
          .split("\n")
          .filter((line) => !others.some((name) => line.startsWith(`- \`${name}\``)))
          .join("\n");
        await NodeFSP.writeFile(index, kept);
      });
    yield* copy(NodePath.join(templates, "bot-kit"), NodePath.join(root, ".studio", "bot", "kit"));
    // The game's AGENTS.md section and ignores are a courtesy to people and
    // the creator's agent; the start goes on without them.
    yield* Effect.gen(function* () {
      const before =
        (yield* io("Run scaffold", "AGENTS.md", () =>
          readText(NodePath.join(root, "AGENTS.md")),
        )) ?? "";
      let agents = before.replace(STALE_SKILLS, "");
      if (!agents.includes(SKILLS_HEADING)) agents = `${agents}${SKILLS_LINE}`;
      agents = withCreatorSection(agents);
      if (agents !== before)
        yield* writeFileStringAtomically({
          filePath: NodePath.join(root, "AGENTS.md"),
          contents: agents,
        });
      const ignore =
        (yield* io("Run scaffold", ".gitignore", () =>
          readText(NodePath.join(root, ".gitignore")),
        )) ?? "";
      const present = new Set(ignore.split("\n").map((line) => line.trim()));
      const missing = RUN_STATE_IGNORES.filter((line) => !present.has(line));
      if (missing.length > 0)
        yield* writeFileStringAtomically({
          filePath: NodePath.join(root, ".gitignore"),
          contents: `${ignore}${ignore === "" || ignore.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`,
        });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("the game's AGENTS.md or .gitignore could not be updated", {
          game: root,
          cause,
        }),
      ),
    );
  });

export const causeText = (cause: Cause.Cause<unknown>): string => {
  // A wrapper error (a tagged one carries no message of its own) says what
  // broke only through its cause.
  const text = (error: unknown, depth: number): string => {
    if (error instanceof Error && error.message !== "") return error.message;
    if (depth < 4 && typeof error === "object" && error !== null && "cause" in error)
      return text(error.cause, depth + 1);
    return error instanceof Error ? error.name : "unrecognized failure";
  };
  return text(Cause.squash(cause), 0).slice(0, 300);
};
