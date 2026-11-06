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
  manifestProject,
} from "@kurambit/contracts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSettings from "../serverSettings.ts";
import { recordProvenance, renderSprites } from "./blenderSprites.ts";
import { lockArmatureRefusal, lockImportRefusal, readGameStyle } from "./gameStyle.ts";
import { gamePaths } from "./engineProfile.ts";
import { breakSession, HeldSources, type LiveHealth, makeLiveRecords } from "./liveEditor.ts";
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
const IMPORT_TOOL = "game_blender_assets_import";

/**
 * Python that prints `STUDIO_ARMATURES {name: [bones]}` for the armatures that
 * would travel with `objs` into a GLB: the objects themselves, their parents
 * and the armatures their modifiers deform with.
 */
const ARMATURES_OF = `
def studio_armatures(objs):
    found = {}
    for o in objs:
        cands = [o, o.parent] + [m.object for m in getattr(o, "modifiers", []) if m.type == "ARMATURE"]
        for a in cands:
            if a is not None and a.type == "ARMATURE":
                found[a.name] = [b.name for b in a.data.bones]
    print("STUDIO_ARMATURES " + json.dumps(found))
`;

const armaturesIn = (text: string): Record<string, ReadonlyArray<string>> | null => {
  const found = /STUDIO_ARMATURES (\{.*\})/.exec(text)?.[1];
  if (found === undefined) return null;
  try {
    return JSON.parse(found) as Record<string, ReadonlyArray<string>>;
  } catch {
    return null;
  }
};

/**
 * The licence an import's source states. Poly Haven is CC0 throughout; the
 * pinned server's Poly Pizza reply carries `Licence:` and `Attribution:`
 * lines (its fixed format); a Sketchfab import reports none, so the line
 * says where to read it.
 */
const importLicence = (source: string, id: string, reply: string): string => {
  if (source === "polyhaven") return "CC0 1.0 (Poly Haven)";
  const licence = /^Licence: (.+)$/m.exec(reply)?.[1]?.trim();
  const attribution = /^Attribution: (.+)$/m.exec(reply)?.[1]?.trim();
  if (licence !== undefined && licence !== "Unknown")
    return `${licence}${attribution === undefined ? "" : `, credit: ${attribution}`}${/BY/i.test(licence) ? " (CC-BY: credit it in the game)" : ""}`;
  return source === "sketchfab"
    ? `not reported by the import; read it at https://sketchfab.com/3d-models/${id} (CC-BY needs credit in the game)`
    : `not reported by ${source}; check it before shipping`;
};

const STILL_WORKING =
  "Blender may still be finishing this call. Inspect the scene with game_blender_scene or game_blender_look before retrying, so the work is not done twice.";

interface Session extends LiveHealth {
  readonly root: string;
  readonly port: number;
  readonly homeDir: string;
  readonly blender: OwnedProcess;
  readonly window: HostedWindow;
  readonly client: Client;
  readonly transport: StdioClientTransport;
  /** What this session was launched from; its own pids are verified against these. */
  readonly live: LiveExecutables;
  /** live.blend as the session holds it in memory; a change on disk makes the session stale. */
  readonly blend: HeldSources;
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
  // Blender's own override of every user folder (config, scripts, extensions),
  // on every OS and without a version folder (Blender 4.2+): the real
  // ~/.config/blender, %APPDATA%\\Blender Foundation and ~/Library/Application
  // Support/Blender are never read or written. Unverified on Windows and macOS.
  env.BLENDER_USER_RESOURCES = NodePath.join(homeDir, "blender");
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
  /** The session's folder, so the server's own copy of the record can be reaped at startup. */
  readonly homeDir: string;
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
  await reapRecord(record, homeDir, live);
  await NodeFSP.rm(file, { force: true });
};

