// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the production loop's native boundary: wall-clock blocks, pids, git, and the run/rounds JSONL in the game folder, like the bot and Blender services.
// GameRun: one game's production loop as a T3 service; state is `.studio/run.json` + `.studio/rounds.jsonl` + git.
// Scope: quality of what exists; code never parses prose apart from STATUS/SHIP/COMPARE lines.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameService from "./GameService.ts";
import * as Templates from "./templates.ts";
import { snapshotBuildSource } from "./sourceSnapshot.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

export class GameRunError extends Schema.TaggedError<GameRunError>()("GameRunError", {
  operation: Schema.String,
  path: Schema.String,
  reason: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail ?? `Game run ${this.operation} failed (${this.reason}).`;
  }
}

// Production-loop block sets how often the game is judged; judgement is blind play, never prose.
const BLOCK_MS = 25 * 60_000;
const FULL_BUILD_MS = 40 * 60_000;
const TESTER_CAP_MS = 12 * 60_000;
const JUDGE_CAP_MS = 6 * 60_000;
const REVIEWER_CAP_MS = 5 * 60_000;
const WRITE_CAP_MS = 2 * 60_000;
const SHIP_CAP_MS = 7 * 60_000;
// Hang watchdog: 4 minutes with no thread activity means interrupt and
// continue, up to 3 times, then replace the thread.
const STALL_MS = 4 * 60_000;
const MAX_RESTARTS = 3;
// Run state is harness bookkeeping, never game content: it stays on disk
// and out of git, so swapping builds always works. Tracked copies from
// before this rule are removed from the index (never from disk). Notes,
// reports and judge worktrees are harness output too: ignoring them keeps
// the tree clean so build swaps never need a stash at all (T28 wedged on a
// half-applied stash pop and voided a round; T29 removed stash use).
const RUN_STATE_IGNORES = [
  ".studio/run.json",
  ".studio/rounds.jsonl",
  ".studio/stop",
  ".studio/run.log",
  ".studio/bot-results.jsonl",
  ".studio/player-report.md",
  ".studio/pick.txt",
  ".studio/next.md",
  ".studio/ship.md",
  ".studio/exports.json",
  ".studio/final-video.json",
  ".studio/tester-*.md",
  ".studio/reviewer-*.md",
  ".studio/worktrees/",
  ".studio/comparisons/",
  ".studio/play-*.md",
  ".studio/round-state.json",
  "PICK-NOTES.md",
  "JUDGE-NOTES.md",
] as const; // An instantly failed turn never reached the model (provider or session
// failure, e.g. an unroutable model): back off, retry, replace the thread,
// pause the run. Never loop hundreds of turns on these (T25 spun 1152).
const INSTANT_FAIL_MS = 8_000;
const INSTANT_FAIL_RETRIES = 3;
const INSTANT_FAIL_REPLACEMENTS = 2;
const DISPLAY_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"] as const;

type VerdictRef = { order: string; verdict: string; reason: string };
type RoundRecord = {
  round: number;
  move: string;
  branch: string;
  sweepFindings: number;
  verdicts: VerdictRef[];
  kept: boolean;
  unjudged?: boolean;
  inconclusive?: boolean;
  durationMs: number;
  linesChanged: number;
  testerNote?: string;
  note?: string;
};
type ThreadRef = { role: string; threadId: string; startedAt: string };

// The persisted recovery point for one round: the known best and the base the
// round starts from, plus the branch partial work belongs to. Written before
// any tree touch each round; bestSha refreshed on merge. Ignored by git, so it
// never blocks a checkout itself.
type RoundState = {
  round: number;
  key: string;
  baseSha: string;
  bestSha: string;
  phase: string;
};

type StoredRun = {
  runId: string;
  brief: string;
  artDirection: string;
  budgetMinutes: number | null;
  provider: string | null;
  model: string | null;
  variant: string | null;
  startedAt: string;
  stage: string;
  ending: string | null;
  stallStreak: number;
  lastFailure: string;
  shipNoReasons: string;
  rounds: RoundRecord[];
  threads: ThreadRef[];
  // Explicit pending candidate: an inconclusive round's branch refined by later
  // rounds against the same judged base. Never merged without a decisive win,
  // never the base itself. Null when no pending line is open.
  pending: {
    branch: string;
    round: number;
    verdicts: VerdictRef[];
    streak: number;
  } | null;
};

const newRunId = (): string =>
  `run_${Date.now().toString(36)}${NodeCrypto.randomBytes(3).toString("hex")}`;

// Nothing may open on the user's desktop; every child inherits a clean room.
const strippedEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of DISPLAY_VARS) delete env[name];
  env.TMPDIR = NodePath.join(NodeOS.homedir(), ".gs-tmp");
  env.NODE_OPTIONS = "--max-old-space-size=1536";
  return env;
};

// Bounded one-line summary of a failure cause for logs: curated error messages
// pass through, defects contribute only their message text, never values.
const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const squashed: unknown = Cause.squash(cause);
  const text =
    typeof squashed === "string"
      ? squashed
      : squashed instanceof Error
        ? squashed.message
        : "unrecognized failure";
  return text.length > 0 ? text : "unrecognized failure";
};

const readJsonFile = async <T>(path: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};

