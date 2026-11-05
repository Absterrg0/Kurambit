// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the native filesystem, process, and MCP-stdio boundary; wall-clock pids and JSON code strings are the domain here.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  GameOperationError,
  type GameBlenderAssetsImportInput,
  type GameBlenderAssetsImportResult,
  type GameBlenderAssetsSearchInput,
  type GameBlenderAssetsSearchResult,
  type GameBlenderCodeInput,
  type GameBlenderCodeResult,
  type GameBlenderExportInput,
  type GameBlenderExportResult,
  type GameBlenderLookInput,
  type GameBlenderLookResult,
  type GameBlenderRenderSpritesInput,
  type GameBlenderRenderSpritesResult,
  type GameBlenderSceneInput,
  type GameBlenderSceneResult,
  type GameManifest,
} from "@kurambit/contracts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { renderSprites } from "./blenderSprites.ts";
import { engineProfile } from "./engineProfile.ts";
import {
  commandFlag,
  commandHas,
  LIVE_IDLE_MS,
  LIVE_SWEEP_MS,
  type McpContent,
  memoryShortfall,
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
  type OwnedProcess,
  type ProcessFacts,
  ProcessHost,
  stopRecorded,
} from "./processHost.ts";
import { OFFSCREEN_POSITION, findWindowHost, type HostedWindow } from "./windowHost.ts";
import { readImageDimensions } from "@kurambit/shared/imageDimensions";

const PINNED_PKG = "mcp-for-blender@2.2.6";
/**
 * Free memory a live Blender needs to open, in MB: Blender, its Xvfb and the
 * MCP child peaked about 1.2 GB (PSS) on this machine through code, an asset
 * import, a GLB export and solid looks; 1.5 GB leaves a little headroom.
 */
const NEEDED_MB = 1536;
const BLENDER_ROOM: MemoryRoom = {
  what: "live Blender",
  neededMb: NEEDED_MB,
  env: "KURAMBIT_BLENDER_MEMORY_MB",
};
/**
 * Further free memory a rendered look needs, in MB: on the same machine a
 * `shading: "rendered"` look took the session to about 3 GB and MemAvailable
 * fell 1.55 GB during it. Checked before each rendered look, not at open,
 * since most sessions never render.
 */
const RENDER_NEEDED_MB = 2048;
const BLEND_REL = "art/blender/live.blend";
const SESSION_FILE = "session.json";

/**
 * Per-tool request timeouts. The SDK's 60 s default fails imports and long
 * execs while Blender keeps working, so the agent retries and duplicates
 * work. The pinned server already bounds each Blender command at 180 s;
 * import_asset chains downloads and several commands.
 */
const CALL_TIMEOUT_MS: Record<string, number> = {
  execute_blender_code: 10 * 60_000,
  import_asset: 10 * 60_000,
  look: 5 * 60_000,
  get_scene_info: 2 * 60_000,
  search_assets: 2 * 60_000,
};
const STILL_WORKING =
  "Blender may still be finishing this call. Inspect the scene with game_blender_scene or game_blender_look before retrying, so the work is not done twice.";

/** Addon keys the service can pass straight through: the pinned addon's
 * config getter reads BLENDERMCP_SKETCHFAB_API_KEY /
 * BLENDERMCP_POLYPIZZA_API_KEY from the environment, so keys set in Game
 * Tools reach the addon via the Blender and MCP child environments. */
export const GAME_BLENDER_SKETCHFAB_SECRET = "game-blender-sketchfab-key";
export const GAME_BLENDER_POLYPIZZA_SECRET = "game-blender-polypizza-key";

interface Session {
  readonly root: string;
  readonly port: number;
  readonly homeDir: string;
  readonly blender: OwnedProcess;
  readonly window: HostedWindow;
  readonly client: Client;
  readonly transport: StdioClientTransport;
  /** What this session was launched from; its own pids are verified against these. */
  readonly live: LiveExecutables;
  lastActive: number;
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
    ...(detail === undefined ? {} : { detail }),
    ...(cause === undefined ? {} : { cause }),
  });

const portFor = (root: string): number => {
  const h = NodeCrypto.createHash("sha1").update(NodePath.resolve(root)).digest();
  return 19100 + (h.readUInt16BE(0) % 700);
};

const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = NodeNet.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => {
      s.destroy();
      resolve(true);
    });
  });

const waitPort = async (port: number, timeoutMs: number): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await portFree(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
};

