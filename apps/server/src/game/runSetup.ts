// @effect-diagnostics globalDate:off globalDateInEffect:off nodeBuiltinImport:off -- The production run's files in the game folder: skill pack, bot kit, ignores, the run log.
// What a run puts in the game folder before and around its steps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { ENGINE_SKILLS, laneProfile } from "./engineProfile.ts";
import { CHECK_BOT_DIR } from "./run/checkRunner.ts";
import { CREATOR_SESSION_SECTION } from "./scaffold.ts";
import * as Templates from "./templates.ts";

// Run notes and reports are harness output, never game content: ignoring them
// keeps the tree clean so build swaps never need a stash (T28 wedged on a
// half-applied stash pop). The list keeps the files earlier runs wrote
// (run.json, rounds.jsonl, stop, steer, profile), so an older game's leftovers
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

// The pack's own AGENTS.md is the one index, so this line cannot drift from the pack.
const SKILLS_HEADING = "## Studio skills (read the ones your role needs)";
// A role told to read every skill must not get another engine's rules.
const keepLaneSkill = async (skills: string, lane: string) => {
  const own = laneProfile(lane).run.skill;
  const others = ENGINE_SKILLS.filter((name) => name !== own);
  await Promise.all(
    others.map((name) => NodeFSP.rm(NodePath.join(skills, `${name}.md`), { force: true })),
  );
  const index = NodePath.join(skills, "AGENTS.md");
  const text = await NodeFSP.readFile(index, "utf8").catch(() => null);
  if (text === null) return;
  const kept = text
    .split("\n")
    .filter((line) => !others.some((name) => line.startsWith(`- \`${name}\``)))
    .join("\n");
  await NodeFSP.writeFile(index, kept);
};

const SKILLS_LINE = `\n\n${SKILLS_HEADING}\n\nCraft advice lives in ./studio-skills, indexed in ./studio-skills/AGENTS.md.\n`;
const STALE_SKILLS =
  /\n*## Studio skills \(read the ones your role needs\)\n\nSkill pack in \.\/studio-skills, one line each:[^\n]*\n/;

export const readText = (path: string): Promise<string | null> =>
  NodeFSP.readFile(path, "utf8").catch(() => null);

// A unique same-directory temp file plus rename: a crash never leaves a torn
// file behind, and concurrent writers never rename each other's inode.
export const writeAtomic = async (file: string, text: string): Promise<void> => {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${NodeCrypto.randomUUID()}`;
  try {
    await NodeFSP.writeFile(tmp, text);
    await NodeFSP.rename(tmp, file);
  } catch (error) {
    await NodeFSP.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
};

/** The run log is for people: nothing reads it back. */
// A rejected append (the folder gone, a full disk) must not break the work it
// logs: Effect.promise would turn it into a defect that Effect.ignore lets through.
export const logLine = (root: string, line: string): Effect.Effect<void> =>
  Effect.tryPromise(() =>
    NodeFSP.mkdir(NodePath.join(root, ".studio"), { recursive: true }).then(() =>
      NodeFSP.appendFile(
        NodePath.join(root, ".studio", "run.log"),
        `${new Date().toISOString()} ${line}\n`,
      ),
    ),
  ).pipe(Effect.ignore);

// A game made before the decision protocol has the older creator section; it is replaced whole.
const CREATOR_HEADING = "## The creator's session and the production run";
const withCreatorSection = (agents: string): string => {
  if (agents.includes("game_run_decide")) return agents;
  const at = agents.indexOf(CREATOR_HEADING);
  if (at < 0) return `${agents.trimEnd()}\n\n${CREATOR_SESSION_SECTION}`;
  const after = agents.indexOf("\n## ", at + CREATOR_HEADING.length);
  return `${agents.slice(0, at)}${CREATOR_SESSION_SECTION}${after < 0 ? "" : agents.slice(after)}`;
};

const templatesDir = async () => {
  const [bundled, monorepo] = Templates.templateDirectoryCandidates(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    NodePath.join,
  );
  return (await NodeFSP.access(bundled).then(
    () => true,
    () => false,
  ))
    ? bundled
    : monorepo;
};

// The engine's in-game play runner speaks this server's protocol, so a new
// run brings it up to date in a commit of its own on trunk, right after
// init: riding in a role's commit, it would force that role through a boot
// and be lost with it when the role is rejected, or land on a leftover
// round branch instead of trunk.
export const refreshHarnessFiles = (
  root: string,
  lane: string,
  log: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const owned = laneProfile(lane).run.harnessFiles;
    if (owned === null) return;
    const templates = yield* Effect.promise(templatesDir);
    const paths = owned.files.map((file) => NodePath.join(lane, file));
    const copied = yield* Effect.promise(async () => {
      try {
        for (const file of owned.files) {
          const to = NodePath.join(root, lane, file);
          await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
          await NodeFSP.copyFile(NodePath.join(templates, owned.template, lane, file), to);
        }
        return null;
      } catch (error) {
        return String(error).slice(0, 300);
      }
    });
    if (copied !== null) return yield* log(`harness files not refreshed: ${copied}`);
    // The run's base build carries them; the run never commits them.
    yield* log(`harness files refreshed: ${paths.join(", ")}`);
  }).pipe(Effect.uninterruptible);

// Skill pack, bot kit and the run-state ignores, so every build the run keeps
// has them. Only a new run refreshes the skills and the kit: a resume after a
// server update would otherwise change them mid-run, and the next build would
// carry harness text as its own work while earlier builds were made under
// different guidance.
export const ensureScaffold = (root: string, lane: string, fresh: boolean) =>
  Effect.promise(async () => {
    const templates = await templatesDir();
    await NodeFSP.mkdir(NodePath.join(root, ".studio", "bot"), { recursive: true });
    const copy = async (from: string, to: string) => {
      const present = await NodeFSP.access(to).then(
        () => true,
        () => false,
      );
      if (!fresh && present) return false;
      await NodeFSP.cp(from, to, { recursive: true }).catch(() => undefined);
      return true;
    };
    const skills = NodePath.join(root, "studio-skills");
    if (await copy(NodePath.join(templates, "studio"), skills)) await keepLaneSkill(skills, lane);
    await copy(NodePath.join(templates, "bot-kit"), NodePath.join(root, ".studio", "bot", "kit"));
    const before = (await readText(NodePath.join(root, "AGENTS.md"))) ?? "";
    let agents = before.replace(STALE_SKILLS, "");
    if (!agents.includes(SKILLS_HEADING)) agents = `${agents}${SKILLS_LINE}`;
    agents = withCreatorSection(agents);
    if (agents !== before) await NodeFSP.writeFile(NodePath.join(root, "AGENTS.md"), agents);
    const ignore = (await readText(NodePath.join(root, ".gitignore"))) ?? "";
    const present = new Set(ignore.split("\n").map((line) => line.trim()));
    const missing = RUN_STATE_IGNORES.filter((line) => !present.has(line));
    if (missing.length > 0)
      await NodeFSP.writeFile(
        NodePath.join(root, ".gitignore"),
        `${ignore}${ignore === "" || ignore.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`,
      );
  }).pipe(Effect.ignore);

export const causeText = (cause: Cause.Cause<unknown>): string => {
  const squashed: unknown = Cause.squash(cause);
  return (squashed instanceof Error ? squashed.message : "unrecognized failure").slice(0, 300);
};
