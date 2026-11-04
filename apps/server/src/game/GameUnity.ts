// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the native editor process, private display and MCP-stdio boundary; wall-clock pids and CLI JSON envelopes are the domain here.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { GameOperationError, type GameProcessResult } from "@kurambit/contracts";
import * as ServerConfig from "../config.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import {
  alive,
  displayInRange,
  findXvfb,
  memoryShortfall,
  pickDisplay,
  processTreeOf,
  readRecord,
  reapVerified,
  underIdleMemoryFloor,
  type RecordedPid,
} from "./liveProcess.ts";
import {
  UNITY_LICENSE_FAILURE,
  isUnityLicensingClient,
  unityCliEnv,
  unityEditorDir,
  unityEditorEnv,
} from "./unityToolchain.ts";
import { checkoutOf } from "./unityPlayerCache.ts";

const IDLE_MS = 10 * 60_000;
/**
 * Free memory a live Unity editor needs to open, in MB: the editor plus its
 * import worker, compilers and player build tools peaked about 4 GB on a
 * Linux player build here, and editors opened with less were OOM-killed
 * mid-build once other processes grew.
 */
const NEEDED_MB = 4096;
const SESSION_FILE = "session.json";
/** Unity's private displays; Blender and the bot pick from other ranges. */
const DISPLAYS = { first: 251, last: 399 } as const;
/** A first open resolves packages and imports every asset; later opens reuse Library/. */
const READY_TIMEOUT_S = 900;
/**
 * The editor tools agents reach through `unity mcp` (its `--tools` filter).
 * Scene, object, component, prefab, material and settings editing plus C#
 * eval, play mode, capture and console. Builds, tests, packages, jobs and
 * editor lifecycle stay hidden: they belong to Kurambit's own operations.
 */
export const UNITY_MCP_TOOLS = [
  "scene_*",
  "gameobject_*",
  "component_*",
  "prefab_*",
  "material_*",
  "asset_find",
  "asset_create_folder",
  "script_attach",
  "script_eval",
  "settings_tags_layers_*",
  "settings_physics_*",
  "settings_time_*",
  "settings_quality_*",
  "settings_player_get",
  "lighting_get_settings",
  "lighting_set_settings",
  "editor_save_all",
  "editor_status",
  "editor_set_auto_tick",
  "editor_playmode_start",
  "editor_playmode_stop",
  "capture_game_view",
  "capture_scene_view",
  "console_get",
  "console_clear",
] as const;
/** Of those, what `game_unity_edit` may call: the editing surface, by name prefix. */
export const UNITY_EDIT_TOOL =
  /^(scene_|gameobject_|component_|prefab_|material_|asset_find$|asset_create_folder$|script_attach$|settings_|lighting_|editor_save_all$|editor_status$|capture_scene_view$)/;

interface Session {
  readonly root: string;
  readonly projectDir: string;
  readonly display: string;
  readonly editorPid: number;
  readonly xvfbPid: number;
  readonly mcpPid: number;
  readonly client: Client;
  readonly logPath: string;
  lastActive: number;
  /** Calls and operations holding this editor right now; only an idle editor is ever evicted or swept. */
  inFlight: number;
}

/**
 * What a live session left on disk so a later server can reap it: in the
 * game folder, and a copy under the server's state dir so a crashed
 * server's editor is found again even when no one reopens its game.
 */
interface SessionRecord {
  readonly root: string;
  readonly homeDir: string;
  readonly display: string;
  readonly editor: string;
  readonly projectDir: string;
  readonly xvfb: string;
  readonly cli: string;
  readonly editorPid?: number;
  readonly xvfbPid?: number;
  readonly mcpPid?: number;
}

export type McpContent = {
  readonly content?: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }>;
  readonly isError?: boolean;
};

export interface UnityCliResult {
  /** The CLI's JSON envelope `data`, when it printed one. */
  readonly data: unknown;
  readonly ok: boolean;
  /** `errors[0].code` and message from the envelope, when it failed. */
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly process: GameProcessResult;
}

const opError = (
  operation: string,
  path: string,
  reason: GameOperationError["reason"],
  detail?: string,
  cause?: unknown,
): GameOperationError =>
  new GameOperationError({
    operation,
    path,
    reason,
    ...(detail === undefined ? {} : { detail: detail.slice(0, 4000) }),
    ...(cause === undefined ? {} : { cause }),
  });

/** What this server would launch now; a recorded pid must still run one of them. */
interface LiveExecutables {
  /** Every detected editor: a game opens with the one its project version picks. */
  readonly editors: ReadonlyArray<string>;
  readonly cli: string;
  readonly xvfb: string | null;
}

/**
 * A recorded pid is ours only while its argv names the binary this server
 * would launch (from the live toolchain, never the record, which an agent
 * can write) and this session's project or display; a reused pid or a
 * forged record never matches.
 */