/** Blender never sees the real HOME/config: everything lives under the game.
 * Live session children (Xvfb, Blender, the pinned MCP server) build on the
 * allowlisted engine base, so model-driven `execute_blender_code` cannot read
 * server secrets; only the intentional BLENDERMCP_* addon keys are added, at
 * the spawn sites. The one-shot addon installer below is different: it
 * fetches the pinned package over the network, so it keeps proxy/cert
 * variables (see toolNetworkEnv). */
const sessionEnv = (homeDir: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const fakeHome = NodePath.join(homeDir, "home");
  const env: NodeJS.ProcessEnv = {
    ...GameProcesses.engineChildEnv(),
    ...extra,
  };
  env.HOME = fakeHome;
  env.XDG_CONFIG_HOME = NodePath.join(fakeHome, ".config");
  env.XDG_CACHE_HOME = NodePath.join(fakeHome, ".cache");
  env.XDG_DATA_HOME = NodePath.join(fakeHome, ".local", "share");
  env.XDG_RUNTIME_DIR = NodePath.join(homeDir, "runtime");
  env.LIBGL_ALWAYS_SOFTWARE = "1";
  env.LP_NUM_THREADS = "2";
  env.DISABLE_TELEMETRY = "true";
  return env;
};

/**
 * Network configuration the pinned-tool installer may need. The uvx
 * addon-install child fetches over HTTPS, so proxy and CA variables ride
 * that one child only; live engine children never see them.
 */
const toolNetworkEnv = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const name of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
};

/** Blender's window, the size its viewport looks render at. */
const BLENDER_WINDOW = { width: 1280, height: 800 } as const;

/**
 * What a live session left on disk so a later server can reap it: the
 * in-memory map dies with the server, the detached children do not.
 */
interface SessionRecord {
  readonly port: number;
  /** Where Blender's window lives (`:119`), once it opened. */
  readonly display?: string;
  readonly blender: string;
  readonly bootPy: string;
  readonly uvx: string;
  readonly blenderLaunch?: LaunchRecord;
  readonly mcpLaunch?: LaunchRecord;
}

/** The executables this server would launch now; a recorded pid must still run one of them. */
interface LiveExecutables {
  readonly blender: string | null;
  readonly uvx: string | null;
}

/**
 * A recorded launch is ours only while it verifies (pid, start time and
 * token; see processHost) and still runs the binary this server would
 * launch (from the live toolchain, never the record) with this session's
 * own boot script, display or port.
 */
const recordedOwners = (
  record: Partial<SessionRecord>,
  live: LiveExecutables,
  bootPy: string,
): ReadonlyArray<{ readonly launch: unknown; readonly owns: (facts: ProcessFacts) => boolean }> => [
  {
    launch: record.mcpLaunch,
    // uvx re-execs as its sibling `uv tool uvx ...`, so match the directory.
    owns: (facts) =>
      live.uvx !== null &&
      commandHas(facts, PINNED_PKG) &&
      (facts.argv === null ||
        (facts.argv[0] !== undefined &&
          NodePath.dirname(facts.argv[0]) === NodePath.dirname(live.uvx))) &&
      commandFlag(facts, "--port", String(record.port)),
  },
  {
    launch: record.blenderLaunch,
    owns: (facts) =>
      live.blender !== null && commandHas(facts, live.blender) && commandHas(facts, bootPy),
  },
];

/** Stops the recorded launches that are verifiably ours, with their trees. */
const reapRecorded = async (homeDir: string, live: LiveExecutables): Promise<void> => {
  const file = NodePath.join(homeDir, SESSION_FILE);
  const record = await readRecord<SessionRecord>(file);
  if (record === null) return;
  const owners = recordedOwners(record, live, NodePath.join(homeDir, "boot_server.py"));
  await stopRecorded(
    owners.map((owner) => owner.launch),
    {
      waitMs: 5_000,
      owns: (facts) =>
        owners.some(
          (owner) =>
            (owner.launch as Partial<LaunchRecord> | undefined)?.pid === facts.pid &&
            owner.owns(facts),
        ),
    },
  );
  await NodeFSP.rm(file, { force: true });
};

