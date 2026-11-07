// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the native filesystem, process, and MCP-stdio boundary; wall-clock pids and JSON code strings are the domain here.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  GameOperationError,
  type GameBlenderAssetsImportInput,
  type GameBlenderAssetsImportResult,
  type GameBlenderAssetsSearchInput,
  type GameBlenderAssetsSearchResult,
  type GameBlenderCharacterInput,
  type GameBlenderCharacterResult,
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
  type GameCharacterRoute,
  type GameManifest,
  type GameStyle,
  type GameStyleView,
  GAME_STYLE_FILE,
  manifestProject,
} from "@kurambit/contracts";
import * as GameArt from "./art/GameArt.ts";
import * as GameAssetLibrary from "./GameAssetLibrary.ts";
import type { PackClips } from "./GameAssetLibrary.ts";
import * as GameTemplates from "./GameTemplates.ts";
import {
  LIBRARY_CATALOG,
  LIBRARY_RIG_JOINTS,
  STANDARD_ARMATURE,
  STANDARD_CLIPS,
  STANDARD_RIG,
} from "./assetLibraryCatalog.ts";
import {
  CANDIDATE_GLB,
  type Candidate,
  KIT_DIR,
  KitDigest,
  PIPELINE_DIR,
  PassResult,
  type PassRecord,
  candidateJsonPath,
  conceptOf,
  encodeCandidate,
  encodePassRecord,
  kitOutput,
  kitVersion,
  ledgerLine,
  ledgerParts,
  measurementText,
  passJsonPath,
  readCandidate,
  readPassRecord,
  reviewKey,
  sidecarOf,
  sidecarPathOf,
  sidecarText,
  subjectName,
} from "./blenderPipeline.ts";
import { commandDetail } from "./commandDetail.ts";
import { fileSha256 } from "./fileHash.ts";
import { ensureGameDir } from "./gameKeptSaves.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSettings from "../serverSettings.ts";
import { recordProvenance, renderSprites } from "./blenderSprites.ts";
import {
  characterRoute,
  lockArmatureRefusal,
  lockCharacterRouteRefusal,
  lockImportRefusal,
  lockPackRefusal,
  readGameStyle,
  resolveRig,
  styleBudgets,
  styleHash,
} from "./gameStyle.ts";
import { gamePaths } from "./engineProfile.ts";
import { GENERATED_DIR, generatedSource, motionClipName } from "./generatedSource.ts";
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
const EXPORT_TOOL = "game_blender_export";

/**
 * Python that prints `STUDIO_ARMATURES {name: [bones]}` for the armatures that
 * would travel with `objs` into a GLB: the objects themselves, their parents
 * and the armatures their modifiers deform with. A generated creature's
 * armature (kurambit_rig) is on its own rig, which the lock does not govern.
 */
const ARMATURES_OF = `
def studio_armatures(objs):
    found = {}
    for o in objs:
        cands = [o, o.parent] + [m.object for m in getattr(o, "modifiers", []) if m.type == "ARMATURE"]
        for a in cands:
            if a is not None and a.type == "ARMATURE" and not a.get("kurambit_rig"):
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

/**
 * Boot lines that put the kit on sys.path and import it; a broken kit is said, not fatal. No
 * bytecode is written: the kit folder is the app's (the repository's in dev), not the game's.
 */
const kitBoot = (kit: string) =>
  `import sys\nsys.dont_write_bytecode = True\nsys.path.insert(0, ${JSON.stringify(kit)})\ntry:\n    import kurambit\nexcept Exception as error:\n    print("KURAMBIT_KIT_FAILED", repr(error))\n`;

/** The one-shot pipeline pass: a factory-startup Blender that opens a copy of the scene. */
const PASS_ROOM: MemoryRoom = {
  what: "Blender pipeline pass",
  neededMb: 1024,
  env: "KURAMBIT_BLENDER_PASS_MEMORY_MB",
};
/** A character's height on screen at game distance, px, by the lock's view. */
const GAME_PX: Readonly<Record<GameStyleView, number>> = {
  perspective: 96,
  side: 96,
  "top-down": 64,
  isometric: 64,
};
const isReason = Schema.is(GameOperationError.fields.reason);
/** What kurambit.character prints (§2.8). */
const CharacterMade = Schema.Struct({
  armature: Schema.String,
  meshes: Schema.Array(Schema.String),
  clips: Schema.Array(Schema.String),
  chains: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  restDeviation: Schema.Number,
  height: Schema.Number,
  notes: Schema.Array(Schema.String),
});
/** What kurambit.review prints (§2.8). */
const ReviewRender = Schema.Struct({
  image: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  /** Tiles the model hardly shows in (under 1% covered): out of frame, or too small to judge. */
  problems: Schema.optionalKey(Schema.Array(Schema.String)),
});
/** What kurambit.generated prints. */
const GeneratedMade = Schema.Struct({
  objects: Schema.Array(Schema.String),
  armature: Schema.NullOr(Schema.String),
  clips: Schema.Array(Schema.String),
  size: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
  notes: Schema.Array(Schema.String),
});
const decodeGeneratedMade = Schema.decodeUnknownEffect(GeneratedMade);
const decodeCharacterMade = Schema.decodeUnknownEffect(CharacterMade);
const decodeMotionStrip = Schema.decodeUnknownEffect(Schema.Struct({ image: Schema.String }));
const decodeReviewRender = Schema.decodeUnknownEffect(ReviewRender);
const decodeDigest = Schema.decodeUnknownEffect(KitDigest);
const decodePass = Schema.decodeUnknownEffect(PassResult);
const STANDARD_BODY_PACKS = LIBRARY_CATALOG.filter(
  (pack) => pack.rig === STANDARD_RIG && pack.kinds.includes("character"),
).map((pack) => pack.id);
const MPFB_MISSING = `An mpfb body needs MPFB2, which is not installed. Only the person installs it, in Settings → Game tools (the MPFB2 row); say so in your reply if the request needs it. Meanwhile use a library body: {library: {pack: "quaternius-universal-base-characters", file: "Base Characters/Godot - UE/Superhero_Female_FullBody.gltf"}} (or Superhero_Male_FullBody.gltf), or the Universal Animation Library's mannequin.`;
/**
 * The person's route refuses a made character on library: an MPFB2 body, or a mesh no library
 * or import stamped (§8). Props are modelled on every route, and a clip keyed here is no mesh.
 */
