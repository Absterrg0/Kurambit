// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the native editor process, private display and MCP-stdio boundary; wall-clock pids and CLI JSON envelopes are the domain here.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  GameOperationError,
  manifestProject,
  type GameProcessResult,
  type GameUnityConsoleInput,
  type GameUnityEditInput,
  type GameUnityEvalInput,
  type GameUnityPlayInput,
  type GameUnityScreenshotInput,
  type GameUnityScreenshotResult,
  type GameUnityTextResult,
  type GameUnityToolsResult,
} from "@kurambit/contracts";
import * as ServerConfig from "../config.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import {
  commandFlag,
  commandHas,
  LIVE_IDLE_MS,
  LIVE_SWEEP_MS,
  type McpContent,
  readRecord,
  stringEnv,
  sweepIdle,
  textOf,
} from "./liveProcess.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import {
  adoptLaunch,
  LAUNCH_ENV,
  type LaunchRecord,
  launchToken,
  listProcesses,
  type OwnedProcess,
  processCwd,
  type ProcessFacts,
  ProcessHost,
  stopRecorded,
} from "./processHost.ts";
import { findWindowHost, findXvfb, type HostedWindow } from "./windowHost.ts";
import {
  UNITY_LICENSE_FAILURE,
  isUnityLicensingClient,
  unityCliEnv,
  unityEditorDir,
  unityEditorEnv,
} from "./unityToolchain.ts";
import { makeCheckoutOf } from "./unityPlayerCache.ts";
import { copyTree, makeAtomicWriter } from "./gameFiles.ts";
import {
  breakSession,
  HeldSources,
  type LiveHealth,
  makeLiveRecords,
  unityScenes,
} from "./liveEditor.ts";
import { readImageDimensions } from "@kurambit/shared/imageDimensions";

/**
 * Free memory a live Unity editor needs to open, in MB: the editor plus its
 * import worker, compilers and player build tools peaked about 4 GB on a
 * Linux player build here, and editors opened with less were OOM-killed
 * mid-build once other processes grew.
 */
const NEEDED_MB = 4096;
const UNITY_ROOM: MemoryRoom = {
  what: "live Unity editor",
  neededMb: NEEDED_MB,
  env: "KURAMBIT_UNITY_MEMORY_MB",
};
const SESSION_FILE = "session.json";
/** The editor's window: big enough for its scene-view captures. */
const EDITOR_WINDOW = { width: 1280, height: 720 } as const;
/** A first open resolves packages and imports every asset; later opens reuse Library/. */
const READY_TIMEOUT_S = 900;
/**
 * How long an open holds the shared memory gate into its ready wait. The
 * editor commits most of its memory while it starts and loads the project; a
 * cold import grows for minutes after, and the peak (a player build) comes
 * later still, past any hold. Shorter than the gate's 75 s queue bound, so a
 * start queued behind an open is never refused by the hold alone.
 */
const GATE_HOLD_S = 60;
/**
 * The editor tools agents reach through `unity mcp` (its `--tools` filter).
 * Scene, object, component, prefab, material and settings editing plus C#
 * eval, play mode, capture and console. Builds, tests, packages, jobs and
 * editor lifecycle stay hidden: they belong to Kurambit's own operations.
 */