const recordedOwners = (
  record: Partial<SessionRecord>,
  homeDir: string,
  live: LiveExecutables,
): ReadonlyArray<RecordedPid> => [
  {
    pid: record.mcpPid,
    owns: (argv) =>
      argv[0] === live.cli &&
      argv[1] === "mcp" &&
      typeof record.projectDir === "string" &&
      argv[argv.indexOf("--project-path") + 1] === record.projectDir,
  },
  {
    pid: record.editorPid,
    owns: (argv) =>
      argv[0] !== undefined &&
      live.editors.includes(argv[0]) &&
      typeof record.projectDir === "string" &&
      argv[argv.indexOf("-projectPath") + 1] === record.projectDir &&
      // The user's own editor (Unity Hub's) may be open on this same project:
      // only the batchmode editor writing this session's log is ours.
      argv.includes("-batchmode") &&
      argv[argv.indexOf("-logFile") + 1] === NodePath.join(homeDir, "editor.log"),
  },
  {
    pid: record.xvfbPid,
    owns: (argv) =>
      live.xvfb !== null &&
      argv[0] === live.xvfb &&
      displayInRange(record.display, DISPLAYS.first, DISPLAYS.last) &&
      argv[1] === record.display,
  },
];

/**
 * Unity starts three out-of-process asset import workers of about 0.7 GB
 * each by default. The count is a per-user setting in
 * UserSettings/EditorUserSettings.asset (gitignored, so a fresh checkout has
 * none); it is written before every start. A desired count of 0 clamps to
 * one worker, the lowest the editor allows; no standby workers are kept.
 */
export const capImportWorkers = async (projectDir: string): Promise<void> => {
  const file = NodePath.join(projectDir, "UserSettings/EditorUserSettings.asset");
  const wanted: Record<string, string> = {
    m_DesiredImportWorkerCount: "0",
    m_StandbyImportWorkerCount: "0",
    m_IdleImportWorkerShutdownDelay: "1000",
  };
  const existing = await NodeFSP.readFile(file, "utf8").catch(() => null);
  if (existing === null) {
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(
      file,
      `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!162 &1\nEditorUserSettings:\n  m_ObjectHideFlags: 0\n  serializedVersion: 5\n${Object.entries(
        wanted,
      )
        .map(([key, value]) => `  ${key}: ${value}\n`)
        .join("")}`,
    );
    return;
  }
  let text = existing;
  for (const [key, value] of Object.entries(wanted)) {
    const line = new RegExp(`^  ${key}: .*$`, "m");
    text = line.test(text)
      ? text.replace(line, `  ${key}: ${value}`)
      : text.replace(/^EditorUserSettings:\n/m, `EditorUserSettings:\n  ${key}: ${value}\n`);
  }
  if (text !== existing) await NodeFSP.writeFile(file, text);
};

/**
 * A killed editor leaves its Unity.DataStore shared memory in /dev/shm, and
 * the next editor on the project hangs before its first refresh trying to
 * reuse it. The segment names carry the namespace this editor logged, so
 * only this project's segments are removed, after its processes are gone.
 */
const dropDataStoreMemory = async (homeDir: string): Promise<void> => {
  const log = await NodeFSP.readFile(NodePath.join(homeDir, "editor.log"), "utf8").catch(() => "");
  const namespace = /Resource namespace: ([0-9a-f]{16,64})/.exec(log)?.[1];
  if (namespace === undefined) return;
  for (const name of await NodeFSP.readdir("/dev/shm").catch(() => [] as string[]))
    if (name.startsWith(`udsMem${namespace}`) || name.startsWith(`sem.udsMem${namespace}`))
      await NodeFSP.rm(NodePath.join("/dev/shm", name), { force: true });
};

/**
 * SIGTERM the recorded pids that verify as ours plus the editor's workers,
 * wait, then SIGKILL stragglers. Of the editor's descendants and process
 * group, only processes running from the pinned editor directory, the pinned
 * CLI or the resolved Xvfb are signalled; a Unity Licensing Client the editor
 * started serves the user's own editors too and is never touched.
 */
const reapRecord = async (
  record: Partial<SessionRecord>,
  homeDir: string,
  live: LiveExecutables,
): Promise<void> => {
  const editorDirs = await Promise.all(
    live.editors.map((editor) => {
      const dir = unityEditorDir(editor);
      return NodeFSP.realpath(dir).catch(() => dir);
    }),
  );
  const keep = (exe: string) =>
    !isUnityLicensingClient(exe) &&
    (editorDirs.some((dir) => exe.startsWith(`${dir}${NodePath.sep}`)) ||
      exe === live.cli ||
      exe === live.xvfb);
  const editorPid = record.editorPid;
  await reapVerified(recordedOwners(record, homeDir, live), {
    waitMs: 15_000,
    pollMs: 200,
    // Taken while the editor still lives: once it exits, its workers reparent.
    tree: async (owned) =>
      editorPid !== undefined && owned.includes(editorPid) ? processTreeOf(editorPid, keep) : [],
  });
  await dropDataStoreMemory(homeDir);
};

