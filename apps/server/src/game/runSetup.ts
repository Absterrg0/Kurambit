// @effect-diagnostics nodeBuiltinImport:off -- The production run's files in the game folder: skill pack, bot kit, ignores.
// What a run puts in the game folder before and around its steps.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  GameManifest,
  GameOperationError,
  manifestRuntime,
  type GameEngineId,
} from "@kurambit/contracts";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import { ENGINE_SKILLS, engineProfile } from "./engineProfile.ts";
import { RUN_STATE_IGNORES, withEveryTurn, withKeepGoing } from "./scaffold.ts";
import { failureText } from "./run/handBack.ts";
import { runtimesDirectory } from "./gameRuntime.ts";

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(GameManifest));

// The pack's own AGENTS.md is the one index, so this line cannot drift from the pack.
const SKILLS_HEADING = "## Studio skills (read the ones this turn needs)";
// A game made before chat turns carries this heading; it is renamed, never added twice.
const ROLE_SKILLS_HEADING = "## Studio skills (read the ones your role needs)";
const SKILLS_LINE = `\n\n${SKILLS_HEADING}\n\nCraft advice lives in ./studio-skills, indexed in ./studio-skills/AGENTS.md.\n`;
const STALE_SKILLS =
  /\n*## Studio skills \(read the ones your role needs\)\n\nSkill pack in \.\/studio-skills, one line each:[^\n]*\n/;

const readText = (path: string): Promise<string | null> =>
  NodeFSP.readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

const ioError = (operation: string, path: string, cause: unknown) =>
  new GameOperationError({
    operation,
    path,
    reason: "io",
    detail: cause instanceof Error ? cause.message.slice(0, 500) : "the write failed",
    cause,
  });

/**
 * The studio skills as this server ships them, for the game's engine only (a role told to read
 * every skill must not get another engine's rules). Files whose text did not change stay as they
 * are, so a refresh with nothing new leaves the game's diff empty.
 */
const writeSkills = (templates: string, root: string, engine: GameEngineId) =>
  Effect.tryPromise({
    try: async () => {
      const skills = NodePath.join(root, "studio-skills");
      const own = engineProfile(engine).run.skill;
      const others = ENGINE_SKILLS.filter((name) => name !== own);
      await NodeFSP.cp(NodePath.join(templates, "studio"), skills, {
        recursive: true,
        force: true,
        filter: (from) => !others.some((name) => NodePath.basename(from) === `${name}.md`),
      });
      await Promise.all(
        others.map((name) => NodeFSP.rm(NodePath.join(skills, `${name}.md`), { force: true })),
      );
      // A game that loads Kurambit's runtime reads its kits' comment blocks here; the game
      // never loads this copy, so an edit to it changes nothing.
      const major = await NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8")
        .then((text) => manifestRuntime(decodeManifest(text)))
        .catch(() => null);
      const kits = NodePath.join(skills, "runtime");
      await NodeFSP.rm(kits, { recursive: true, force: true });
      if (major !== null)
        await NodeFSP.cp(
          NodePath.join(runtimesDirectory(templates), engine, String(major), "shell"),
          NodePath.join(kits, "shell"),
          { recursive: true },
        );
      const index = NodePath.join(skills, "AGENTS.md");
      const text = await NodeFSP.readFile(index, "utf8");
      const kept = text
        .split("\n")
        .filter((line) => !others.some((name) => line.startsWith(`- \`${name}\``)))
        .join("\n");
      if (kept !== text) await NodeFSP.writeFile(index, kept);
    },
    catch: (cause) => ioError("Studio skills", "studio-skills", cause),
  });

/**
 * Skill pack, bot kit and the run-state ignores, so every build the run keeps
 * has them. Only a new run refreshes the skills and the kit: a resume after a
 * server update would otherwise change them mid-run, and the next build would
 * carry harness text as its own work while earlier builds were made under
 * different guidance. A pack or kit that cannot be put in place fails the
 * start: roles told to read them would work without them.
 */
export const ensureScaffold = (
  templates: string,
  root: string,
  engine: GameEngineId,
  fresh: boolean,
): Effect.Effect<void, GameOperationError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
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
    const hasSkills = yield* io("Run scaffold", "studio-skills", () =>
      NodeFSP.access(NodePath.join(root, "studio-skills")).then(
        () => true,
        () => false,
      ),
    );
    if (fresh || !hasSkills) yield* writeSkills(templates, root, engine);
    yield* copy(NodePath.join(templates, "bot-kit"), NodePath.join(root, ".studio", "bot", "kit"));
    // The run-state ignores keep every build the run captures free of its
    // notes and records: a start that cannot write them fails, as for the pack.
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
      }).pipe(Effect.mapError((cause) => ioError("Run scaffold", ".gitignore", cause)));
    // The game's AGENTS.md section is a courtesy to people and the creator's
    // agent; the start goes on without it.
    yield* Effect.gen(function* () {
      const before =
        (yield* io("Run scaffold", "AGENTS.md", () =>
          readText(NodePath.join(root, "AGENTS.md")),
        )) ?? "";
      let agents = before.replace(STALE_SKILLS, "").replace(ROLE_SKILLS_HEADING, SKILLS_HEADING);
      if (!agents.includes(SKILLS_HEADING)) agents = `${agents}${SKILLS_LINE}`;
      agents = withEveryTurn(withKeepGoing(agents, engine), engine);
      if (agents !== before)
        yield* writeFileStringAtomically({
          filePath: NodePath.join(root, "AGENTS.md"),
          contents: agents,
        });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("the game's AGENTS.md could not be updated", { game: root, cause }),
      ),
    );
  });

/**
 * A game made before the turn loop gets its engine's "Every turn" section in
 * AGENTS.md, once, so its agent knows its turns are played and can be undone.
 * Called whenever the game is opened; a write that fails is logged, never the
 * open's failure.
 */
export const ensureTurnSections = (
  root: string,
  engine: GameEngineId,
  /**
   * The server's templates: the studio skills are brought up to this server's between turns too,
   * since a chat game has no run start to refresh them, and guidance written after a game was
   * made would otherwise never reach it.
   */
  templates: string | null = null,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = NodePath.join(root, "AGENTS.md");
    const before = yield* Effect.tryPromise(() => readText(path));
    if (before === null) return;
    const agents = withEveryTurn(before, engine);
    if (agents !== before) yield* writeFileStringAtomically({ filePath: path, contents: agents });
    if (templates !== null) yield* writeSkills(templates, root, engine);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("the game's AGENTS.md or studio skills could not be updated", {
        game: root,
        cause,
      }),
    ),
  );

export const causeText = (cause: Cause.Cause<unknown>): string =>
  failureText(Cause.squash(cause)).slice(0, 300);
