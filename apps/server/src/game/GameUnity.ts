// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the native editor process, private display and MCP-stdio boundary; wall-clock pids and CLI JSON envelopes are the domain here.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { GameOperationError, type GameProcessResult } from "@kurambit/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { UNITY_LICENSE_FAILURE, unityChildEnv } from "./unityToolchain.ts";

const IDLE_MS = 10 * 60_000;
const SESSION_FILE = "session.json";
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
}

/** What a live session left on disk so a later server can reap it. */
interface SessionRecord {
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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readCmdline = async (pid: number): Promise<string[] | null> => {
  try {
    const raw = await NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8");
    const argv = raw.split("\0").filter((part) => part !== "");
    return argv.length === 0 ? null : argv;
  } catch {
    return null;
  }
};

/**
 * A recorded pid is ours only while its argv still names the binary we
 * launched and this session's project or display; a reused pid never matches.
 * The editor leads its own process group, so its asset workers and shader
 * compilers go with it.
 */
const recordedOwners = (
  record: SessionRecord,
): Array<{ pid: number; group: boolean; owns: (argv: string[]) => boolean }> => {
  const out: Array<{ pid: number; group: boolean; owns: (argv: string[]) => boolean }> = [];
  if (record.mcpPid !== undefined)
    out.push({
      pid: record.mcpPid,
      group: false,
      owns: (argv) => argv[0] === record.cli && argv.includes("mcp"),
    });
  if (record.editorPid !== undefined)
    out.push({
      pid: record.editorPid,
      group: true,
      owns: (argv) => argv[0] === record.editor && argv.includes(record.projectDir),
    });
  if (record.xvfbPid !== undefined)
    out.push({
      pid: record.xvfbPid,
      group: false,
      owns: (argv) => argv[0] === record.xvfb && argv[1] === record.display,
    });
  return out;
};

const signalOwned = (pid: number, group: boolean, signal: NodeJS.Signals): void => {
  try {
    process.kill(group ? -pid : pid, signal);
  } catch {
    try {
      if (group) process.kill(pid, signal);
    } catch {
      /* gone */
    }
  }
};

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
 * Every process below a pid, read from /proc. Unity's import workers start
 * their own sessions, so a process-group signal does not reach them; walking
 * the parent links from the editor pid we spawned does, without matching any
 * name.
 */
const descendantsOf = async (pid: number): Promise<number[]> => {
  const parents = new Map<number, number[]>();
  for (const entry of await NodeFSP.readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await NodeFSP.readFile(`/proc/${entry}/stat`, "utf8").catch(() => null);
    const ppid = stat === null ? NaN : Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!Number.isFinite(ppid)) continue;
    parents.set(ppid, [...(parents.get(ppid) ?? []), Number(entry)]);
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of parents.get(queue.shift()!) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
};

/** SIGTERM the recorded pids that are verifiably ours, wait, then SIGKILL stragglers. */
const reapRecorded = async (homeDir: string): Promise<void> => {
  const file = NodePath.join(homeDir, SESSION_FILE);
  let record: SessionRecord;
  try {
    record = JSON.parse(await NodeFSP.readFile(file, "utf8")) as SessionRecord;
  } catch {
    return;
  }
  const owned = async () => {
    const live: Array<{ pid: number; group: boolean }> = [];
    for (const { pid, group, owns } of recordedOwners(record)) {
      const argv = await readCmdline(pid);
      if (argv !== null && owns(argv)) live.push({ pid, group });
    }
    return live;
  };
  let live = await owned();
  // Taken while the editor still lives: once it exits, its workers reparent.
  const editorTree =
    record.editorPid !== undefined && live.some((entry) => entry.pid === record.editorPid)
      ? await descendantsOf(record.editorPid)
      : [];
  for (const entry of live) signalOwned(entry.pid, entry.group, "SIGTERM");
  for (const pid of editorTree) signalOwned(pid, false, "SIGTERM");
  for (let waited = 0; live.length > 0 && waited < 15_000; waited += 200) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    live = await owned();
  }
  for (const entry of live) signalOwned(entry.pid, entry.group, "SIGKILL");
  for (const pid of editorTree) if (alive(pid)) signalOwned(pid, false, "SIGKILL");
  await NodeFSP.rm(file, { force: true });
};