export const textOf = (result: McpContent): string =>
  (result.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n");

/** PNG IHDR dimensions without a decoder: width/height at bytes 16/20. */
const pngSize = (bytes: Buffer): { width: number; height: number } | null =>
  bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : null;

/**
 * The capture as an image: either MCP image content or a base64 PNG field in
 * the command's JSON text, whichever the Pipeline version returns.
 */
export const screenshotOf = (
  result: McpContent,
): {
  readonly text: string;
  readonly screenshot?: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
} => {
  let data = (result.content ?? []).find((entry) => entry.type === "image")?.data;
  let text = textOf(result);
  if (data === undefined) {
    const found = /"(?:image|base64|data|png)"\s*:\s*"([A-Za-z0-9+/=]{200,})"/.exec(text);
    if (found?.[1] !== undefined) {
      data = found[1];
      text = text.replace(found[1], "<image attached>");
    }
  }
  if (data === undefined) return { text: text.slice(0, 4000) || "The editor returned no image." };
  const size = pngSize(Buffer.from(data, "base64"));
  if (size === null)
    return { text: `The editor returned an image that is not a PNG. ${text.slice(0, 2000)}` };
  return {
    text: text.slice(0, 4000) || "See the attached Game view.",
    screenshot: { mimeType: "image/png", data, ...size },
  };
};

const stringEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
};

const withCliFlags = (args: ReadonlyArray<string>, flags: ReadonlyArray<string>): string[] => {
  const fence = args.indexOf("--");
  return fence < 0
    ? [...args, ...flags]
    : [...args.slice(0, fence), ...flags, ...args.slice(fence)];
};

/** The CLI prints one JSON envelope; editor log lines may precede it. */
export const parseCliEnvelope = (
  stdout: string,
): {
  success: boolean;
  data: unknown;
  errors: Array<{ code?: string; message?: string }>;
} | null => {
  const start = stdout.indexOf("{");
  for (let at = start; at >= 0; at = stdout.indexOf("{", at + 1)) {
    try {
      const parsed = JSON.parse(stdout.slice(at)) as Record<string, unknown>;
      if (typeof parsed === "object" && parsed !== null && "success" in parsed)
        return {
          success: parsed["success"] === true,
          data: parsed["data"],
          errors: Array.isArray(parsed["errors"])
            ? (parsed["errors"] as Array<{ code?: string; message?: string }>)
            : [],
        };
    } catch {
      /* not the envelope yet */
    }
  }
  return null;
};

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/**
 * Left out of the copy: files that name the editor that wrote them, and the
 * compiled-script state keyed by the main checkout's path. The worktree
 * recompiles its scripts in any case; built from the copied state, its player
 * lost the scene's MonoBehaviours ("referenced script is missing").
 */
const LIBRARY_NOT_COPIED = [
  "Pipeline/.unity-pipeline-port",
  "EditorInstance.json",
  "ilpp.pid",
  "burst.pid",
  "Bee",
  "ScriptAssemblies",
  "ScriptMapper",
  "MonoManager.asset",
  "BuildPlayerData",
  "PlayerDataCache",
];

/**
 * Whether any process on this machine has `projectDir` open as a Unity
 * project: the user's own editor, or another Kurambit server's. Paths are
 * compared real (git reports the main checkout through symlinks resolved, an
 * editor may name it through a link), and a relative -projectPath is read
 * against that process's own working directory. Read-only: it reads /proc
 * and signals nothing.
 */
const editorHasProjectOpen = async (projectDir: string): Promise<boolean> => {
  const real = (path: string) => NodeFSP.realpath(path).catch(() => NodePath.resolve(path));
  const want = await real(projectDir);
  for (const pid of await NodeFSP.readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(pid)) continue;
    const raw = await NodeFSP.readFile(`/proc/${pid}/cmdline`).catch(() => null);
    if (raw === null || raw.length === 0) continue;
    const args = raw.toString("utf8").split("\0");
    const at = args.findIndex((arg) => arg.toLowerCase() === "-projectpath");
    const value = at >= 0 ? args[at + 1] : undefined;
    if (value === undefined || value === "") continue;
    const cwd = await NodeFSP.readlink(`/proc/${pid}/cwd`).catch(() => "/");
    if ((await real(NodePath.resolve(cwd, value))) === want) return true;
  }
  return false;
};

/**
 * A worktree checkout starts with no Library/, which would cost a full asset
 * import. It gets a copy-on-write copy of its main checkout's import cache
 * instead, so Unity reimports only what differs at this commit. The copy
 * lands whole or not at all, and removing the worktree removes it. Answers
 * why it did not copy, or null when it did: while any editor has the main
 * project open (the user's own, or another server's; ours is reaped before
 * this) its asset database may be mid-write, so the worktree imports cold.
 */