export class GameBlender extends Context.Service<
  GameBlender,
  {
    readonly code: (
      root: string,
      input: GameBlenderCodeInput,
    ) => Effect.Effect<GameBlenderCodeResult, GameOperationError>;
    readonly look: (
      root: string,
      input: GameBlenderLookInput,
    ) => Effect.Effect<GameBlenderLookResult, GameOperationError>;
    readonly scene: (
      root: string,
      input: GameBlenderSceneInput,
    ) => Effect.Effect<GameBlenderSceneResult, GameOperationError>;
    readonly assetsSearch: (
      root: string,
      input: GameBlenderAssetsSearchInput,
    ) => Effect.Effect<GameBlenderAssetsSearchResult, GameOperationError>;
    readonly assetsImport: (
      root: string,
      input: GameBlenderAssetsImportInput,
    ) => Effect.Effect<GameBlenderAssetsImportResult, GameOperationError>;
    /** Live Blender scene: export named objects (or every mesh) as a GLB under the engine directory. */
    readonly exportGlb: (
      root: string,
      input: GameBlenderExportInput,
    ) => Effect.Effect<GameBlenderExportResult, GameOperationError>;
    /** Live Blender scene: render named objects to a strip of sprite PNGs with a fitted camera. */
    readonly renderSprites: (
      root: string,
      input: GameBlenderRenderSpritesInput,
    ) => Effect.Effect<GameBlenderRenderSpritesResult, GameOperationError>;
    /** Stop one game's live session by root; game_stop calls this. */
    readonly stop: (root: string) => Effect.Effect<void>;
  }
>()("kurambit/game/GameBlender") {}