const reapRecord = async (
  record: Partial<SessionRecord>,
  homeDir: string,
  live: LiveExecutables,
): Promise<void> => {
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
  const settings = yield* ServerSettings.ServerSettingsService;
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
        Effect.suspend(() => {
          const left = (held.get(root) ?? 1) - 1;
          if (left > 0) held.set(root, left);
          else held.delete(root);
          // A session something showed unusable closes when its last holder lets go.
          const session = sessions.get(root);
          return left <= 0 && session !== undefined && session.broken !== null
            ? Effect.andThen(
                Effect.logWarning("live Blender closed", { root, reason: session.broken }),
                drop(root),
              )
            : Effect.void;
        }),
    );

  // The pinned addon's config getter reads BLENDERMCP_SKETCHFAB_API_KEY and
  // BLENDERMCP_POLYPIZZA_API_KEY, so the Game tools keys reach it only through
  // the Blender and MCP child environments; without them the addon runs keyless.
  const readAddonKeyEnv: Effect.Effect<NodeJS.ProcessEnv> = settings.getSettings.pipe(
    Effect.map(({ gameSketchfabApiKey, gamePolyPizzaApiKey }) => ({
      ...(gameSketchfabApiKey === "" ? {} : { BLENDERMCP_SKETCHFAB_API_KEY: gameSketchfabApiKey }),
      ...(gamePolyPizzaApiKey === "" ? {} : { BLENDERMCP_POLYPIZZA_API_KEY: gamePolyPizzaApiKey }),
    })),
    Effect.orElseSucceed(() => ({})),
  );

  const homeDirOf = (root: string) => NodePath.join(root, "builds/logs/blender-live");
  const records = yield* makeLiveRecords<SessionRecord>("blender-live", (root) =>
    NodePath.join(homeDirOf(root), SESSION_FILE),
  );

  // uv comes from the toolchain: detected, or fetched once on first use. Defined
  // before anything that runs during construction can reach it.
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
      yield* Effect.promise(() =>
        NodeFSP.rm(records.serverRecordOf(root), { force: true }).catch(() => undefined),
      );
      if (!recorded) return;
      const live = session?.live ?? (yield* liveExecutables);
      yield* Effect.promise(() => reapRecorded(homeDirOf(root), live));
    });

  // A Blender orphaned by a crashed server is found through the server's own
  // copy of its record, whether or not its game is ever opened again.
  const startupLive = yield* liveExecutables;
  yield* records.reapAll(async (record) => {
    if (typeof record.homeDir === "string") await reapRecord(record, record.homeDir, startupLive);
  });

  const withBinDir = (env: NodeJS.ProcessEnv, binDir: string | null): NodeJS.ProcessEnv => {
    if (binDir === null) return env;
    return { ...env, PATH: `${binDir}${NodePath.delimiter}${env.PATH ?? ""}` };
  };

  const ensure = (root: string): Effect.Effect<Session, GameOperationError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const existing = sessions.get(root);
      // Reused only while it is usable and live.blend on disk is still the
      // scene it holds: after a file restore beside it, the next save would
      // write the old scene over the restored one, so it reopens the file.
      const stale =
        existing === undefined ? null : yield* Effect.promise(() => existing.blend.changed());
      if (
        existing !== undefined &&
        existing.blender.running() &&
        existing.broken === null &&
        stale === null &&
        now - existing.lastActive < LIVE_IDLE_MS
      ) {
        existing.lastActive = now;
        return existing;
      }
      if (stale !== null)
        yield* Effect.logInfo("live Blender reopens: live.blend changed on disk", { root });
      yield* drop(root);
      return yield* start(root).pipe(
        // A start cut short or failed (a stopped turn during the socket wait)
        // must not leave Blender or its MCP child running outside the session
        // map: its record names them, and the reap stops them.
        Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : drop(root))),
      );
    });

  const start = (root: string): Effect.Effect<Session, GameOperationError> =>
    Effect.gen(function* () {
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
      // Blender says where its user addons live under the isolated user folder
      // (BLENDER_USER_RESOURCES), so no version or OS layout is guessed.
      const located = yield* processes.run({
        root,
        executable: blender.path,
        args: [
          "--background",
          "--factory-startup",
          "--python-exit-code",
          "1",
          "--python-expr",
          "import bpy; print('KURAMBIT_ADDONS=' + bpy.utils.user_resource('SCRIPTS', path='addons', create=True))",
        ],
        operation: "blender-live-addons-dir",
        timeoutMs: 120_000,
        env: sessionEnv(homeDir),
        envMode: "replace",
      });
      const addonsDir = /KURAMBIT_ADDONS=(.+)/.exec(located.stdout)?.[1]?.trim();
      if (
        located.exitCode !== 0 ||
        addonsDir === undefined ||
        !NodePath.resolve(addonsDir).startsWith(NodePath.resolve(homeDir) + NodePath.sep)
      )
        return yield* opError(
          "blender-live",
          located.logPath,
          "tool-failed",
          `Blender ${blender.version} did not report a user addon folder inside the session's own folder${addonsDir === undefined ? "" : ` (it reported ${addonsDir})`}, so the pinned addon cannot be installed without touching the user's real Blender settings.`,
          located,
        );
      // The pinned server ships its addon; install it into the isolated
      // config only, never the user's real Blender folders.
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
          "tool-failed",
          "Could not install the pinned Blender addon into the isolated config.",
          installed,
        );
      // Enable the official module name in the isolated prefs headlessly.
      const enable = yield* processes.run({
        root,
        executable: blender.path,
        // Blender exits 0 when a --python-expr raises; the exit code flag and
        // the marker make a missing addon fail here, not as a 90 s socket wait.
        args: [
          "--background",
          "--python-exit-code",
          "1",
          "--python-expr",
          "import bpy; bpy.ops.preferences.addon_enable(module='blender_mcp'); bpy.ops.wm.save_userpref(); print('KURAMBIT_ENABLED')",
        ],
        operation: "blender-live-enable",
        timeoutMs: 120_000,
        env: sessionEnv(homeDir),
        envMode: "replace",
      });
      if (enable.exitCode !== 0 || !enable.stdout.includes("KURAMBIT_ENABLED"))
        return yield* opError(
          "blender-live",
          enable.logPath,
          "tool-failed",
          `Blender ${blender.version} could not enable the pinned addon in the isolated config (it was not found or failed to load).`,
          enable,
        );
      const bootPy = NodePath.join(homeDir, "boot_server.py");
      let record: SessionRecord = {
        homeDir,
        port,
        blender: blender.path,
        bootPy,
        uvx: uv.uvx,
      };
      // Written as each pid appears, so a crash mid-start still leaves the
      // next ensure or game_stop something to reap.
      const remember = (launches: Partial<SessionRecord>) =>
        Effect.suspend(() => {
          record = { ...record, ...launches };
          return records.remember(root, record);
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
              "tool-failed",
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
            "tool-failed",
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
      const blend = new HeldSources(async () => [blendPath]);
      yield* Effect.promise(() => blend.hold());
      const session: Session = {
        root,
        port,
        homeDir,
        blender: blenderProcess,
        window: hosted,
        client,
        transport,
        live: { blender: blender.path, uvx: uv.uvx },
        blend,
        broken: null,
        lastActive: startedAt,
      };
      // The MCP child gone means every call would fail "did not answer": the
      // session closes at its next release and the next call restarts it.
      client.onclose = () => breakSession(session, "the pinned MCP server exited");
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
        catch: (cause) => {
          // An answered JSON-RPC error (an unknown tool, bad arguments) is the
          // caller's request; only silence or a lost connection is Blender's.
          if (
            cause instanceof McpError &&
            cause.code !== ErrorCode.RequestTimeout &&
            cause.code !== ErrorCode.ConnectionClosed
          )
            return opError(
              "blender-live",
              name,
              "invalid-input",
              `Blender refused '${name}': ${cause.message}`,
              cause,
            );
          // A Blender that does not answer at all will not answer the next call either.
          breakSession(session, `Blender did not answer '${name}'`);
          return opError(
            "blender-live",
            root,
            "tool-failed",
            cause instanceof McpError && cause.code === ErrorCode.RequestTimeout
              ? `Blender did not answer '${name}' within ${Math.round((CALL_TIMEOUT_MS[name] ?? 120_000) / 1000)}s. ${STILL_WORKING}`
              : `Blender did not answer '${name}'.`,
            cause,
          );
        },
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
    gamePaths(manifest.engine.name, manifestProject(manifest)).blender;
  const exportDirOf = (root: string) => projects.read(root).pipe(Effect.map(assetDirOf));

  /** The game's style lock, read fresh on every call. */
  const styleOf = (root: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.realpath(root),
      catch: (cause) => opError("blender-live", root, "io", undefined, cause),
    }).pipe(Effect.flatMap(readGameStyle));

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
      // What the session holds is now what is on disk.
      const session = sessions.get(root);
      if (session !== undefined) yield* Effect.promise(() => session.blend.hold());
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
              alive: Effect.sync(() => session.broken === null && session.blender.running()),
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
          const refused = lockImportRefusal(input.source, yield* styleOf(root));
          const text = yield* callText(root, "search_assets", {
            source: input.source,
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.assetType === undefined ? {} : { asset_type: input.assetType }),
            ...(input.category === undefined ? {} : { category: input.category }),
            limit: input.limit ?? 10,
          });
          return {
            text:
              refused === null
                ? text
                : `${text}\n\nAn import from ${input.source} would be refused: ${refused}`,
          };
        }),
      ),
    assetsImport: (root, input) =>
      holding(
        root,
        Effect.gen(function* () {
          // Refused before the live scene changes.
          const style = yield* styleOf(root);
          const outside = lockImportRefusal(input.source, style);
          if (outside !== null)
            return yield* opError("blender-assets-import", root, "invalid-input", outside);
          // The import adds to the live scene; only what it added is exported,
          // never the rest of the scene under the asset's name.
          const before = yield* callText(root, "execute_blender_code", {
            code: "import bpy, json\nprint('STUDIO_NAMES ' + json.dumps([o.name for o in bpy.data.objects]))\n",
          });
          const known = /STUDIO_NAMES (\[.*\])/.exec(before)?.[1];
          if (known === undefined)
            return yield* opError(
              "blender-assets-import",
              root,
              "tool-failed",
              `Blender did not list the scene's objects before the import: ${before.slice(0, 500)}`,
            );
          const text = yield* callText(root, "import_asset", {
            source: input.source,
            id: input.id,
            ...(input.assetType === undefined ? {} : { asset_type: input.assetType }),
            ...(input.targetSize === undefined ? {} : { target_size: input.targetSize }),
            ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
            ...(input.applyTo === undefined ? {} : { apply_to: input.applyTo }),
          });
          // A rigged import must be on the lock's rig; one that is not leaves the scene again.
          const rigged = yield* callText(root, "execute_blender_code", {
            code: [
              "import bpy, json",
              ARMATURES_OF,
              `before = set(${known})`,
              "studio_armatures([o for o in bpy.context.scene.objects if o.name not in before])",
            ].join("\n"),
          });
          const armatures = armaturesIn(rigged);
          if (armatures === null)
            return yield* opError(
              "blender-assets-import",
              root,
              "tool-failed",
              `Blender did not list the import's armatures: ${rigged.slice(0, 500)}`,
            );
          const offRig = lockArmatureRefusal(armatures, style);
          if (offRig !== null) {
            yield* callText(root, "execute_blender_code", {
              code: [
                "import bpy",
                `before = set(${known})`,
                "for o in [o for o in bpy.data.objects if o.name not in before]: bpy.data.objects.remove(o, do_unlink=True)",
              ].join("\n"),
            });
            return yield* opError(
              "blender-assets-import",
              root,
              "invalid-input",
              `${offRig} The import was taken out of the live scene again.`,
            );
          }
          const blend = yield* saveBlend(root);
          // Library models arrive at arbitrary scale: normalize the id to a
          // file name, export what the import added as one GLB the game can
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
              `before = set(${known})`,
              // New objects in the scene, with their parents so armatures and empties travel along.
              "added = [o for o in bpy.context.scene.objects if o.name not in before]",
              "keep = set(added)",
              "for o in added:",
              "    p = o.parent",
              "    while p is not None:",
              "        keep.add(p)",
              "        p = p.parent",
              "bpy.ops.object.select_all(action='DESELECT')",
              "for o in keep: o.select_set(True)",
              "if keep: bpy.ops.export_scene.gltf(filepath=fp, export_format='GLB', use_selection=True)",
              "print(f'STUDIO_EXPORTED {len(keep)}')",
            ].join("\n"),
          });
          const count = Number(/STUDIO_EXPORTED (\d+)/.exec(exported)?.[1] ?? Number.NaN);
          if (!Number.isFinite(count))
            return {
              text: `${text}\nSaved .blend source: ${blend}\nGLB export failed: ${exported.slice(0, 500)}`,
            };
          if (count === 0)
            return {
              text: `${text}\nSaved .blend source: ${blend}\nThe import added no object to the scene (an HDRI or a texture), so there is nothing to export.`,
              blend,
            };
          // Provenance travels with the file: CC-BY models must be credited in the game.
          const credited = yield* Effect.flatMap(
            Effect.tryPromise({
              try: () => NodeFSP.realpath(root),
              catch: (cause) => opError("blender-assets-import", root, "io", undefined, cause),
            }),
            (realRoot) =>
              recordProvenance(
                realRoot,
                [
                  {
                    first: exportRel,
                    line: `- \`${exportRel}\` — Blender import from ${input.source} ${input.id} by ${IMPORT_TOOL}; licence: ${importLicence(input.source, input.id, text)}. Depicts / loaded by: (fill in).`,
                  },
                ],
                IMPORT_TOOL,
              ),
          );
          return {
            text: `${text}\nSaved .blend source: ${blend}\nExported ${exportRel} (${count} object${count === 1 ? "" : "s"} the import added). ${credited} Run game_import after.`,
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
          const engineDir = manifestProject(manifest);
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
          // Characters reach the game only on the lock's rig: checked before anything is written.
          const rigged = yield* callText(root, "execute_blender_code", {
            code: [
              "import bpy, json",
              ARMATURES_OF,
              `wanted = ${JSON.stringify(names)}`,
              "obs = [bpy.data.objects.get(n) for n in wanted] if wanted else [o for o in bpy.context.scene.objects if o.type == 'MESH']",
              "studio_armatures([o for o in obs if o is not None])",
            ].join("\n"),
          });
          const armatures = armaturesIn(rigged);
          if (armatures === null)
            return yield* opError(
              "blender-export",
              file,
              "tool-failed",
              `Blender did not list the export's armatures: ${rigged.slice(0, 500)}`,
            );
          const offRig = lockArmatureRefusal(armatures, yield* styleOf(root));
          if (offRig !== null)
            return yield* opError("blender-export", file, "invalid-input", offRig);
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