// State writes go through a unique same-directory temp file plus rename, so a
// crash never leaves a torn run.json or rounds.jsonl behind: readers treat a
// missing file as empty, and rename is atomic on one filesystem. Concurrent
// writers each own their temp path, so nobody truncates or renames another
// writer's inode; a crash orphan keeps a tmp.* name no reader ever opens.
const writeJsonAtomic = async (file: string, text: string): Promise<void> => {
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

const lastMatch = (text: string, re: RegExp): string | null => {
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return null;
  return (matches[matches.length - 1]?.[1] ?? "").toUpperCase();
};

const isUsageLimit = (text: string): boolean =>
  /usage limit|rate limit|quota exceeded|exceeded.*quota|\b429\b|capacity exceeded|overloaded/i.test(
    text,
  );

// Variant selections ride in the model options (`{id:"variant"}` for the
// opencode driver), never in the model id. Unknown option shapes pass
// through untouched.
const withVariantOption = (options: unknown, variant: string | null | undefined): unknown => {
  if (variant === null || variant === undefined || variant.length === 0) return options;
  if (Array.isArray(options)) {
    const kept = (options as Array<Record<string, unknown>>).filter(
      (entry) => entry?.["id"] !== "variant",
    );
    return [...kept, { id: "variant", value: variant }];
  }
  if (typeof options === "object" && options !== null)
    return { ...(options as Record<string, unknown>), variant };
  return [{ id: "variant", value: variant }];
};

// Declared lines only. Code never interprets any other prose.
const parseStatus = (text: string): string | null => {
  const m = lastMatch(text, /^STATUS:\s*(continue|ready)\s*$/gim);
  return m === null ? null : m.toLowerCase();
};
const parseShip = (text: string): string | null => {
  const m = lastMatch(text, /^SHIP:\s*(YES|NO)\s*$/gim);
  return m === null ? null : m.toUpperCase();
};
const parseCompare = (text: string): string | null => {
  const m = lastMatch(text, /^COMPARE:\s*(A|B|TIE)\s*$/gim);
  return m === null ? null : m.toUpperCase();
};
// Continuation selection after a tied compare: which prototype to extend.
// A selection, never a quality verdict; parsed strictly like COMPARE.
const parseSelect = (text: string): string | null => {
  const m = lastMatch(text, /^SELECT:\s*(A|B)\s*$/gim);
  return m === null ? null : m.toUpperCase();
};

export class GameRun extends Context.Service<
  GameRun,
  {
    readonly runStart: (input: {
      readonly threadId: ThreadId;
      readonly brief: string;
      readonly artDirection?: string | undefined;
      readonly budgetMinutes?: number | undefined;
      readonly provider?: string | undefined;
      readonly model?: string | undefined;
      readonly variant?: string | undefined;
    }) => Effect.Effect<
      { runId: string; root: string; stage: string; resumed: boolean },
      GameRunError
    >;
    readonly runStatus: (threadId: ThreadId) => Effect.Effect<
      {
        active: boolean;
        runId: string | null;
        stage: string;
        ending: string | null;
        rounds: Array<{
          round: number;
          move: string;
          branch: string;
          kept: boolean;
          verdicts: VerdictRef[];
          linesChanged: number;
          testerNote: string | null;
          durationMs: number;
          note: string | null;
        }>;
        threads: ThreadRef[];
        message: string;
      },
      GameRunError
    >;
    readonly runStop: (
      threadId: ThreadId,
    ) => Effect.Effect<{ stopped: boolean; message: string }, GameRunError>;
    /** MCP catalog role: "run" for threads this service launched, else null. */
    readonly toolRole: (caller: { readonly threadId: ThreadId }) => Effect.Effect<"run" | null>;
  }
>()("t3/game/GameRun") {}

export const layer = (options: { readonly stateDir: string }) => {
  const callerFile = (threadId: string): string =>
    NodePath.join(options.stateDir, "game-run-callers", `${encodeURIComponent(threadId)}.json`);

  // Game services resolve at call time from the request scope (the same way
  // MCP handlers do), so this layer only needs its state directory at build
  // time and never constrains the server's layer order.
  const needService = <S>(
    option: Effect.Effect<Option.Option<S>>,
    operation: string,
    path: string,
    name: string,
  ): Effect.Effect<S, GameRunError> =>
    option.pipe(
      Effect.flatMap((found) =>
        Option.isSome(found)
          ? Effect.succeed(found.value)
          : Effect.fail(
              new GameRunError({
                operation,
                path,
                reason: "service-unavailable",
                detail: `${name} is not in scope for this call.`,
              }),
            ),
      ),
    );

  const make = Effect.gen(function* () {
    const active = new Map<string, { fiber: Fiber.Fiber<string, GameRunError>; runId: string }>();
    // Run-wide count of back-to-back instantly failed turns. Builder blocks
    // run their own replace policy; this catches every other role.
    const routeHealth = { consec: 0 };

    const runPaths = (root: string) => ({
      dir: NodePath.join(root, ".studio"),
      run: NodePath.join(root, ".studio", "run.json"),
      rounds: NodePath.join(root, ".studio", "rounds.jsonl"),
      stop: NodePath.join(root, ".studio", "stop"),
      botResults: NodePath.join(root, ".studio", "bot-results.jsonl"),
    });

    const fail = (operation: string, path: string, reason: string, detail?: string): GameRunError =>
      new GameRunError({ operation, path, reason, ...(detail === undefined ? {} : { detail }) });

    const needThreads = (operation: string, path: string) =>
      needService(
        Effect.serviceOption(ThreadManagement.ThreadManagementService),
        operation,
        path,
        "Thread management",
      );
    const needLaunches = (operation: string, path: string) =>
      needService(
        Effect.serviceOption(ThreadLaunch.ThreadLaunchService),
        operation,
        path,
        "Thread launching",
      );
    const needProjects = (operation: string, path: string) =>
      needService(
        Effect.serviceOption(GameProjectService.GameProjectService),
        operation,
        path,
        "Game projects",
      );
    const needGame = (operation: string, path: string) =>
      needService(Effect.serviceOption(GameService.GameService), operation, path, "Game service");
    const needSecrets = (operation: string, path: string) =>
      needService(
        Effect.serviceOption(ServerSecretStore.ServerSecretStore),
        operation,
        path,
        "Secret store",
      );
    const needProject = (operation: string, path: string) =>
      needService(Effect.serviceOption(ProjectService.ProjectService), operation, path, "Projects");

    const resolveGame = Effect.fn("GameRun.resolveGame")(function* (threadId: ThreadId) {
      const projects = yield* needProjects("resolve-game", String(threadId));
      const threads = yield* needThreads("resolve-game", String(threadId));
      const root = yield* projects
        .resolve(threadId)
        .pipe(
          Effect.mapError((cause) =>
            fail("resolve-game", String(threadId), "project-not-found", cause.message),
          ),
        );
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(
          Effect.mapError((cause) =>
            fail("resolve-game", String(threadId), "thread-read", String(cause)),
          ),
        );
      if (shell === null || shell.deletedAt !== null)
        return yield* Effect.fail(
          fail("resolve-game", String(threadId), "project-not-found", "The thread is gone."),
        );
      return { root, projectId: shell.projectId as ProjectId };
    });

    const readStored = (root: string): Effect.Effect<StoredRun | null> =>
      Effect.promise(() => readJsonFile<StoredRun | null>(runPaths(root).run, null));

    const writeStored = (root: string, stored: StoredRun): Effect.Effect<void> =>
      Effect.promise(() =>
        writeJsonAtomic(runPaths(root).run, `${JSON.stringify(stored, null, 2)}\n`),
      );

    // The rounds journal is the authority for round metadata on resume: a crash
    // between appendRound's two writes leaves the journal one record ahead of
    // the snapshot, and only the journal tells the truth then. Stage,
    // stallStreak, ending and threads stay with the snapshot.
    const reconcileJournal = (root: string, resumed: StoredRun): Effect.Effect<void> =>
      Effect.promise(async () => {
        const text = await NodeFSP.readFile(runPaths(root).rounds, "utf8").catch(() => "");
        const records: RoundRecord[] = [];
        for (const line of text.split("\n").filter(Boolean)) {
          try {
            records.push(JSON.parse(line) as RoundRecord);
          } catch {
            // Skip torn lines, as the fresh-run path does.
          }
        }
        if (records.length > resumed.rounds.length) resumed.rounds = records;
      });

    const markRoleThread = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(callerFile(String(threadId))), { recursive: true });
        await NodeFSP.writeFile(callerFile(String(threadId)), '{"role":"run"}\n');
      }).pipe(Effect.orElseSucceed(() => undefined));

    const recordThread = (
      root: string,
      stored: StoredRun,
      role: string,
      threadId: ThreadId,
    ): Effect.Effect<void> =>
      Effect.andThen(
        markRoleThread(threadId),
        Effect.promise(async () => {
          stored.threads.push({
            role,
            threadId: String(threadId),
            startedAt: new Date().toISOString(),
          });
          await writeJsonAtomic(runPaths(root).run, `${JSON.stringify(stored, null, 2)}\n`);
        }),
      );

    const appendRound = (
      root: string,
      stored: StoredRun,
      record: RoundRecord,
    ): Effect.Effect<void> =>
      Effect.promise(async () => {
        stored.rounds.push(record);
        // The file mirrors run.json's array (full rewrite, not blind
        // append): branch checkouts between rounds can clobber trailing
        // lines, and the rewrite heals that (T26: round 3's line).
        await writeJsonAtomic(
          runPaths(root).rounds,
          stored.rounds.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        );
        await writeJsonAtomic(runPaths(root).run, `${JSON.stringify(stored, null, 2)}\n`);
      });

    const stopRequested = (root: string): Effect.Effect<boolean> =>
      Effect.promise(() =>
        NodeFSP.access(runPaths(root).stop)
          .then(() => true)
          .catch(() => false),
      );

    const roundStatePath = (root: string): string =>
      NodePath.join(root, ".studio", "round-state.json");

    const writeRoundState = (root: string, state: RoundState): Effect.Effect<void, GameRunError> =>
      Effect.promise(() =>
        writeJsonAtomic(roundStatePath(root), `${JSON.stringify(state, null, 2)}\n`),
      ).pipe(
        Effect.mapError((cause) =>
          fail("write-round-state", root, "state-unwritten", String(cause).slice(0, 200)),
        ),
      );

    const readRoundState = (root: string): Effect.Effect<RoundState | null> =>
      Effect.promise(() => readJsonFile<RoundState | null>(roundStatePath(root), null));

    const shaReachable = (root: string, sha: string): Effect.Effect<boolean> =>
      gitExec(root, ["cat-file", "-e", sha], 60_000).pipe(Effect.map((r) => r.exitCode === 0));

    const gitExec = (
      root: string,
      args: ReadonlyArray<string>,
      timeoutMs: number,
    ): Effect.Effect<{ exitCode: number | null; stdout: string }> =>
      Effect.promise(() => {
        const child = NodeChildProcess.spawn("git", [...args], {
          cwd: root,
          env: strippedEnv(),
          timeout: timeoutMs,
        });
        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        return new Promise<{ exitCode: number | null; stdout: string }>((resolve) => {
          child.on("close", (code) => resolve({ exitCode: code, stdout }));
          child.on("error", () => resolve({ exitCode: null, stdout }));
        });
      });

    const gitOut = (root: string, args: ReadonlyArray<string>): Effect.Effect<string> =>
      Effect.sync(() => {
        try {
          return NodeChildProcess.execFileSync("git", [...args], { cwd: root, env: strippedEnv() })
            .toString()
            .trim();
        } catch {
          return "";
        }
      });

    const commitAll = (root: string, message: string): Effect.Effect<string | null> =>
      Effect.sync(() => {
        try {
          NodeChildProcess.execFileSync("git", ["add", "-A"], { cwd: root, env: strippedEnv() });
          try {
            NodeChildProcess.execFileSync("git", ["diff", "--cached", "--quiet"], {
              cwd: root,
              env: strippedEnv(),
            });
            try {
              return NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: root,
                env: strippedEnv(),
              })
                .toString()
                .trim();
            } catch {
              return null;
            }
          } catch {
            NodeChildProcess.execFileSync(
              "git",
              ["-c", "user.email=studio@local", "-c", "user.name=studio", "commit", "-qm", message],
              { cwd: root, env: strippedEnv() },
            );
            return NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: root,
              env: strippedEnv(),
            })
              .toString()
              .trim();
          }
        } catch {
          return null;
        }
      });

    // The game's own source and assets live under its engine directory
    // (godot/ for native games, web/ for three.js games). Bots, notes and
    // skill-pack files never count as game change: a round with no change
    // here is no real change (T25 merged a .studio-only round as unjudged).
    const gamePaths = (projectDir: string) => [
      projectDir,
      `:(exclude)${projectDir}/**/*.import`,
      `:(exclude)${projectDir}/**/*.uid`,
      `:(exclude)${projectDir}/.godot`,
    ];
    const gameLinesSince = (root: string, sha: string, projectDir: string): Effect.Effect<number> =>
      Effect.sync(() => {
        try {
          const stat = NodeChildProcess.execFileSync(
            "git",
            ["diff", "--numstat", `${sha}..HEAD`, "--", ...gamePaths(projectDir)],
            { cwd: root, env: strippedEnv() },
          ).toString();
          let total = 0;
          for (const line of stat.split("\n")) {
            const parts = line.split("\t");
            const add = Number(parts[0]);
            const del = Number(parts[1]);
            if (Number.isFinite(add)) total += add;
            if (Number.isFinite(del)) total += del;
          }
          return total;
        } catch {
          return 0;
        }
      });

    const gameChangedSince = (
      root: string,
      sha: string,
      projectDir: string,
    ): Effect.Effect<boolean, GameRunError> =>
      gitExec(
        root,
        ["diff", "--quiet", `${sha}..HEAD`, "--", ...gamePaths(projectDir)],
        60_000,
      ).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(false)
            : result.exitCode === 1
              ? Effect.succeed(true)
              : Effect.fail(fail("read-progress", root, "game-diff-failed")),
        ),
      );

    const checkoutOk = (root: string, ref: string): Effect.Effect<boolean> =>
      gitExec(root, ["checkout", "-q", ref], 60_000).pipe(Effect.map((r) => r.exitCode === 0));

    // Plain live-tree checkout: no stash, ever. Run state, notes and reports
    // are git-ignored, so a blocked checkout names real dirt (usually
    // uncommitted game files), never harness bookkeeping.
    const checkoutRef = Effect.fn("GameRun.checkoutRef")(function* (
      root: string,
      ref: string,
      why: string,
    ) {
      if (yield* checkoutOk(root, ref)) return true;
      const status = yield* gitOut(root, ["status", "--porcelain=v1", "--", "."]);
      yield* logLine(
        root,
        `checkout ${ref} blocked (${why}); leaving refs alone. ` +
          `Dirt: ${status.split("\n").filter(Boolean).slice(0, 8).join(" | ").slice(0, 400)}`,
      );
      return false;
    });

    // Blind judging never touches the live tree: each build gets a detached
    // worktree under ignored `.studio/worktrees/`, opened as its own game so
    // the judge thread plays it through the game_* tools. Worktrees are
    // removed after judging; a failed add names the reason instead of
    // voiding silently.
    const worktreeDir = (root: string, label: string): string =>
      NodePath.join(root, ".studio", "worktrees", label);
    const dropWorktree = (root: string, label: string): Effect.Effect<void> =>
      gitExec(root, ["worktree", "remove", "--force", worktreeDir(root, label)], 60_000).pipe(
        Effect.ignore,
      );
    const ensureWorktree = Effect.fn("GameRun.ensureWorktree")(function* (
      root: string,
      sha: string,
      label: string,
    ): Generator<Effect.Effect<unknown, GameRunError>, string | null, never> {
      const dir = worktreeDir(root, label);
      // Stale admin entries from a killed server would block the add: prune
      // first, then force-remove any leftover dir, then add detached.
      yield* gitExec(root, ["worktree", "prune"], 60_000).pipe(Effect.ignore);
      yield* dropWorktree(root, label);
      const added = yield* gitExec(root, ["worktree", "add", "--detach", dir, sha], 120_000);
      if (added.exitCode !== 0) {
        yield* logLine(root, `worktree ${label} at ${sha} failed: ${added.stdout.slice(0, 300)}`);
        return null;
      }
      return dir;
    });

    // Reset main only when actually on main; never reset a round branch.
    const resetMainTo = Effect.fn("GameRun.resetMainTo")(function* (root: string, ref: string) {
      const at = yield* gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (at.trim() !== "main") {
        yield* logLine(root, `refusing reset on ${at.trim() || "?"} (not main)`);
        return false;
      }
      const done = yield* gitExec(root, ["reset", "--hard", "-q", ref], 60_000);
      return done.exitCode === 0;
    });

    // New games ignore run state from scaffold; continued games get the
    // same lines appended here, and tracked copies leave the index while
    // staying on disk (the loop resumes from the folder, not from git).
    const ensureRunStateIgnored = (root: string): Effect.Effect<void> =>
      Effect.promise(async () => {
        const ignorePath = NodePath.join(root, ".gitignore");
        const current = await NodeFSP.readFile(ignorePath, "utf8").catch(() => "");
        const present = new Set(current.split("\n").map((line) => line.trim()));
        const missing = RUN_STATE_IGNORES.filter((line) => !present.has(line));
        if (missing.length > 0) {
          const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
          await NodeFSP.writeFile(ignorePath, `${current}${prefix}${missing.join("\n")}\n`);
        }
      }).pipe(
        Effect.andThen(() =>
          gitExec(
            root,
            ["rm", "--cached", "-q", "--ignore-unmatch", "--", ...RUN_STATE_IGNORES],
            60_000,
          ),
        ),
        Effect.ignore,
      );

    // Failed work is saved on rejected/<label>, never thrown away.
    // A checkout that only creates-or-enters must read the exit code: the
    // git process resolves successfully either way, so an Effect-level catch
    // never fires and the plain checkout would silently never run (the R1
    // resume built on main and recorded a phantom merge failure).
    const checkoutBranch = (root: string, key: string): Effect.Effect<void> =>
      gitExec(root, ["checkout", "-qb", key], 60_000).pipe(
        Effect.flatMap((created) =>
          created.exitCode === 0
            ? Effect.void
            : gitExec(root, ["checkout", "-q", key], 60_000).pipe(Effect.asVoid),
        ),
      );

    const rejectWork = Effect.fn("GameRun.rejectWork")(function* (
      root: string,
      best: string,
      label: string,
      why: string,
    ) {
      yield* checkoutBranch(root, `rejected/${label}`);
      yield* commitAll(root, `rejected ${label}: ${why.slice(0, 120)}`);
      if (yield* checkoutRef(root, "main", `reject ${label}`)) {
        if (best.length > 0) yield* resetMainTo(root, best);
      }
    });

    // Initial prototype adoption, pick paths only (never judged rounds): ff-only
    // first for linear history, then a --no-ff merge recording the selection.
    // Adoption is claimed only on a merge success plus an ancestor fact. A failed
    // merge aborts verified-clean (no MERGE_HEAD left) or fails loudly preserving
    // work; builders never run on conflicts.
    const adoptProtoBase = (
      root: string,
      base: string,
      selected: string,
      why: string,
    ): Effect.Effect<{ merged: boolean; mainSha: string; ancestor: boolean }, GameRunError> =>
      Effect.gen(function* () {
        const cleanAbort = Effect.fn("GameRun.adoptAbort")(function* () {
          const aborted = yield* gitExec(root, ["merge", "--abort"], 60_000);
          const mergeHead = yield* gitOut(root, ["rev-parse", "--verify", "MERGE_HEAD"]);
          if (aborted.exitCode === 0 && mergeHead.trim().length === 0) return true;
          return yield* Effect.fail(
            fail("pick-base", root, "abort-failed", `${selected} (${why})`),
          );
        });
        const ancestryOf = (sha: string): Effect.Effect<boolean> =>
          gitExec(root, ["merge-base", "--is-ancestor", sha, "HEAD"], 60_000).pipe(
            Effect.map((r) => r.exitCode === 0),
          );
        if (!(yield* checkoutRef(root, "main", `pick base merge (${why})`)))
          return { merged: false, mainSha: "", ancestor: false };
        const ff = yield* gitExec(root, ["merge", "--ff-only", "-q", base], 60_000);
        if (ff.exitCode === 0) {
          const mainSha = yield* gitOut(root, ["rev-parse", "HEAD"]);
          return { merged: true, mainSha, ancestor: yield* ancestryOf(base) };
        }
        const noe = yield* gitExec(
          root,
          ["merge", "-q", "--no-ff", "-m", `pick base ${selected} (${why}, unjudged)`, base],
          60_000,
        );
        if (noe.exitCode === 0) {
          const mainSha = yield* gitOut(root, ["rev-parse", "HEAD"]);
          const ancestor = yield* ancestryOf(base);
          if (ancestor) {
            yield* logLine(root, `pick base ${selected} merged with history (${why}, unjudged)`);
            return { merged: true, mainSha, ancestor: true };
          }
          // A merge commit always parents the base, so this is unreachable in
          // practice; treat as unadopted without touching the good tree.
          yield* logLine(
            root,
            `pick base ${selected} merged but ancestry unverified; treating as unadopted`,
          );
          return { merged: false, mainSha, ancestor: false };
        }
        yield* logLine(
          root,
          `pick base merge failed (${noe.stdout.slice(0, 200)}); verifying abort`,
        );
        yield* cleanAbort();
        const mainSha = yield* gitOut(root, ["rev-parse", "HEAD"]);
        return { merged: false, mainSha, ancestor: yield* ancestryOf(base) };
      });

    const readNextMd = (root: string): Effect.Effect<string> =>
      Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, ".studio", "next.md"), "utf8")
          .then((text) => text.trim().slice(0, 4000))
          .catch(() => ""),
      );

    const readPick = (root: string): Effect.Effect<string> =>
      Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, ".studio", "pick.txt"), "utf8")
          .then((text) => text.trim().slice(0, 1500))
          .catch(() => ""),
      );

    // Scaffold for new runs: .studio/ plus the skill pack, with skills
    // readable through a one-line list in AGENTS.md. Run-state ignores ride
    // along so swapping builds never blocks on harness bookkeeping. Templates
    // resolve the same way the game projects do (bundled dist/templates,
    // then the monorepo tree), checked with plain Node so this also works in
    // the packaged app instead of a checkout path.
    const ensureGameScaffold = (root: string): Effect.Effect<void> =>
      Effect.promise(async () => {
        const [bundled, monorepo] = Templates.templateDirectoryCandidates(
          NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
          NodePath.join,
        );
        let templatesDir: string | null = null;
        for (const candidate of [bundled, monorepo]) {
          try {
            await NodeFSP.access(candidate);
            templatesDir = candidate;
            break;
          } catch {
            /* next candidate */
          }
        }
        await NodeFSP.mkdir(NodePath.join(root, ".studio"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, ".studio", "bot"), { recursive: true });
        if (templatesDir !== null) {
          try {
            await NodeFSP.cp(
              NodePath.join(templatesDir, "studio"),
              NodePath.join(root, "studio-skills"),
              { recursive: true },
            );
          } catch {
            // The pack may already exist; never fail a run on it.
          }
          try {
            await NodeFSP.cp(
              NodePath.join(templatesDir, "bot-kit"),
              NodePath.join(root, ".studio", "bot", "kit"),
              { recursive: true },
            );
          } catch {
            // The kit may already exist; never fail a run on it.
          }
        }
        const agentsPath = NodePath.join(root, "AGENTS.md");
        const existing = await NodeFSP.readFile(agentsPath, "utf8").catch(() => "");
        if (!/studio-skills\//.test(existing)) {
          const line = `\n\n## Studio skills (read the ones your role needs)\n\nSkill pack in ./studio-skills, one line each: planning (look, cut to the ask, plan and rungs); game-foundations (boundaries, state ownership, data-driven content); godot-game (engine rules, CLI, export); three (three.js browser lane: static project, studio bridge, export); playtest (smoke/feature/regression/visual passes, report separately); art-pipeline (key art first, every asset as a file); audio (effects plus a music loop as files); art-director (would you ship this, defects, DO NOT REGRESS, one big move); stranger (first minute cold).\n`;
          await NodeFSP.writeFile(agentsPath, `${existing}${line}`);
        }
      }).pipe(Effect.andThen(() => ensureRunStateIgnored(root)));

    // The only engine-specific answers the loop needs: which directory holds
    // the game's sources, and which explore target plays it. Everything else
    // in the loop is engine-neutral; the services branch on the manifest.
    const laneOf = (root: string): Effect.Effect<{ dir: string; explore: string }, GameRunError> =>
      needProjects("read-manifest", root).pipe(
        Effect.flatMap((projects) => Effect.option(projects.read(root))),
        Effect.map((found) => {
          if (found._tag === "Some" && found.value.engine.name === "three")
            return { dir: found.value.godotProject, explore: "web" };
          if (found._tag === "Some") return { dir: found.value.godotProject, explore: "native" };
          return { dir: "godot", explore: "native" };
        }),
      );

    const stageDone = (root: string, projectDir: string): Effect.Effect<Record<string, boolean>> =>
      Effect.promise(async () => {
        const exists = async (rel: string): Promise<boolean> =>
          NodeFSP.access(NodePath.join(root, rel))
            .then(() => true)
            .catch(() => false);
        let branches = "";
        try {
          branches = NodeChildProcess.execFileSync(
            "git",
            ["branch", "--list", "--format=%(refname:short)"],
            { cwd: root, env: strippedEnv() },
          ).toString();
        } catch {
          branches = "";
        }
        const names = new Set(
          branches
            .split("\n")
            .map((name) => name.trim())
            .filter(Boolean),
        );
        const assets = await NodeFSP.readdir(NodePath.join(root, projectDir, "assets")).catch(
          () => [] as string[],
        );
        return {
          vision: await exists("VISION.md"),
          proto0: names.has("proto-0") || names.has("rejected/proto-0"),
          proto1: names.has("proto-1") || names.has("rejected/proto-1"),
          pick: await exists(".studio/pick.txt"),
          plan: await exists("PLAN.md"),
          art: assets.length > 0 || (await exists("ASSETS.md")),
        };
      });

    // The game's chosen provider, model and options: the creator thread's own
    // selection unless the run was started with explicit overrides. A
    // `#variant` suffix on a model id is the client's display form, not a
    // routable model: the opencode adapter parses provider/model and reads
    // the variant from the model options, so launching with the suffix fails
    // every turn at once (provider.no-route, ~100ms, zero assistant text).
    // The suffix is stripped and becomes the `variant` option instead. (T25:
    // every #xhigh turn failed this way while the plain model was fine.)
    const selectionFor = Effect.fn("GameRun.selectionFor")(function* (
      creatorThreadId: ThreadId,
      stored: Pick<StoredRun, "provider" | "model" | "variant">,
    ) {
      const threads = yield* needThreads("read-model", String(creatorThreadId));
      const projection = (yield* threads
        .getThreadProjection(creatorThreadId)
        .pipe(
          Effect.mapError((cause) =>
            fail("read-model", String(creatorThreadId), "thread-read", String(cause)),
          ),
        )) as unknown as {
        thread: { modelSelection: ModelSelection };
        runs: Array<{ modelSelection: ModelSelection }>;
      };
      const current: ModelSelection =
        projection.runs[0]?.modelSelection ?? projection.thread.modelSelection;
      const known = current as unknown as {
        instanceId: ProviderInstanceId;
        model: string;
        options?: unknown;
      };
      let model = stored.model ?? known.model;
      let variant = stored.variant;
      const suffix = /#([A-Za-z][A-Za-z0-9_-]*)$/.exec(model);
      if (suffix !== null) {
        model = model.slice(0, suffix.index);
        if (
          (variant === null || variant === undefined || variant.length === 0) &&
          suffix[1] !== undefined
        )
          variant = suffix[1];
      }
      const instanceId =
        stored.provider === null || stored.provider === undefined
          ? known.instanceId
          : ProviderInstanceId.make(stored.provider);
      if (
        (variant === null || variant === undefined || variant.length === 0) &&
        (stored.model === null || stored.model === undefined) &&
        (stored.provider === null || stored.provider === undefined)
      )
        return current;
      const base = current as unknown as Record<string, unknown>;
      const options = withVariantOption(known.options, variant);
      return {
        ...base,
        instanceId,
        model,
        ...(options === undefined ? {} : { options }),
      } as ModelSelection;
    });

    const shellFor = Effect.fn("GameRun.shellFor")(function* (creatorThreadId: ThreadId) {
      const threads = yield* needThreads("read-thread", String(creatorThreadId));
      const projection = (yield* threads
        .getThreadProjection(creatorThreadId)
        .pipe(
          Effect.mapError((cause) =>
            fail("read-thread", String(creatorThreadId), "thread-read", String(cause)),
          ),
        )) as unknown as {
        thread: { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode };
      };
      return {
        runtimeMode: projection.thread.runtimeMode,
        interactionMode: projection.thread.interactionMode,
      };
    });

    // One fresh ordinary thread on the game's project. `createdBy: "user"`
    // keeps it a normal client-visible thread rather than a subagent child.
    // On resume the same role name reattaches to its thread instead of
    // launching a second one: when the newest thread recorded for this role
    // still has a live run, the prompt goes to it as a new turn (a server
    // restart kills the run fiber but not the role thread, so without this
    // every resume duplicates in-flight builders, pickers and testers).
    const TERMINAL_RUN = new Set([
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "rolled_back",
    ]);
    const stopTurn = Effect.fn("GameRun.stopTurn")(function* (
      projectId: ProjectId,
      threadId: ThreadId,
      runId: RunId | undefined,
      reason: string,
    ) {
      const threads = yield* needThreads("stop-turn", String(threadId));
      yield* threads
        .interruptThread({
          projectId,
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          ...(runId === undefined ? {} : { runId }),
          reason,
        })
        .pipe(Effect.mapError(() => fail("stop-turn", String(threadId), "interrupt-failed")));
      const stopped = yield* threads
        .waitForThread({
          projectId,
          threadId,
          ...(runId === undefined ? {} : { runId }),
          timeoutMs: 60_000,
        })
        .pipe(Effect.mapError(() => fail("stop-turn", String(threadId), "wait-failed")));
      // An interrupt request only commits a command; the provider stops later.
      if (stopped.timedOut || (stopped.run !== null && !TERMINAL_RUN.has(stopped.run.status)))
        return yield* Effect.fail(fail("stop-turn", String(threadId), "stop-unconfirmed"));
    });
    const liveRoleThread = (
      stored: StoredRun,
      role: string,
    ): Effect.Effect<{ threadId: ThreadId; projectId: ProjectId } | null, GameRunError> =>
      Effect.gen(function* () {
        const peer = [...stored.threads].reverse().find((entry) => entry.role === role);
        if (peer === undefined) return null;
        const threads = yield* needThreads("reattach-thread", peer.threadId);
        const projection = (yield* threads
          .getThreadProjection(peer.threadId as ThreadId)
          .pipe(Effect.orElseSucceed(() => null))) as unknown as {
          thread: { projectId: ProjectId };
          runs: Array<{ id: RunId; status: string }>;
        } | null;
        if (projection === null) return null;
        const latest = projection.runs[projection.runs.length - 1];
        if (latest === undefined || TERMINAL_RUN.has(latest.status)) return null;
        yield* stopTurn(
          projection.thread.projectId,
          peer.threadId as ThreadId,
          latest.id,
          "Resuming the role after a server restart.",
        );
        return { threadId: peer.threadId as ThreadId, projectId: projection.thread.projectId };
      });
    const launchRole = Effect.fn("GameRun.launchRole")(function* (
      root: string,
      stored: StoredRun,
      creatorThreadId: ThreadId,
      projectId: ProjectId,
      role: string,
      title: string,
      prompt: string,
    ) {
      const resumed = yield* liveRoleThread(stored, role);
      if (resumed !== null && String(resumed.projectId) === String(projectId)) {
        yield* logLine(root, `reusing live ${role} thread (no second thread on resume)`);
        const runId = yield* sendTurn(projectId, resumed.threadId, prompt);
        return { threadId: resumed.threadId, runId };
      }
      const launches = yield* needLaunches("launch-thread", root);
      const selection: ModelSelection = yield* selectionFor(creatorThreadId, stored);
      const shell: { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode } =
        yield* shellFor(creatorThreadId);
      const launched = (yield* launches
        .launch({
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          projectId,
          title,
          modelSelection: selection,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          workspaceStrategy: { type: "root" },
          initialMessage: { text: prompt, attachments: [] },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError((cause) =>
            fail("launch-thread", root, "thread-launch", cause.message ?? String(cause)),
          ),
        )) as unknown as { threadId: ThreadId; projection: { runs: Array<{ id: RunId }> } };
      const threadId = launched.threadId;
      const runId = launched.projection.runs[0]?.id;
      yield* recordThread(root, stored, role, threadId);
      return { threadId, runId };
    });

    const sendTurn = Effect.fn("GameRun.sendTurn")(function* (
      projectId: ProjectId,
      threadId: ThreadId,
      text: string,
    ) {
      const threads = yield* needThreads("send-turn", String(threadId));
      const sent = (yield* threads
        .sendToThread({
          projectId,
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          messageId: MessageId.make(NodeCrypto.randomUUID()),
          text,
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError((cause) =>
            fail("send-turn", String(threadId), "thread-send", String(cause)),
          ),
        )) as unknown as { run: { id: RunId } };
      return sent.run.id;
    });

    // Wait for the thread's run with the 4-minute hang watchdog: no thread
    // activity for STALL_MS means interrupt and continue on the same thread,
    // up to MAX_RESTARTS times, then the caller replaces the thread.
    const waitWithWatchdog = Effect.fn("GameRun.waitWithWatchdog")(function* (
      projectId: ProjectId,
      threadId: ThreadId,
      runId: RunId | undefined,
      capMs: number,
      continueText: string,
    ) {
      const threads = yield* needThreads("wait-thread", String(threadId));
      const deadline = Date.now() + capMs;
      let restarts = 0;
      let currentRunId = runId;
      let lastGrowth = Date.now();
      const baseline = (yield* threads.getThreadEventSequence(threadId).pipe(
        Effect.mapError((cause) =>
          fail("watch-thread", String(threadId), "thread-read", String(cause)),
        ),
        Effect.orElseSucceed(() => -1),
      )) as unknown as number;
      let lastSequence = baseline;
      return yield* Effect.gen(function* () {
        for (;;) {
          const left = deadline - Date.now();
          if (left <= 0) {
            yield* stopTurn(projectId, threadId, currentRunId, "Role play/work cap reached.");
            return { replaced: false as const, restarts, runId: currentRunId, capped: true };
          }
          const slice = Math.min(60_000, left);
          const waited = (yield* threads
            .waitForThread({
              projectId,
              threadId,
              ...(currentRunId === undefined ? {} : { runId: currentRunId }),
              timeoutMs: slice,
            })
            .pipe(
              Effect.mapError((cause) =>
                fail("wait-thread", String(threadId), "thread-wait", String(cause)),
              ),
            )) as unknown as { run: { id: RunId; status: string } | null; timedOut: boolean };
          if (waited.run !== null && waited.run.id !== undefined) currentRunId = waited.run.id;
          if (!waited.timedOut)
            return { replaced: false as const, restarts, runId: currentRunId, capped: false };
          const sequence = (yield* threads.getThreadEventSequence(threadId).pipe(
            Effect.mapError((cause) =>
              fail("watch-thread", String(threadId), "thread-read", String(cause)),
            ),
            Effect.orElseSucceed(() => lastSequence),
          )) as unknown as number;
          if (sequence !== lastSequence) {
            lastSequence = sequence;
            lastGrowth = Date.now();
            continue;
          }
          if (Date.now() - lastGrowth < STALL_MS) continue;
          if (restarts >= MAX_RESTARTS) {
            yield* stopTurn(
              projectId,
              threadId,
              currentRunId,
              "Role watchdog replacing stalled thread.",
            );
            return { replaced: true as const, restarts, runId: currentRunId, capped: false };
          }
          restarts += 1;
          lastGrowth = Date.now();
          yield* stopTurn(
            projectId,
            threadId,
            currentRunId,
            "No thread activity for 4 minutes; continuing.",
          );
          currentRunId = yield* sendTurn(projectId, threadId, continueText);
        }
      }).pipe(
        Effect.onInterrupt(() =>
          stopTurn(projectId, threadId, currentRunId, "Game run stopped.").pipe(Effect.orDie),
        ),
      );
    });

    const assistantText = Effect.fn("GameRun.assistantText")(function* (
      threadId: ThreadId,
      runId: RunId | undefined,
    ) {
      const threads = yield* needThreads("read-answer", String(threadId));
      const records = (yield* threads
        .getThreadRecords(threadId, ["runs", "messages"], { messageRoles: ["assistant"] })
        .pipe(Effect.orElseSucceed(() => null))) as unknown as {
        messages: Array<{ runId: RunId | null; role: string; text: string }>;
      } | null;
      if (records === null) return "";
      const texts: string[] = [];
      for (const message of records.messages ?? []) {
        if (runId !== undefined && message.runId !== null && message.runId !== runId) continue;
        if (typeof message.text === "string" && message.text.length > 0) texts.push(message.text);
      }
      return texts.join("\n");
    });

    const pauseOnUsageLimit = Effect.fn("GameRun.pauseOnUsageLimit")(function* (
      threadId: ThreadId,
      runId: RunId | undefined,
    ) {
      const text = yield* assistantText(threadId, runId);
      return isUsageLimit(text) ? ("usage-limit" as const) : ("ok" as const);
    });

    const logLine = (root: string, line: string): Effect.Effect<void> =>
      Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, ".studio"), { recursive: true });
        await NodeFSP.appendFile(
          NodePath.join(root, ".studio", "run.log"),
          `${new Date().toISOString()} ${line}\n`,
        );
      }).pipe(Effect.ignore);

    // The latest executed run's outcome: instant provider/session failures
    // carry the provider's own reason (never model prose). Failed turns
    // carry no assistant text, so the usage-limit text check never sees
    // them; the failure class covers that gap too.
    const latestOutcome = Effect.fn("GameRun.latestOutcome")(function* (threadId: ThreadId) {
      const threads = yield* needThreads("read-outcome", String(threadId));
      const records = (yield* threads
        .getThreadRecords(threadId, ["runs", "turnItems"])
        .pipe(Effect.orElseSucceed(() => null))) as unknown as {
        runs: ReadonlyArray<OrchestrationV2Run>;
        turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
      } | null;
      if (records === null) return { instant: false, reason: "", cls: null as string | null };
      const run = latestExecutedRun(records.runs);
      if (run === null) return { instant: false, reason: "", cls: null as string | null };
      const failure = latestRootProviderFailure(run, records.turnItems);
      if (run.status !== "failed")
        return {
          instant: false,
          reason: failure === null ? "" : `${failure.class}: ${failure.message}`.slice(0, 300),
          cls: (failure?.class ?? null) as string | null,
        };
      const text = yield* assistantText(threadId, run.id);
      const wallMs =
        run.startedAt !== null && run.completedAt !== null
          ? DateTime.toEpochMillis(run.completedAt) - DateTime.toEpochMillis(run.startedAt)
          : Number.POSITIVE_INFINITY;
      const instant = wallMs < INSTANT_FAIL_MS && text.trim().length === 0;
      const reason =
        failure === null
          ? "run failed with no provider message"
          : `${failure.class}: ${failure.message}`.slice(0, 300);
      return { instant, reason, cls: (failure?.class ?? null) as string | null };
    });

    // Back off and retry an instant failure, replace the thread after a few,
    // pause the run when fresh threads fail the same way. Sleeps inside.
    const handleInstantFail = Effect.fn("GameRun.handleInstantFail")(function* (
      root: string,
      stored: StoredRun,
      state: { consec: number; replacements: number },
      reason: string,
      cls: string | null,
    ): Generator<
      Effect.Effect<unknown, GameRunError>,
      "retry" | "replace" | "down" | "usage",
      never
    > {
      state.consec += 1;
      stored.lastFailure = reason;
      yield* writeStored(root, stored);
      yield* logLine(root, `instant-failed turn (${reason}) [${state.consec} in a row]`);
      if (cls === "usage_limit") return "usage";
      if (state.consec >= INSTANT_FAIL_RETRIES) {
        if (state.replacements >= INSTANT_FAIL_REPLACEMENTS) {
          yield* logLine(root, `provider route still down (${reason}): pausing run`);
          return "down";
        }
        state.replacements += 1;
        state.consec = 0;
        yield* logLine(root, `replacing thread after repeated instant failures (${reason})`);
        return "replace";
      }
      yield* Effect.sleep(`${Math.min(15 * 2 ** (state.consec - 1), 120)} seconds`);
      return "retry";
    });

    // One wait plus the usage-limit pause. `end` is null while the run goes on.
    // An instantly failed turn backs off here too, so judging and writing
    // roles never spin; builder blocks add replacement on top.
    // Authority: the loop fiber owns the in-memory record; this touches only
    // lastFailure (last-writer-wins there alone), never rounds or threads.
    const noteRouteFailure = (root: string, reason: string): Effect.Effect<void> =>
      Effect.promise(async () => {
        const path = NodePath.join(root, ".studio", "run.json");
        try {
          const current = JSON.parse(await NodeFSP.readFile(path, "utf8")) as StoredRun;
          current.lastFailure = reason;
          await writeJsonAtomic(path, `${JSON.stringify(current, null, 2)}\n`);
        } catch {
          // Never fail a run on bookkeeping.
        }
      }).pipe(Effect.ignore);

    const waitRole = Effect.fn("GameRun.waitRole")(function* (
      root: string,
      projectId: ProjectId,
      threadId: ThreadId,
      runId: RunId | undefined,
      capMs: number,
      continueText: string,
    ): Generator<
      Effect.Effect<unknown, GameRunError>,
      { replaced: boolean; restarts: number; end: string | null },
      never
    > {
      const waited = yield* waitWithWatchdog(projectId, threadId, runId, capMs, continueText);
      const game = yield* needGame("finish-play", String(threadId));
      yield* game
        .finishExploration(threadId)
        .pipe(Effect.mapError(() => fail("finish-play", String(threadId), "close-failed")));
      if (waited.capped) yield* logLine(root, `role cap: ${threadId}; run terminal before handoff`);
      const limit = yield* pauseOnUsageLimit(threadId, waited.runId ?? runId);
      if (limit !== "ok")
        return { replaced: waited.replaced, restarts: waited.restarts, end: limit };
      const outcome = yield* latestOutcome(threadId);
      if (outcome.cls === "usage_limit") {
        yield* noteRouteFailure(root, outcome.reason);
        return { replaced: waited.replaced, restarts: waited.restarts, end: "usage-limit" };
      }
      if (!outcome.instant) {
        routeHealth.consec = 0;
        return { replaced: waited.replaced, restarts: waited.restarts, end: null };
      }
      routeHealth.consec += 1;
      yield* noteRouteFailure(root, outcome.reason);
      yield* logLine(
        root,
        `instant-failed turn (${outcome.reason}) [run-wide ${routeHealth.consec}]`,
      );
      yield* Effect.sleep("30 seconds");
      if (routeHealth.consec >= 8) {
        yield* logLine(root, `provider route down (${outcome.reason}): pausing run`);
        return { replaced: waited.replaced, restarts: waited.restarts, end: "provider-down" };
      }
      return { replaced: waited.replaced, restarts: waited.restarts, end: null };
    });

    // Run one role turn, then a separate writing turn on the same thread, so
    // a report file always exists even when the play turn hits its cap.
    const playThenWrite = Effect.fn("GameRun.playThenWrite")(function* (
      root: string,
      stored: StoredRun,
      creatorThreadId: ThreadId,
      projectId: ProjectId,
      role: string,
      playPrompt: string,
      writePrompt: string,
      playCapMs: number,
      notesRel: string | null,
      notesRoot: string = root,
    ) {
      const continued = "Continue where you left off. Reply briefly, then keep working.";
      const launched = yield* launchRole(
        root,
        stored,
        creatorThreadId,
        projectId,
        role,
        `studio ${role}`,
        playPrompt,
      );
      const play = yield* waitRole(
        root,
        projectId,
        launched.threadId,
        launched.runId,
        playCapMs,
        continued,
      );
      if (play.end !== null)
        return {
          threadId: launched.threadId,
          notes: "",
          wrote: false as const,
          restarts: play.restarts,
          end: play.end,
        };
      let activeThreadId = launched.threadId;
      let restarts = play.restarts;
      if (play.replaced) {
        const retry = yield* launchRole(
          root,
          stored,
          creatorThreadId,
          projectId,
          role,
          `studio ${role} (continued)`,
          `${playPrompt}\n\nA previous thread hung and was replaced. Carry on from the folder state.`,
        );
        activeThreadId = retry.threadId;
        const retryWait = yield* waitRole(
          root,
          projectId,
          retry.threadId,
          retry.runId,
          WRITE_CAP_MS,
          continued,
        );
        restarts += retryWait.restarts;
        if (retryWait.end !== null)
          return {
            threadId: activeThreadId,
            notes: "",
            wrote: false as const,
            restarts,
            end: retryWait.end,
          };
      }
      const game = yield* needGame("finish-play", String(activeThreadId));
      const playEvidence = yield* game
        .finishExploration(activeThreadId)
        .pipe(Effect.mapError(() => fail("finish-play", String(activeThreadId), "close-failed")));
      const writeRunId = yield* sendTurn(
        projectId,
        activeThreadId,
        `Stop playing, now write it. ${writePrompt}`,
      );
      const written = yield* waitRole(
        root,
        projectId,
        activeThreadId,
        writeRunId,
        WRITE_CAP_MS,
        continued,
      );
      if (written.end !== null)
        return {
          threadId: activeThreadId,
          playEvidence,
          notes: "",
          wrote: false as const,
          restarts,
          end: written.end,
        };
      let notes = "";
      if (notesRel !== null) {
        notes = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(notesRoot, notesRel), "utf8").catch(() => ""),
        );
        notes = notes.trim();
      }
      if (notes.trim().length <= 20) {
        const fallback = yield* assistantText(activeThreadId, writeRunId);
        if (fallback.trim().length > 20)
          return {
            threadId: activeThreadId,
            playEvidence,
            notes: fallback,
            wrote: true as const,
            restarts,
            end: null as string | null,
          };
      }
      return {
        threadId: activeThreadId,
        notes,
        playEvidence,
        wrote: (notes.trim().length > 20) as boolean,
        restarts,
        end: null as string | null,
      };
    });

    const gameSourceVersion = (root: string, projectDir: string) =>
      Effect.tryPromise({
        try: (signal) => snapshotBuildSource(root, projectDir, { signal }),
        catch: () => fail("read-progress", root, "game-files-unreadable"),
      }).pipe(
        Effect.flatMap((snapshot) =>
          snapshot.kind === "known"
            ? Effect.succeed(snapshot.sourceId)
            : Effect.fail(fail("read-progress", root, snapshot.reason)),
        ),
      );

    // A finished turn may need follow-up, but two turns without a game-file
    // change end the block instead of replaying a completed task until its cap.
    const builderBlock = Effect.fn("GameRun.builderBlock")(function* (
      root: string,
      stored: StoredRun,
      creatorThreadId: ThreadId,
      projectId: ProjectId,
      tag: string,
      direction: string,
      blockMs: number,
      lane: { dir: string },
    ) {
      const continued = "Continue where you left off. Reply briefly, then keep working.";
      const end = Date.now() + blockMs;
      let versions = yield* gameSourceVersion(root, lane.dir);
      let quietTurns = 0;
      const first =
        `${buildRule(lane.dir)}${SKILL_LINE}\n\nThis block's direction (follow it exactly; play weakness first):\n${direction}\n` +
        `Note learnings in NOTES.md. Do not use subagents. Never commit, never reset git.`;
      const launched = yield* launchRole(
        root,
        stored,
        creatorThreadId,
        projectId,
        `builder-${tag}`,
        `studio builder ${tag}`,
        first,
      );
      let threadId = launched.threadId;
      let runId = launched.runId;
      let turns = 0;
      const failState = { consec: 0, replacements: 0 };
      const replaceThread = function* (why: string) {
        const retry = yield* launchRole(
          root,
          stored,
          creatorThreadId,
          projectId,
          `builder-${tag}`,
          `studio builder ${tag} (continued)`,
          `${first}\n\n${why} Carry on from the folder state.`,
        );
        threadId = retry.threadId;
        runId = retry.runId;
      };
      for (;;) {
        const left = end - Date.now();
        if (left < 120_000) break;
        turns += 1;
        const waited = yield* waitRole(root, projectId, threadId, runId, left, continued);
        if (waited.end !== null) return { threadId, turns, end: waited.end as string | null };
        if (waited.replaced) {
          yield* replaceThread("A previous builder thread hung and was replaced.");
          failState.consec = 0;
          continue;
        }
        // An instantly failed turn never reached the model: back off and
        // retry the direction (never the minutes-left nudge), replace the
        // thread after a few, pause the run when the route stays down.
        const outcome = yield* latestOutcome(threadId);
        if (outcome.instant) {
          const action = yield* handleInstantFail(
            root,
            stored,
            failState,
            outcome.reason,
            outcome.cls,
          );
          if (action === "down") return { threadId, turns, end: "provider-down" as string | null };
          if (action === "usage") return { threadId, turns, end: "usage-limit" as string | null };
          if (action === "replace") {
            yield* replaceThread(
              `The last turns failed before reaching the model (${outcome.reason}).`,
            );
            continue;
          }
          runId = yield* sendTurn(
            projectId,
            threadId,
            `The last turn failed before reaching the model (${outcome.reason}). Continue with this block's direction:\n${direction}\nNo subagents. No commits.`,
          );
          continue;
        }
        failState.consec = 0;
        const after = yield* gameSourceVersion(root, lane.dir);
        const changed = after !== versions;
        quietTurns = changed ? 0 : quietTurns + 1;
        versions = after;
        if (quietTurns >= 2) {
          yield* logLine(
            root,
            `builder ${tag}: finished after two turns without a game-file change (${turns} turns)`,
          );
          break;
        }
        const leftAfter = end - Date.now();
        if (leftAfter < 120_000) break;
        const mins = Math.max(1, Math.round(leftAfter / 60_000));
        runId = yield* sendTurn(
          projectId,
          threadId,
          `${mins} minutes left in this block. Keep going with what's still undone from this block's direction:\n${direction}\nDo not redo what works. No subagents. No commits.`,
        );
      }
      yield* stopTurn(projectId, threadId, runId, "Builder block complete.");
      return { threadId, turns, end: null as string | null };
    });

    // Plain code facts for reviewers. States numbers, never interprets them.
    // The bot's fastest finish is a plain fact with no length target beside
    // it; the reviewer decides what it means.
    const codeFacts = (root: string, lane: { dir: string }): Effect.Effect<string> =>
      Effect.promise(async () => {
        const isWeb = lane.dir !== "godot";
        const codeExts = isWeb ? [".js", ".mjs"] : [".gd"];
        const sources: Array<{ f: string; n: number }> = [];
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const full = NodePath.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (entry.name !== ".godot" && entry.name !== "builds" && entry.name !== "vendor")
                await walk(full);
            } else if (codeExts.some((ext) => entry.name.endsWith(ext))) {
              const text = await NodeFSP.readFile(full, "utf8").catch(() => "");
              sources.push({ f: NodePath.relative(root, full), n: text.split("\n").length });
            }
          }
        };
        await walk(NodePath.join(root, lane.dir));
        sources.sort((a, b) => b.n - a.n);
        const count = async (re: RegExp): Promise<number> => {
          let found = 0;
          const walkFiles = async (dir: string): Promise<void> => {
            for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true }).catch(
              () => [],
            )) {
              const full = NodePath.join(dir, entry.name);
              if (entry.isDirectory()) {
                if (entry.name !== ".godot") await walkFiles(full);
              } else if (re.test(entry.name) && !entry.name.endsWith(".import")) found += 1;
            }
          };
          await walkFiles(NodePath.join(root, lane.dir));
          return found;
        };
        const images = await count(/\.(png|jpg|jpeg|webp|svg)$/i);
        const audio = await count(/\.(wav|ogg|mp3|mid|midi)$/i);
        const models = await count(/\.(glb|gltf|fbx|obj|blend)$/i);
        let refs = 0;
        try {
          const out = await new Promise<string>((resolve) => {
            const child = NodeChildProcess.spawn(
              "grep",
              isWeb
                ? ["-rho", `from\\s*["']\\.\\/[^"']*["']`, NodePath.join(root, lane.dir)]
                : ["-rho", "res://[^\"' )]*", NodePath.join(root, lane.dir)],
              { env: strippedEnv() },
            );
            let text = "";
            child.stdout?.on("data", (chunk: Buffer) => {
              text += chunk.toString("utf8");
            });
            child.on("close", () => resolve(text));
            child.on("error", () => resolve(""));
          });
          refs = out.split("\n").filter(Boolean).length;
        } catch {
          refs = 0;
        }
        const top =
          sources
            .slice(0, 5)
            .map((entry) => `${entry.f} ${entry.n} lines`)
            .join("; ") || (isWeb ? "no js files" : "no gd files");
        const refWord = isWeb ? "relative imports" : "res:// references";
        // Bot-run facts: fastest finish anyone managed, how many runs
        // reached the ending. Testers append one JSON line per game_bot_run.
        let botLine = "no bot runs recorded yet";
        try {
          const lines = (
            await NodeFSP.readFile(NodePath.join(root, ".studio", "bot-results.jsonl"), "utf8")
          )
            .split("\n")
            .filter(Boolean);
          let wins = 0;
          let fastest: number | null = null;
          let total = 0;
          let findings = 0;
          let explores = 0;
          const deciders = new Set<string>();
          for (const line of lines) {
            try {
              const row = JSON.parse(line) as {
                won?: boolean;
                seconds?: number;
                findings?: number;
                mode?: string;
                decider?: string;
              };
              total += 1;
              if (row.mode === "explore") explores += 1;
              if (typeof row.decider === "string") deciders.add(row.decider);
              if (row.won === true) {
                wins += 1;
                if (typeof row.seconds === "number" && (fastest === null || row.seconds < fastest))
                  fastest = row.seconds;
              }
              if (typeof row.findings === "number") findings += row.findings;
            } catch {
              // One bad line never breaks the facts.
            }
          }
          botLine = `${total} bot runs (${explores} exploration, deciders: ${[...deciders].join("/") || "none"}), ${wins} reached the ending${fastest === null ? "" : `, fastest finish ${fastest.toFixed(1)}s`}, ${findings} detector findings`;
        } catch {
          // No bot results yet; leave the default.
        }
        // File-to-use map: art must record which file serves which use plus its
        // source. Code counts entries only; the reviewer judges whether the game
        // actually loads them.
        let artMap = "ASSETS.md missing";
        try {
          const lines = (await NodeFSP.readFile(NodePath.join(root, "ASSETS.md"), "utf8"))
            .split("\n")
            .filter((line) => line.trim().length > 0).length;
          artMap = `ASSETS.md with ${lines} non-empty lines (unverified)`;
        } catch {
          // No map yet; leave the default.
        }
        return `Largest sources: ${top}. Files: ${images} images, ${audio} audio, ${models} 3D models. Code has ${refs} ${refWord}. Bots: ${botLine}. Art map: ${artMap}.`;
      });

    // The tester explores with Jev only when the key is actually there.
    // The value never leaves the secret store; this returns presence alone.
    const hasJevKey = (root: string): Effect.Effect<boolean> =>
      needSecrets("read-key", root).pipe(
        Effect.flatMap((secrets) =>
          secrets.get("game-bot-jev-api-key").pipe(
            Effect.map((found) => Option.isSome(found)),
            Effect.orElseSucceed(() => false),
          ),
        ),
        Effect.orElseSucceed(() => false),
      );

    const readPlayerReport = (root: string): Effect.Effect<string> =>
      Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, ".studio", "player-report.md"), "utf8")
          .then((text) => text.trim().slice(0, 3000))
          .catch(() => ""),
      );

    const bootCheck = Effect.fn("GameRun.bootCheck")(function* (threadId: ThreadId) {
      const game = yield* needGame("boot-check", String(threadId));
      const result = (yield* game
        .check(threadId)
        .pipe(
          Effect.mapError((cause) =>
            fail("boot-check", String(threadId), "check-failed", cause.message),
          ),
        )) as unknown as { ok: boolean };
      if (result.ok) return { ok: true as const, detail: "boot clean" };
      return { ok: false as const, detail: "check failed" };
    });

    // Resume from the persisted recovery point, never from an unjudged HEAD. A
    // crash after commitAll but before appendRound leaves the candidate on HEAD
    // with no record; a dirty stop mid-builder leaves partial work in the tree.
    // Either way the partial work is preserved on its own round branch and the
    // run continues with a verified best, so the candidate is judged instead of
    // silently adopted. A crash after a judged merge (phase 'merged') repeats
    // one honest round with real verdicts instead of stalling; that best is
    // judged, so trusting it is not the unjudged-adoption defect. Returns the
    // best to run with, or fails loudly with work preserved on its branch (the
    // tree may be left on the round branch, never promoted to main).
    const recoverRoundState = (
      root: string,
      stored: StoredRun,
      headBest: string,
    ): Effect.Effect<string, GameRunError> =>
      Effect.gen(function* () {
        const state = yield* readRoundState(root);
        if (state === null) {
          const branch = yield* gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
          if (branch.trim() === "main") return headBest;
          // Off main with no recovery point, the branch tip may be an unjudged
          // candidate: never return it. Main is the judged line (candidates
          // live on round branches), so fall back to it explicitly; without a
          // reachable main, preserve work and fail loudly.
          const mainSha = yield* gitOut(root, ["rev-parse", "main"]);
          if (mainSha.trim().length > 0 && (yield* shaReachable(root, mainSha.trim()))) {
            yield* logLine(
              root,
              `no round recovery point; HEAD on ${branch.trim()}, falling back to main` +
                ` ${mainSha.trim().slice(0, 8)} explicitly`,
            );
            return mainSha.trim();
          }
          const here = branch.trim();
          const key = here.length > 0 && here !== "HEAD" ? here : "recovered-work";
          yield* preserveRecoveryDirt(root, stored, key);
          yield* logLine(
            root,
            `no round recovery point and no reachable main; work preserved on branch;` +
              ` failing loudly`,
          );
          return yield* Effect.fail(fail("recover-round", root, "no-point-no-main", branch));
        }
        if (state.round <= stored.rounds.length) return headBest;
        const reachable = (sha: string): Effect.Effect<boolean> =>
          sha.trim().length > 0 ? shaReachable(root, sha) : Effect.succeed(false as boolean);
        // HEAD here may be the unjudged candidate: only verified shas decide.
        // The round base predates the round's work, so it is a safe baseline
        // even though it was never judged as a candidate.
        const bestOk = yield* reachable(state.bestSha);
        const baseOk = yield* reachable(state.baseSha);
        if (!bestOk && !baseOk) {
          yield* preserveRecoveryDirt(root, stored, state.key);
          yield* logLine(
            root,
            `round state unrecoverable for ${state.key}: best and base unreachable;` +
              ` work preserved on branch; failing loudly`,
          );
          return yield* Effect.fail(fail("recover-round", root, "unreachable-refs", state.key));
        }
        yield* preserveRecoveryDirt(root, stored, state.key);
        const best = bestOk ? state.bestSha : state.baseSha;
        yield* logLine(
          root,
          `recovered ${state.key} (${state.phase}): running with` +
            ` ${bestOk ? "best" : "round base; best unverified"} ${best.slice(0, 8)}` +
            ` for unrecorded round ${state.round}`,
        );
        return best;
      });

    // Snapshot tree dirt onto the given branch: stop any still-live owned role
    // first (its turn may still be writing), prove the branch identity before
    // committing, require the commit, and require the return to main. Any
    // failure ends recovery loudly with work preserved on its branch; the tree
    // may be left on the round branch, never promoted to main.
    const preserveRecoveryDirt = (
      root: string,
      stored: StoredRun,
      key: string,
    ): Effect.Effect<void, GameRunError> =>
      Effect.gen(function* () {
        const dirt = yield* gitOut(root, ["status", "--porcelain=v1", "--", "."]);
        if (dirt.trim().length === 0) return;
        const latest =
          stored.threads.length > 0 ? stored.threads[stored.threads.length - 1] : undefined;
        if (latest !== undefined) {
          // A null result means no live thread; anything live is stopped here.
          yield* liveRoleThread(stored, latest.role).pipe(
            Effect.mapError(() => fail("recover-round", root, "role-stop", latest.role)),
          );
        }
        yield* checkoutBranch(root, key);
        const onBranch = yield* gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (onBranch.trim() !== key)
          return yield* Effect.fail(
            fail(
              "recover-round",
              root,
              "branch-verify",
              `expected ${key}, on ${onBranch.trim() || "?"}`,
            ),
          );
        const sha = yield* commitAll(root, `${key} recovered`);
        const head = yield* gitOut(root, ["rev-parse", "HEAD"]);
        if (sha === null || head.trim() !== sha.trim() || head.trim().length === 0)
          return yield* Effect.fail(
            fail("recover-round", root, "commit-verify", `${key} at ${head.trim() || "?"}`),
          );
        if (!(yield* checkoutRef(root, "main", "recovery cleanup")))
          return yield* Effect.fail(
            fail("recover-round", root, "main-unreachable", `${key} at ${head.trim()}`),
          );
      });

    const runLoop = Effect.fn("GameRun.runLoop")(function* (
      root: string,
      projectId: ProjectId,
      creatorThreadId: ThreadId,
      stored: StoredRun,
    ): Generator<Effect.Effect<unknown, GameRunError>, string, never> {
      yield* ensureGameScaffold(root);
      const lane = yield* laneOf(root);
      const deadline =
        stored.budgetMinutes === null ? Infinity : Date.now() + stored.budgetMinutes * 60_000;
      const remaining = (): number => deadline - Date.now();
      const done = yield* stageDone(root, lane.dir);
      let best = yield* gitOut(root, ["rev-parse", "HEAD"]);
      best = yield* recoverRoundState(root, stored, best);
      let stallStreak = stored.stallStreak;

      // Open one worktree checkout as its own game so a role thread can play
      // a build that is not checked out anywhere else. The thread belongs to
      // that game's project, so its game_* tools play the worktree.
      const openWorktreeGame = Effect.fn("GameRun.openWorktreeGame")(function* (dir: string) {
        const projects = yield* needProjects("open-worktree", dir);
        const selection: ModelSelection = yield* selectionFor(creatorThreadId, stored);
        const opened = (yield* projects
          .open({ path: dir, modelSelection: selection })
          .pipe(
            Effect.mapError((cause) =>
              fail("open-worktree", dir, "project-open", cause.message ?? String(cause)),
            ),
          )) as unknown as { projectId: ProjectId; threadId: ThreadId; root: string };
        return opened;
      });
      // Temporary judge projects are owned by this comparison: once the sample
      // role is terminal and its reports/evidence are retained in memory, delete
      // exactly that project through the project service, then drop its
      // worktree. Unconfirmed termination or delete keeps the worktree for
      // recovery. No raw DB deletes, no arbitrary paths, no sleeps — and no
      // finalization-code changes (the T31 refresh/index-lock causal order is
      // unproven). Never fails: every failure retains and logs.
      const closeSampleProject = (
        root: string,
        label: string,
        projectId: ProjectId,
        threadId: ThreadId,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const retain = (why: string): Effect.Effect<void> =>
            logLine(root, `sample ${label} retained (${why}); keeping worktree`);
          const threadsOpt = yield* Effect.option(needThreads("close-sample", String(threadId)));
          if (threadsOpt._tag === "None") return yield* retain("thread service unavailable");
          const projection = (yield* threadsOpt.value
            .getThreadProjection(threadId)
            .pipe(Effect.orElseSucceed(() => null))) as unknown as {
            thread: { projectId: ProjectId };
            runs: Array<{ id: RunId; status: string }>;
          } | null;
          const latest =
            projection !== null && projection.runs.length > 0
              ? projection.runs[projection.runs.length - 1]
              : undefined;
          if (
            latest === undefined ||
            !TERMINAL_RUN.has(latest.status) ||
            String(projection?.thread.projectId) !== String(projectId)
          )
            return yield* retain("role not terminal");
          const projectsOpt = yield* Effect.option(needProject("close-sample", String(threadId)));
          if (projectsOpt._tag === "None") return yield* retain("project service unavailable");
          const deleted = yield* Effect.option(
            projectsOpt.value.delete({
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              projectId,
              force: true,
            }),
          );
          if (deleted._tag === "None") return yield* retain("project delete unconfirmed");
          yield* dropWorktree(root, label);
        });
      const compareBuilds = Effect.fn("GameRun.compareBuilds")(function* (
        tag: string,
        aSha: string,
        bSha: string,
        question: string,
      ) {
        const comparisonId = `${tag}-${NodeCrypto.randomUUID()}`;
        const sample = Effect.fn("GameRun.playSample")(function* (sha: string) {
          const label = NodeCrypto.randomUUID();
          const playerNotes = `.studio/play-${label}.md`;
          const wt = yield* ensureWorktree(root, sha, label);
          if (wt === null) return null;
          let owned: { projectId: ProjectId; threadId: ThreadId } | null = null;
          return yield* Effect.gen(function* () {
            yield* ensureGameScaffold(wt);
            const opened = yield* openWorktreeGame(wt);
            const played = yield* playThenWrite(
              root,
              stored,
              creatorThreadId,
              opened.projectId,
              `sample-${label}`,
              `${PLAYBOOK}You are independently playing one game build. You do not know its identity or another sample's result. Use real input with game_explore_start/act/close. You have the same six-minute wall allowance and 120-second total in-game input budget as the other player. Aim to use that input budget to investigate the named flaw; multiple sessions share the same 120 seconds. Do not substitute screenshots or bots for hands-on play. Shared question: ${question} Append what you actually did, reached and felt to ${playerNotes}. Include uncertainty and what you did not reach. Judge from play, without reading source files, Git history or earlier reviews. Do not change game files. Do not use subagents.`,
              `Rewrite ${playerNotes} with your actual actions, decisions, failures, boredom, desire to replay, and the furthest state reached. Address the shared question with observations, separating facts from uncertainty. Do not compare to an unseen build or declare a winner. You may only write ${playerNotes}.`,
              JUDGE_CAP_MS,
              playerNotes,
              wt,
            );
            // Reports and evidence are retained in memory from here on, so the
            // temporary project can go once its role is terminal.
            owned = { projectId: opened.projectId, threadId: played.threadId };
            return played;
          }).pipe(
            Effect.catch((cause) =>
              cause.operation === "stop-turn" || cause.operation === "finish-play"
                ? Effect.fail(cause)
                : logLine(root, `sample ${label} could not finish: ${cause.reason}`).pipe(
                    Effect.as(null),
                  ),
            ),
            Effect.onExit((exit) => {
              const target = owned;
              return Exit.isSuccess(exit) && target !== null
                ? closeSampleProject(root, label, target.projectId, target.threadId)
                : logLine(root, `sample ${label} retained for recovery after interrupted handoff`);
            }),
          );
        });
        const playAFirst = NodeCrypto.randomInt(2) === 0;
        const first = yield* sample(playAFirst ? aSha : bSha);
        if (first?.end != null) return { verdict: "NONE", reason: "", end: first.end };
        const second = yield* sample(playAFirst ? bSha : aSha);
        if (second?.end != null) return { verdict: "NONE", reason: "", end: second.end };
        const a = playAFirst ? first : second;
        const b = playAFirst ? second : first;
        const evidenceOf = (played: typeof a) =>
          played !== null && "playEvidence" in played ? (played.playEvidence ?? null) : null;
        const aEvidence = evidenceOf(a);
        const bEvidence = evidenceOf(b);
        const presentAFirst = NodeCrypto.randomInt(2) === 0;
        const evidence = {
          aSha,
          bSha,
          playOrder: playAFirst ? "A,B" : "B,A",
          presentation: presentAFirst ? "A,B" : "B,A",
          A: aEvidence,
          B: bEvidence,
          players: { A: a?.threadId ?? null, B: b?.threadId ?? null },
          reports: { A: a?.notes ?? "", B: b?.notes ?? "" },
        };
        yield* Effect.promise(async () => {
          const dir = NodePath.join(root, ".studio", "comparisons");
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, `${comparisonId}.json`),
            JSON.stringify(evidence, null, 2) + "\n",
          );
        });
        if (
          a === null ||
          b === null ||
          aEvidence === null ||
          bEvidence === null ||
          aEvidence.executedInputSteps === 0 ||
          bEvidence.executedInputSteps === 0
        )
          return {
            verdict: "NONE",
            reason: "Both builds did not receive recorded hands-on input.",
            end: null as string | null,
          };
        if (aEvidence.nominalMs > 120_000 || bEvidence.nominalMs > 120_000)
          return {
            verdict: "NONE",
            reason: "A play sample exceeded the equal 120-second input budget.",
            end: null as string | null,
          };
        const reports = {
          A: `Build A. Recorded play: ${JSON.stringify(aEvidence)}\n${a.notes}`,
          B: `Build B. Recorded play: ${JSON.stringify(bEvidence)}\n${b.notes}`,
        };
        const notesRel = `.studio/comparisons/${comparisonId}.md`;
        const launched = yield* launchRole(
          root,
          stored,
          creatorThreadId,
          projectId,
          `compare-${comparisonId}`,
          "studio blind comparison",
          `Compare these two independent play reports. Shared question: ${question} Which build better handles that flaw, and is better to play overall? Consider uncertainty and unequal observed exposure. The players may have made different choices or mistakes; an outcome difference alone does not prove different game behavior. TIE means no demonstrated preference. Reports are anonymous and their presentation order is randomized; do not prefer a label or position. Use only these reports, not the game folder, sources or Git. Write ${notesRel}. Put exactly one declaration, COMPARE: A or COMPARE: B or COMPARE: TIE, alone on its own line without any other text. Put play-based reasons in a separate paragraph after that line. Do not play or use subagents.\n\n${presentAFirst ? reports.A + "\n\n" + reports.B : reports.B + "\n\n" + reports.A}`,
        );
        const waited = yield* waitRole(
          root,
          projectId,
          launched.threadId,
          launched.runId,
          WRITE_CAP_MS,
          `Finish only ${notesRel} with the comparison and reasons.`,
        );
        if (waited.end !== null) return { verdict: "NONE", reason: "", end: waited.end };
        const readComparison = () =>
          Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, notesRel), "utf8").catch(() => ""),
          );
        let notes = yield* readComparison();
        if (parseCompare(notes) === null) {
          const correction = yield* sendTurn(
            projectId,
            launched.threadId,
            `Correct only the format of ${notesRel}, using the reports already provided. Put your declaration COMPARE: A or COMPARE: B or COMPARE: TIE alone on its own line. Put reasons in a separate paragraph below it. Do not play again or collect new evidence.`,
          );
          const corrected = yield* waitRole(
            root,
            projectId,
            launched.threadId,
            correction,
            WRITE_CAP_MS,
            `Finish only the comparison file ${notesRel}.`,
          );
          if (corrected.end !== null) return { verdict: "NONE", reason: "", end: corrected.end };
          notes = yield* readComparison();
        }
        const lines = notes.split("\n");
        const at = lines.findLastIndex((line) => /^COMPARE:\s*(A|B|TIE)\s*$/i.test(line));
        const reason =
          at < 0
            ? ""
            : lines
                .slice(at + 1)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 500);
        return {
          verdict: parseCompare(notes) ?? "NONE",
          reason,
          notes,
          end: null as string | null,
        };
      });

      const singleStage = Effect.fn("GameRun.singleStage")(function* (
        key: string,
        title: string,
        prompt: string,
        capMs: number,
      ) {
        const current = yield* readStored(root);
        if (current !== null && current.stage !== key && done[key] === true) {
          stored.stage = key;
          yield* writeStored(root, stored);
          return null as string | null;
        }
        const launched = yield* launchRole(
          root,
          stored,
          creatorThreadId,
          projectId,
          key,
          `studio ${title}`,
          prompt,
        );
        const staged = yield* waitRole(
          root,
          projectId,
          launched.threadId,
          launched.runId,
          capMs,
          "Continue where you left off. Reply briefly, then keep working.",
        );
        if (staged.end !== null) return staged.end;
        const sha = yield* commitAll(root, key);
        if (sha !== null && sha !== best) {
          const boot = yield* bootCheck(launched.threadId);
          if (!boot.ok) {
            yield* rejectWork(root, best, key, boot.detail);
          } else {
            best = sha;
          }
        }
        stored.stage = key;
        yield* writeStored(root, stored);
        return null as string | null;
      });

      // 1. Vision.
      if (done.vision !== true) {
        const visionEnd = yield* singleStage(
          "vision",
          "vision",
          `${PLAYBOOK}Read the brief in BRIEF.md (and PROJECT.md when present) and make it yours. Write VISION.md in this folder in your own words: the player's fantasy, the 30-second loop, what makes this one special. Then create one key-art PNG the finished game must live up to (write it with code or your own image tools) and name it in VISION.md. Do not write game code yet. Work only in this folder. Do not use subagents. Never commit.`,
          6 * 60_000,
        );
        if (visionEnd !== null) return visionEnd;
      } else {
        stored.stage = "vision";
        yield* writeStored(root, stored);
      }
      if (yield* stopRequested(root)) return "stopped";

      // 2. Two quick prototypes on branches, then a blind pick by a fresh
      // thread that plays them.
      const protos = done;
      for (let i = 0; i < 2; i += 1) {
        const key = `proto-${i}`;
        if (protos[`proto${i}`] === true) continue;
        const launched = yield* launchRole(
          root,
          stored,
          creatorThreadId,
          projectId,
          key,
          `studio ${key}`,
          `${buildRule(lane.dir)}${SKILL_LINE}Read the brief first. Build the smallest playable core loop in ./${lane.dir} on this branch with placeholder art only: something winnable and losable. Keep the boot clean. Do not use subagents. Do not commit.`,
        );
        const protoWait = yield* waitRole(
          root,
          projectId,
          launched.threadId,
          launched.runId,
          8 * 60_000,
          "Continue where you left off. Reply briefly, then keep working.",
        );
        if (protoWait.end !== null) return protoWait.end;
        yield* checkoutBranch(root, key);
        const sha = yield* commitAll(root, key);
        if (sha !== null) {
          const boot = yield* bootCheck(launched.threadId);
          if (!boot.ok) yield* rejectWork(root, best, key, boot.detail);
        }
        yield* checkoutRef(root, "main", "proto cleanup");
        if (best.length > 0) yield* resetMainTo(root, best);
      }
      if ((yield* stageDone(root, lane.dir)).pick !== true) {
        const usable = (yield* gitOut(root, ["branch", "--list", "--format=%(refname:short)"]))
          .split("\n")
          .map((name) => name.trim())
          .filter((name) => /^(rejected\/)?proto-\d+$/.test(name));
        // Prototype labels, playback order and report presentation are
        // randomized independently; each player sees only one worktree.
        if (usable.length >= 2) {
          const reverse = NodeCrypto.randomInt(2) === 0;
          const aSha = usable[reverse ? 1 : 0]!;
          const bSha = usable[reverse ? 0 : 1]!;
          const pickResult = yield* compareBuilds(
            "pick",
            aSha,
            bSha,
            "Which core loop is better to play and worth building on? Consider decisions, meaningful failure, control, boredom and wanting another go.",
          );
          if (pickResult.end !== null) return pickResult.end;
          if (pickResult.verdict === "A" || pickResult.verdict === "B") {
            const pickText = "notes" in pickResult ? (pickResult.notes ?? "") : "";
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(root, ".studio", "pick.txt"), pickText),
            );
            const verdict = pickResult.verdict;
            const winner = verdict === "B" ? bSha : aSha;
            const adopted = yield* adoptProtoBase(root, winner, verdict, "pick winner");
            if (adopted.mainSha.length > 0) best = adopted.mainSha;
            yield* logLine(
              root,
              adopted.merged && adopted.ancestor
                ? `pick winner ${verdict} adopted at ${adopted.mainSha.slice(0, 8)}`
                : `pick winner ${verdict} not adopted (main ${adopted.mainSha.slice(0, 8) || "unreached"}); staying on best`,
            );
          } else if (pickResult.verdict === "TIE") {
            // TIE compares honestly but creation needs a base: ask the synthesis
            // thread which prototype to continue. A selection, not a win; the tie
            // stays on record and the base merges as unjudged starting material
            // (same semantics as the single-prototype path). An unparsable answer
            // builds from merge-base with the tie recorded instead of looping.
            const compareEntry = [...stored.threads]
              .reverse()
              .find((entry) => entry.role.startsWith("compare-"));
            let selected: string | null = null;
            let selectReasons = "";
            if (compareEntry !== undefined) {
              const selectRunId = yield* sendTurn(
                projectId,
                compareEntry.threadId as ThreadId,
                "The comparison is a tie with no demonstrated preference either way. For continuation only, not a quality verdict: which prototype should the first build extend, A or B, and in what direction? Put exactly one line SELECT: A or SELECT: B alone on its own line, then reasons in a separate paragraph below it. Do not replay or collect new evidence.",
              );
              const selectWaited = yield* waitRole(
                root,
                projectId,
                compareEntry.threadId as ThreadId,
                selectRunId,
                WRITE_CAP_MS,
                "Finish the selection: one SELECT line plus reasons.",
              );
              if (selectWaited.end !== null) return selectWaited.end;
              const selectText = yield* assistantText(
                compareEntry.threadId as ThreadId,
                selectRunId,
              );
              selected = parseSelect(selectText);
              selectReasons = selectText
                .split("\n")
                .filter((line) => !/^SELECT:\s*(A|B)\s*$/i.test(line))
                .join(" ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 500);
            }
            const tieNotes = "notes" in pickResult ? (pickResult.notes ?? "") : "";
            if (selected === "A" || selected === "B") {
              const base = selected === "B" ? bSha : aSha;
              const adopted = yield* adoptProtoBase(root, base, selected, "tie-selected");
              const basedOn =
                adopted.merged && adopted.ancestor
                  ? `${selected} adopted at ${adopted.mainSha.slice(0, 8)}`
                  : `current main ${adopted.mainSha.slice(0, 8) || "unreached"} (base not adopted)`;
              if (adopted.mainSha.length > 0) best = adopted.mainSha;
              yield* Effect.promise(() =>
                NodeFSP.writeFile(
                  NodePath.join(root, ".studio", "pick.txt"),
                  `${tieNotes}\nSELECT: ${selected} (continuation choice on tied comparison; no demonstrated preference)\n${selectReasons}\nBase: ${basedOn}\n`,
                ),
              );
              yield* logLine(
                root,
                adopted.merged && adopted.ancestor
                  ? `pick tie: continuing with ${selected} as unjudged base (${basedOn})`
                  : `pick tie: selection ${selected} recorded but not adopted; building from ${basedOn}`,
              );
            } else {
              yield* Effect.promise(() =>
                NodeFSP.writeFile(NodePath.join(root, ".studio", "pick.txt"), tieNotes),
              );
              yield* logLine(
                root,
                "pick tie unresolved: building from merge-base with tie recorded",
              );
            }
          } else
            yield* logLine(root, "pick incomplete: no prototype selected without play evidence");
        } else if (usable.length === 1) {
          const adopted = yield* adoptProtoBase(root, usable[0]!, "single", "single prototype");
          if (adopted.mainSha.length > 0) best = adopted.mainSha;
          yield* logLine(
            root,
            adopted.merged && adopted.ancestor
              ? `pick single prototype adopted at ${adopted.mainSha.slice(0, 8)}`
              : "pick single prototype not adopted; building from current main",
          );
        }
        stored.stage = "pick";
        yield* writeStored(root, stored);
      }
      if (yield* stopRequested(root)) return "stopped";

      // 3. Plan: PLAN.md with the game's structure, assets, what makes the
      // core experience good, and what done means for the scope the brief
      // asks for. No content list, no length target: quality of what exists
      // is the goal, and adding levels is the creator's job, not the loop's.
      if ((yield* stageDone(root, lane.dir)).plan !== true) {
        const planEnd = yield* singleStage(
          "plan",
          "plan",
          `${TOOL_RULE}${SKILL_LINE}Play the base build first with game_explore_start (default target). Then write PLAN.md: the game's structure, with rules and state separate from presentation so later passes can change it safely; the asset list; what makes the core experience good (how it should play, feel and look); and what done means for the scope the brief asks for. Concrete and short. Plan the depth the core needs; avoid filler and length targets. More content is the creator's choice. Do not write game code. Do not use subagents. Do not commit.`,
          5 * 60_000,
        );
        if (planEnd !== null) return planEnd;
        const sha = yield* commitAll(root, "plan");
        if (sha !== null && sha !== best) best = sha;
      } else {
        stored.stage = "plan";
        yield* writeStored(root, stored);
      }

      // 4. Art. For 3D that means the game_blender_* tools.
      if ((yield* stageDone(root, lane.dir)).art !== true) {
        const artEnd = yield* singleStage(
          "art",
          "art",
          `${TOOL_RULE}${SKILL_LINE}Read VISION.md and look at the key art named there. Render the game's asset set as files in ${lane.dir}/assets (every character, object, tile, background, UI piece and effect the plan needs, with animation frames where things move), plus sound effects and a music loop as audio files, all held to the look of the key art. ${lane.dir === "godot" ? "A 3D game needs real 3D models made with the game_blender_* tools and exported as GLB (rigged characters where they move), then imported and checked in the engine; code-built primitives are placeholders, same as 2D. " : "Code-built meshes and local files only: the export is a static copy, so everything the game needs must be a file under web/. "}Record each file's intended use and source in ASSETS.md as a file-to-use map (one line per file: path, what it depicts, where the game loads it, source and licence). Do not write game code yet. Do not use subagents. Do not commit.`,
          8 * 60_000,
        );
        if (artEnd !== null) return artEnd;
        const sha = yield* commitAll(root, "art");
        if (sha !== null && sha !== best) {
          const boot = yield* bootCheck(creatorThreadId);
          if (!boot.ok) yield* rejectWork(root, best, "art", boot.detail);
          else best = sha;
        }
      } else {
        stored.stage = "art";
        yield* writeStored(root, stored);
      }
      if (yield* stopRequested(root)) return "stopped";

      // 5. Build block.
      if (stored.rounds.length === 0) {
        const blockMs =
          stored.budgetMinutes === null
            ? FULL_BUILD_MS
            : Math.min(FULL_BUILD_MS, remaining() - 24 * 60_000);
        if (blockMs >= 120_000) {
          const buildBlock = yield* builderBlock(
            root,
            stored,
            creatorThreadId,
            projectId,
            "build",
            firstDirection(lane.dir, `${lane.dir}/assets`),
            blockMs,
            lane,
          );
          if (buildBlock.end !== null) return buildBlock.end;
          const sha = yield* commitAll(root, "build");
          if (sha !== null && sha !== best) {
            const boot = yield* bootCheck(creatorThreadId);
            if (!boot.ok) yield* rejectWork(root, best, "build", boot.detail);
            else best = sha;
          }
        }
        stored.stage = "build";
        yield* writeStored(root, stored);
      }

      // 6. Rounds until an ending.
      let round = stored.rounds.length;
      // Pre-durability run.json files have no pending field; normalize once.
      if (stored.pending === undefined) stored.pending = null;
      for (;;) {
        if (yield* stopRequested(root)) return "stopped";
        if (stored.budgetMinutes !== null && remaining() < 4 * 60_000 + 18 * 60_000)
          return "budget";
        round += 1;
        const key = `round-${round}`;
        const roundStart = Date.now();
        const nextMd = yield* readNextMd(root);
        const pickNotes = nextMd.length > 0 ? "" : yield* readPick(root);
        const concreteAsk = `Make the smallest change that fixes the named top play flaw, including a deeper rule or system change when needed. Avoid filler and length targets. Work in game files under ${lane.dir}/; notes, bots and skill files do not count.`;
        const direction =
          nextMd.length > 0
            ? nextMd
            : pickNotes.length > 0
              ? `No review yet. The blind pick of the prototypes reported real play issues; fix the most important one in how the game plays, feels or looks:\n${pickNotes}\n${concreteAsk}`
              : `Read PLAN.md and improve the biggest quality gap in what exists: how it plays, feels and looks, working systems, no bugs. Play weakness first. ${concreteAsk}`;
        const move = direction.slice(0, 300);
        const record: RoundRecord = {
          round,
          move,
          branch: key,
          sweepFindings: 0,
          verdicts: [],
          kept: false,
          durationMs: 0,
          linesChanged: 0,
        };
        // The recovery point goes down before any tree touch: known best, base
        // and the branch partial work belongs to.
        yield* writeRoundState(root, {
          round,
          key,
          baseSha: best,
          bestSha: best,
          phase: "round-start",
        });
        // Every round writes a record or it doesn't count: a blocked start
        // records a real stall round with the reason instead of burning a
        // sleep, and three in a row end the run naming that cause.
        if (!(yield* checkoutRef(root, "main", `round ${round} start`))) {
          const reason = `round ${round}: cannot reach main; stalled (blocked live checkout)`;
          yield* logLine(root, reason);
          record.note = "stalled (cannot reach main; blocked live checkout)";
          record.durationMs = Date.now() - roundStart;
          yield* appendRound(root, stored, record);
          stored.lastFailure = reason;
          stallStreak += 1;
          stored.stallStreak = stallStreak;
          yield* writeStored(root, stored);
          if (stallStreak >= 3) return "stalled";
          continue;
        }
        // Refine an open pending candidate against the same judged base instead
        // of rebuilding from main: enter its branch so the new round branch
        // grows from pending work. Best stays main; promotion still needs a
        // decisive win, and ff-only merge stays viable while main never moves.
        if (stored.pending !== null) {
          const pendingBranch = stored.pending.branch;
          const exists =
            (yield* gitOut(root, ["rev-parse", "--verify", pendingBranch])).trim().length > 0;
          if (!exists) {
            yield* logLine(
              root,
              `round ${round}: pending ${pendingBranch} pruned; continuing from main`,
            );
            stored.pending = null;
          } else {
            yield* checkoutBranch(root, pendingBranch);
            const onBranch = yield* gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
            if (onBranch.trim() !== pendingBranch) {
              yield* logLine(
                root,
                `round ${round}: cannot reach pending ${pendingBranch}; continuing from main`,
              );
              stored.pending = null;
            } else
              yield* logLine(
                root,
                `round ${round}: refining pending ${pendingBranch} against best ${best.slice(0, 8)}`,
              );
          }
        }
        yield* checkoutBranch(root, key);
        const blockMs =
          stored.budgetMinutes === null
            ? BLOCK_MS
            : Math.min(BLOCK_MS, remaining() - 18 * 60_000 - 4 * 60_000);
        if (blockMs < 120_000) return stored.budgetMinutes === null ? "stopped" : "budget";
        const roundBlock = yield* builderBlock(
          root,
          stored,
          creatorThreadId,
          projectId,
          `${round}`,
          direction,
          blockMs,
          lane,
        );
        if (roundBlock.end !== null) return roundBlock.end;
        yield* commitAll(root, key);
        if (!(yield* gameChangedSince(root, best, lane.dir))) {
          // One short replace attempt with a concrete prompt before calling
          // it stalled: the last block changed no game files.
          const retryMs =
            stored.budgetMinutes === null
              ? 6 * 60_000
              : Math.min(6 * 60_000, remaining() - 5 * 60_000);
          if (retryMs >= 120_000) {
            const retry = yield* builderBlock(
              root,
              stored,
              creatorThreadId,
              projectId,
              `${round}b`,
              `The last block changed no game files under ${lane.dir}/. Address the named top flaw now: ${direction} ${concreteAsk} Verify with game_check. No subagents. No commits.`,
              retryMs,
              lane,
            );
            if (retry.end !== null) return retry.end;
            yield* commitAll(root, `${key}-retry`);
          }
        }
        if (!(yield* gameChangedSince(root, best, lane.dir))) {
          yield* checkoutRef(root, "main", `round ${round} stall`);
          yield* logLine(
            root,
            `round ${round}: stalled (no game-code change under ${lane.dir}/ after replace attempt)`,
          );
          record.note = `stalled (no game-code change under ${lane.dir}/ after replace attempt)`;
          record.durationMs = Date.now() - roundStart;
          yield* appendRound(root, stored, record);
          stored.lastFailure = `round ${round}: no game-code change under ${lane.dir}/ after replace attempt`;
          stallStreak += 1;
          stored.stallStreak = stallStreak;
          yield* writeStored(root, stored);
          if (stallStreak >= 3) return "stalled";
          continue;
        }
        const candidate = yield* gitOut(root, ["rev-parse", "HEAD"]);
        const boot = yield* bootCheck(creatorThreadId);
        if (!boot.ok) {
          yield* rejectWork(root, best, key, `boot failed: ${boot.detail}`);
          record.note = `boot failed: ${boot.detail}`.slice(0, 300);
          record.durationMs = Date.now() - roundStart;
          yield* appendRound(root, stored, record);
          stored.lastFailure = `round ${round}: ${record.note}`;
          stallStreak += 1;
          stored.stallStreak = stallStreak;
          yield* writeStored(root, stored);
          if (stallStreak >= 3) return "stalled";
          continue;
        }
        record.linesChanged = yield* gameLinesSince(root, best, lane.dir);

        // Tester: plays, writes bots, tries to reach the ending, plays
        // roughly, writes .studio/tester-<n>.md. The service records every
        // bot run itself in .studio/bot-results.jsonl, so the tester never
        // appends there. With a Jev key the tester also runs exploration
        // (an exploration bot, broad options, no win goal) alongside the
        // win bot; the reviewer gets the resulting player report as facts.
        const jevKey = yield* hasJevKey(root);
        const winBotAsk = jevKey
          ? "Write TWO bots under .studio/bot/: a win bot (goal: win or reach the ending; decider jev when the game suits fast decisions, else policy; run it with game_bot_run, seconds 60) and an exploration bot (goal: try everything; options covering the mechanics broadly, preferring what has not been tried, edge cases and limits; no goal of winning; see the run types in .studio/bot/kit/KIT-GUIDE.md; run it with game_bot_run mode explore, decider jev, seconds 40, runs 3). The service records every run and writes .studio/player-report.md; do not append to .studio/bot-results.jsonl yourself. A note without bot runs does not count."
          : "You must also write or update a bot file under .studio/bot/ for this game and run it at least once with game_bot_run (decider policy unless the game needs jev). The service records every run in .studio/bot-results.jsonl; do not append there yourself. A note without a bot run does not count.";
        const botRunsBefore = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, ".studio", "bot-results.jsonl"), "utf8")
            .then((text) => text.split("\n").filter(Boolean).length)
            .catch(() => 0),
        );
        const tester = yield* playThenWrite(
          root,
          stored,
          creatorThreadId,
          projectId,
          `tester-${round}`,
          `${PLAYBOOK}Play the game in this folder freely: start it with game_explore_start (default target), get past the menu, push as far as you can, try to win and to lose. ${winBotAsk} Play roughly, not gently. After every couple of plays, append what you did and felt to .studio/tester-${round}.md, main complaint first. You may only write that notes file and .studio/bot/ files; do not change game files. Do not use subagents.`,
          `Read .studio/tester-${round}.md. Rewrite the notes file so it states what you did and felt in your own words: decisions, fail, boredom, wanting another go, and your main complaint first. Prior flaw for this round: ${move} State whether it is fixed, partly fixed, or unchanged, with what you did and the furthest state you reached. You may only write that notes file.`,
          TESTER_CAP_MS,
          `.studio/tester-${round}.md`,
        );
        if (tester.end !== null) return tester.end;
        // Duty check: the tester must actually run a bot. When its turns
        // produced no new bot-results line, one follow-up turn says so
        // plainly and asks for the run; T28's testers ran zero bots each.
        const botRunsAfter = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, ".studio", "bot-results.jsonl"), "utf8")
            .then((text) => text.split("\n").filter(Boolean).length)
            .catch(() => 0),
        );
        let testerNotes = tester.notes;
        let testerWrote = tester.wrote;
        if (botRunsAfter <= botRunsBefore) {
          yield* logLine(root, `round ${round}: tester ran no bot; one follow-up turn asks for it`);
          const followRunId = yield* sendTurn(
            projectId,
            tester.threadId,
            "You ended your turn without running any bot, so there is no play evidence. Write or update a bot file under .studio/bot/ for this game now (goal, observe, options, status; see .studio/bot/kit/KIT-GUIDE.md) and run it at least once with game_bot_run, then append what the run showed to your notes file. A note without a bot run does not count.",
          );
          const follow = yield* waitRole(
            root,
            projectId,
            tester.threadId,
            followRunId,
            Math.min(TESTER_CAP_MS, 6 * 60_000),
            "Continue where you left off. Reply briefly, then keep working.",
          );
          if (follow.end !== null) return follow.end;
          testerNotes = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, ".studio", `tester-${round}.md`), "utf8").catch(
              () => testerNotes,
            ),
          );
          if (testerNotes.trim().length > 20) testerWrote = true;
        }
        // Tester bot work joins the round branch: uncommitted tester files
        // would otherwise block the live checkout back to main at merge
        // time (the T29 lighthouse stall: "merge skipped (cannot reach
        // main)"). Ignored harness notes stay out of git as before.
        yield* commitAll(root, key);
        record.testerNote = testerNotes.split("\n").slice(0, 20).join("\n").slice(0, 600);
        if (!testerWrote) record.note = `${record.note ?? ""} tester write failed`.trim();

        const judgeOne = (tag: string, firstSha: string, secondSha: string) =>
          compareBuilds(
            tag,
            firstSha,
            secondSha,
            `The prior reviewer named this unresolved play weakness and direction, not a claim about either build: ${direction}. Is it better handled, and is the game better to play overall?`,
          );
        let order1 = yield* judgeOne(`${key}-1`, candidate, best);
        if (order1.end !== null) return order1.end;
        // A missing verdict gets one retry; a round with no verdicts is
        // never kept as if it had won.
        const retryNone = function* (
          tag: string,
          first: string,
          second: string,
          cur: { verdict: string; reason: string; end: string | null },
        ) {
          if (cur.verdict !== "NONE") return cur;
          yield* logLine(root, `round ${round}: judge ${tag} gave no verdict, retrying once`);
          const retry = yield* judgeOne(`${key}-${tag}r`, first, second);
          if (retry.end !== null) return { verdict: "NONE", reason: "", end: retry.end };
          return retry.verdict !== "NONE" ? retry : cur;
        };
        order1 = yield* retryNone("order 1", candidate, best, order1);
        if (order1.end !== null) return order1.end;
        record.verdicts.push({
          order: "A=candidate,B=best",
          verdict: order1.verdict,
          reason: order1.reason,
        });
        let order2 = yield* judgeOne(`${key}-2`, best, candidate);
        if (order2.end !== null) return order2.end;
        order2 = yield* retryNone("order 2", best, candidate, order2);
        if (order2.end !== null) return order2.end;
        record.verdicts.push({
          order: "A=best,B=candidate",
          verdict: order2.verdict,
          reason: order2.reason,
        });
        const bestWinsBoth = order1.verdict === "B" && order2.verdict === "A";
        const noVerdicts = order1.verdict === "NONE" || order2.verdict === "NONE";
        const candidateWinsBoth = order1.verdict === "A" && order2.verdict === "B";
        let reviewedBuild = "the current best on main";
        if (bestWinsBoth) {
          if (yield* checkoutRef(root, "main", `round ${round} reject`)) {
            if (best.length > 0) yield* resetMainTo(root, best);
          }
          record.kept = false;
          record.note = `${record.note ?? ""} rejected: best won both orders`.trim();
          stored.lastFailure = `round ${round}: rejected, best won both orders`;
          stallStreak += 1;
          stored.pending = null;
          reviewedBuild = "the current best on main (last candidate rejected; best won both)";
        } else if (noVerdicts) {
          if (yield* checkoutRef(root, "main", `round ${round} unjudged`)) {
            if (best.length > 0) yield* resetMainTo(root, best);
          }
          yield* logLine(
            root,
            `round ${round}: no judge verdicts after retry; kept on branch ${key}`,
          );
          record.unjudged = true;
          record.kept = false;
          record.note = `${record.note ?? ""} no judge verdicts after retry; kept on branch`.trim();
          stored.pending = null;
          reviewedBuild = `the current best on main (last round unjudged; its candidate stays on branch ${key})`;
          stored.lastFailure =
            `round ${round}: ${order1.verdict === "NONE" ? order1.reason : order2.reason}`.slice(
              0,
              300,
            );
          stallStreak += 1;
        } else if (!candidateWinsBoth) {
          // Inconclusive (tie or split): a tie is an honest non-finding, never
          // a keep. The judged best stands, the candidate stays on its branch
          // for the record, and the loop continues with the same weakness. No
          // stall increment: judging completed with verdicts.
          const split = `${order1.verdict}/${order2.verdict}`;
          if (yield* checkoutRef(root, "main", `round ${round} inconclusive`)) {
            record.note =
              `${record.note ?? ""} inconclusive (${split}); best stands, kept on branch ${key}`.trim();
          } else {
            record.note =
              `${record.note ?? ""} inconclusive (${split}); cannot reach main; kept on branch`.trim();
          }
          record.kept = false;
          record.inconclusive = true;
          // Open pending line: later rounds refine this candidate against the
          // same judged base instead of rebuilding from main. Three consecutive
          // inconclusives drop the line and count one stall: not converging.
          const streak = (stored.pending !== null ? stored.pending.streak : 0) + 1;
          if (streak >= 3) {
            stored.pending = null;
            stallStreak += 1;
            record.note =
              `${record.note ?? ""} inconclusive (${split}); pending dropped after 3 inconclusive rounds`.trim();
            yield* logLine(root, `round ${round}: pending dropped after 3 inconclusive rounds`);
          } else {
            stored.pending = { branch: key, round, verdicts: record.verdicts, streak };
          }
          reviewedBuild = `the current best on main (last round inconclusive ${split}; its candidate stays on branch ${key} unmerged; the top flaw below is still open)`;
          yield* logLine(
            root,
            `round ${round}: inconclusive ${split}; best stands, kept on branch ${key}`,
          );
        } else if (!(yield* checkoutRef(root, "main", `round ${round} merge`))) {
          yield* logLine(root, `round ${round}: cannot reach main; kept on branch ${key}`);
          record.kept = false;
          record.note =
            `${record.note ?? ""} merge skipped (cannot reach main); kept on branch`.trim();
          stallStreak += 1;
          stored.pending = null;
          reviewedBuild = `the unmerged candidate on branch ${key} (merge skipped: cannot reach main)`;
        } else {
          const merged = yield* gitExec(root, ["merge", "--ff-only", "-q", key], 60_000);
          if (merged.exitCode !== 0) {
            yield* logLine(
              root,
              `round ${round}: merge ${key} failed (${merged.stdout.slice(0, 200)}); kept on branch`,
            );
            record.kept = false;
            record.note = `${record.note ?? ""} merge failed; kept on branch`.trim();
            stallStreak += 1;
            stored.pending = null;
            reviewedBuild = `the unmerged candidate on branch ${key} (merge failed; best on main is unchanged)`;
          } else {
            best = candidate;
            record.kept = true;
            stallStreak = 0;
            stored.pending = null;
            reviewedBuild = "the kept build (just merged to main)";
            // Keep the pre-round base: the fallback needs it exactly when the
            // candidate is unreachable.
            const prevState = yield* readRoundState(root);
            const prevBase = prevState?.baseSha ?? "";
            yield* writeRoundState(root, {
              round,
              key,
              baseSha: prevBase.trim().length > 0 ? prevBase : candidate,
              bestSha: candidate,
              phase: "merged",
            });
          }
        }

        // Reviewer plays, then writes .studio/next.md ending in STATUS.
        // Quality of what exists only: how it plays, feels and looks,
        // working systems, no bugs. Never a push for more levels or length.
        // The reviewer gets the code facts plus the player report (facts
        // from bot runs across the game) among its facts.
        const facts = yield* codeFacts(root, lane);
        const playerText = yield* readPlayerReport(root);
        const playerFacts =
          playerText.length > 0
            ? `\nPlayer report (facts from bot runs across the game, no interpretation):\n${playerText}`
            : "\nNo player report recorded yet.";
        const reviewer = yield* playThenWrite(
          root,
          stored,
          creatorThreadId,
          projectId,
          `reviewer-${round}`,
          `${PLAYBOOK}${SKILL_LINE}Play the game in this folder briefly (a few minutes at most): ${reviewedBuild}. Read PLAN.md and .studio/tester-${round}.md. Code facts: ${facts}.${playerFacts} After every couple of plays, append what you did and felt to .studio/reviewer-${round}.md. You may only write that notes file. Do not change game files. Do not use subagents.`,
          `Read .studio/reviewer-${round}.md. Rewrite the notes file with what you did and felt, then write .studio/next.md with: the biggest weakness in how the game plays, feels or looks; the most important bug or rough edge; how to raise the feel and look; the smallest change that fixes the top flaw, including a deeper rule or system change if needed, without filler or length targets; a DO NOT REGRESS list; the furthest state you reached and what blocked further progress; and as the very last line STATUS: continue or STATUS: ready (ready only if a stranger could pay for this demo today). Prior round worked from: ${move} Verdicts ${order1.verdict}/${order2.verdict} (${record.kept ? "kept" : record.inconclusive === true ? "inconclusive, flaw still open" : "rejected/unjudged"}). State whether that prior flaw is fixed, partly fixed, or unchanged, with what action reached which state. Code facts: ${facts}.${playerFacts} Play weakness first. You may only write .studio/reviewer-${round}.md and .studio/next.md.`,
          REVIEWER_CAP_MS,
          `.studio/reviewer-${round}.md`,
        );
        if (reviewer.end !== null) return reviewer.end;
        if (!reviewer.wrote) record.note = `${record.note ?? ""} reviewer write failed`.trim();
        record.durationMs = Date.now() - roundStart;
        yield* appendRound(root, stored, record);
        stored.stallStreak = stallStreak;
        stored.stage = key;
        yield* writeStored(root, stored);
        if (!record.kept && stallStreak >= 3) return "stalled";

        const nextText = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, ".studio", "next.md"), "utf8").catch(() => ""),
        );
        if (parseStatus(nextText) === "ready") {
          // Fresh ship review plays and writes SHIP: YES|NO. YES finishes;
          // NO goes back into the next round.
          const ship = yield* playThenWrite(
            root,
            stored,
            creatorThreadId,
            projectId,
            `ship-${round}`,
            `${PLAYBOOK}Play the game in this folder to the end if you can. After every couple of plays, append what you did and felt to .studio/ship.md. Do not change files. Do not use subagents.`,
            "Read .studio/ship.md. Rewrite the notes file with what you did and felt, then name the furthest late state actually reached (ending? win or loss? which levels or systems?) and what remains unverified, then end with exactly one line SHIP: YES or SHIP: NO and the reasons. You may only write .studio/ship.md.",
            SHIP_CAP_MS,
            ".studio/ship.md",
          );
          if (ship.end !== null) return ship.end;
          const shipFile = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, ".studio", "ship.md"), "utf8").catch(() => ""),
          );
          const shipText = shipFile.length > 0 ? shipFile : ship.notes;
          if (parseShip(shipText) === "YES") return "ready";
          stored.shipNoReasons =
            shipText
              .split(/SHIP:\s*(YES|NO)/i)
              .pop()
              ?.trim()
              .slice(0, 500) ?? "";
          yield* writeStored(root, stored);
        }
      }
    });

    const finishExports = Effect.fn("GameRun.finishExports")(function* (
      root: string,
      creatorThreadId: ThreadId,
    ) {
      // Exports and final video on any ending. Every outcome lands in the
      // log and in .studio/exports.json with verified on-disk paths (T27b
      // reported the web build missing because nothing recorded where the
      // content-addressed export actually landed). The final video comes
      // from the best real tester or bot run whether or not it won, and the
      // record says which run it came from.
      const game = yield* needGame("export", root);
      // Ask only targets the backend declares, resolved through the service's
      // own engine path (no scope surgery, no directory heuristics). Anything
      // else is recorded skipped with the backend message; other export
      // failures stay failures, never skipped.
      const targets = yield* game
        .exportTargets(creatorThreadId)
        .pipe(
          Effect.catch(() =>
            logLine(root, "finishExports targets unresolved; asking Web and Linux").pipe(
              Effect.as({ targets: ["Web", "Linux"] as const, displayName: "Game" }),
            ),
          ),
        );
      type ExportRow = {
        ok: boolean;
        skipped: null | "unsupported-target";
        message: string;
        path: string | null;
      };
      const runTarget = (target: "Web" | "Linux"): Effect.Effect<ExportRow, GameRunError> =>
        game.export(creatorThreadId, target).pipe(
          Effect.map((result) => ({
            ok: result.success,
            skipped: null as null | "unsupported-target",
            message: result.message,
            path: result.path,
          })),
          Effect.orElseSucceed(() => ({
            ok: false as boolean,
            skipped: null as null | "unsupported-target",
            message: `${target} export errored`,
            path: null as string | null,
          })),
        );
      const skipTarget = (target: "Web" | "Linux"): ExportRow => ({
        ok: false as boolean,
        skipped: "unsupported-target" as const,
        message: `${targets.displayName} games export ${targets.targets.join(", ")} only; ${target} skipped`,
        path: null as string | null,
      });
      const web: ExportRow = targets.targets.includes("Web")
        ? yield* runTarget("Web")
        : skipTarget("Web");
      const linux: ExportRow = targets.targets.includes("Linux")
        ? yield* runTarget("Linux")
        : skipTarget("Linux");
      const nonEmpty = (path: string): Effect.Effect<boolean> =>
        Effect.promise(() =>
          NodeFSP.stat(path)
            .then((stat) => stat.isFile() && stat.size > 4096)
            .catch(() => false),
        );
      // A static three.js entry is a few hundred bytes of HTML; what proves
      // the build is real is the whole directory's substance, not the entry alone.
      const webSubstance = (directory: string): Effect.Effect<boolean> =>
        Effect.promise(async () => {
          let total = 0;
          const stack = [NodePath.join(root, directory)];
          for (let guard = 0; guard < 1000; guard += 1) {
            const current = stack.pop();
            if (current === undefined) break;
            for (const entry of await NodeFSP.readdir(current, { withFileTypes: true }).catch(
              () => [],
            )) {
              const full = NodePath.join(current, entry.name);
              if (entry.isDirectory()) stack.push(full);
              else if (entry.isFile())
                total += (await NodeFSP.stat(full).catch(() => null))?.size ?? 0;
            }
          }
          return total > 4096;
        });
      const webDir = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, "builds/web-selected.json"), "utf8")
          .then((text) => (JSON.parse(text) as { directory?: string }).directory ?? null)
          .catch(() => null),
      );
      const webIndex = webDir === null ? null : NodePath.join(root, webDir, "index.html");
      const webIndexPresent =
        webIndex === null
          ? false
          : yield* Effect.promise(() =>
              NodeFSP.stat(webIndex)
                .then((stat) => stat.isFile() && stat.size > 0)
                .catch(() => false),
            );
      const webOk =
        web.ok &&
        webIndexPresent &&
        webDir !== null &&
        (yield* nonEmpty(webIndex!).pipe(
          Effect.flatMap((entry) => (entry ? Effect.succeed(true) : webSubstance(webDir))),
        ));
      const linuxBin = NodePath.join(root, "builds/linux/game.x86_64");
      const linuxOk = linux.ok && (yield* nonEmpty(linuxBin));
      yield* logLine(
        root,
        `finishExports web ok=${webOk} index=${webIndex ?? "none"} msg=${web.message.slice(0, 200)}`,
      );
      yield* logLine(
        root,
        `finishExports linux ok=${linuxOk} bin=${linuxBin} msg=${linux.message.slice(0, 200)}`,
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, ".studio", "exports.json"),
          `${JSON.stringify({ at: new Date().toISOString(), web: { ...web, index: webIndex, verified: webOk }, linux: { ...linux, bin: linuxBin, verified: linuxOk } }, null, 2)}\n`,
        ).catch(() => undefined),
      );
      // Best real run: fastest win first; otherwise the latest run with a
      // real video, fewest findings breaking ties. Wins or not, the video
      // is real play and the record names its run.
      const botText = yield* Effect.promise(() =>
        NodeFSP.readFile(runPaths(root).botResults, "utf8").catch(() => ""),
      );
      const rows: Array<{
        runId: string;
        seconds: number;
        won: boolean;
        video: string;
        findings: number;
        at: string;
      }> = [];
      for (const line of botText.split("\n").filter(Boolean)) {
        try {
          const row = JSON.parse(line) as {
            runId?: string;
            seconds?: number;
            won?: boolean;
            video?: string;
            findings?: number;
            at?: string;
          };
          if (typeof row.runId === "string" && typeof row.video === "string")
            rows.push({
              runId: row.runId,
              seconds: typeof row.seconds === "number" ? row.seconds : Number.POSITIVE_INFINITY,
              won: row.won === true,
              video: row.video,
              findings: typeof row.findings === "number" ? row.findings : 999,
              at: typeof row.at === "string" ? row.at : "",
            });
        } catch {
          // Skip bad lines.
        }
      }
      const wins = rows.filter((row) => row.won).sort((a, b) => a.seconds - b.seconds);
      const rest = rows
        .filter((row) => !row.won)
        // The longest run shows the most play; a short clean run can be a bot stuck at the menu.
        .sort((a, b) => b.seconds - a.seconds || a.findings - b.findings);
      let picked: (typeof rows)[number] | null = null;
      for (const candidate of [...wins, ...rest]) {
        if (yield* nonEmpty(candidate.video)) {
          picked = candidate;
          break;
        }
      }
      if (picked === null) {
        yield* logLine(root, "finishExports: no bot run video for the final video");
        return;
      }
      const reason =
        picked.won === true
          ? `fastest winning bot run (${picked.seconds.toFixed(1)}s)`
          : `longest non-winning bot run (${picked.seconds.toFixed(1)}s, ${picked.findings} findings; no win recorded)`;
      yield* Effect.promise(() =>
        NodeFSP.copyFile(picked.video, NodePath.join(root, ".studio", "final.mp4")).catch(
          () => undefined,
        ),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, ".studio", "final-video.json"),
          `${JSON.stringify({ runId: picked.runId, video: picked.video, reason, at: new Date().toISOString() }, null, 2)}\n`,
        ).catch(() => undefined),
      );
      yield* logLine(root, `finishExports: final video from run ${picked.runId} (${reason})`);
    });

    const runStart = Effect.fn("GameRun.runStart")(function* (input: {
      readonly threadId: ThreadId;
      readonly brief: string;
      readonly artDirection?: string | undefined;
      readonly budgetMinutes?: number | undefined;
      readonly provider?: string | undefined;
      readonly model?: string | undefined;
      readonly variant?: string | undefined;
    }) {
      const target = yield* resolveGame(input.threadId);
      const root = target.root;
      const projectId = target.projectId;
      if (active.has(root)) {
        const current = yield* readStored(root);
        return {
          runId: current?.runId ?? active.get(root)!.runId,
          root,
          stage: current?.stage ?? "running",
          resumed: true as const,
        };
      }
      let stored = yield* readStored(root);
      let resumed = false;
      // A start is an intent to run: clear a stale stop request first, or
      // the new fiber would end instantly on the previous stop (the panel
      // proved this: Start after Stop ended in under a minute).
      yield* Effect.promise(() =>
        NodeFSP.rm(runPaths(root).stop, { force: true }).catch(() => undefined),
      );
      // Continuable endings resume from the folder (stages it already has
      // are skipped); only a shipped or stalled run starts over.
      const continuable =
        stored !== null &&
        (stored.ending === null ||
          stored.ending === "budget" ||
          stored.ending === "usage-limit" ||
          stored.ending === "provider-down" ||
          stored.ending === "stopped");
      if (continuable) {
        resumed = true;
        const resumedRun = stored as StoredRun;
        if (input.brief.length > 0) resumedRun.brief = input.brief;
        if (input.budgetMinutes !== undefined) resumedRun.budgetMinutes = input.budgetMinutes;
        // A stale ending from the previous fiber would lie about the resumed
        // run (T28 showed `stalled` across resumes); the loop sets it again.
        resumedRun.ending = null;
        yield* reconcileJournal(root, resumedRun);
        yield* writeStored(root, resumedRun);
      } else {
        stored = {
          runId: newRunId(),
          brief: input.brief,
          artDirection: input.artDirection ?? "",
          budgetMinutes: input.budgetMinutes ?? null,
          provider: input.provider ?? null,
          model: input.model ?? null,
          variant: input.variant ?? null,
          startedAt: new Date().toISOString(),
          stage: "starting",
          ending: null,
          stallStreak: 0,
          lastFailure: "",
          shipNoReasons: "",
          rounds: [],
          threads: [],
          pending: null,
        };
        const roundsText = yield* Effect.promise(() =>
          NodeFSP.readFile(runPaths(root).rounds, "utf8").catch(() => ""),
        );
        for (const line of roundsText.split("\n").filter(Boolean)) {
          try {
            stored.rounds.push(JSON.parse(line) as RoundRecord);
          } catch {
            // Skip bad lines.
          }
        }
        yield* writeStored(root, stored);
      }
      if (stored === null)
        return yield* Effect.fail(fail("run-start", root, "state", "The run record is missing."));
      const run = stored;
      // The loop outlives the runStart request, so it gets its own scope:
      // streams inside (thread waits, watches) must not run in the request's
      // scope, which closes as soon as this RPC returns.
      const fiber = yield* Effect.forkDetach(
        Effect.scoped(
          runLoop(root, projectId, input.threadId, run).pipe(
            Effect.tap((ending) =>
              Effect.promise(async () => {
                const current = await readJsonFile<StoredRun | null>(runPaths(root).run, null);
                if (current !== null) {
                  // Authority: only the ending scalar here; rounds were already
                  // journaled by appendRound before the loop returned.
                  current.ending = ending as string;
                  await writeJsonAtomic(
                    runPaths(root).run,
                    `${JSON.stringify(current, null, 2)}\n`,
                  );
                }
              }).pipe(Effect.ignore),
            ),
            Effect.tap(() => finishExports(root, input.threadId).pipe(Effect.ignore)),
            // A failed loop must never end silently (observed: a failed boot check
            // left ending null with no log and no next role). tapCause observes
            // typed failures and defects (verified on the installed runtime);
            // creator-stop interruption bypasses observation taps by construction,
            // so a user stop is never mislabeled as a provider failure. Record
            // plus lastFailure through existing bookkeeping, then let it stand.
            Effect.tapCause((cause) =>
              logLine(root, `run loop failed: ${causeMessage(cause).slice(0, 500)}`).pipe(
                Effect.andThen(() => noteRouteFailure(root, "run loop failed; see run.log")),
                Effect.ignore,
              ),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (active.get(root)?.runId === run.runId) active.delete(root);
              }),
            ),
          ),
        ),
      );
      active.set(root, { fiber, runId: run.runId });
      return { runId: run.runId, root, stage: run.stage, resumed };
    });

    const runStatus = Effect.fn("GameRun.runStatus")(function* (threadId: ThreadId) {
      const target = yield* resolveGame(threadId);
      const stored = yield* readStored(target.root);
      if (stored === null) {
        return {
          active: false as const,
          runId: null as string | null,
          stage: "none",
          ending: null as string | null,
          rounds: [],
          threads: [],
          message: "No run recorded for this game.",
        };
      }
      const running = active.has(target.root);
      // A stop request with no live fiber means the creator stopped the run
      // (runStop interrupts before the fiber can record its ending): report
      // it as stopped rather than "not started".
      const stopped = !running && (yield* stopRequested(target.root));
      const ending = stopped ? "stopped" : stored.ending;
      return {
        active: running,
        runId: stored.runId,
        stage: stored.stage,
        ending,
        rounds: stored.rounds.map((record) => ({
          round: record.round,
          move: record.move,
          branch: record.branch,
          kept: record.kept,
          verdicts: record.verdicts,
          linesChanged: record.linesChanged,
          testerNote: record.testerNote ?? null,
          durationMs: record.durationMs,
          note: record.note ?? null,
        })),
        threads: stored.threads,
        message:
          ending === null
            ? `Run ${stored.runId} at stage ${stored.stage} with ${stored.rounds.length} rounds.${(stored.lastFailure ?? "").length > 0 ? ` Last provider failure: ${stored.lastFailure}` : ""}`
            : `Run ${stored.runId} ended: ${ending}.${(stored.lastFailure ?? "").length > 0 ? ` Last provider failure: ${stored.lastFailure}` : ""}`,
      };
    });

    const runStop = Effect.fn("GameRun.runStop")(function* (threadId: ThreadId) {
      const target = yield* resolveGame(threadId);
      const root = target.root;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          runPaths(root).stop,
          `stopped by the creator at ${new Date().toISOString()}\n`,
        ).catch(() => undefined),
      );
      const running = active.get(root);
      if (running !== undefined) {
        yield* Fiber.interrupt(running.fiber);
        active.delete(root);
      }
      return {
        stopped: true as const,
        message:
          "The run was stopped. Rejected work stays on its branch; the folder holds all state.",
      };
    });

    const toolRole = (caller: { readonly threadId: ThreadId }): Effect.Effect<"run" | null> =>
      Effect.promise(() =>
        readJsonFile<{ role?: string } | null>(callerFile(String(caller.threadId)), null),
      ).pipe(
        Effect.map((marker) => (marker?.role === "run" ? ("run" as const) : null)),
        Effect.orElseSucceed(() => null),
      );

    return GameRun.of({ runStart, runStatus, runStop, toolRole });
  });
  return Layer.effect(GameRun, make);
};

