// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the native filesystem, process, and MCP-stdio boundary; wall-clock pids and JSON code strings are the domain here.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
  type GameBlenderGenerateInput,
  type GameBlenderGenerateResult,
  type GameBlenderLookInput,
  type GameBlenderLookResult,
  type GameBlenderSceneInput,
  type GameBlenderSceneResult,
} from "@t3tools/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const PINNED_PKG = "mcp-for-blender@2.2.6";
const IDLE_MS = 10 * 60_000;
const BLEND_REL = "art/blender/live.blend";
const EXPORT_DIR = "godot/assets/blender";

/** Addon keys the service can pass straight through: the pinned addon's
 * config getter reads BLENDERMCP_SKETCHFAB_API_KEY /
 * BLENDERMCP_POLYPIZZA_API_KEY from the environment, so keys set in Game
 * Tools reach the addon via the Blender and MCP child environments. */
export const GAME_BLENDER_SKETCHFAB_SECRET = "game-blender-sketchfab-key";
export const GAME_BLENDER_POLYPIZZA_SECRET = "game-blender-polypizza-key";

interface Session {
  readonly root: string;
  readonly display: string;
  readonly port: number;
  readonly homeDir: string;
  readonly blenderPid: number;
  readonly xvfbPid: number;
  readonly mcpPid: number;
  readonly client: Client;
  readonly transport: StdioClientTransport;
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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
const sessionEnv = (
  homeDir: string,
  display: string | null,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
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
  env.TMPDIR = NodePath.join(NodeOS.homedir(), ".gs-tmp");
  env.LIBGL_ALWAYS_SOFTWARE = "1";
  env.LP_NUM_THREADS = "2";
  env.DISABLE_TELEMETRY = "true";
  if (display !== null) env.DISPLAY = display;
  return env;
};

/** Plain record for the stdio transport: no undefined entries. */
const stringEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
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

const pickDisplay = async (): Promise<number | null> => {
  for (let n = 119; n < 250; n++) {
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

/** PNG IHDR dimensions without a decoder: width/height at bytes 16/20. */
const pngSizeOf = (data: string, fallback: number): { width: number; height: number } => {
  try {
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47)
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } catch {
    /* fall through */
  }
  return { width: fallback, height: fallback };
};

type McpContent = {
  readonly content?: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }>;
};

const textOf = (result: McpContent): string =>
  (result.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n");

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
    readonly generate: (
      root: string,
      input: GameBlenderGenerateInput,
    ) => Effect.Effect<GameBlenderGenerateResult, GameOperationError>;
    /** Live Blender scene: export named objects (or every mesh) as a GLB under godot/. */
    readonly exportGlb: (
      root: string,
      input: GameBlenderExportInput,
    ) => Effect.Effect<GameBlenderExportResult, GameOperationError>;
    /** Stop one game's live session by root; game_stop calls this. */
    readonly stop: (root: string) => Effect.Effect<void>;
  }
>()("t3/game/GameBlender") {}

const make = Effect.gen(function* () {
  const processes = yield* GameProcesses.GameProcesses;
  const tools = yield* GameToolchain.GameToolchain;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = new Map<string, Session>();

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

  const killPid = (pid: number | undefined): void => {
    if (pid === undefined || pid <= 0 || !alive(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  };

  const drop = (root: string): void => {
    const session = sessions.get(root);
    if (session === undefined) return;
    sessions.delete(root);
    killPid(session.mcpPid);
    killPid(session.blenderPid);
    killPid(session.xvfbPid);
    void session.client.close().catch(() => undefined);
  };

  const failMissingUv = (): GameOperationError =>
    opError(
      "blender-live",
      PINNED_PKG,
      "tool-missing",
      "The live Blender view needs managed uv (Settings > General > Game tools > Install), or `uvx` on PATH. Follow-up: teach GameToolchain to install uv like Blender and Godot.",
    );

  // uv resolved once per session: the toolchain's managed install first
  // (downloaded and pinned like Blender and Godot), PATH as a fallback.
  interface UvPaths {
    readonly uvx: string;
    readonly binDir: string | null;
  }
  const resolveUv: Effect.Effect<UvPaths, GameOperationError> = Effect.gen(function* () {
    const managed = yield* tools.executable("uv").pipe(
      Effect.map((resolved) => resolved.path),
      Effect.orElseSucceed(() => null as string | null),
    );
    if (managed !== null) {
      const dir = NodePath.dirname(managed);
      const sibling = NodePath.join(dir, "uvx");
      const hasSibling = yield* Effect.promise(() =>
        NodeFSP.access(sibling, NodeFSP.constants.X_OK)
          .then(() => true)
          .catch(() => false),
      );
      return { uvx: hasSibling ? sibling : managed, binDir: dir };
    }
    for (const name of ["uvx", "uv"]) {
      for (const dir of (process.env.PATH ?? "").split(NodePath.delimiter)) {
        if (dir === "") continue;
        const candidate = NodePath.join(dir, name);
        const found = yield* Effect.promise(() =>
          NodeFSP.access(candidate, NodeFSP.constants.X_OK)
            .then(() => true)
            .catch(() => false),
        );
        if (found) return { uvx: candidate, binDir: null };
      }
    }
    return yield* failMissingUv();
  });

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
        alive(existing.blenderPid) &&
        alive(existing.xvfbPid) &&
        now - existing.lastActive < IDLE_MS
      ) {
        existing.lastActive = now;
        return existing;
      }
      if (existing !== undefined) drop(root);
      const uv = yield* resolveUv;
      const blender = yield* tools.executable("blender");
      const addonKeys = yield* readAddonKeyEnv;
      const homeDir = NodePath.join(root, "builds/logs/blender-live");
      const port = portFor(root);
      if (yield* Effect.promise(() => portFree(port)).pipe(Effect.map((free) => !free)))
        return yield* opError(
          "blender-live",
          `${root}:${port}`,
          "busy",
          `The live Blender port ${port} is taken. Stop this game's live session with game_stop and retry.`,
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
            ...sessionEnv(homeDir, null),
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
        env: sessionEnv(homeDir, null),
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
      const displayNum = yield* Effect.promise(() => pickDisplay());
      if (displayNum === null)
        return yield* opError(
          "blender-live",
          root,
          "busy",
          "No free private Xvfb display (:119–:249).",
        );
      const display = `:${displayNum}`;
      const xvfb = NodeChildProcess.spawn("Xvfb", [display, "-screen", "0", "1280x800x24"], {
        env: sessionEnv(homeDir, null),
        detached: true,
        stdio: "ignore",
      });
      xvfb.unref();
      if (xvfb.pid === undefined) {
        return yield* opError("blender-live", display, "io", "Xvfb did not start.");
      }
      const xvfbPid = xvfb.pid;
      const bootPy = NodePath.join(homeDir, "boot_server.py");
      yield* Effect.tryPromise({
        try: () =>
          NodeFSP.writeFile(
            bootPy,
            `import bpy\nbpy.ops.preferences.addon_enable(module='blender_mcp')\nscene = bpy.context.scene\nscene.blendermcp_port = ${port}\nscene.blendermcp_use_polyhaven = True\nscene.blendermcp_auto_start_server = True\nbpy.ops.blendermcp.start_server()\nprint("STUDIO_BLENDER_READY port=${port}")\n`,
          ),
        catch: (cause) => opError("blender-live", bootPy, "io", undefined, cause),
      });
      const logPath = NodePath.join(homeDir, "blender.log");
      const spawned = yield* Effect.sync(() => {
        const logFd = NodeFS.openSync(logPath, "w");
        const child = NodeChildProcess.spawn(blender.path, ["--python", bootPy], {
          env: withBinDir({ ...sessionEnv(homeDir, display), ...addonKeys }, uv.binDir),
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        child.unref();
        try {
          NodeFS.closeSync(logFd);
        } catch {
          /* the child keeps its copy */
        }
        return child.pid;
      });
      if (spawned === undefined) {
        killPid(xvfbPid);
        return yield* opError("blender-live", root, "io", "Blender did not start.");
      }
      const blenderPid = spawned;
      if (!(yield* Effect.promise(() => waitPort(port, 90_000)))) {
        killPid(blenderPid);
        killPid(xvfbPid);
        return yield* opError(
          "blender-live",
          logPath,
          "command-failed",
          "Blender's addon socket did not open in 90s; see builds/logs/blender-live/blender.log.",
        );
      }
      // One child of the pinned server per game, telemetry off, over stdio.
      // The addon reads Sketchfab/Poly Pizza keys from BLENDERMCP_* env, so
      // keys set in Game Tools ride the Blender and MCP environments below.
      // The MCP child serves tool calls to the model, so it gets the
      // allowlisted base plus only those intentional addon keys.
      const mcpEnv = stringEnv(
        withBinDir(
          {
            ...GameProcesses.engineChildEnv(),
            TMPDIR: NodePath.join(NodeOS.homedir(), ".gs-tmp"),
            DISABLE_TELEMETRY: "true",
            LIBGL_ALWAYS_SOFTWARE: "1",
            ...addonKeys,
          },
          uv.binDir,
        ),
      );
      const transport = new StdioClientTransport({
        command: uv.uvx,
        args: [PINNED_PKG, "--port", String(port)],
        env: mcpEnv,
      });
      const client = new Client({ name: "t3-game-blender", version: "1.0.0" }, {});
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
      });
      void connected;
      const startedAt = yield* Clock.currentTimeMillis;
      const mcpPid = (transport as unknown as { _process?: { pid?: number } })._process?.pid ?? -1;
      const session: Session = {
        root,
        display,
        port,
        homeDir,
        blenderPid,
        xvfbPid,
        mcpPid,
        client,
        transport,
        lastActive: startedAt,
      };
      sessions.set(root, session);
      return session;
    });

  const callText = (
    root: string,
    name: string,
    args: Record<string, unknown>,
  ): Effect.Effect<string, GameOperationError> =>
    Effect.gen(function* () {
      const session = yield* ensure(root);
      const result = (yield* Effect.tryPromise({
        try: () => session.client.callTool({ name, arguments: args }),
        catch: (cause) =>
          opError(
            "blender-live",
            root,
            "command-failed",
            `Blender did not answer '${name}'.`,
            cause,
          ),
      })) as McpContent;
      session.lastActive = yield* Clock.currentTimeMillis;
      return textOf(result);
    });

  const saveBlend = (root: string): Effect.Effect<string, GameOperationError> =>
    Effect.gen(function* () {
      const absolute = NodePath.join(root, BLEND_REL);
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true }),
        catch: (cause) => opError("blender-live", BLEND_REL, "io", undefined, cause),
      });
      const text = yield* callText(root, "execute_blender_code", {
        code: `import bpy\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(absolute)})\nprint("STUDIO_SAVED")\n`,
      });
      if (!text.includes("STUDIO_SAVED"))
        return yield* opError("blender-live", BLEND_REL, "command-failed", text.slice(0, 1000));
      return BLEND_REL;
    });

  // Idle sessions die on a detached sweep so one forgotten game cannot hold
  // Blender, Xvfb and the MCP child forever.
  yield* Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep("60 seconds");
      const now = yield* Clock.currentTimeMillis;
      for (const [root, session] of sessions) if (now - session.lastActive > IDLE_MS) drop(root);
    }),
  ).pipe(Effect.forkDetach);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const root of [...sessions.keys()]) drop(root);
    }),
  );

  return GameBlender.of({
    code: (root, input) =>
      Effect.gen(function* () {
        const text = yield* callText(root, "execute_blender_code", { code: input.code });
        const blend = yield* saveBlend(root);
        return { output: `${text}\nSaved .blend source: ${blend}` };
      }),
    look: (root, input) =>
      Effect.gen(function* () {
        const session = yield* ensure(root);
        const result = (yield* Effect.tryPromise({
          try: () =>
            session.client.callTool({
              name: "look",
              arguments: {
                ...(input.mode === undefined ? {} : { mode: input.mode }),
                ...(input.target === undefined ? {} : { target: input.target }),
                ...(input.views === undefined ? {} : { views: input.views }),
                ...(input.distance === undefined ? {} : { distance: input.distance }),
                ...(input.shading === undefined ? {} : { shading: input.shading }),
                ...(input.frames === undefined ? {} : { frames: input.frames }),
                ...(input.frameCount === undefined ? {} : { frame_count: input.frameCount }),
                ...(input.view === undefined ? {} : { view: input.view }),
                max_size: input.maxSize ?? 768,
              },
            }),
          catch: (cause) =>
            opError(
              "blender-live",
              root,
              "command-failed",
              "Blender did not answer 'look'.",
              cause,
            ),
        })) as McpContent;
        session.lastActive = yield* Clock.currentTimeMillis;
        const text = textOf(result);
        const image = (result.content ?? []).find((entry) => entry.type === "image");
        if (image?.data === undefined)
          return { text: text === "" ? "Blender returned no image." : text };
        const size = pngSizeOf(image.data, input.maxSize ?? 768);
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
    scene: (root, input) =>
      Effect.gen(function* () {
        const text = yield* callText(root, "get_scene_info", { ...input });
        return { text };
      }),
    assetsSearch: (root, input) =>
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
    assetsImport: (root, input) =>
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
        const exportRel = `${EXPORT_DIR}/${safe}.glb`;
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
          text: `${text}\nSaved .blend source: ${blend}\nRun game_import so Godot sees it.`,
          blend,
          export: exportRel,
        };
      }),
    generate: (root, input) =>
      Effect.gen(function* () {
        const text = yield* callText(root, "generate_3d", { ...input });
        return { text };
      }),
    exportGlb: (root, input) =>
      Effect.gen(function* () {
        // Thin path from the live scene to a GLB the game can load: select
        // the named objects (or every mesh) and run the glTF exporter, then
        // save the .blend source like every other scene-changing call.
        const file = input.file ?? "godot/assets/blender/scene.glb";
        if (!file.startsWith("godot/") || !file.endsWith(".glb") || file.includes(".."))
          return yield* opError(
            "blender-export",
            file,
            "invalid-input",
            "The destination must be a game-relative path under godot/ ending with .glb.",
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
          return yield* opError("blender-export", file, "command-failed", exported.slice(0, 1000));
        const blend = yield* saveBlend(root);
        return {
          text: `${exported}\nSaved .blend source: ${blend}\nRun game_import so Godot sees it.`,
          blend,
          export: file,
        };
      }),
    stop: (root) => Effect.sync(() => drop(root)),
  });
});

export const layer = Layer.effect(GameBlender, make);