const UNITY_MCP_TOOLS = [
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
const UNITY_EDIT_TOOL =
  /^(scene_|gameobject_|component_|prefab_|material_|asset_find$|asset_create_folder$|script_attach$|settings_|lighting_|editor_save_all$|editor_status$|capture_scene_view$)/;

interface Session extends LiveHealth {
  readonly root: string;
  readonly projectDir: string;
  readonly editor: OwnedProcess;
  readonly window: HostedWindow;
  readonly client: Client;
  readonly logPath: string;
  /** The project's scenes as the editor holds them; a change on disk while it sits idle makes it stale. */
  readonly scene: HeldSources;
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
  /** Where the editor's window lives (`:251`), once it opened. */
  readonly display?: string;
  readonly editor: string;
  readonly projectDir: string;
  readonly cli: string;
  readonly editorLaunch?: LaunchRecord;
  readonly mcpLaunch?: LaunchRecord;
}

export interface UnityCliResult {
  /** The CLI's JSON envelope `data`, when it printed one. */
  readonly data: unknown;
  readonly ok: boolean;
  /** `errors[0].code` and message from the envelope, when it failed. */
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly process: GameProcessResult;
}

/**
 * How Unity answered one CLI call, the one reading every caller uses: the
 * Pipeline answered (`result` is its command result, when it has one), it
 * refused with its own error, or nothing came back (no envelope, or the call
 * timed out: on a main-thread command, a frozen editor).
 */
export type UnityAnswer =
  | { readonly kind: "answered"; readonly result: Record<string, unknown> | null }
  | { readonly kind: "refused"; readonly code: string | null; readonly message: string }
  | { readonly kind: "silent"; readonly timedOut: boolean };

export const answerOf = (result: UnityCliResult): UnityAnswer => {
  if (result.process.timedOut) return { kind: "silent", timedOut: true };
  if (result.ok && result.data !== null) {
    const data = result.data as { readonly result?: unknown };
    return {
      kind: "answered",
      result:
        typeof data.result === "object" && data.result !== null
          ? (data.result as Record<string, unknown>)
          : null,
    };
  }
  if (result.errorCode !== null || result.errorMessage !== null)
    return {
      kind: "refused",
      code: result.errorCode,
      message: result.errorMessage ?? result.errorCode ?? "refused",
    };
  return { kind: "silent", timedOut: false };
};

/** A rejected MCP call the editor never answered: a timeout, or the connection gone. */
const mcpUnanswered = (cause: unknown) =>
  !(cause instanceof McpError) ||
  cause.code === ErrorCode.RequestTimeout ||
  cause.code === ErrorCode.ConnectionClosed;

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
 * A recorded launch is ours only while it verifies (pid, start time and
 * token; see processHost) and still runs the binary this server would
 * launch (from the live toolchain, never the record, which an agent can
 * write) for this session's project or display.
 */
const recordedOwners = (
  record: Partial<SessionRecord>,
  homeDir: string,
  live: LiveExecutables,
): ReadonlyArray<{ readonly launch: unknown; readonly owns: (facts: ProcessFacts) => boolean }> => [
  {
    launch: record.mcpLaunch,
    owns: (facts) =>
      commandHas(facts, live.cli) &&
      commandHas(facts, "mcp") &&
      typeof record.projectDir === "string" &&
      commandFlag(facts, "--project-path", record.projectDir),
  },
  {
    launch: record.editorLaunch,
    owns: (facts) =>
      live.editors.some((editor) => commandHas(facts, editor)) &&
      typeof record.projectDir === "string" &&
      commandFlag(facts, "-projectPath", record.projectDir) &&
      // The user's own editor (Unity Hub's) may be open on this same project:
      // only the batchmode editor writing this session's log is ours.
      commandHas(facts, "-batchmode") &&
      commandFlag(facts, "-logFile", NodePath.join(homeDir, "editor.log")),
  },
];

/**
 * Unity starts three out-of-process asset import workers of about 0.7 GB
 * each by default. The count is a per-user setting in
 * UserSettings/EditorUserSettings.asset (gitignored, so a fresh checkout has
 * none); it is written before every start. A desired count of 0 clamps to
 * one worker, the lowest the editor allows; no standby workers are kept.
 * Answers the settings text to write, or null when it already says so.
 */
const importWorkerSettings = (existing: string | null): string | null => {
  const wanted: Record<string, string> = {
    m_DesiredImportWorkerCount: "0",
    m_StandbyImportWorkerCount: "0",
    m_IdleImportWorkerShutdownDelay: "1000",
  };
  if (existing === null)
    return `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!162 &1\nEditorUserSettings:\n  m_ObjectHideFlags: 0\n  serializedVersion: 5\n${Object.entries(
      wanted,
    )
      .map(([key, value]) => `  ${key}: ${value}\n`)
      .join("")}`;
  let text = existing;
  for (const [key, value] of Object.entries(wanted)) {
    const line = new RegExp(`^  ${key}: .*$`, "m");
    text = line.test(text)
      ? text.replace(line, `  ${key}: ${value}`)
      : text.replace(/^EditorUserSettings:\n/m, `EditorUserSettings:\n  ${key}: ${value}\n`);
  }
  return text === existing ? null : text;
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
  const keep = (facts: ProcessFacts) =>
    facts.exe !== null &&
    !isUnityLicensingClient(facts.exe) &&
    (editorDirs.some((dir) => facts.exe!.startsWith(`${dir}${NodePath.sep}`)) ||
      facts.exe === live.cli ||
      facts.exe === live.xvfb);
  const owners = recordedOwners(record, homeDir, live);
  await stopRecorded(
    owners.map((owner) => owner.launch),
    {
      waitMs: 15_000,
      owns: (facts) =>
        owners.some(
          (owner) =>
            (owner.launch as Partial<LaunchRecord> | undefined)?.pid === facts.pid &&
            owner.owns(facts),
        ),
      keep,
    },
  );
  await dropDataStoreMemory(homeDir);
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  const bytes = Buffer.from(data, "base64");
  // The result is labelled image/png, and a provider refuses a turn whose
  // image bytes are another format; the shared reader accepts several.
  const size = bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? readImageDimensions(bytes) : null;
  if (size === null)
    return { text: `The editor returned an image that is not a PNG. ${text.slice(0, 2000)}` };
  return {
    text: text.slice(0, 4000) || "See the attached Game view.",
    screenshot: { mimeType: "image/png", data, ...size },
  };
};

const withCliFlags = (args: ReadonlyArray<string>, flags: ReadonlyArray<string>): string[] => {
  const fence = args.indexOf("--");
  return fence < 0
    ? [...args, ...flags]
    : [...args.slice(0, fence), ...flags, ...args.slice(fence)];
};

/** The CLI prints one JSON envelope; editor log lines may precede it. */
const parseCliEnvelope = (
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
  for (const facts of await listProcesses()) {
    const args = facts.argv ?? facts.command.split(" ");
    const at = args.findIndex((arg) => arg.toLowerCase() === "-projectpath");
    const value = at >= 0 ? args[at + 1] : undefined;
    if (value === undefined || value === "") continue;
    if (NodePath.isAbsolute(value)) {
      if ((await real(value)) === want) return true;
      continue;
    }
    // Only Linux shows another process's working directory; elsewhere a
    // relative project path that could be this one counts as open.
    const cwd = await processCwd(facts.pid);
    if (
      cwd === null
        ? NodePath.basename(value) === NodePath.basename(want)
        : (await real(NodePath.resolve(cwd, value))) === want
    )
      return true;
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
  signal: AbortSignal,
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
    // Bounded, and stopped with its caller, so a cut-short open leaves no copy running.
    await copyTree(source, staging, AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]));
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
      options: {
        readonly operation: string;
        readonly timeoutMs: number;
        /**
         * False for a poll the editor may leave unanswered while it works (a
         * build's status): its timeout then does not mark the editor stuck.
         */
        readonly unansweredIsNews?: boolean;
        /**
         * False when "not ready" is itself the answer the caller reads (a
         * readiness wait, a probe during play): the call is never waited out
         * and run again. Readiness waits (`--until-ready`) are never retried.
         */
        readonly retryReload?: boolean;
      },
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
    /**
     * Marks this game's live editor unusable (the game froze it, play mode
     * would not stop): it closes once its last holder lets go, and the next
     * call opens a fresh one.
     */
    readonly wedged: (root: string, why: string) => Effect.Effect<void>;
    /** `game_unity_tools`: the editing tools `game_unity_edit` may call. Refuses a game that is not Unity's. */
    readonly listTools: (root: string) => Effect.Effect<GameUnityToolsResult, GameOperationError>;
    /** `game_unity_edit`: one editing tool and the scene save, in one hold; fails when the save does not land. */
    readonly edit: (
      root: string,
      input: GameUnityEditInput,
    ) => Effect.Effect<GameUnityTextResult, GameOperationError>;
    readonly evaluate: (
      root: string,
      input: GameUnityEvalInput,
    ) => Effect.Effect<GameUnityTextResult, GameOperationError>;
    readonly play: (
      root: string,
      input: GameUnityPlayInput,
    ) => Effect.Effect<GameUnityTextResult, GameOperationError>;
    readonly screenshot: (
      root: string,
      input: GameUnityScreenshotInput,
    ) => Effect.Effect<GameUnityScreenshotResult, GameOperationError>;
    readonly console: (
      root: string,
      input: GameUnityConsoleInput,
    ) => Effect.Effect<GameUnityTextResult, GameOperationError>;
  }