const routeRefusalOf = (candidate: Candidate, route: GameCharacterRoute) =>
  candidate.kind !== "character"
    ? null
    : candidate.parts.some((part) => part.from === "mpfb2")
      ? lockCharacterRouteRefusal("mpfb-body", route)
      : // The body or a creature's own rig: a generated prop it holds (a sword, a hat) is no character.
        candidate.parts.some((part) => part.ai && part.what === "body") ||
          Object.keys(candidate.creatures ?? {}).length > 0
        ? lockCharacterRouteRefusal("generated-body", route)
        : candidate.parts.some((part) => part.from === "made" && part.what !== "clips")
          ? lockCharacterRouteRefusal("unstamped-mesh", route)
          : null;

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
  /** MPFB2 is installed in this session's own Blender folder (it was ready when the session opened). */
  readonly mpfb: boolean;
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

const waitPortFree = async (port: number, timeoutMs: number): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await portFree(port)) return true;
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

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
    /**
     * Strips of motion-lane clips, each on the body its GLB holds, written as one PNG; rendered in
     * a throwaway scene like the review, so the live scene does not change.
     */
    readonly motionStrip: GameArt.MotionStripRender;
    /** A model's front, side and back, textured and in clay, as one PNG; the live scene does not change. */
    readonly modelViews: GameArt.ModelViewsRender;
    /** Live Blender scene: a rigged, animated character conformed to the standard skeleton. */
    readonly character: (
      root: string,
      input: GameBlenderCharacterInput,
    ) => Effect.Effect<GameBlenderCharacterResult, GameOperationError>;
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
  const art = yield* GameArt.GameArt;
  const library = yield* GameAssetLibrary.GameAssetLibrary;
  const templates = yield* GameTemplates.GameTemplates;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const sessions = new Map<string, Session>();
  /**
   * One per game (its real root) around a review's pass and its records, and an export's
   * promotion: an export never copies a GLB a pass is still writing, and two reviews of one key
   * never share a candidate folder at once.
   */
  const pipelineLocks = yield* KeyedLock.make<string>();
  const pipelineLocked =
    (root: string) =>
    <A>(effect: Effect.Effect<A, GameOperationError>) =>
      Effect.flatMap(realRootOf(root), (realRoot) => pipelineLocks.withLock(realRoot, effect));
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

  const kitDirectory = templates.directory.pipe(
    Effect.map((directory) => NodePath.join(directory, KIT_DIR)),
  );
  // Once per server, like the facts harness: the kit ships with it and is not edited in place.
  const kitVersionOf = yield* Effect.cached(
    kitDirectory.pipe(
      Effect.flatMap((kit) =>
        Effect.tryPromise({
          try: () => kitVersion(kit),
          catch: (cause) =>
            opError("blender-kit", kit, "io", "The Blender kit could not be read.", cause),
        }),
      ),
    ),
  );

  /**
   * MPFB2 in the session's own Blender folder (BLENDER_USER_RESOURCES), never the user's: while
   * Settings holds the verified zip it is installed once (a marker names the zip), and after a
   * Remove the next session takes it out again. A failed install never stops the session; an
   * mpfb body then says why.
   */
  const installMpfb = (root: string, blender: string, homeDir: string) =>
    Effect.gen(function* () {
      const zip = yield* tools.blenderExtension("mpfb");
      const marker = NodePath.join(homeDir, "mpfb.installed");
      const have = yield* Effect.promise(() => NodeFSP.readFile(marker, "utf8").catch(() => null));
      const want = zip === null ? null : NodePath.basename(zip);
      if (have === want) return want !== null;
      const run = (args: ReadonlyArray<string>, operation: string) =>
        processes
          .run({
            root,
            executable: blender,
            args: ["--background", "--command", "extension", ...args],
            operation,
            timeoutMs: 180_000,
            env: sessionEnv(homeDir),
            envMode: "replace",
          })
          .pipe(
            Effect.map((result) => result.exitCode === 0 && !result.timedOut),
            Effect.orElseSucceed(() => false),
          );
      if (zip === null) {
        yield* run(["remove", "user_default.mpfb"], "blender-live-mpfb-remove");
        yield* Effect.promise(() => NodeFSP.rm(marker, { force: true }));
        return false;
      }
      const installed = yield* run(
        ["install-file", "--repo", "user_default", "--enable", zip],
        "blender-live-mpfb",
      );
      if (!installed) {
        yield* Effect.logWarning("MPFB2 did not install into the live Blender", { root });
        return false;
      }
      yield* Effect.promise(() => NodeFSP.writeFile(marker, want!).catch(() => undefined));
      return true;
    });

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
      // A session just closed (a reopen) lets its port go within its stop's grace.
      if (!(yield* Effect.promise(() => waitPortFree(port, 10_000))))
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
        // The first open on a machine downloads the pinned server and its Python
        // (minutes on a slow network); later opens find them in the shared cache.
        timeoutMs: 600_000,
        env: withBinDir(
          {
            ...sessionEnv(homeDir),
            ...GameToolchain.uvCacheEnv(),
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
          installed.timedOut
            ? `Downloading the pinned Blender MCP server (${PINNED_PKG}) did not finish in 10 minutes. What downloaded is kept, so opening Blender again continues it; check the network if it keeps stopping.`
            : `Could not install the pinned Blender addon into the isolated config (${PINNED_PKG}); see ${installed.logPath}. A network failure here is uv's download: check the network and retry.`,
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
      const mpfb = yield* installMpfb(root, blender.path, homeDir);
      // The kit is importable in every exec (`import kurambit`): on sys.path and imported at
      // open. A kit that fails to import is said at the first call that needs it, never here.
      const kit = yield* kitDirectory.pipe(Effect.orElseSucceed(() => null));
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
            `import bpy\nbpy.context.preferences.filepaths.save_version = 0\n${kit === null ? "" : kitBoot(kit)}bpy.ops.preferences.addon_enable(module='blender_mcp')\nscene = bpy.context.scene\nscene.blendermcp_port = ${port}\nscene.blendermcp_use_polyhaven = True\nscene.blendermcp_auto_start_server = True\nbpy.ops.blendermcp.start_server()\nprint("STUDIO_BLENDER_READY port=${port}")\n`,
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
            ...GameToolchain.uvCacheEnv(),
            // The installer just filled the shared cache with this exact pin: the
            // child the model reaches never needs the network to start.
            UV_OFFLINE: "1",
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
        // A cold uv environment build can outlast the SDK's 60 s default.
        try: () => client.connect(transport, { timeout: 120_000 }),
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
        mpfb,
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

  /**
   * One kit entry in the live scene (§2.8): its one result line, decoded; its refusal as the
   * reason it names; anything it raised fails the call with the traceback already.
   */
  const kitCall = <A>(
    root: string,
    operation: string,
    decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>,
    code: string,
  ): Effect.Effect<A, GameOperationError> =>
    Effect.gen(function* () {
      const kit = yield* kitDirectory;
      const text = yield* callText(root, "execute_blender_code", {
        code: `import sys, json\nsys.dont_write_bytecode = True\nif ${JSON.stringify(kit)} not in sys.path: sys.path.insert(0, ${JSON.stringify(kit)})\nimport kurambit\n${code}\n`,
      });
      const output = kitOutput(text);
      if (output.kind === "refused")
        return yield* opError(
          operation,
          root,
          isReason(output.reason) ? output.reason : "invalid-input",
          output.text.slice(0, 2000),
        );
      if (output.kind === "none")
        return yield* opError(
          operation,
          root,
          "tool-failed",
          `The Blender kit printed no result: ${text.slice(0, 1500)}`,
        );
      return yield* decode(output.value).pipe(
        Effect.mapError((cause) =>
          opError(
            operation,
            root,
            "tool-failed",
            `The Blender kit's result did not match its protocol: ${cause.message.slice(0, 600)}`,
            cause,
          ),
        ),
      );
    });

  const pyJson = (value: unknown) => `json.loads(${JSON.stringify(JSON.stringify(value))})`;

  /** The objects a review or export covers, digested as they are in the live scene now. */
  const liveDigest = (root: string, names: ReadonlyArray<string> | null) =>
    kitCall(
      root,
      "blender-digest",
      decodeDigest,
      [
        "import bpy",
        `wanted = ${names === null ? "None" : pyJson(names)}`,
        "missing = [n for n in (wanted or []) if bpy.data.objects.get(n) is None]",
        "if missing: print('KURAMBIT_REFUSED ' + json.dumps({'reason': 'invalid-input', 'text': 'No object named ' + ', '.join(missing) + ' in the live scene; it has ' + ', '.join(o.name for o in list(bpy.data.objects)[:40]) + '.'}))",
        "else: kurambit.digest(wanted)",
      ].join("\n"),
    ).pipe(
      Effect.flatMap((digest) =>
        digest.objects.length === 0
          ? Effect.fail(
              opError(
                "blender-digest",
                root,
                "invalid-input",
                "Nothing to review or export: name the objects (a character's armature brings its body and parts), or put a mesh in the scene.",
              ),
            )
          : Effect.succeed(digest),
      ),
    );

  /** The candidate folder of a key, made inside the game (a link out of it is refused). */
  const candidateDir = (realRoot: string, key: string) =>
    Effect.tryPromise({
      try: () => ensureGameDir(realRoot, `${PIPELINE_DIR}/${key}`),
      catch: (cause) =>
        opError("blender-review", `${PIPELINE_DIR}/${key}`, "invalid-path", undefined, cause),
    });

  const writeText = (filePath: string, contents: string, operation: string) =>
    writeFileStringAtomically({ filePath, contents, followLink: false }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
      Effect.mapError((cause) => opError(operation, filePath, "io", undefined, cause)),
    );

  const realRootOf = (root: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.realpath(root),
      catch: (cause) => opError("blender-live", root, "io", undefined, cause),
    });

  /**
   * The one-shot pass on a copy of the saved scene (§2.8): the style pass and the measurement
   * in a factory-startup Blender under the session's isolated folders, behind the memory gate.
   * It writes the GLB to `glb`, a name of this run's that the caller renames into place; its
   * result is returned as it measured it.
   */
  const runPass = (
    root: string,
    out: string,
    glb: string,
    params: Record<string, unknown>,
  ): Effect.Effect<typeof PassResult.Type, GameOperationError> =>
    Effect.gen(function* () {
      const blender = yield* tools.executable("blender");
      const kit = yield* kitDirectory;
      const run = NodeCrypto.randomUUID();
      const copy = NodePath.join(out, `scene.${run}.blend`);
      const paramsFile = NodePath.join(out, `params.${run}.json`);
      // The live scene saves the copy itself: Blender remaps its relative paths (library
      // textures) for the copy's folder, so the pass resolves the same files the scene does.
      const saved = yield* callText(root, "execute_blender_code", {
        code: `import bpy\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(copy)}, copy=True, compress=True)\nprint("STUDIO_SAVED")\n`,
      });
      if (!saved.includes("STUDIO_SAVED"))
        return yield* opError("blender-review", copy, "command-failed", saved.slice(0, 1000));
      yield* Effect.tryPromise({
        try: () => NodeFSP.writeFile(paramsFile, JSON.stringify({ ...params, out, glb })),
        catch: (cause) => opError("blender-review", out, "io", undefined, cause),
      });
      const result = yield* gate
        .admit(
          "blender-pipeline-pass",
          root,
          PASS_ROOM,
          processes.run({
            root,
            executable: blender.path,
            args: [
              "-b",
              "--factory-startup",
              copy,
              "--python-exit-code",
              "1",
              "--python",
              NodePath.join(kit, "run.py"),
              "--",
              "pass",
              paramsFile,
            ],
            operation: "blender-pipeline-pass",
            timeoutMs: 180_000,
            env: sessionEnv(homeDirOf(root)),
            envMode: "replace",
          }),
        )
        // The copy is the size of the scene; the candidate GLB is what the review keeps.
        .pipe(
          Effect.ensuring(
            Effect.promise(() =>
              Promise.all([copy, paramsFile].map((file) => NodeFSP.rm(file, { force: true }))),
            ),
          ),
        );
      const output = kitOutput(result.stdout);
      if (output.kind === "refused")
        return yield* opError(
          "blender-review",
          root,
          isReason(output.reason) ? output.reason : "invalid-input",
          output.text.slice(0, 2000),
        );
      if (output.kind === "none" || result.exitCode !== 0)
        return yield* opError(
          "blender-review",
          result.logPath,
          "tool-failed",
          `${result.timedOut ? "The pipeline pass did not finish in 180 s" : "The pipeline pass failed"}: ${commandDetail(result).slice(-2000)}`,
          result,
        );
      return yield* decodePass(output.value).pipe(
        Effect.mapError((cause) =>
          opError(
            "blender-review",
            root,
            "tool-failed",
            `The pipeline pass's result did not match its protocol: ${cause.message.slice(0, 600)}`,
            cause,
          ),
        ),
      );
    });

  /**
   * Each named clip found in the lock's animation packs on the standard skeleton, in the
   * lock's order (the standard armature's pack first); "pack:Clip" picks the pack.
   */
  const resolveClips = (root: string, names: ReadonlyArray<string>, packs: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const refuse = (detail: string) =>
        Effect.fail(opError("blender-character", root, "invalid-input", detail));
      const ordered = [...packs].toSorted(
        (a, b) => Number(b === STANDARD_ARMATURE.pack) - Number(a === STANDARD_ARMATURE.pack),
      );
      const withClips = ordered.filter((id) =>
        LIBRARY_CATALOG.find((pack) => pack.id === id)?.kinds.includes("animation"),
      );
      if (names.length > 0 && withClips.length === 0)
        return yield* refuse(
          `${GAME_STYLE_FILE}'s packs list no animation pack on ${STANDARD_RIG}, so no clip can be added. Add "${STANDARD_ARMATURE.pack}" to its packs.`,
        );
      const libraries = new Map<string, ReadonlyArray<PackClips>>();
      for (const id of withClips) libraries.set(id, yield* library.packClips(id));
      const found: Array<{ pack: string; name: string; path: string; licence: string }> = [];
      const missing: string[] = [];
      for (const wanted of names) {
        const colon = wanted.indexOf(":");
        const named = colon > 0 ? wanted.slice(0, colon) : null;
        const clip = colon > 0 ? wanted.slice(colon + 1) : wanted;
        if (named !== null && !withClips.includes(named))
          return yield* refuse(
            `${wanted}: ${named} is not an animation pack ${GAME_STYLE_FILE}'s packs list on ${STANDARD_RIG} (${withClips.join(", ") || "none"}). Add it to packs first if it fits the game.`,
          );
        const hit = (named === null ? withClips : [named]).flatMap((id) =>
          (libraries.get(id) ?? [])
            .filter((entry) => entry.clips.includes(clip))
            .map((entry) => ({ id, entry })),
        )[0];
        if (hit === undefined) missing.push(wanted);
        else
          found.push({
            pack: hit.id,
            name: clip,
            path: hit.entry.file,
            licence: LIBRARY_CATALOG.find((pack) => pack.id === hit.id)?.licence ?? "",
          });
      }
      if (missing.length > 0)
        return yield* refuse(
          `No clip ${missing.join(", ")} in ${withClips.join(", ")}. They hold: ${withClips
            .map(
              (id) =>
                `${id}: ${[...new Set((libraries.get(id) ?? []).flatMap((entry) => entry.clips))].slice(0, 80).join(", ")}`,
            )
            .join("; ")}.`.slice(0, 4000),
        );
      return found;
    });

  /**
   * The lock's rig check skips an armature marked as a generated creature (kurambit_rig), and
   * any scene code can set that mark. So each one must name the finished creature generation of
   * this game that delivered it, as the import wrote it; anything else is refused here, at the
   * review and again at the export. The route itself is routeRefusalOf's.
   */
  const creatureRefusal = (root: string, candidate: Candidate) =>
    Effect.gen(function* () {
      for (const name of Object.keys(candidate.creatures ?? {})) {
        const source = candidate.creatureSources?.[name];
        const row =
          source === undefined ? null : yield* art.delivered(root, source.id, source.path);
        if (row === null || row.generation.lane !== "creature")
          return `${name} is marked as a creature on its own rig (kurambit_rig), but no finished creature generation of this game delivered it, so the lock's rig check cannot skip it. Bring the creature game_generate made in with game_blender_assets_import (source generated), or build the character on STYLE.json's rig with game_blender_character.`;
      }
      return null;
    });

  /**
   * A model game_generate delivered, into the live scene: stamped with its generation record (the
   * provider, its licence, ai and the cost), so the review and the export credit it like any import.
   * A prop comes in as it is; a creature keeps its own rig and clips. A humanoid is conformed by
   * game_blender_character instead, and images and sound never need Blender.
   */
  const importGenerated = (root: string, path: string | undefined) =>
    Effect.gen(function* () {
      const refuse = (detail: string) =>
        Effect.fail(opError("blender-assets-import", path ?? root, "invalid-input", detail));
      if (path === undefined)
        return yield* refuse(
          `source generated takes path: the game-relative model game_generate delivered under ${GENERATED_DIR}/ (game_generate_wait lists its files).`,
        );
      const realRoot = yield* realRootOf(root);
      const { file, source } = yield* generatedSource(
        realRoot,
        path,
        "blender-assets-import",
        (id, delivered) => art.delivered(root, id, delivered),
      );
      if (source.lane === "character")
        return yield* refuse(
          `${path} is a generated humanoid: game_blender_character with body {game: "${path}"} conforms it to the standard skeleton, so the clip library plays on it.`,
        );
      if (source.lane !== "model" && source.lane !== "creature")
        return yield* refuse(
          `${path} came from the ${source.lane} lane, which Blender does not take: add it to the game with game_import.`,
        );
      if (source.lane === "creature") {
        const refused = lockCharacterRouteRefusal(
          "generated-body",
          characterRoute(yield* projects.read(root)),
        );
        if (refused !== null) return yield* refuse(refused);
      }
      const name = NodePath.basename(NodePath.dirname(file));
      const made = yield* kitCall(
        root,
        "blender-assets-import",
        decodeGeneratedMade,
        `kurambit.generated(${pyJson({ path: file, name, lane: source.lane, stamp: source.stamp, rig: source.rig, generation: source.generation, restore: source.restore })})`,
      );
      const blend = yield* saveBlend(root);
      const cost =
        source.stamp.credits === null ? "cost unknown" : `$${source.stamp.credits.toFixed(2)}`;
      return {
        text: [
          `${made.objects.join(", ")} from ${source.stamp.from} (${source.lane}), ${made.size.map((x) => x.toFixed(2)).join(" x ")} m, marked AI-made with its licence (${source.stamp.licence}) and ${cost}.`,
          ...(made.armature === null
            ? []
            : [
                `${made.armature} keeps its own rig, ${source.rig}${made.clips.length === 0 ? ", with no clips" : `, and its clips: ${made.clips.join(", ")}`}. The lock's rig governs humanoids only.`,
              ]),
          ...made.notes,
          `Saved .blend source: ${blend}. Generators model at their own scale and facing: check the size, stand it on the ground facing -Y, then game_blender_look mode review and game_blender_export.`,
        ].join("\n"),
        blend,
      };
    });

  /**
   * The locked part of a review: the pass of this key (run now, or the one a review already ran,
   * kept as pass.json), its composite rendered in a throwaway scene of the live session, and only
   * then candidate.json, so an export never follows a review nobody saw (§0.5).
   */
  const reviewed = (
    root: string,
    realRoot: string,
    style: GameStyle | null,
    input: GameBlenderLookInput,
  ) =>
    Effect.gen(function* () {
      const kit = yield* kitVersionOf;
      const digest = yield* liveDigest(root, input.target ?? null);
      const key = reviewKey(digest.perObject, styleHash(style), kit);
      const out = yield* candidateDir(realRoot, key);
      const found = yield* Effect.promise(() => readPassRecord(out));
      const passed: PassRecord =
        found ??
        (yield* Effect.gen(function* () {
          // A new pass replaces the GLB: nothing may promote what an earlier review rendered.
          yield* Effect.promise(() => NodeFSP.rm(candidateJsonPath(out), { force: true }));
          const glb = NodePath.join(out, `candidate.${NodeCrypto.randomUUID()}.glb`);
          return yield* Effect.gen(function* () {
            const rig = style?.rig === undefined ? null : resolveRig(style.rig);
            const pass = yield* runPass(root, out, glb, {
              objects: digest.objects,
              expectedDigest: digest.perObject,
              style,
              budgets: styleBudgets(style),
              standardJoints: rig === null ? null : (LIBRARY_RIG_JOINTS[rig] ?? null),
              rig,
              standard: yield* library.packFile(STANDARD_ARMATURE.pack, STANDARD_ARMATURE.file),
            });
            // The scene's own armatures too: one deforming no skinned mesh leaves none in the GLB.
            const live = armaturesIn(
              yield* callText(root, "execute_blender_code", {
                code: [
                  "import bpy, json",
                  ARMATURES_OF,
                  `studio_armatures([bpy.data.objects[n] for n in ${pyJson(digest.objects)}])`,
                ].join("\n"),
              }),
            );
            const carried = { ...live, ...pass.armatures };
            const offRig = lockArmatureRefusal(carried, style);
            const armatures = Object.keys(carried);
            const record: PassRecord = {
              ...pass,
              refusals:
                offRig === null || pass.refusals.some((refusal) => refusal.code === "off-rig")
                  ? pass.refusals
                  : [...pass.refusals, { code: "off-rig" as const, text: offRig.slice(0, 400) }],
              key,
              kit,
              digest: digest.perObject,
              at: DateTime.formatIso(yield* DateTime.now),
              subject: subjectName(
                armatures.length === 1 ? armatures[0]! : (input.target?.[0] ?? digest.objects[0]!),
              ),
            };
            yield* Effect.tryPromise({
              try: () => NodeFSP.rename(glb, NodePath.join(out, CANDIDATE_GLB)),
              catch: (cause) => opError("blender-review", out, "io", undefined, cause),
            });
            yield* writeText(passJsonPath(out), encodePassRecord(record), "blender-review");
            return record;
          }).pipe(Effect.ensuring(Effect.promise(() => NodeFSP.rm(glb, { force: true }))));
        }));
      const ledger = ledgerParts(passed.parts);
      if ("refusal" in ledger)
        return yield* opError("blender-review", root, "invalid-input", ledger.refusal);
      // The concept is read at every review, so one added since is beside the next render.
      const concept = yield* Effect.promise(() => conceptOf(realRoot, passed.subject));
      const candidate: Candidate = { ...passed, parts: ledger.parts, concept: concept.ref };
      const image = NodePath.join(out, "review.png");
      const view = style?.view ?? "perspective";
      const rendered = yield* kitCall(
        root,
        "blender-review",
        decodeReviewRender,
        `kurambit.review(${pyJson({
          candidate: NodePath.join(out, CANDIDATE_GLB),
          out: image,
          gamePx: input.gamePx ?? GAME_PX[view],
          view,
          palette: Array.isArray(style?.palette) ? style.palette : null,
          used: candidate.usedPalette,
          concept_png: concept.png,
        })})`,
      );
      const png = yield* Effect.tryPromise({
        try: () => NodeFSP.readFile(rendered.image),
        catch: (cause) => opError("blender-review", rendered.image, "io", undefined, cause),
      });
      const bytes = yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(out, CANDIDATE_GLB)).then((stat) => stat.size),
      );
      yield* writeText(candidateJsonPath(out), encodeCandidate(candidate), "blender-review");
      return { key, candidate, concept, rendered, png, bytes };
    });

  /**
   * Look's review mode (§2.2): digest the objects, reuse the pass of that key or run it, then
   * render its composite in a throwaway scene of the live session.
   */
  const review = (root: string, input: GameBlenderLookInput) =>
    Effect.gen(function* () {
      const short = yield* memoryShortfall(
        memory,
        "Blender review",
        RENDER_NEEDED_MB,
        "KURAMBIT_BLENDER_RENDER_MEMORY_MB",
      );
      if (short !== null) return yield* opError("blender-review", root, "low-memory", short);
      const realRoot = yield* realRootOf(root);
      const style = yield* readGameStyle(realRoot);
      const { key, candidate, concept, rendered, png, bytes } = yield* pipelineLocks.withLock(
        realRoot,
        reviewed(root, realRoot, style, input),
      );
      const imageRel = `${PIPELINE_DIR}/${key}/${NodePath.basename(rendered.image)}`;
      const route = characterRoute(yield* projects.read(root));
      const routeRefusal =
        routeRefusalOf(candidate, route) ?? (yield* creatureRefusal(root, candidate));
      const refusing = [
        ...candidate.refusals.map((refusal) => `- [${refusal.code}] ${refusal.text}`),
        ...(routeRefusal === null ? [] : [`- [route] ${routeRefusal}`]),
      ];
      const text = [
        `Review of ${candidate.objects.join(", ")} (key ${key.slice(0, 12)}), exactly what game_blender_export would write. Image: ${imageRel}.`,
        concept.section === null
          ? `No concept: art/CONCEPT.md has no section headed "${candidate.subject}"${concept.png === null ? ` and there is no art/concepts/${candidate.subject}.png` : ""}.`
          : `Concept (${candidate.concept}):\n${concept.section}`,
        measurementText(candidate, styleBudgets(style), bytes),
        ...(rendered.problems === undefined || rendered.problems.length === 0
          ? []
          : [
              `The image has errors:\n${rendered.problems.map((problem) => `- ${problem}`).join("\n")}`,
            ]),
        refusing.length === 0
          ? "Would refuse: nothing; game_blender_export would write it."
          : `Would refuse:\n${refusing.join("\n")}`,
      ].join("\n\n");
      return {
        text,
        screenshot: {
          mimeType: "image/png" as const,
          data: png.toString("base64"),
          width: rendered.width,
          height: rendered.height,
        },
        review: {
          key,
          objects: candidate.objects,
          image: imageRel,
          measured: candidate.measured,
          refusals: candidate.refusals,
          concept: candidate.concept,
        },
      } satisfies GameBlenderLookResult;
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
          if (input.mode === "review") return yield* review(root, input);
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
    motionStrip: (root, clips, out) =>
      holding(
        root,
        Effect.gen(function* () {
          const realRoot = yield* realRootOf(root);
          yield* kitCall(
            root,
            "blender-motion-strip",
            decodeMotionStrip,
            `kurambit.motion_strip(${pyJson({
              clips: clips.map((clip) => ({
                path: NodePath.join(realRoot, clip.path),
                label: clip.label,
              })),
              out: NodePath.join(realRoot, out),
            })})`,
          );
        }),
      ),
    modelViews: (root, model, out) =>
      holding(
        root,
        Effect.gen(function* () {
          const realRoot = yield* realRootOf(root);
          yield* kitCall(
            root,
            "blender-model-views",
            decodeMotionStrip,
            `kurambit.model_views(${pyJson({
              model: NodePath.join(realRoot, model),
              out: NodePath.join(realRoot, out),
            })})`,
          );
        }),
      ),
    character: (root, input) =>
      holding(
        root,
        Effect.gen(function* () {
          const fail = (reason: GameOperationError["reason"], detail: string) =>
            Effect.fail(opError("blender-character", root, reason, detail));
          const realRoot = yield* realRootOf(root);
          const style = yield* readGameStyle(realRoot);
          if (style?.rig === undefined || resolveRig(style.rig) !== STANDARD_RIG)
            return yield* fail(
              "invalid-input",
              `game_blender_character puts characters on the standard skeleton, and ${GAME_STYLE_FILE}${style === null ? " does not exist yet" : style.rig === undefined ? " names no rig" : `'s rig is ${style.rig}`}. Set ${GAME_STYLE_FILE}'s rig to "${STANDARD_RIG}" (and list an animation pack on it, such as quaternius-universal-animation-library, in packs) first.`,
            );
          const standardPacks = style.packs.filter(
            (id) => LIBRARY_CATALOG.find((pack) => pack.id === id)?.rig === STANDARD_RIG,
          );
          let body: Record<string, unknown>;
          if ("library" in input.body) {
            const { pack: id, file } = input.body.library;
            const pack = LIBRARY_CATALOG.find((candidate) => candidate.id === id);
            if (pack?.rig !== STANDARD_RIG)
              return yield* fail(
                "invalid-input",
                `${id} is not on ${STANDARD_RIG}; library bodies come from ${STANDARD_BODY_PACKS.join(" or ")}.`,
              );
            const refused = lockPackRefusal(pack, style);
            if (refused !== null) return yield* fail("invalid-input", refused);
            body = {
              library: yield* library.packFile(id, file),
              pack: id,
              licence: pack.licence,
            };
          } else if ("mpfb" in input.body) {
            const refused = lockCharacterRouteRefusal(
              "mpfb-body",
              characterRoute(yield* projects.read(root)),
            );
            if (refused !== null) return yield* fail("invalid-input", refused);
            if ((yield* tools.blenderExtension("mpfb")) === null)
              return yield* fail("tool-missing", MPFB_MISSING);
            // A session opened before the install has no MPFB2 yet; its scene is saved, so reopen it.
            if (!(yield* ensure(root)).mpfb) {
              yield* drop(root);
              if (!(yield* ensure(root)).mpfb)
                return yield* fail(
                  "tool-failed",
                  "MPFB2 is installed, but it could not be installed into this game's live Blender; see the blender-live-mpfb log under builds/logs. Library bodies work meanwhile.",
                );
            }
            body = { mpfb: input.body.mpfb };
          } else if (input.body.game.replaceAll("\\", "/").startsWith(`${GENERATED_DIR}/`)) {
            // A generated humanoid: conformed like any body, credited to its provider.
            const generated = yield* generatedSource(
              realRoot,
              input.body.game,
              "blender-character",
              (id, delivered) => art.delivered(root, id, delivered),
            );
            if (generated.source.lane !== "character")
              return yield* fail(
                "invalid-input",
                `${input.body.game} came from the ${generated.source.lane} lane. ${generated.source.lane === "creature" ? "A creature keeps its own rig and clips: bring it in with game_blender_assets_import (source generated), then review and export it." : "Only a character-lane humanoid is put on the standard skeleton."}`,
              );
            const refused = lockCharacterRouteRefusal(
              "generated-body",
              characterRoute(yield* projects.read(root)),
            );
            if (refused !== null) return yield* fail("invalid-input", refused);
            body = { game: generated.file, source: generated.source.stamp };
          } else {
            const relative = input.body.game;
            const absolute = NodePath.resolve(realRoot, relative);
            const real = yield* Effect.promise(() => NodeFSP.realpath(absolute).catch(() => null));
            if (
              real === null ||
              !real.startsWith(realRoot + NodePath.sep) ||
              !/\.(glb|gltf)$/i.test(real)
            )
              return yield* fail(
                "invalid-input",
                `${relative} is not a .glb or .gltf file in this game; a game body is a game-relative path to an earlier export.`,
              );
            body = { game: real };
          }
          // A clip is a library name, or the game path of a GLB the motion lane delivered: the
          // generation that delivered it is checked, and its clip carries that generation's stamp.
          const asked = input.clips ?? STANDARD_CLIPS;
          const isMotion = (clip: string) =>
            clip.replaceAll("\\", "/").startsWith(`${GENERATED_DIR}/`);
          const fromLibrary = yield* resolveClips(
            root,
            asked.filter((clip) => !isMotion(clip)),
            standardPacks,
          );
          const fromMotion = yield* Effect.forEach(asked.filter(isMotion), (clip) =>
            Effect.gen(function* () {
              const generated = yield* generatedSource(
                realRoot,
                clip,
                "blender-character",
                (id, delivered) => art.delivered(root, id, delivered),
              );
              if (generated.source.lane !== "motion")
                return yield* fail(
                  "invalid-input",
                  `${clip} came from the ${generated.source.lane} lane; clips take a library clip name or a GLB the motion lane delivered.`,
                );
              const delivered = generated.source.generation.path;
              return {
                pack: generated.source.stamp.from,
                name: motionClipName(
                  NodePath.posix.basename(NodePath.posix.dirname(delivered)),
                  delivered,
                ),
                path: generated.file,
                licence: generated.source.stamp.licence,
                source: generated.source.stamp,
                motion: true,
              };
            }),
          );
          const clips = [...fromLibrary, ...fromMotion];
          const made = yield* kitCall(
            root,
            "blender-character",
            decodeCharacterMade,
            `kurambit.character(${pyJson({
              name: input.name,
              body,
              standard: yield* library.packFile(STANDARD_ARMATURE.pack, STANDARD_ARMATURE.file),
              clips,
              chains: input.chains ?? [],
              replace: input.replace ?? false,
              fit: input.fit ?? null,
            })})`,
          );
          const blend = yield* saveBlend(root);
          const chains = Object.entries(made.chains);
          return {
            text: [
              `${made.armature}: ${made.meshes.length === 0 ? "no mesh" : made.meshes.join(", ")} on ${STANDARD_RIG}, ${made.height.toFixed(2)} m tall, rest frames ${made.restDeviation.toFixed(1)}° off the standard skeleton at most.`,
              `Clips: ${made.clips.join(", ") || "none"}.`,
              ...(chains.length === 0
                ? []
                : [
                    `Chains (no clip keys them; the game springs them): ${chains.map(([name, bones]) => `${name} ${bones.join(", ")}`).join("; ")}.`,
                  ]),
              ...made.notes,
              `Saved .blend source: ${blend}. Model the rest with game_blender_code (import kurambit for the helpers), parented to its bones; then game_blender_look mode review, then game_blender_export.`,
            ].join("\n"),
            armature: made.armature,
            meshes: made.meshes,
            clips: made.clips,
            chains: made.chains,
            restDeviation: made.restDeviation,
            height: made.height,
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
          if (input.source === "generated") return yield* importGenerated(root, input.path);
          const id = input.id;
          if (id === undefined)
            return yield* opError(
              "blender-assets-import",
              root,
              "invalid-input",
              `source ${input.source} takes id: the asset id game_blender_assets_search listed.`,
            );
          const source = input.source;
          // Refused before the live scene changes.
          const style = yield* styleOf(root);
          const outside = lockImportRefusal(source, style);
          if (outside !== null)
            return yield* opError("blender-assets-import", root, "invalid-input", outside);
          // The import adds to the live scene; only what it added is exported,
          // never the rest of the scene under the asset's name.
          const before = yield* callText(root, "execute_blender_code", {
            code: "import bpy, json\nprint('STUDIO_NAMES ' + json.dumps([o.name for o in bpy.data.objects]))\nprint('STUDIO_ACTIONS ' + json.dumps([a.name for a in bpy.data.actions]))\n",
          });
          const known = /STUDIO_NAMES (\[.*\])/.exec(before)?.[1];
          const knownActions = /STUDIO_ACTIONS (\[.*\])/.exec(before)?.[1];
          if (known === undefined || knownActions === undefined)
            return yield* opError(
              "blender-assets-import",
              root,
              "tool-failed",
              `Blender did not list the scene's objects before the import: ${before.slice(0, 500)}`,
            );
          const text = yield* callText(root, "import_asset", {
            source,
            id,
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
                `before_actions = set(${knownActions})`,
                "for o in [o for o in bpy.data.objects if o.name not in before]: bpy.data.objects.remove(o, do_unlink=True)",
                // Its clips go too, or they ride along with any armature whose bones they key.
                "for a in [a for a in bpy.data.actions if a.name not in before_actions]: bpy.data.actions.remove(a)",
              ].join("\n"),
            });
            return yield* opError(
              "blender-assets-import",
              root,
              "invalid-input",
              `${offRig} The import was taken out of the live scene again.`,
            );
          }
          // The import stays in the live scene, stamped with its source and licence (§2.8): the
          // export composes the ledger from the stamps, after a review like anything built here.
          // Its clips are stamped too, so a rigged import's animations are credited to it, not
          // called made here; a clip keyed later on its armature carries no stamp and is.
          const licence = importLicence(source, id, text);
          const stampOf = (what: "mesh" | "clips") =>
            JSON.stringify(
              JSON.stringify({
                what,
                from: source,
                licence: licence.slice(0, 200),
                ai: false,
                credits: null,
              }),
            );
          const stamped = yield* callText(root, "execute_blender_code", {
            code: [
              "import bpy, json",
              `before = set(${known})`,
              `before_actions = set(${knownActions})`,
              `stamp = ${stampOf("mesh")}`,
              "added = [o for o in bpy.context.scene.objects if o.name not in before and o.type in ('MESH', 'ARMATURE')]",
              "for o in added: o['kurambit_source'] = stamp",
              `for a in [a for a in bpy.data.actions if a.name not in before_actions]: a['kurambit_source'] = ${stampOf("clips")}`,
              "print(f'STUDIO_STAMPED {len(added)}')",
            ].join("\n"),
          });
          const count = Number(/STUDIO_STAMPED (\d+)/.exec(stamped)?.[1] ?? 0);
          const blend = yield* saveBlend(root);
          return {
            text: `${text}\nSaved .blend source: ${blend}\n${count === 0 ? "The import added no model to the scene (an HDRI or a texture)." : `The import stays in the live scene, marked with its source and licence (${licence}); review and export it like anything you build (game_blender_look mode review, then game_blender_export).`}`,
            blend,
          };
        }),
      ),
    exportGlb: (root, input) =>
      holding(
        root,
        Effect.gen(function* () {
          // An export promotes the candidate its review left for these objects as they are now
          // (F1, D6): nothing is passed, measured or refused again here.
          const manifest = yield* projects.read(root);
          const engineDir = manifestProject(manifest);
          const realRoot = yield* realRootOf(root);
          const style = yield* readGameStyle(realRoot);
          const digest = yield* liveDigest(root, input.objects ?? null);
          const key = reviewKey(digest.perObject, styleHash(style), yield* kitVersionOf);
          const out = NodePath.join(realRoot, PIPELINE_DIR, key);
          const candidate = yield* Effect.promise(() => readCandidate(out));
          if (candidate === null)
            return yield* opError(
              "blender-export",
              root,
              "invalid-input",
              `No review of these objects as they are now (${digest.objects.join(", ")}): call game_blender_look with mode review first. A change to them, or to ${GAME_STYLE_FILE}, since a review needs a new one, and a review covers exactly the objects it named.`,
            );
          if (candidate.refusals.length > 0)
            return yield* opError(
              "blender-export",
              root,
              "invalid-input",
              `The review measured what the lock refuses; fix it and review again:\n${candidate.refusals.map((refusal) => `- [${refusal.code}] ${refusal.text}`).join("\n")}`,
            );
          // The person's route is read now, not at the review: they may have changed it since.
          const routeRefusal =
            routeRefusalOf(candidate, characterRoute(manifest)) ??
            (yield* creatureRefusal(root, candidate));
          if (routeRefusal !== null)
            return yield* opError("blender-export", root, "invalid-input", routeRefusal);
          const file = input.file ?? `${assetDirOf(manifest)}/${candidate.subject}.glb`;
          if (
            !file.startsWith(`${engineDir}/`) ||
            file.split("/").some((segment) => segment === ".." || segment === "") ||
            !/^[A-Za-z0-9_.-]{1,120}\.glb$/.test(NodePath.posix.basename(file))
          )
            return yield* opError(
              "blender-export",
              file,
              "invalid-input",
              `The destination must be a game-relative path under ${engineDir}/ ending in a plain <name>.glb (letters, digits, _ . -).`,
            );
          const directory = yield* Effect.tryPromise({
            try: () => ensureGameDir(realRoot, NodePath.posix.dirname(file)),
            catch: (cause) => opError("blender-export", file, "invalid-path", undefined, cause),
          });
          const absolute = NodePath.join(directory, NodePath.posix.basename(file));
          // Copied beside the target and renamed over it, so a game never loads half a model.
          const glb = yield* Effect.tryPromise({
            try: async () => {
              const staged = `${absolute}.${NodeCrypto.randomUUID()}.part`;
              try {
                await NodeFSP.copyFile(NodePath.join(out, CANDIDATE_GLB), staged);
                const hashed = await fileSha256(staged);
                await NodeFSP.rename(staged, absolute);
                return hashed;
              } finally {
                await NodeFSP.rm(staged, { force: true });
              }
            },
            catch: (cause) => opError("blender-export", file, "io", undefined, cause),
          });
          const sidecar = sidecarPathOf(file);
          yield* writeText(
            NodePath.join(directory, NodePath.posix.basename(sidecar)),
            sidecarText(
              sidecarOf(
                candidate,
                {
                  name: NodePath.posix.basename(file),
                  sha256: glb.sha256,
                  bytes: glb.bytes,
                },
                characterRoute(manifest),
              ),
            ),
            "blender-export",
          );
          const credited = yield* recordProvenance(
            realRoot,
            [{ first: file, line: ledgerLine(file, candidate) }],
            EXPORT_TOOL,
          );
          const blend = yield* saveBlend(root);
          return {
            text: `Exported the review ${key.slice(0, 12)} of ${candidate.objects.join(", ")}: ${file} (${(glb.bytes / 1048576).toFixed(2)} MB) and its sidecar ${sidecar}. ${credited}\nSaved .blend source: ${blend}\nRun game_import after.${manifest.engine.name === "three" ? ` three.js games load the sidecar: ASSETS = { ${candidate.subject}: "${sidecar.slice(engineDir.length + 1)}" }.` : ""}`,
            blend,
            export: file,
            sidecar,
          };
        }).pipe(pipelineLocked(root)),
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