const make = Effect.gen(function* () {
  const scheduler = yield* Scheduler.Scheduler;
  const memory = yield* HostResources.HostResources;
  const processHost = yield* ProcessHost;
  const processes = yield* GameProcesses.GameProcesses;
  const gate = yield* GameMemoryGate.GameMemoryGate;
  const tools = yield* GameToolchain.GameToolchain;
  const projects = yield* GameProjectService.GameProjectService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = new Map<string, Session>();
  /** Public operations running per game right now; a sweep never closes a held game's Blender. */
  const held = new Map<string, number>();
  const holding = <A>(
    root: string,
    effect: Effect.Effect<A, GameOperationError>,
  ): Effect.Effect<A, GameOperationError> =>
    Effect.acquireUseRelease(
      Effect.sync(() => held.set(root, (held.get(root) ?? 0) + 1)),
      () => effect,
      () =>
        Effect.sync(() => {
          const left = (held.get(root) ?? 1) - 1;
          if (left > 0) held.set(root, left);
          else held.delete(root);
        }),
    );

  // Addon keys, when set, as env for Blender/MCP children. Values never
  // leave the secret store except into the child environment; absence
  // means the addon runs keyless, exactly as before.
  const readAddonKeyEnv: Effect.Effect<NodeJS.ProcessEnv> = Effect.gen(function* () {
    const read = (name: string, env: string): Effect.Effect<[string, string] | null> =>
      secrets.get(name).pipe(
        Effect.map((found) => {
          if (Option.isNone(found)) return null;
          const text = Buffer.from(found.value).toString("utf8").trim();
          return text === "" ? null : ([env, text] as [string, string]);
        }),
        Effect.orElseSucceed(() => null),
      );
    const entries = yield* Effect.all([
      read(GAME_BLENDER_SKETCHFAB_SECRET, "BLENDERMCP_SKETCHFAB_API_KEY"),
      read(GAME_BLENDER_POLYPIZZA_SECRET, "BLENDERMCP_POLYPIZZA_API_KEY"),
    ]);
    const env: NodeJS.ProcessEnv = {};
    for (const entry of entries) if (entry !== null) env[entry[0]] = entry[1];
    return env;
  });

  const homeDirOf = (root: string) => NodePath.join(root, "builds/logs/blender-live");

  const liveExecutables: Effect.Effect<LiveExecutables> = Effect.gen(function* () {
    const blender = yield* tools.executable("blender").pipe(
      Effect.map((resolved): string | null => resolved.path),
      Effect.orElseSucceed(() => null),
    );
    const uvx = yield* tools.executable("uv").pipe(
      Effect.flatMap((resolved) => uvPaths(resolved.path)),
      Effect.map((uv): string | null => uv.uvx),
      Effect.orElseSucceed(() => null),
    );
    return { blender, uvx };
  });

  /** Ends the in-memory session synchronously, so a sweep's idle check and the close are one step. */
  const take = (root: string): Session | undefined => {
    const session = sessions.get(root);
    if (session !== undefined) {
      sessions.delete(root);
      // Closing the client ends the MCP child it spawned.
      void session.client.close().catch(() => undefined);
      void session.window.stop();
    }
    return session;
  };

  /** Ends the in-memory session, then reaps whatever the record still names (a previous server's session included). */
  const drop = (root: string): Effect.Effect<void> => Effect.suspend(() => reap(root, take(root)));

  const reap = (root: string, session: Session | undefined): Effect.Effect<void> =>
    Effect.gen(function* () {
      // A live session is checked against what it was launched from, so a
      // Blender path change never orphans it; only a record without one (a
      // previous server's) resolves the toolchain.
      const recorded = yield* Effect.promise(() =>
        NodeFSP.access(NodePath.join(homeDirOf(root), SESSION_FILE)).then(
          () => true,
          () => false,
        ),
      );
      if (!recorded) return;
      const live = session?.live ?? (yield* liveExecutables);
      yield* Effect.promise(() => reapRecorded(homeDirOf(root), live));
    });

  // uv comes from the toolchain: detected, or fetched once on first use.
  interface UvPaths {
    readonly uvx: string;
    readonly binDir: string | null;
  }
  const uvPaths = (uv: string): Effect.Effect<UvPaths> =>
    Effect.promise(async () => {
      const dir = NodePath.dirname(uv);
      const sibling = NodePath.join(dir, "uvx");
      const hasSibling = await NodeFSP.access(sibling, NodeFSP.constants.X_OK)
        .then(() => true)
        .catch(() => false);
      return { uvx: hasSibling ? sibling : uv, binDir: dir };
    });
  const resolveUv: Effect.Effect<UvPaths, GameOperationError> = tools.uv.pipe(
    Effect.flatMap(uvPaths),
  );

  const withBinDir = (env: NodeJS.ProcessEnv, binDir: string | null): NodeJS.ProcessEnv => {
    if (binDir === null) return env;
    return { ...env, PATH: `${binDir}${NodePath.delimiter}${env.PATH ?? ""}` };
  };

  const ensure = (root: string): Effect.Effect<Session, GameOperationError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const existing = sessions.get(root);
      if (
        existing !== undefined &&
        existing.blender.running() &&
        now - existing.lastActive < LIVE_IDLE_MS
      ) {
        existing.lastActive = now;
        return existing;
      }
      yield* drop(root);
      const uv = yield* resolveUv;
      const blender = yield* tools.executable("blender");
      const host = yield* Effect.promise(() => findWindowHost(processHost));
      if (host === null)
        return yield* opError(
          "blender-live",
          "Xvfb",
          "tool-missing",
          "The live Blender needs a window, and this machine has no private display. Install the system Xvfb package (or set KURAMBIT_XVFB).",
        );
      const addonKeys = yield* readAddonKeyEnv;
      const homeDir = homeDirOf(root);
      const port = portFor(root);
      if (yield* Effect.promise(() => portFree(port)).pipe(Effect.map((free) => !free)))
        return yield* opError(
          "blender-live",
          `${root}:${port}`,
          "busy",
          `The live Blender port ${port} is held by a process this server cannot verify as this game's Blender. Close it, then retry.`,
        );
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(homeDir, { recursive: true });
          await NodeFSP.mkdir(NodePath.join(homeDir, "home/.config"), { recursive: true });
          await NodeFSP.mkdir(NodePath.join(homeDir, "runtime"), {
            recursive: true,
            mode: 0o700,
          });
        },
        catch: (cause) => opError("blender-live", homeDir, "io", undefined, cause),
      });
      const addonsDir = NodePath.join(homeDir, "home/.config/blender/4.5/scripts/addons");
      // The pinned server ships its addon; install it into the isolated
      // config only, never the real ~/.config/blender.
      const installed = yield* processes.run({
        root,
        executable: uv.uvx,
        args: [PINNED_PKG, "install-addon"],
        operation: "blender-live-addon",
        timeoutMs: 120_000,
        env: withBinDir(
          {
            ...sessionEnv(homeDir),
            BLENDERMCP_ADDONS_DIR: addonsDir,
            // Fixed installer argv, fetched over the network: proxy/cert
            // variables ride this child only.
            ...toolNetworkEnv(),
          },
          uv.binDir,
        ),
        envMode: "replace",
      });
      if (installed.exitCode !== 0)
        return yield* opError(
          "blender-live",
          installed.logPath,
          "command-failed",
          "Could not install the pinned Blender addon into the isolated config.",
          installed,
        );
      // Enable the official module name in the isolated prefs headlessly.
      const enable = yield* processes.run({
        root,
        executable: blender.path,
        args: [
          "--background",
          "--python-expr",
          "import bpy; bpy.ops.preferences.addon_enable(module='blender_mcp'); bpy.ops.wm.save_userpref()",
        ],
        operation: "blender-live-enable",
        timeoutMs: 120_000,
        env: sessionEnv(homeDir),
        envMode: "replace",
      });
      if (enable.exitCode !== 0)
        return yield* opError(
          "blender-live",
          enable.logPath,
          "command-failed",
          "Could not enable the Blender addon in the isolated config.",
          enable,
        );
      const bootPy = NodePath.join(homeDir, "boot_server.py");
      let record: SessionRecord = {
        port,
        blender: blender.path,
        bootPy,
        uvx: uv.uvx,
      };
      // Written as each pid appears, so a crash mid-start still leaves the
      // next ensure or game_stop something to reap.
      const remember = (launches: Partial<SessionRecord>) =>
        Effect.tryPromise({
          try: () => {
            record = { ...record, ...launches };
            return NodeFSP.writeFile(NodePath.join(homeDir, SESSION_FILE), JSON.stringify(record));
          },
          catch: (cause) => opError("blender-live", SESSION_FILE, "io", undefined, cause),
        });
      yield* Effect.tryPromise({
        try: () =>
          NodeFSP.writeFile(
            bootPy,
            `import bpy\nbpy.context.preferences.filepaths.save_version = 0\nbpy.ops.preferences.addon_enable(module='blender_mcp')\nscene = bpy.context.scene\nscene.blendermcp_port = ${port}\nscene.blendermcp_use_polyhaven = True\nscene.blendermcp_auto_start_server = True\nbpy.ops.blendermcp.start_server()\nprint("STUDIO_BLENDER_READY port=${port}")\n`,
          ),
        catch: (cause) => opError("blender-live", bootPy, "io", undefined, cause),
      });
      const logPath = NodePath.join(homeDir, "blender.log");
      // A new session reopens the saved source; starting from Blender's
      // default scene would overwrite live.blend on the next save.
      const blendPath = NodePath.join(root, BLEND_REL);
      const reopen = yield* Effect.promise(() =>
        NodeFSP.access(blendPath)
          .then(() => [blendPath])
          .catch(() => [] as string[]),
      );
      // Blender starts through the shared memory gate, held until its addon
      // socket opens, so its load is in the next heavy start's memory check.
      const hosted = yield* gate.admit(
        "blender-live",
        root,
        BLENDER_ROOM,
        Effect.gen(function* () {
          const hosted = yield* Effect.tryPromise({
            try: async () => {
              const logFd = NodeFS.openSync(logPath, "w");
              // Blender hands what follows `--` to Python and ignores it, so the
              // token rides the command line where an OS hides environments.
              const token = launchToken();
              try {
                // cwd is the game root so relative paths in model code land in the game.
                return await host.launch(
                  {
                    executable: blender.path,
                    args: [
                      ...reopen,
                      ...(host.kind === "offscreen"
                        ? // The user's desktop: a window far off every monitor that
                          // opens behind other windows without taking focus.
                          [
                            "--window-geometry",
                            String(OFFSCREEN_POSITION.x),
                            String(OFFSCREEN_POSITION.y),
                            String(BLENDER_WINDOW.width),
                            String(BLENDER_WINDOW.height),
                            "--no-window-focus",
                          ]
                        : []),
                      "--python",
                      bootPy,
                      "--",
                      token,
                    ],
                    cwd: root,
                    env: withBinDir({ ...sessionEnv(homeDir), ...addonKeys }, uv.binDir),
                    stdio: ["ignore", logFd, logFd],
                    token,
                  },
                  BLENDER_WINDOW,
                );
              } finally {
                NodeFS.closeSync(logFd);
              }
            },
            catch: (cause) =>
              opError("blender-live", root, "io", "Blender's window did not open.", cause),
          });
          const stopStarted = Effect.promise(() => hosted.stop());
          const blenderLaunch = yield* Effect.promise(() => hosted.process.record);
          yield* remember({
            display: hosted.label,
            ...(blenderLaunch === null ? {} : { blenderLaunch }),
          });
          if (blenderLaunch === null) {
            yield* stopStarted;
            return yield* opError("blender-live", root, "io", "Blender did not start.");
          }
          if (!(yield* Effect.promise(() => waitPort(port, 90_000)))) {
            yield* stopStarted;
            return yield* opError(
              "blender-live",
              logPath,
              "command-failed",
              "Blender's addon socket did not open in 90s; see builds/logs/blender-live/blender.log.",
            );
          }
          return hosted;
        }),
      );
      const blenderProcess = hosted.process;
      const stopStarted = Effect.promise(() => hosted.stop());
      // One child of the pinned server per game, telemetry off, over stdio.
      // The addon reads Sketchfab/Poly Pizza keys from BLENDERMCP_* env, so
      // keys set in Game Tools ride the Blender and MCP environments below.
      // The MCP child serves tool calls to the model, so it gets the
      // allowlisted base plus only those intentional addon keys.
      const mcpEnv = stringEnv(
        withBinDir(
          {
            ...GameProcesses.engineChildEnv(),
            DISABLE_TELEMETRY: "true",
            LIBGL_ALWAYS_SOFTWARE: "1",
            ...addonKeys,
          },
          uv.binDir,
        ),
      );
      // The server logs every command it relays; keep that beside the
      // session instead of in Kurambit's own stderr.
      const mcpLog = NodeFS.openSync(NodePath.join(homeDir, "mcp.log"), "w");
      const mcpToken = launchToken();
      const transport = new StdioClientTransport({
        command: uv.uvx,
        args: [PINNED_PKG, "--port", String(port)],
        env: { ...mcpEnv, [LAUNCH_ENV]: mcpToken },
        stderr: mcpLog,
      });
      const client = new Client({ name: "kurambit-game-blender", version: "1.0.0" }, {});
      const connected = yield* Effect.tryPromise({
        try: () => client.connect(transport),
        catch: (cause) =>
          opError(
            "blender-live",
            PINNED_PKG,
            "command-failed",
            "Could not start the pinned MCP server over stdio.",
            cause,
          ),
      }).pipe(
        Effect.tapError(() => stopStarted),
        Effect.ensuring(Effect.sync(() => NodeFS.closeSync(mcpLog))),
      );
      void connected;
      const mcpPid = transport.pid;
      if (mcpPid === null) {
        void client.close().catch(() => undefined);
        yield* stopStarted;
        return yield* opError(
          "blender-live",
          PINNED_PKG,
          "io",
          "The pinned MCP server connected but reported no pid, so it could not be stopped later.",
        );
      }
      const mcpLaunch = yield* Effect.promise(() => adoptLaunch(processHost, mcpPid, mcpToken));
      if (mcpLaunch !== null) yield* remember({ mcpLaunch });
      const startedAt = yield* Clock.currentTimeMillis;
      const session: Session = {
        root,
        port,
        homeDir,
        blender: blenderProcess,
        window: hosted,
        client,
        transport,
        live: { blender: blender.path, uvx: uv.uvx },
        lastActive: startedAt,
      };
      sessions.set(root, session);
      return session;
    });

  /**
   * One tool call with a timeout that fits the tool. The pinned server
   * reports Python and download failures as plain text ("Error executing
   * code: ...", "Error: ...") with isError false, so both forms fail here.
   */
  const call = (
    root: string,
    name: string,
    args: Record<string, unknown>,
  ): Effect.Effect<McpContent, GameOperationError> =>
    Effect.gen(function* () {
      const session = yield* ensure(root);
      const result = (yield* Effect.tryPromise({
        try: () =>
          session.client.callTool({ name, arguments: args }, undefined, {
            timeout: CALL_TIMEOUT_MS[name] ?? 2 * 60_000,
            resetTimeoutOnProgress: true,
            onprogress: () => undefined,
          }),
        catch: (cause) =>
          opError(
            "blender-live",
            root,
            "command-failed",
            cause instanceof McpError && cause.code === ErrorCode.RequestTimeout
              ? `Blender did not answer '${name}' within ${Math.round((CALL_TIMEOUT_MS[name] ?? 120_000) / 1000)}s. ${STILL_WORKING}`
              : `Blender did not answer '${name}'.`,
            cause,
          ),
      })) as McpContent;
      session.lastActive = yield* Clock.currentTimeMillis;
      const text = textOf(result);
      if (result.isError === true || /^\s*error\b/i.test(text))
        return yield* opError(
          "blender-live",
          name,
          "command-failed",
          // The server's own 180 s socket timeout surfaces as one of these.
          (/Timeout waiting for Blender response|No data received|Incomplete JSON response/.test(
            text,
          )
            ? `${STILL_WORKING}\n`
            : "") +
            (text.trim() === "" ? `Blender reported an error for '${name}'.` : text.slice(0, 4000)),
        );
      return result;
    });

  const callText = (
    root: string,
    name: string,
    args: Record<string, unknown>,
  ): Effect.Effect<string, GameOperationError> => call(root, name, args).pipe(Effect.map(textOf));

  /** Where GLBs land in the engine project, from the manifest and its engine's layout. */
  const assetDirOf = (manifest: GameManifest) =>
    `${manifest.godotProject}/${engineProfile(manifest.engine.name).layout.blender}`;
  const exportDirOf = (root: string) => projects.read(root).pipe(Effect.map(assetDirOf));

  const saveBlend = (root: string): Effect.Effect<string, GameOperationError> =>
    Effect.gen(function* () {
      const absolute = NodePath.join(root, BLEND_REL);
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true }),
        catch: (cause) => opError("blender-live", BLEND_REL, "io", undefined, cause),
      });
      // Compressed: live.blend is committed with the game after every exec, and
      // an uncompressed scene adds ~10 MB of history each time.
      const text = yield* callText(root, "execute_blender_code", {
        code: `import bpy\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(absolute)}, compress=True)\nprint("STUDIO_SAVED")\n`,
      });
      if (!text.includes("STUDIO_SAVED"))
        return yield* opError("blender-live", BLEND_REL, "command-failed", text.slice(0, 1000));
      return BLEND_REL;
    });

  // A held game's Blender is never idle; the check and the close are one synchronous step.
  const idle = (root: string) => (held.get(root) ?? 0) === 0 && sessions.has(root);
  yield* scheduler.register(
    "game-blender-idle",
    yield* Scheduler.every(
      LIVE_SWEEP_MS,
      sweepIdle({
        what: "live Blender",
        memory,
        idle: () =>
          Array.from(sessions)
            .filter(([root]) => idle(root))
            .map(([root, session]) => ({
              root,
              lastActive: session.lastActive,
              close: Effect.suspend(() => (idle(root) ? reap(root, take(root)) : Effect.void)),
            })),
      }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.keys()], drop, { discard: true, concurrency: "unbounded" }),
  );

  return GameBlender.of({
    code: (root, input) =>
      holding(
        root,
        Effect.gen(function* () {
          const text = yield* callText(root, "execute_blender_code", { code: input.code });
          const blend = yield* saveBlend(root);
          return { output: `${text}\nSaved .blend source: ${blend}` };
        }),
      ),
    look: (root, input) =>
      holding(
        root,
        Effect.gen(function* () {
          if (input.shading === "rendered") {
            const short = yield* memoryShortfall(
              memory,
              "rendered Blender look",
              RENDER_NEEDED_MB,
              "KURAMBIT_BLENDER_RENDER_MEMORY_MB",
            );
            if (short !== null)
              return yield* opError(
                "blender-look",
                root,
                "low-memory",
                `${short} A solid look (the default shading) needs far less and works now.`,
              );
          }
          const result = yield* call(root, "look", {
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(input.views === undefined ? {} : { views: input.views }),
            ...(input.distance === undefined ? {} : { distance: input.distance }),
            ...(input.shading === undefined ? {} : { shading: input.shading }),
            ...(input.frames === undefined ? {} : { frames: input.frames }),
            ...(input.frameCount === undefined ? {} : { frame_count: input.frameCount }),
            ...(input.view === undefined ? {} : { view: input.view }),
            max_size: input.maxSize ?? 768,
          });
          const text = textOf(result);
          const image = (result.content ?? []).find((entry) => entry.type === "image");
          if (image?.data === undefined)
            return { text: text === "" ? "Blender returned no image." : text };
          const size = readImageDimensions(Buffer.from(image.data, "base64")) ?? {
            width: input.maxSize ?? 768,
            height: input.maxSize ?? 768,
          };
          return {
            text: text === "" ? "See the attached viewport image." : text,
            screenshot: {
              mimeType: "image/png" as const,
              data: image.data,
              width: size.width,
              height: size.height,
            },
          };
        }),
      ),
    scene: (root, input) =>
      holding(
        root,
        Effect.gen(function* () {
          const text = yield* callText(root, "get_scene_info", { ...input });
          return { text };
        }),
      ),
    assetsSearch: (root, input) =>
      holding(
        root,
        Effect.gen(function* () {
          const text = yield* callText(root, "search_assets", {
            source: input.source,
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.assetType === undefined ? {} : { asset_type: input.assetType }),
            ...(input.category === undefined ? {} : { category: input.category }),
            limit: input.limit ?? 10,
          });
          return { text };
        }),
      ),
    assetsImport: (root, input) =>
      holding(
        root,
        Effect.gen(function* () {
          const text = yield* callText(root, "import_asset", {
            source: input.source,
            id: input.id,
            ...(input.assetType === undefined ? {} : { asset_type: input.assetType }),
            ...(input.targetSize === undefined ? {} : { target_size: input.targetSize }),
            ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
            ...(input.applyTo === undefined ? {} : { apply_to: input.applyTo }),
          });
          const blend = yield* saveBlend(root);
          // Library models arrive at arbitrary scale: normalize the id to a
          // file name, export the scene's meshes as one GLB the game can
          // preload, and keep the .blend source in the game.
          const safe =
            input.id
              .toLowerCase()
              .replace(/[^a-z0-9_-]+/g, "-")
              .slice(0, 60) || "asset";
          const exportRel = `${yield* exportDirOf(root)}/${safe}.glb`;
          const absolute = NodePath.join(root, exportRel);
          yield* Effect.tryPromise({
            try: () => NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true }),
            catch: (cause) => opError("blender-live", exportRel, "io", undefined, cause),
          });
          const exported = yield* callText(root, "execute_blender_code", {
            code: [
              "import bpy",
              `fp = ${JSON.stringify(absolute)}`,
              "obs = [o for o in bpy.context.scene.objects if o.type == 'MESH']",
              "bpy.ops.object.select_all(action='DESELECT')",
              "for o in obs: o.select_set(True)",
              "bpy.ops.export_scene.gltf(filepath=fp, export_format='GLB', use_selection=True)",
              "print(f'STUDIO_EXPORTED {len(obs)}')",
            ].join("\n"),
          });
          if (!exported.includes("STUDIO_EXPORTED"))
            return {
              text: `${text}\nSaved .blend source: ${blend}\nGLB export failed: ${exported.slice(0, 500)}`,
            };
          return {
            text: `${text}\nSaved .blend source: ${blend}\nExported ${exportRel}. Run game_import after.`,
            blend,
            export: exportRel,
          };
        }),
      ),
    exportGlb: (root, input) =>
      holding(
        root,
        Effect.gen(function* () {
          // Thin path from the live scene to a GLB the game can load: select
          // the named objects (or every mesh) and run the glTF exporter, then
          // save the .blend source like every other scene-changing call.
          const manifest = yield* projects.read(root);
          const engineDir = manifest.godotProject;
          const file = input.file ?? `${assetDirOf(manifest)}/scene.glb`;
          if (!file.startsWith(`${engineDir}/`) || !file.endsWith(".glb") || file.includes(".."))
            return yield* opError(
              "blender-export",
              file,
              "invalid-input",
              `The destination must be a game-relative path under ${engineDir}/ ending with .glb.`,
            );
          const absolute = NodePath.join(root, file);
          const names = input.objects ?? [];
          const exported = yield* callText(root, "execute_blender_code", {
            code: [
              "import bpy, os, json",
              `fp = ${JSON.stringify(absolute)}`,
              `wanted = ${JSON.stringify(names)}`,
              "allnames = [o.name for o in bpy.data.objects]",
              "obs = [bpy.data.objects.get(n) for n in wanted] if wanted else [o for o in bpy.context.scene.objects if o.type == 'MESH']",
              "obs = [o for o in obs if o is not None]",
              "missing = [n for n in wanted if bpy.data.objects.get(n) is None]",
              "bpy.ops.object.select_all(action='DESELECT')",
              "for o in obs: o.select_set(True)",
              "print('STUDIO_ALL ' + json.dumps(allnames[:40]))",
              "print('STUDIO_MISSING ' + json.dumps(missing)) if missing else None",
              "print('STUDIO_EMPTY') if len(obs) == 0 else None",
              "os.makedirs(os.path.dirname(fp), exist_ok=True)",
              "bpy.ops.export_scene.gltf(filepath=fp, export_format='GLB', use_selection=True) if len(obs) > 0 else None",
              "print(f'STUDIO_EXPORTED {len(obs)} ' + str(os.path.getsize(fp))) if len(obs) > 0 else None",
            ].join("\n"),
          });
          if (exported.includes("STUDIO_MISSING") || exported.includes("STUDIO_EMPTY"))
            return yield* opError("blender-export", file, "invalid-input", exported.slice(0, 1000));
          if (!exported.includes("STUDIO_EXPORTED"))
            return yield* opError(
              "blender-export",
              file,
              "command-failed",
              exported.slice(0, 1000),
            );
          const blend = yield* saveBlend(root);
          return {
            text: `${exported}\nSaved .blend source: ${blend}\nRun game_import after.`,
            blend,
            export: file,
          };
        }),
      ),
    renderSprites: (root, input) =>
      holding(
        root,
        Effect.gen(function* () {
          const short = yield* memoryShortfall(
            memory,
            "sprite render",
            RENDER_NEEDED_MB,
            "KURAMBIT_BLENDER_RENDER_MEMORY_MB",
          );
          if (short !== null)
            return yield* opError("blender-render-sprites", root, "low-memory", short);
          // Renders in a throwaway scene and changes nothing in the live one, so no .blend save.
          return yield* renderSprites({ callText, manifest: projects.read }, root, input);
        }),
      ),
    stop: drop,
  });
});

export const layer = Layer.effect(GameBlender, make);