>()("kurambit/game/GameUnity") {}

const make = Effect.gen(function* () {
  const scheduler = yield* Scheduler.Scheduler;
  const memory = yield* HostResources.HostResources;
  const processHost = yield* ProcessHost;
  const processes = yield* GameProcesses.GameProcesses;
  const tools = yield* GameToolchain.GameToolchain;
  const projects = yield* GameProjectService.GameProjectService;
  const gate = yield* GameMemoryGate.GameMemoryGate;
  const homeDirOf = (root: string) => NodePath.join(root, "builds/logs/unity-live");
  const writeAtomic = yield* makeAtomicWriter;
  const checkoutOf = yield* makeCheckoutOf;
  const records = yield* makeLiveRecords<SessionRecord>("unity-live", (root) =>
    NodePath.join(homeDirOf(root), SESSION_FILE),
  );
  const sessions = new Map<string, Session>();
  // Opening an editor takes minutes; two callers for one game must share it.
  const openLock = Semaphore.makeUnsafe(1);
  // The CLI path and its HOME never depend on which editor a game picks.
  const install = yield* tools.unityExecutables;
  const serverRecordOf = records.serverRecordOf;
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
      .pipe(
        Effect.map((manifest) => GameProjectService.insideGame(root, manifestProject(manifest))),
      );

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
  yield* records.reapAll(async (record) => {
    if (typeof record.homeDir === "string") await reapRecord(record, record.homeDir, startupLive);
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
        // A held session is reused as it is; an idle one only while it is
        // usable and its scene on disk is still the one it holds in memory
        // (a file restore beside it would otherwise be saved over).
        // A broken session still held is never replaced under its holder: the
        // holder's next call fails at once, and the session is replaced when
        // the hold ends.
        if (existing !== undefined && existing.inFlight > 0 && existing.broken !== null)
          return yield* opError(
            "unity-live",
            root,
            "tool-failed",
            `The live Unity editor stopped answering (${existing.broken}); it is closed when this operation ends, and the next Unity call reopens it.`,
          );
        const stale =
          existing === undefined || existing.inFlight > 0
            ? null
            : yield* Effect.promise(() => existing.scene.changed());
        if (
          existing !== undefined &&
          existing.editor.running() &&
          existing.broken === null &&
          stale === null &&
          (existing.inFlight > 0 || now - existing.lastActive < LIVE_IDLE_MS)
        ) {
          existing.lastActive = now;
          take(existing);
          return existing;
        }
        if (stale !== null)
          yield* Effect.logInfo("live Unity editor reopens: its scene changed on disk", {
            root,
            scene: stale,
          });
        // A game may be open from a git worktree of its folder, as a chat's own copy.
        const checkout = yield* checkoutOf(root);
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
            const [mine, theirs] = yield* Effect.all([checkoutOf(root), checkoutOf(otherRoot)]);
            // Another copy of the same game (a git worktree of it) holds the
            // editor: stopping this game's own work would not free it.
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
                ? "The live Unity editor is busy with another copy of this game (a git worktree of it); only one Unity editor runs at a time. Retry when that copy's Unity work finishes, or stop it with game_stop in that copy's chat."
                : `The live Unity editor is busy with the game "${yield* gameName(otherRoot)}" (${otherRoot}); only one Unity editor runs at a time. Retry when that game's Unity work finishes, or stop it with game_stop there.`,
            );
          }
        for (const otherRoot of Array.from(sessions.keys())) yield* drop(otherRoot);
        yield* drop(root);
        const host = yield* Effect.promise(() => findWindowHost(processHost));
        if (host === null)
          return yield* opError(
            "unity-live",
            "Xvfb",
            "tool-missing",
            "The live Unity editor needs a window, and this machine has no private display. Install the system Xvfb package (or set KURAMBIT_XVFB).",
          );
        const homeDir = homeDirOf(root);
        const workerSettings = NodePath.join(projectDir, "UserSettings/EditorUserSettings.asset");
        const settingsText = yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(homeDir, { recursive: true });
            await NodeFSP.mkdir(records.directory, { recursive: true });
            await NodeFSP.mkdir(install.cliHome, { recursive: true });
            // Every earlier editor for this game was reaped above.
            await dropDataStoreMemory(homeDir);
            return importWorkerSettings(
              await NodeFSP.readFile(workerSettings, "utf8").catch(() => null),
            );
          },
          catch: (cause) => opError("unity-live", homeDir, "io", undefined, cause),
        });
        if (settingsText !== null) yield* writeAtomic(workerSettings, settingsText, "unity-live");
        // After the drops above: the main checkout's editor is closed, so its
        // import cache is copied whole.
        if (checkout.kind === "linked") {
          const notSeeded = yield* Effect.tryPromise({
            try: (signal) =>
              seedLibrary(
                NodePath.join(checkout.main, NodePath.relative(root, projectDir)),
                projectDir,
                NodePath.dirname(homeDir),
                signal,
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
        let record: SessionRecord = {
          root,
          homeDir,
          editor: unity.editor,
          projectDir,
          cli: unity.cli,
        };
        // Written as each pid appears, so a crash mid-start still leaves the
        // next open or game_stop something to reap.
        const remember = (launches: Partial<SessionRecord>) =>
          Effect.suspend(() => {
            record = { ...record, ...launches };
            return records.remember(root, record);
          });
        // A start that fails for its own reasons is a tool's fault unless the
        // game's code is named (compile errors), which callers read as the build's.
        const fail = (detail: string, reason: GameOperationError["reason"] = "tool-failed") =>
          Effect.gen(function* () {
            yield* drop(root);
            return yield* opError("unity-live", root, reason, detail);
          });
        const logPath = NodePath.join(homeDir, "editor.log");
        // The token rides the command line as well as the environment, where
        // an OS without readable environments can still verify it.
        const editorToken = launchToken();
        // The editor leads its own tree so a stop takes its asset-import
        // workers and shader compilers with it. It starts through the shared
        // memory gate, held through the launch and the first GATE_HOLD_S of
        // its ready wait, so what it takes is in the next start's memory
        // check. Checked after the drops above, so an editor this server just
        // closed counts as free.
        const {
          hosted,
          editorProcess,
          editor,
          ready: early,
          waitReady,
        } = yield* gate.admit(
          "unity-live",
          root,
          UNITY_ROOM,
          Effect.gen(function* () {
            const hosted = yield* Effect.tryPromise({
              try: () =>
                host.launch(
                  {
                    executable: unity.editor,
                    args: [
                      "-batchmode",
                      "-projectPath",
                      projectDir,
                      "-logFile",
                      logPath,
                      // Xvfb offers software OpenGL only; elsewhere the editor
                      // keeps its default graphics API.
                      ...(host.kind === "private-display" ? ["-force-glcore"] : []),
                      // Caps the job system's worker threads (the log confirms
                      // "Creating JobQueue using job-worker-count value 2").
                      "-job-worker-count",
                      "2",
                      "-kurambitLaunch",
                      editorToken,
                    ],
                    cwd: root,
                    env: unityEditorEnv({ LIBGL_ALWAYS_SOFTWARE: "1" }),
                    stdio: "ignore",
                    token: editorToken,
                    // On Windows the editor starts the user's Licensing
                    // Client, which other editors share: the editor stays out
                    // of the kill-on-close job, and a stop never ends that client.
                    joinsJob: false,
                    keep: (facts) => facts.exe !== null && !isUnityLicensingClient(facts.exe),
                  },
                  EDITOR_WINDOW,
                ),
              catch: (cause) =>
                opError("unity-live", root, "io", "The Unity editor's window did not open.", cause),
            });
            const editorProcess = hosted.process;
            const editor = editorProcess.child;
            const editorLaunch = yield* Effect.promise(() => editorProcess.record);
            yield* remember({
              display: hosted.label,
              ...(editorLaunch === null ? {} : { editorLaunch }),
            });
            if (editorLaunch === null) return yield* fail("The Unity editor did not start.", "io");
            // A batchmode editor that cannot open the project (compile errors, a
            // licence refusal) exits within seconds; the CLI would still wait out
            // its whole timeout for an editor that is gone.
            const exited = Effect.callback<null>((resume) => {
              const done = () => resume(Effect.succeed(null));
              if (editor.exitCode !== null || editor.signalCode !== null) return done();
              editor.once("exit", done);
              return Effect.sync(() => editor.off("exit", done));
            });
            const waitReady = (seconds: number) =>
              Effect.raceFirst(
                runCli(
                  root,
                  unity.cli,
                  [
                    "status",
                    "--until-ready",
                    "--project-path",
                    projectDir,
                    "--timeout",
                    String(seconds),
                  ],
                  { operation: "unity-ready", timeoutMs: (seconds + 30) * 1000 },
                ),
                exited,
              );
            const ready = yield* waitReady(GATE_HOLD_S);
            return { hosted, editorProcess, editor, ready, waitReady };
          }),
        );
        // A cold import is still running: the rest of its wait is outside the gate.
        const ready =
          early !== null && !early.ok && editorProcess.running()
            ? yield* waitReady(READY_TIMEOUT_S - GATE_HOLD_S)
            : early;
        if (ready === null || !ready.ok || !editorProcess.running()) {
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
          const compiles = errors.length > 0 || /error CS\d{4}/.test(tail);
          const compile = compiles
            ? ` C# compile errors stop it opening the project; fix them and retry:\n${errors.join("\n")}\n`
            : "";
          return yield* fail(
            ready === null
              ? `The Unity editor exited before it was ready (exit ${editor.exitCode ?? editor.signalCode}).${compile} Editor log: ${logPath}\n${tail.slice(-1500)}`
              : `The Unity editor did not become ready (${ready.errorCode ?? `exit ${ready.process.exitCode}`}: ${ready.errorMessage ?? "no answer"}).${compile} Editor log: ${logPath}\n${tail.slice(-1500)}`,
            compiles ? "command-failed" : "tool-failed",
          );
        }
        // A batchmode editor starts on an untitled scene; edits, saves and the
        // camera capture all belong to the game's main scene.
        const manifest = yield* projects.read(root);
        const scenePath = manifest.gameplayScene ?? "Assets/Scenes/Main.unity";
        yield* runCli(
          root,
          unity.cli,
          ["command", "scene", "open", "--project-path", projectDir, "--", "--path", scenePath],
          { operation: "unity-open-scene", timeoutMs: 120_000 },
        );
        const scene = new HeldSources(() => unityScenes(projectDir));
        yield* Effect.promise(() => scene.hold());
        const mcpLog = NodeFS.openSync(NodePath.join(homeDir, "mcp.log"), "w");
        const mcpToken = launchToken();
        const transport = new StdioClientTransport({
          command: unity.cli,
          args: ["mcp", "--project-path", projectDir, "--tools", UNITY_MCP_TOOLS.join(",")],
          env: stringEnv({ ...unityCliEnv(install.cliHome), [LAUNCH_ENV]: mcpToken }),
          stderr: mcpLog,
        });
        const client = new Client({ name: "kurambit-game-unity", version: "1.0.0" }, {});
        yield* Effect.tryPromise({
          try: () => client.connect(transport),
          catch: (cause) =>
            opError(
              "unity-live",
              root,
              "tool-failed",
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
        const mcpLaunch = yield* Effect.promise(() => adoptLaunch(processHost, mcpPid, mcpToken));
        if (mcpLaunch !== null) yield* remember({ mcpLaunch });
        const session: Session = {
          root,
          projectDir,
          editor: editorProcess,
          window: hosted,
          client,
          logPath,
          scene,
          broken: null,
          lastActive: yield* Clock.currentTimeMillis,
          inFlight: 0,
        };
        // `unity mcp` gone means every editing call would fail "did not answer":
        // the session is closed at its next release and the next call reopens it.
        client.onclose = () => breakSession(session, "`unity mcp` exited");
        sessions.set(root, session);
        take(session);
        return session;
      }).pipe(
        // A start cut short (a stopped turn during the minutes-long ready
        // wait) must not leave an editor running outside the session map: its
        // record names it, and dropping reaps it.
        Effect.onInterrupt(() => (sessions.has(root) ? Effect.void : drop(root))),
      ),
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
            // The last holder's work (an edit, an eval that saved, a build) is
            // the session's own: what is on disk now is what it holds. Taken
            // before the count drops, so no acquire sees it idle in between.
            if (session.inFlight === 1 && session.broken === null)
              yield* Effect.promise(() => session.scene.hold());
            session.inFlight -= 1;
            session.lastActive = yield* Clock.currentTimeMillis;
            // A session something showed unusable closes when its last holder lets go.
            if (session.broken !== null && session.inFlight === 0)
              yield* openLock.withPermits(1)(
                Effect.suspend(() =>
                  session.inFlight === 0 && sessions.get(root) === session
                    ? Effect.andThen(
                        Effect.logWarning("live Unity editor closed", {
                          root,
                          reason: session.broken,
                        }),
                        drop(root),
                      )
                    : Effect.void,
                ),
              );
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
  /**
   * The one domain-reload courtesy: after a call failed because the editor
   * was reloading, wait for it once and run the call again. Never for a
   * session already marked unusable, and an editor that does not come back
   * from the wait is marked unusable instead of being asked again, so a
   * frozen editor is never waited out twice or replayed within one hold.
   */
  const afterReload = <A>(session: Session, retry: Effect.Effect<A, GameOperationError>) =>
    Effect.gen(function* () {
      if (session.broken !== null) return null;
      const ready = yield* waitReady(session.root, session);
      if (answerOf(ready).kind !== "answered") {
        breakSession(session, "the live Unity editor did not become ready again");
        return null;
      }
      return yield* retry;
    });
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
      catch: (cause) => {
        // An answered JSON-RPC error (an unknown tool, bad arguments) is the
        // caller's request; only silence or a lost connection is the editor's.
        if (!mcpUnanswered(cause))
          return opError(
            "unity-live",
            name,
            "invalid-input",
            `The Unity editor refused '${name}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          );
        // An editor that does not answer at all will not answer the next call either.
        breakSession(session, `the live Unity editor did not answer '${name}'`);
        return opError(
          "unity-live",
          name,
          "tool-failed",
          cause instanceof McpError && cause.code === ErrorCode.RequestTimeout
            ? `The Unity editor did not answer '${name}' within ${Math.round(timeoutMs / 1000)}s. It may still be working; read the scene before retrying.`
            : `The Unity editor did not answer '${name}'. ${cause instanceof Error ? cause.message : ""}`,
          cause,
        );
      },
    });

  const call: GameUnity["Service"]["call"] = (root, name, args, timeoutMs = 2 * 60_000) =>
    withSession(root, (session) =>
      Effect.gen(function* () {
        let result = yield* attempt(session, name, args, timeoutMs);
        // One retry after the editor is ready again: a domain reload is not
        // the agent's error, and the call never reached the editor.
        if (result.isError === true && RELOADING.test(textOf(result)))
          result = (yield* afterReload(session, attempt(session, name, args, timeoutMs))) ?? result;
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

  // A held editor is never idle.
  yield* scheduler.register(
    "game-unity-idle",
    yield* Scheduler.every(
      LIVE_SWEEP_MS,
      sweepIdle({
        what: "live Unity editor",
        memory,
        idle: () =>
          Array.from(sessions)
            .filter(([, session]) => session.inFlight === 0)
            .map(([root, session]) => ({
              root,
              lastActive: session.lastActive,
              alive: Effect.sync(() => session.broken === null && session.editor.running()),
              // Re-read under the lock: a call may have taken it meanwhile.
              close: openLock.withPermits(1)(
                Effect.suspend(() =>
                  session.inFlight === 0 && sessions.get(root) === session
                    ? drop(root)
                    : Effect.void,
                ),
              ),
            })),
      }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.keys()], drop, { discard: true, concurrency: "unbounded" }),
  );

  const listTools = (root: string) =>
    withSession(root, (session) =>
      Effect.gen(function* () {
        const listed = yield* Effect.tryPromise({
          try: () => session.client.listTools(),
          catch: (cause) =>
            opError(
              "unity-live",
              root,
              "tool-failed",
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
    );

  // The game_unity_* tools are the Unity editor's own front, so only a Unity game has them.
  const unityGame = (root: string, operation: string) =>
    projects
      .read(root)
      .pipe(
        Effect.flatMap((manifest) =>
          manifest.engine.name === "unity"
            ? Effect.void
            : Effect.fail(
                opError(
                  operation,
                  root,
                  "invalid-input",
                  "The game_unity_* tools work on Unity games; this game runs another engine.",
                ),
              ),
        ),
      );

  const edit = (root: string, input: GameUnityEditInput) =>
    Effect.gen(function* () {
      yield* unityGame(root, "Unity edit");
      if (!UNITY_EDIT_TOOL.test(input.tool))
        return yield* opError(
          "Unity edit",
          input.tool,
          "invalid-input",
          "That tool is not an editing tool here. List the editing tools with game_unity_tools; use game_unity_eval, game_unity_play, game_unity_screenshot or game_unity_console for the rest.",
        );
      // Edits live in the open scene until saved, so the edit and its save hold one editor.
      return yield* withSession(root, (session) =>
        Effect.gen(function* () {
          const result = yield* call(root, input.tool, { ...input.arguments });
          // An edit whose save did not land is held only in the editor: the
          // run's next capture would miss it, so the call fails.
          const saved = yield* call(root, "editor_save_all", {}).pipe(
            Effect.catchTags({
              GameOperationError: (error) =>
                Effect.fail(
                  opError(
                    "Unity edit",
                    root,
                    error.reason,
                    `The edit ran but the scene was not saved, so it is held only in the live editor: ${error.detail ?? error.reason}\n${textOf(result).slice(0, 2000)}`,
                    error,
                  ),
                ),
            }),
          );
          return { text: `${textOf(result).slice(0, 8000)}\n${textOf(saved)}` };
        }),
      );
    });

  return GameUnity.of({
    wedged: (root, why) =>
      Effect.sync(() => {
        const session = sessions.get(root);
        if (session !== undefined) breakSession(session, why);
      }),
    listTools: (root) =>
      Effect.andThen(unityGame(root, "Unity tools"), listTools(root)).pipe(
        Effect.map((tools) => ({ tools })),
      ),
    edit,
    evaluate: (root, input) =>
      Effect.andThen(
        unityGame(root, "Unity eval"),
        call(root, "script_eval", { code: input.code, timeout: 60 }, 90_000),
      ).pipe(Effect.map((result) => ({ text: textOf(result).slice(0, 8000) }))),
    play: (root, input) =>
      Effect.gen(function* () {
        yield* unityGame(root, "Unity play");
        // An unfocused editor freezes play mode at frame 1 without auto-tick.
        if (input.action === "start") yield* call(root, "editor_set_auto_tick", {});
        const result = yield* call(
          root,
          input.action === "start" ? "editor_playmode_start" : "editor_playmode_stop",
          {},
          120_000,
        );
        return { text: textOf(result) };
      }),
    screenshot: (root, input) =>
      Effect.andThen(
        unityGame(root, "Unity screenshot"),
        call(root, "capture_game_view", { source: "camera", max_resolution: input.maxSize ?? 960 }),
      ).pipe(Effect.map(screenshotOf)),
    console: (root, input) =>
      Effect.andThen(
        unityGame(root, "Unity console"),
        call(root, "console_get", { level: input.level ?? "log", tail: input.tail ?? 50 }),
      ).pipe(Effect.map((result) => ({ text: textOf(result).slice(0, 12000) }))),
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
          // A call that hung past its bound found the editor stuck (on its main
          // thread for most commands): it is not retried and not reused.
          if (result.process.timedOut) {
            // A poll that may go unanswered while the editor works (a build's
            // status) says nothing about the editor; any other call does.
            if (options.unansweredIsNews !== false)
              breakSession(
                session,
                `the live Unity editor did not answer \`${args.join(" ")}\` in time`,
              );
            return result;
          }
          if (
            options.retryReload !== false &&
            !args.includes("--until-ready") &&
            !result.ok &&
            (result.process.exitCode === 12 ||
              RELOADING.test(`${result.errorCode} ${result.errorMessage}`))
          )
            result = (yield* afterReload(session, run())) ?? result;
          if (result.process.timedOut && options.unansweredIsNews !== false)
            breakSession(
              session,
              `the live Unity editor did not answer \`${args.join(" ")}\` in time`,
            );
          return result;
        }),
      ),
    call,
    tools: listTools,
    logTail,
    stop: drop,
  });
});

export const layer = Layer.effect(GameUnity, make);