// Shared prompt fragments. Builders write; the harness plays. About 150
// words, names no game, genre or mechanic.
// Role threads have no local engine binaries and must never look for any:
// the game_* MCP tools are the only way to check, play, export, bot-test or
// model anything. Shell Godot/Blender do not exist for these threads.
const TOOL_RULE =
  "You have no local Godot or Blender binaries and must never look for any. Check, play, export, bot-test and model ONLY with the game_* MCP tools (game_check, game_explore_start/act/close, game_bot_run, game_bot_view, game_export, game_blender_*, game_status). ";
const buildRule = (projectDir: string) =>
  `${TOOL_RULE}Make the smallest change that fixes this block's named top flaw. Follow its cause even when it needs a deeper rule or system change. Keep the game bootable; avoid filler and length targets. Use game_check for boot checks and focused play when needed to understand or verify the flaw. The harness independently plays and judges your build afterwards. Work under ${projectDir}/; changes only to notes, bots or skills do not count. Finish when the direction is addressed and report what changed and what remains unverified.`;

const SKILL_LINE = "Read the skill files in ./studio-skills first and follow them. ";
const PLAYBOOK = `${TOOL_RULE}Play first with the game_explore_* tools (default target) and study every frame. The code says what should happen, playing shows what does, and playing wins. Use held-key steps for reliable input, choosing their duration from the observed control response. Observe between adjustments. `;
const firstDirection = (projectDir: string, assetsDir: string) =>
  `Read VISION.md and PLAN.md first. Continue from what is on main (the picked prototype where one was merged): extend its code, do not restart from blank. Build the most important playable part: the full loop, a way to win and lose, sound from the start, using the files in ${assetsDir} for every visual and sound. Load every visual and sound through the ASSETS.md file-to-use map so each file lands where it was made for. Organize as a normal small project a stranger can read and continue: domain scenes/scripts beside presentation, rules and state separate. End with something a player notices in the first minute; game files under ${projectDir}/ only.`;