const seedLibrary = async (
  mainProjectDir: string,
  projectDir: string,
  scratch: string,
): Promise<string | null> => {
  const target = NodePath.join(projectDir, "Library");
  if ((await NodeFSP.stat(target).catch(() => null)) !== null) return "it already has one";
  const source = NodePath.join(mainProjectDir, "Library");
  if (!(await NodeFSP.stat(source).catch(() => null))?.isDirectory())
    return "the main checkout has none yet";
  if (await editorHasProjectOpen(mainProjectDir))
    return "a Unity editor has the main checkout open, so its import cache may be mid-write";
  const staging = NodePath.join(scratch, `library-${NodeCrypto.randomUUID()}`);
  try {
    await execFile("cp", ["-a", "--reflink=auto", "--", source, staging], {
      timeout: 15 * 60_000,
    });
    for (const name of LIBRARY_NOT_COPIED)
      await NodeFSP.rm(NodePath.join(staging, name), { recursive: true, force: true });
    await NodeFSP.rename(staging, target);
    return null;
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
};

export class GameUnity extends Context.Service<
  GameUnity,
  {
    /**
     * Run `effect` holding this game's live editor: open and ready (a
     * batchmode editor on a private display with the Pipeline package
     * serving), and never evicted or swept while held. Only one Unity editor
     * runs on this server; opening one closes another only while it is idle,
     * and fails `busy` naming the game that holds it otherwise.
     */
    readonly hold: (
      root: string,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | GameOperationError, R>;
    /** One `unity <args> --format json` against this game's live editor. */
    readonly cli: (
      root: string,
      args: ReadonlyArray<string>,
      options: { readonly operation: string; readonly timeoutMs: number },
    ) => Effect.Effect<UnityCliResult, GameOperationError>;
    /** One `unity mcp` tool call against this game's live editor. */
    readonly call: (
      root: string,
      name: string,
      args: Record<string, unknown>,
      timeoutMs?: number,
    ) => Effect.Effect<McpContent, GameOperationError>;
    /** The editing tools `game_unity_edit` may call, with their input schemas. */
    readonly tools: (root: string) => Effect.Effect<
      ReadonlyArray<{
        readonly name: string;
        readonly description: string;
        readonly input: unknown;
      }>,
      GameOperationError
    >;
    /** The live editor's log tail, for honest failure detail. */
    readonly logTail: (root: string) => Effect.Effect<string>;
    /** Close this game's live editor (by recorded pid only); game_stop calls this. */
    readonly stop: (root: string) => Effect.Effect<void>;
  }
>()("kurambit/game/GameUnity") {}

const make = Effect.gen(function* () {
  const processes = yield* GameProcesses.GameProcesses;
  const tools = yield* GameToolchain.GameToolchain;
  const projects = yield* GameProjectService.GameProjectService;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const sessions = new Map<string, Session>();
  // Opening an editor takes minutes; two callers for one game must share it.
  const openLock = Semaphore.makeUnsafe(1);
  // The CLI path and its HOME never depend on which editor a game picks.
  const install = yield* tools.unityExecutables;
  const serverRecords = NodePath.join(stateDir, "unity-live");

  const homeDirOf = (root: string) => NodePath.join(root, "builds/logs/unity-live");
  const serverRecordOf = (root: string) =>
    NodePath.join(
      serverRecords,
      `${NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 24)}.json`,
    );
  const liveExecutables = (): Effect.Effect<LiveExecutables> =>
    tools.unityExecutables.pipe(
      Effect.flatMap((unity) =>
        Effect.promise(async () => ({
          editors: unity.editors,
          cli: unity.cli,
          xvfb: await findXvfb(),
        })),
      ),
    );

  const projectDirOf = (root: string) =>
    projects
      .read(root)
      .pipe(Effect.map((manifest) => GameProjectService.insideGame(root, manifest.godotProject)));

  /**
   * Reaps one record file and removes it; a missing or unreadable record
   * reaps nothing. The game-folder copy is writable by the game's agents, so
   * it is trusted only while it names this game and its own Unity project.
   */
  const reapFile = async (
    file: string,
    homeDir: string,
    live: LiveExecutables,
    expected?: { readonly root: string; readonly projectDir: string | null },
  ) => {
    const record = await readRecord<SessionRecord>(file);
    if (
      record !== null &&
      (expected === undefined ||
        (record.root === expected.root && record.projectDir === expected.projectDir))
    )
      await reapRecord(record, homeDir, live);
    await NodeFSP.rm(file, { force: true });
  };

  /** Ends the in-memory session, then reaps whatever its records still name (a previous server's session included). */
  const drop = (root: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const projectDir = yield* projectDirOf(root).pipe(Effect.orElseSucceed(() => null));
      const live = yield* liveExecutables();
      yield* Effect.promise(async () => {
        const session = sessions.get(root);
        if (session !== undefined) {
          sessions.delete(root);
          void session.client.close().catch(() => undefined);
        }
        await reapFile(NodePath.join(homeDirOf(root), SESSION_FILE), homeDirOf(root), live, {
          root,
          projectDir: session?.projectDir ?? projectDir,
        });
        await reapFile(serverRecordOf(root), homeDirOf(root), live);
      });
    });

  // An editor orphaned by a crashed server is found through the server's own
  // copy of its record, whether or not its game is ever opened again.
  const startupLive = yield* liveExecutables();
  yield* Effect.promise(async () => {
    const live = startupLive;
    for (const name of await NodeFSP.readdir(serverRecords).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const file = NodePath.join(serverRecords, name);
      const record = await readRecord<SessionRecord>(file);
      if (record !== null && typeof record.homeDir === "string")
        await reapRecord(record, record.homeDir, live);
      await NodeFSP.rm(file, { force: true });
    }
  });

  const runCli = (
    root: string,
    cli: string,
    args: ReadonlyArray<string>,
    options: { readonly operation: string; readonly timeoutMs: number },
  ) =>
    processes
      .run({
        root,
        executable: cli,
        // CLI flags must precede the `--` fence; after it, every flag is a
        // Pipeline command parameter.
        args: withCliFlags(args, ["--format", "json"]),
        operation: options.operation,
        timeoutMs: options.timeoutMs,
        env: unityCliEnv(install.cliHome),
        envMode: "replace",
      })
      .pipe(
        Effect.flatMap((run) =>
          // Large reports (a build status lists every step and file) outgrow
          // the 64 KB stdout tail; the operation log holds the whole envelope.
          parseCliEnvelope(run.stdout) !== null
            ? Effect.succeed({ run, stdout: run.stdout })
            : Effect.promise(() =>
                NodeFSP.readFile(run.logPath, "utf8")
                  .catch(() => run.stdout)
                  .then((text) => ({ run, stdout: text })),
              ),
        ),
        Effect.map(({ run, stdout }): UnityCliResult => {
          const envelope = parseCliEnvelope(stdout);
          const first = envelope?.errors[0];
          return {
            data: envelope?.data ?? null,
            ok: run.exitCode === 0 && !run.timedOut && envelope?.success !== false,
            errorCode: first?.code ?? null,
            errorMessage: first?.message ?? null,
            process: run,
          };
        }),
      );

  const editorLog = (root: string) =>
    Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(homeDirOf(root), "editor.log"), "utf8").catch(() => ""),
    );

  const logTail = (root: string) => editorLog(root).pipe(Effect.map((text) => text.slice(-3000)));

  const gameName = (root: string) =>
    projects.read(root).pipe(
      Effect.map((manifest) => manifest.name),
      Effect.orElseSucceed(() => NodePath.basename(root)),
    );

  /**
   * The game's ready session, counted as held: `take` runs synchronously
   * with the count going up, under the open lock, so no other game's open
   * can see this session idle between the lookup and the hold.
   */
  const acquire = (
    root: string,
    take: (session: Session) => void,
  ): Effect.Effect<Session, GameOperationError> =>
    openLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const existing = sessions.get(root);
        if (
          existing !== undefined &&
          alive(existing.editorPid) &&
          alive(existing.xvfbPid) &&
          (existing.inFlight > 0 || now - existing.lastActive < IDLE_MS)
        ) {
          existing.lastActive = now;
          take(existing);
          return existing;
        }
        // The production run plays blind samples in git worktrees of the game.
        const checkout = yield* Effect.promise(() => checkoutOf(root));
        if (checkout.kind === "other")
          return yield* opError(
            "unity-live",
            root,
            "invalid-input",
            `This Unity game folder is a git checkout that is not a worktree of a game folder (${checkout.detail}), such as a submodule. The live Unity editor opens a game's own folder or a git worktree of it; open the game from its own folder.`,
          );
        const projectDir = yield* projectDirOf(root);
        const unity = yield* tools.unity(projectDir);
        if (unity.upgradesProject !== null)
          yield* Effect.logWarning("Unity project opens in a newer editor", {
            root,
            project: unity.upgradesProject,
            editor: unity.version,
          });
        // One Unity editor per server: a second one would double a 2-3 GB
        // process and fight the first for the Licensing Client. An editor in
        // use is never closed under its caller.
        for (const [otherRoot, other] of Array.from(sessions))
          if (otherRoot !== root && other.inFlight > 0) {
            const [mine, theirs] = yield* Effect.promise(() =>
              Promise.all([checkoutOf(root), checkoutOf(otherRoot)]),
            );
            // A production run builds its blind samples in worktrees of the
            // game; stopping one from the game's own thread would not free the
            // editor and would sabotage the run.
            const sameGame =
              (theirs.kind === "linked" &&
                NodePath.resolve(theirs.main) === NodePath.resolve(root)) ||
              (mine.kind === "linked" &&
                NodePath.resolve(mine.main) === NodePath.resolve(otherRoot));
            return yield* opError(
              "unity-live",
              root,
              "busy",
              sameGame
                ? "The live Unity editor is busy: the production run is building a copy of this game in a worktree to play it blind. Only one Unity editor runs at a time; retry in a few minutes, or steer the run with game_run_steer."
                : `The live Unity editor is busy with the game "${yield* gameName(otherRoot)}" (${otherRoot}); only one Unity editor runs at a time. Retry when that game's Unity work finishes, or stop it with game_stop there.`,
            );
          }
        for (const otherRoot of Array.from(sessions.keys())) yield* drop(otherRoot);
        yield* drop(root);
        const xvfbPath = yield* Effect.promise(findXvfb);
        if (xvfbPath === null)
          return yield* opError(
            "unity-live",
            "Xvfb",
            "tool-missing",
            "Xvfb is needed for the live Unity editor's private display. Install the system Xvfb package (or set KURAMBIT_XVFB).",
          );
        // After the drops above, so an editor this server just closed counts as free.
        const short = yield* Effect.promise(() =>
          memoryShortfall("live Unity editor", NEEDED_MB, "KURAMBIT_UNITY_MEMORY_MB"),
        );
        if (short !== null) return yield* opError("unity-live", root, "low-memory", short);
        const homeDir = homeDirOf(root);
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(homeDir, { recursive: true });
            await NodeFSP.mkdir(serverRecords, { recursive: true });
            await NodeFSP.mkdir(install.cliHome, { recursive: true });
            await capImportWorkers(projectDir);
            // Every earlier editor for this game was reaped above.
            await dropDataStoreMemory(homeDir);
          },
          catch: (cause) => opError("unity-live", homeDir, "io", undefined, cause),
        });
        // After the drops above: the main checkout's editor is closed, so its
        // import cache is copied whole.
        if (checkout.kind === "linked") {
          const notSeeded = yield* Effect.tryPromise({
            try: () =>
              seedLibrary(
                NodePath.join(checkout.main, NodePath.relative(root, projectDir)),
                projectDir,
                NodePath.dirname(homeDir),
              ),
            catch: (cause) =>
              opError(
                "unity-live",
                NodePath.join(projectDir, "Library"),
                "io",
                `Could not copy the import cache (Library/) of ${checkout.main} into this worktree. ${cause instanceof Error ? cause.message : ""}`,
                cause,
              ),
          });
          if (notSeeded !== null && notSeeded !== "it already has one")
            yield* Effect.logWarning("Unity worktree imports cold", { root, reason: notSeeded });
        }
        const displayNum = yield* Effect.promise(() => pickDisplay(DISPLAYS.first, DISPLAYS.last));
        if (displayNum === null)
          return yield* opError(
            "unity-live",
            root,
            "busy",
            `No free private Xvfb display (:${DISPLAYS.first}–:${DISPLAYS.last}).`,
          );
        const display = `:${displayNum}`;
        let record: SessionRecord = {
          root,
          homeDir,
          display,
          editor: unity.editor,
          projectDir,
          xvfb: xvfbPath,
          cli: unity.cli,
        };
        // Written as each pid appears, so a crash mid-start still leaves the
        // next open or game_stop something to reap.
        const remember = (pids: Partial<SessionRecord>) =>
          Effect.tryPromise({
            try: async () => {
              record = { ...record, ...pids };
              const text = JSON.stringify(record);
              await NodeFSP.writeFile(NodePath.join(homeDir, SESSION_FILE), text);
              await NodeFSP.writeFile(serverRecordOf(root), text);
            },
            catch: (cause) => opError("unity-live", SESSION_FILE, "io", undefined, cause),
          });
        const fail = (detail: string, reason: GameOperationError["reason"] = "command-failed") =>
          Effect.gen(function* () {
            yield* drop(root);
            return yield* opError("unity-live", root, reason, detail);
          });
        const xvfb = NodeChildProcess.spawn(
          xvfbPath,
          [display, "-screen", "0", "1280x720x24", "-nolisten", "tcp"],
          {
            env: GameProcesses.engineChildEnv(),
            detached: true,
            stdio: "ignore",
          },
        );
        xvfb.unref();
        if (xvfb.pid === undefined) return yield* fail("Xvfb did not start.", "io");
        const xvfbPid = xvfb.pid;
        yield* remember({ xvfbPid });
        const logPath = NodePath.join(homeDir, "editor.log");
        const editor = yield* Effect.sync(() => {
          // The editor leads its own process group so a stop takes its
          // asset-import workers and shader compilers with it.
          const child = NodeChildProcess.spawn(
            unity.editor,
            [
              "-batchmode",
              "-projectPath",
              projectDir,
              "-logFile",
              logPath,
              "-force-glcore",
              // Caps the job system's worker threads (the log confirms
              // "Creating JobQueue using job-worker-count value 2").
              "-job-worker-count",
              "2",
            ],
            {
              cwd: root,
              env: unityEditorEnv({ DISPLAY: display, LIBGL_ALWAYS_SOFTWARE: "1" }),
              detached: true,
              stdio: "ignore",
            },
          );
          child.unref();
          return child;
        });
        const editorPid = editor.pid;
        if (editorPid === undefined) return yield* fail("The Unity editor did not start.", "io");
        yield* remember({ editorPid });
        // A batchmode editor that cannot open the project (compile errors, a
        // licence refusal) exits within seconds; the CLI would still wait out
        // its whole timeout for an editor that is gone.
        const exited = Effect.callback<null>((resume) => {
          const done = () => resume(Effect.succeed(null));
          if (editor.exitCode !== null || editor.signalCode !== null) return done();
          editor.once("exit", done);
          return Effect.sync(() => editor.off("exit", done));
        });
        const ready = yield* Effect.raceFirst(
          runCli(
            root,
            unity.cli,
            [
              "status",
              "--until-ready",
              "--project-path",
              projectDir,
              "--timeout",
              String(READY_TIMEOUT_S),
            ],
            { operation: "unity-ready", timeoutMs: (READY_TIMEOUT_S + 30) * 1000 },
          ),
          exited,
        );
        if (ready === null || !ready.ok || !alive(editorPid)) {
          const tail = yield* logTail(root);
          if (UNITY_LICENSE_FAILURE.test(tail))
            return yield* fail(
              `The Unity editor refused to start without a valid licence. ${tail
                .split("\n")
                .filter((line) => UNITY_LICENSE_FAILURE.test(line))
                .slice(0, 3)
                .join(" ")}`,
              "license-missing",
            );
          // The errors are what the agent acts on; the log repeats each one
          // several times and its tail often ends past them.
          const errors = [
            ...new Set((yield* editorLog(root)).match(/^[^\n]*error CS\d{4}:[^\n]*$/gm) ?? []),
          ].slice(0, 6);
          const compile =
            errors.length > 0 || /error CS\d{4}/.test(tail)
              ? ` C# compile errors stop it opening the project; fix them and retry:\n${errors.join("\n")}\n`
              : "";
          return yield* fail(
            ready === null
              ? `The Unity editor exited before it was ready (exit ${editor.exitCode ?? editor.signalCode}).${compile} Editor log: ${logPath}\n${tail.slice(-1500)}`
              : `The Unity editor did not become ready (${ready.errorCode ?? `exit ${ready.process.exitCode}`}: ${ready.errorMessage ?? "no answer"}).${compile} Editor log: ${logPath}\n${tail.slice(-1500)}`,
          );
        }
        // A batchmode editor starts on an untitled scene; edits, saves and the
        // camera capture all belong to the game's main scene.
        const manifest = yield* projects.read(root);
        yield* runCli(
          root,
          unity.cli,
          [
            "command",
            "scene",
            "open",
            "--project-path",
            projectDir,
            "--",
            "--path",
            manifest.gameplayScene ?? "Assets/Scenes/Main.unity",
          ],
          { operation: "unity-open-scene", timeoutMs: 120_000 },
        );
        const mcpLog = NodeFS.openSync(NodePath.join(homeDir, "mcp.log"), "w");
        const transport = new StdioClientTransport({
          command: unity.cli,
          args: ["mcp", "--project-path", projectDir, "--tools", UNITY_MCP_TOOLS.join(",")],
          env: stringEnv(unityCliEnv(install.cliHome)),
          stderr: mcpLog,
        });
        const client = new Client({ name: "kurambit-game-unity", version: "1.0.0" }, {});
        yield* Effect.tryPromise({
          try: () => client.connect(transport),
          catch: (cause) =>
            opError(
              "unity-live",
              root,
              "command-failed",
              "Could not start `unity mcp` over stdio.",
              cause,
            ),
        }).pipe(
          Effect.tapError(() => drop(root)),
          Effect.ensuring(Effect.sync(() => NodeFS.closeSync(mcpLog))),
        );
        const mcpPid = transport.pid;
        if (mcpPid === null) {
          void client.close().catch(() => undefined);
          return yield* fail(
            "`unity mcp` connected but reported no pid, so it could not be stopped later.",
            "io",
          );
        }
        yield* remember({ mcpPid });
        const session: Session = {
          root,
          projectDir,
          display,
          editorPid,
          xvfbPid,
          mcpPid,
          client,
          logPath,
          lastActive: yield* Clock.currentTimeMillis,
          inFlight: 0,
        };
        sessions.set(root, session);
        take(session);
        return session;
      }),
    );

  const withSession = <A, E, R>(
    root: string,
    use: (session: Session) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | GameOperationError, R> =>
    Effect.suspend(() => {
      let held: Session | null = null;
      return acquire(root, (session) => {
        session.inFlight += 1;
        held = session;
      }).pipe(
        Effect.flatMap(use),
        Effect.ensuring(
          Effect.gen(function* () {
            const session: Session | null = held;
            if (session === null) return;
            session.inFlight -= 1;
            session.lastActive = yield* Clock.currentTimeMillis;
          }),
        ),
      );
    });

  /**
   * Waits until the editor's Pipeline server answers again. A recompile that
   * adds or changes scripts reloads the domain, and play mode does too; the
   * server is gone for a few seconds and calls in that window fail.
   */
  const waitReady = (root: string, session: Session) =>
    runCli(
      root,
      install.cli,
      ["status", "--until-ready", "--project-path", session.projectDir, "--timeout", "180"],
      { operation: "unity-ready", timeoutMs: 200_000 },
    );
  const RELOADING =
    /socket hang up|No Pipeline instance found|ECONNREFUSED|ECONNRESET|EDITOR_NOT_READY|not ready/i;

  const attempt = (
    session: Session,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ) =>
    Effect.tryPromise({
      try: () =>
        session.client.callTool({ name, arguments: args }, undefined, {
          timeout: timeoutMs,
          resetTimeoutOnProgress: true,
          onprogress: () => undefined,
        }) as Promise<McpContent>,
      catch: (cause) =>
        opError(
          "unity-live",
          name,
          "command-failed",
          cause instanceof McpError && cause.code === ErrorCode.RequestTimeout
            ? `The Unity editor did not answer '${name}' within ${Math.round(timeoutMs / 1000)}s. It may still be working; read the scene before retrying.`
            : `The Unity editor did not answer '${name}'. ${cause instanceof Error ? cause.message : ""}`,
          cause,
        ),
    });

  const call: GameUnity["Service"]["call"] = (root, name, args, timeoutMs = 2 * 60_000) =>
    withSession(root, (session) =>
      Effect.gen(function* () {
        let result = yield* attempt(session, name, args, timeoutMs);
        // One retry after the editor is ready again: a domain reload is not
        // the agent's error, and the call never reached the editor.
        if (result.isError === true && RELOADING.test(textOf(result))) {
          yield* waitReady(root, session);
          result = yield* attempt(session, name, args, timeoutMs);
        }
        if (result.isError === true)
          return yield* opError(
            "unity-live",
            name,
            "command-failed",
            textOf(result).trim() || `The Unity editor reported an error for '${name}'.`,
          );
        return result;
      }),
    );

  // Idle sessions die on a sweep so one forgotten game cannot hold a 2-3 GB
  // editor and its display forever, and close early when the machine runs
  // short of memory; a held editor is never idle.
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("15 seconds");
        const now = yield* Clock.currentTimeMillis;
        const idle = Array.from(sessions).filter(([, session]) => session.inFlight === 0);
        const shortMb = idle.length === 0 ? null : yield* Effect.promise(underIdleMemoryFloor);
        for (const [root, session] of idle) {
          const expired = now - session.lastActive > IDLE_MS;
          if (!expired && shortMb === null) continue;
          yield* openLock.withPermits(1)(
            // Re-read under the lock: a call may have taken it meanwhile.
            Effect.suspend(() =>
              session.inFlight === 0 && sessions.get(root) === session
                ? (expired
                    ? Effect.void
                    : Effect.logWarning("closing the idle live Unity editor: memory is short", {
                        root,
                        availableMb: shortMb,
                      })
                  ).pipe(Effect.andThen(drop(root)))
                : Effect.void,
            ),
          );
        }
      }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.keys()], drop, { discard: true, concurrency: "unbounded" }),
  );

  return GameUnity.of({
    hold: (root) => (effect) => withSession(root, () => effect),
    cli: (root, args, options) =>
      withSession(root, (session) =>
        Effect.gen(function* () {
          const run = () =>
            runCli(
              root,
              install.cli,
              withCliFlags(args, ["--project-path", session.projectDir]),
              options,
            );
          let result = yield* run();
          if (
            !result.ok &&
            (result.process.exitCode === 12 ||
              RELOADING.test(`${result.errorCode} ${result.errorMessage}`))
          ) {
            yield* waitReady(root, session);
            result = yield* run();
          }
          return result;
        }),
      ),
    call,
    tools: (root) =>
      withSession(root, (session) =>
        Effect.gen(function* () {
          const listed = yield* Effect.tryPromise({
            try: () => session.client.listTools(),
            catch: (cause) =>
              opError(
                "unity-live",
                root,
                "command-failed",
                "`unity mcp` did not list its tools.",
                cause,
              ),
          });
          return listed.tools
            .filter((tool) => UNITY_EDIT_TOOL.test(tool.name))
            .map((tool) => ({
              name: tool.name,
              description: (tool.description ?? "").slice(0, 600),
              input: tool.inputSchema,
            }));
        }),
      ),
    logTail,
    stop: drop,
  });
});

export const layer = Layer.effect(GameUnity, make);