const pickDisplay = async (): Promise<number | null> => {
  for (let n = 251; n < 400; n++) {
    try {
      await NodeFSP.access(`/tmp/.X${n}-lock`);
      continue;
    } catch {
      /* candidate */
    }
    const taken = await new Promise<boolean>((resolve) => {
      const s = NodeNet.connect(6000 + n, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => {
        s.destroy();
        resolve(false);
      });
    });
    if (!taken) return n;
  }
  return null;
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

export class GameUnity extends Context.Service<
  GameUnity,
  {
    /**
     * Ensure this game's live editor is open and ready: a batchmode editor
     * on a private display with the Pipeline package serving. Only one Unity
     * editor runs at a time on this server; opening one closes any other.
     */
    readonly open: (
      root: string,
    ) => Effect.Effect<{ readonly projectDir: string }, GameOperationError>;
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
  const sessions = new Map<string, Session>();
  // Opening an editor takes minutes; two callers for one game must share it.
  const openLock = Semaphore.makeUnsafe(1);

  const homeDirOf = (root: string) => NodePath.join(root, "builds/logs/unity-live");

  const drop = async (root: string): Promise<void> => {
    const session = sessions.get(root);
    if (session !== undefined) {
      sessions.delete(root);
      void session.client.close().catch(() => undefined);
    }
    await reapRecorded(homeDirOf(root));
  };

  const projectDirOf = (root: string) =>
    projects
      .read(root)
      .pipe(Effect.map((manifest) => GameProjectService.insideGame(root, manifest.godotProject)));

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
        env: unityChildEnv(),
        envMode: "replace",
      })
      .pipe(
        Effect.map((run): UnityCliResult => {
          const envelope = parseCliEnvelope(run.stdout);
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

  const logTail = (root: string) =>
    Effect.promise(async () => {
      const text = await NodeFSP.readFile(
        NodePath.join(homeDirOf(root), "editor.log"),
        "utf8",
      ).catch(() => "");
      return text.slice(-3000);
    });

  const ensure = (root: string): Effect.Effect<Session, GameOperationError> =>
    openLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const existing = sessions.get(root);
        if (
          existing !== undefined &&
          alive(existing.editorPid) &&
          alive(existing.xvfbPid) &&
          now - existing.lastActive < IDLE_MS
        ) {
          existing.lastActive = now;
          return existing;
        }
        const unity = yield* tools.unity;
        const projectDir = yield* projectDirOf(root);
        // One Unity editor per server: a second one would double a 2-3 GB
        // process and fight the first for the Licensing Client.
        for (const other of [...sessions.keys()]) yield* Effect.promise(() => drop(other));
        yield* Effect.promise(() => drop(root));
        const xvfbPath = yield* Effect.promise(() =>
          GameProcesses.findExecutable("Xvfb", {
            pathEnv: `${process.env.PATH ?? ""}${NodePath.delimiter}${process.env.HOME ?? ""}/.gs-tmp/xvfb-local/usr/bin`,
            override: process.env.KURAMBIT_XVFB,
          }),
        );
        if (xvfbPath === null)
          return yield* opError(
            "unity-live",
            "Xvfb",
            "tool-missing",
            "Xvfb is needed for the live Unity editor's private display. Install the system Xvfb package (or set KURAMBIT_XVFB).",
          );
        const homeDir = homeDirOf(root);
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(homeDir, { recursive: true });
            await capImportWorkers(projectDir);
          },
          catch: (cause) => opError("unity-live", homeDir, "io", undefined, cause),
        });
        const displayNum = yield* Effect.promise(() => pickDisplay());
        if (displayNum === null)
          return yield* opError(
            "unity-live",
            root,
            "busy",
            "No free private Xvfb display (:251–:399).",
          );
        const display = `:${displayNum}`;
        let record: SessionRecord = {
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
            try: () => {
              record = { ...record, ...pids };
              return NodeFSP.writeFile(
                NodePath.join(homeDir, SESSION_FILE),
                JSON.stringify(record),
              );
            },
            catch: (cause) => opError("unity-live", SESSION_FILE, "io", undefined, cause),
          });
        const fail = (detail: string, reason: GameOperationError["reason"] = "command-failed") =>
          Effect.gen(function* () {
            yield* Effect.promise(() => drop(root));
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
        const editorPid = yield* Effect.sync(() => {
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
              env: unityChildEnv({ DISPLAY: display, LIBGL_ALWAYS_SOFTWARE: "1" }),
              detached: true,
              stdio: "ignore",
            },
          );
          child.unref();
          return child.pid;
        });
        if (editorPid === undefined) return yield* fail("The Unity editor did not start.", "io");
        yield* remember({ editorPid });
        const ready = yield* runCli(
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
        );
        if (!ready.ok || !alive(editorPid)) {
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
          const compile = /error CS\d{4}/.test(tail)
            ? " The project has C# compile errors, so the editor stayed in Safe Mode; fix them (see the log) and retry."
            : "";
          return yield* fail(
            `The Unity editor did not become ready (${ready.errorCode ?? `exit ${ready.process.exitCode}`}: ${ready.errorMessage ?? "no answer"}).${compile} Editor log: ${logPath}\n${tail.slice(-1500)}`,
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
          env: stringEnv(unityChildEnv()),
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
          Effect.tapError(() => Effect.promise(() => drop(root))),
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
        };
        sessions.set(root, session);
        return session;
      }),
    );

  /**
   * Waits until the editor's Pipeline server answers again. A recompile that
   * adds or changes scripts reloads the domain, and play mode does too; the
   * server is gone for a few seconds and calls in that window fail.
   */
  const waitReady = (root: string, session: Session) =>
    Effect.gen(function* () {
      const unity = yield* tools.unity;
      return yield* runCli(
        root,
        unity.cli,
        ["status", "--until-ready", "--project-path", session.projectDir, "--timeout", "180"],
        { operation: "unity-ready", timeoutMs: 200_000 },
      );
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
    Effect.gen(function* () {
      const session = yield* ensure(root);
      let result = yield* attempt(session, name, args, timeoutMs);
      // One retry after the editor is ready again: a domain reload is not
      // the agent's error, and the call never reached the editor.
      if (result.isError === true && RELOADING.test(textOf(result))) {
        yield* waitReady(root, session);
        result = yield* attempt(session, name, args, timeoutMs);
      }
      session.lastActive = yield* Clock.currentTimeMillis;
      if (result.isError === true)
        return yield* opError(
          "unity-live",
          name,
          "command-failed",
          textOf(result).trim() || `The Unity editor reported an error for '${name}'.`,
        );
      return result;
    });

  // Idle sessions die on a detached sweep so one forgotten game cannot hold
  // a 2-3 GB editor and its display forever.
  yield* Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep("60 seconds");
      const now = yield* Clock.currentTimeMillis;
      for (const [root, session] of sessions)
        if (now - session.lastActive > IDLE_MS) yield* Effect.promise(() => drop(root));
    }),
  ).pipe(Effect.forkDetach);
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => Promise.all([...sessions.keys()].map(drop))),
  );

  return GameUnity.of({
    open: (root) =>
      ensure(root).pipe(Effect.map((session) => ({ projectDir: session.projectDir }))),
    cli: (root, args, options) =>
      Effect.gen(function* () {
        const session = yield* ensure(root);
        const unity = yield* tools.unity;
        const run = () =>
          runCli(
            root,
            unity.cli,
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
        session.lastActive = yield* Clock.currentTimeMillis;
        return result;
      }),
    call,
    tools: (root) =>
      Effect.gen(function* () {
        const session = yield* ensure(root);
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
    logTail,
    stop: (root) => Effect.promise(() => drop(root)),
  });
});

export const layer = Layer.effect(GameUnity, make);
