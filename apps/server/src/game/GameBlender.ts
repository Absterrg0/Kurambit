// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the native filesystem, process, and MCP-stdio boundary; wall-clock pids and JSON code strings are the domain here.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
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
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  GameOperationError,
  type GameAnimateInput,
  type GameAnimateResult,
  type GameBlenderAssetsImportInput,
  type GameBlenderAssetsImportResult,
  type GameBlenderAssetsSearchInput,
  type GameBlenderAssetsSearchResult,
  type GameBlenderCharacterInput,
  type GameBlenderCharacterResult,
  GameBlenderRigFact,
  type GameBlenderCodeInput,
  type GameBlenderCodeResult,
  type GameBlenderExportInput,
  type GameBlenderExportResult,
  type GameBlenderLookInput,
  type GameBlenderLookResult,
  type GameBlenderPaintInput,
  type GameBlenderPaintResult,
  type GameBlenderSceneInput,
  type GameBlenderSceneResult,
  type GameManifest,
  type GameStyle,
  type GameStyleView,
  GAME_STYLE_FILE,
  manifestProject,
  manifestRuntime,
  type ThreadId,
} from "@kurambit/contracts";
import * as GameAssetLibrary from "./GameAssetLibrary.ts";
import * as GameFreshEyes from "./GameFreshEyes.ts";
import { pythonFailure } from "./blenderFailure.ts";
import type { PackClips } from "./GameAssetLibrary.ts";
import * as GameTemplates from "./GameTemplates.ts";
import {
  LIBRARY_CATALOG,
  LIBRARY_RIG_JOINTS,
  MESH2MOTION_PACK,
  STANDARD_ARMATURE,
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
  REVIEW_PNG,
  candidateJsonPath,
  exportedMarkPath,
  conceptOf,
  encodeCandidate,
  encodePassRecord,
  kitOutput,
  liveRefusal,
  kitVersion,
  ledgerLine,
  ledgerParts,
  measurementText,
  passJsonPath,
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
import { inGame, insideGame, staysInsideGame } from "./gamePath.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSettings from "../serverSettings.ts";
import { recordProvenance } from "./assetProvenance.ts";
import { LIBRARY_LICENCES } from "./assetLibraryFiles.ts";
import {
  characterRoute,
  isClipPack,
  LIBRARY_OFF_REFUSAL,
  modelChoice,
  ownRigNote,
  readGameStyle,
  resolveRig,
  standardClipPacks,
  styleBudgets,
  styleHash,
} from "./gameStyle.ts";
import { afterAddingArt, availableEngine, engineProfile, gamePaths } from "./engineProfile.ts";
import { gltfTriangles } from "./assetFacts.ts";
import { glbJson } from "./gltfJson.ts";
import { packGlb } from "./glbPack.ts";
import { type SheetSource, sheetSource } from "./sheetSource.ts";
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
import { keepHeroSheet } from "./heroSheets.ts";

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
/** The three.js template's model loader and the meshopt decoder it vendors, under its web folder. */
// Games carrying their own copy got it from runtime major 1, which keeps this decoder.
const THREE_RUNTIME_1 = "runtime/three/1";
const MESHOPT_LOADER = "shell/assets.js";
const MESHOPT_DECODER = "vendor/addons/libs/meshopt_decoder.module.js";
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
const EXPORT_TOOL = "game_blender op export";

/**
 * Python that prints `STUDIO_ARMATURES {name: [bones]}` for the armatures that
 * would travel with `objs` into a GLB: the objects themselves, their parents
 * and the armatures their modifiers deform with. An armature marked on its own
 * rig (kurambit_rig) is left to the review's own-rig check, not the lock's rig.
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

/**
 * Python run before every save: Blender drops an action nothing uses when it saves, so a clip
 * keyed and then swapped off its armature (the plain way to key several) would vanish from
 * live.blend, and from the review's copy, which then differs from the live scene.
 */
const KEEP_CLIPS =
  "for a in bpy.data.actions:\n    if a.users == 0:\n        a.use_fake_user = True\n";

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
 * kurambit is a builtin too: each op code call runs in a fresh namespace, and agents wrote
 * kurambit helpers without importing them (10 NameErrors in one 14-run bench).
 */
const kitBoot = (kit: string) =>
  `import sys\nsys.dont_write_bytecode = True\nsys.path.insert(0, ${JSON.stringify(kit)})\ntry:\n    import builtins, kurambit\n    builtins.kurambit = kurambit\nexcept Exception as error:\n    print("KURAMBIT_KIT_FAILED", repr(error))\n`;

/** The one-shot pipeline pass: a factory-startup Blender that opens a copy of the scene. */
const PASS_ROOM: MemoryRoom = {
  what: "Blender pipeline pass",
  neededMb: 1024,
  env: "KURAMBIT_BLENDER_PASS_MEMORY_MB",
};
/** A character's height on screen at game distance, px, by the lock's view. */
/**
 * A paint run: the sheet, the depth renders, a handful of float atlases of up to
 * 4096² and Cycles bakes. Measured peaks are in the K report.
 */
const SHEET_ROOM: MemoryRoom = {
  what: "Blender sheet projection",
  neededMb: 3072,
  env: "KURAMBIT_BLENDER_SHEET_MEMORY_MB",
};
const PAINT_TIMEOUT_MS = 15 * 60_000;
/** Where painted textures live in the game, one folder per name. */
const TEXTURES_DIR = "art/blender/textures";
const decodePainted = Schema.decodeUnknownEffect(
  Schema.Struct({
    library: Schema.String,
    name: Schema.String,
    meshes: Schema.Record(Schema.String, Schema.String),
    files: Schema.Array(Schema.String),
    alignment: Schema.String,
    views: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        columns: Schema.Array(Schema.Number),
        overlap: Schema.Number,
      }),
    ),
    mirrored: Schema.NullOr(Schema.String),
    head: Schema.Boolean,
    seen: Schema.Number,
    notes: Schema.Array(Schema.String),
  }),
);
const decodeAdopted = Schema.decodeUnknownEffect(
  Schema.Struct({ objects: Schema.Array(Schema.String), files: Schema.Array(Schema.String) }),
);
const isGameOperationError = Schema.is(GameOperationError);
/** A one-shot run's refusal as it is; a result that does not decode is the kit's fault. */
const protocolError =
  (operation: string, root: string) => (cause: GameOperationError | Schema.SchemaError) =>
    Schema.is(GameOperationError)(cause)
      ? cause
      : opError(
          operation,
          root,
          "tool-failed",
          `The Blender kit's result did not match its protocol: ${cause.message.slice(0, 600)}`,
          cause,
        );
const sheetCredit = (sheet: SheetSource) =>
  sheet.stamp.ai
    ? `credited as AI-made (${sheet.stamp.licence})`
    : `credited to the person's own image ${sheet.path}`;

const GAME_PX: Readonly<Record<GameStyleView, number>> = {
  perspective: 96,
  side: 96,
  "top-down": 64,
  isometric: 64,
};
const isReason = Schema.is(GameOperationError.fields.reason);
/** What kurambit.review prints: one JSON result line. */
const ReviewRender = Schema.Struct({
  image: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  /** Tiles the model hardly shows in (under 1% covered): out of frame, or too small to judge. */
  problems: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Measured from the pictures: thin parts at game distance, and the reference's overlap. */
  facts: Schema.optionalKey(Schema.Array(Schema.String)),
});
/** What kurambit.rig and kurambit.character print: one JSON result line. */
const decodeRigged = Schema.decodeUnknownEffect(
  Schema.Struct({
    armature: Schema.String,
    meshes: Schema.Array(Schema.String),
    template: Schema.String,
    bones: Schema.Number,
    /** Which weighting ran: bone heat on the joined parts, or without the parts heat cannot solve. */
    weights: Schema.String,
    rigid: Schema.Record(Schema.String, Schema.String),
    chains: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    clips: Schema.Array(Schema.String),
    facts: Schema.Array(GameBlenderRigFact),
    notes: Schema.Array(Schema.String),
  }),
);
/** What kurambit.scan prints: the materials that took the scan, and at what size. */
/**
 * A model's parts in a sentence: the first few named, the rest counted. The whole list rides in a
 * result's details; spelled out in its text, 94 armour pieces filled an answer's byte cap and cut
 * what came after them (73 export and review texts across 68 bench transcripts).
 */
const someNames = (names: ReadonlyArray<string>, most = 8) =>
  names.length <= most
    ? names.join(", ")
    : `${names.slice(0, most).join(", ")} and ${names.length - most} more (${names.length} objects)`;

const decodeScanned = Schema.decodeUnknownEffect(
  Schema.Struct({
    materials: Schema.Array(Schema.String),
    objects: Schema.Array(Schema.String),
    metres: Schema.Number,
    size: Schema.Number,
    dimmed: Schema.Array(Schema.String),
  }),
);
/** What kurambit.animate prints; the full bundle is its bundle.json. */
const decodeAnimated = Schema.decodeUnknownEffect(
  Schema.Struct({
    action: Schema.String,
    images: Schema.Array(
      Schema.Struct({ path: Schema.String, width: Schema.Number, height: Schema.Number }),
    ),
    warnings: Schema.Array(Schema.String),
    summary: Schema.Array(Schema.String),
  }),
);
/** Where each game_blender op animate pass keeps its spec, bundle and pictures: <dir>/<clip>/<n>. */
const ANIMATE_DIR = "builds/logs/animate";
/** Words that say nothing about a move when a bar is picked by name. */
const BAR_FILLER = new Set([
  "loop",
  "fwd",
  "bwd",
  "rm",
  "inplace",
  "anim",
  "animation",
  "start",
  "end",
]);
const clipWords = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 1 && !BAR_FILLER.has(word));
const decodeReviewRender = Schema.decodeUnknownEffect(ReviewRender);
const decodeDigest = Schema.decodeUnknownEffect(KitDigest);
const decodePass = Schema.decodeUnknownEffect(PassResult);
/** A human body's library stand-in, while MPFB2 is not installed. */
const LIBRARY_BODY = `{library: {pack: "quaternius-universal-base-characters", file: "Base Characters/Godot - UE/Superhero_Female_FullBody.gltf"}} (or Superhero_Male_FullBody.gltf), or the Universal Animation Library's mannequin`;
/**
 * What an agent is told when a route needs an add-on the person is asked for first: the ask is
 * the agent's own (its question tool where it has one, its reply otherwise), and the install is
 * one op, so a provider that asks before tool calls names exactly it.
 */
const addonAsk = (need: string, addon: GameToolchain.BlenderAddon, meanwhile: string) =>
  `${need} needs ${addon.name}, an add-on that is not installed. ${GameToolchain.addonAbout(addon)} Ask the person whether to add it; on their yes, call game_blender op addon {"install": "${addon.id}", "asked": true} and try again. They can remove it in Settings → Game tools. ${meanwhile}`;
const refusalLines = (candidate: Candidate) =>
  candidate.refusals.map((refusal) => `- [${refusal.code}] ${refusal.text}`).join("\n");

const STILL_WORKING =
  "Blender may still be finishing this call. Inspect the scene with game_blender op code (printing what it needs) or op look before retrying, so the work is not done twice.";

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
  /** The add-ons installed in this session's own Blender folder (ready when the session opened). */
  readonly addons: ReadonlySet<string>;
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
const sessionEnv = (
  homeDir: string,
  userResources: string,
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
  // Blender's own override of every user folder (config, scripts, extensions),
  // on every OS and without a version folder (Blender 4.2+): the real
  // ~/.config/blender, %APPDATA%\\Blender Foundation and ~/Library/Application
  // Support/Blender are never read or written. Unverified on Windows and macOS.
  env.BLENDER_USER_RESOURCES = userResources;
  env.LIBGL_ALWAYS_SOFTWARE = "1";
  // Software GL renders every look on the CPU: with two threads, four looks took 47 s on an
  // 8-core machine against 28 s on all of them. A machine running several games at once gives
  // each fewer (KURAMBIT_BLENDER_THREADS), or seven live Blenders fight over every core.
  env.LP_NUM_THREADS = String(
    Number(process.env.KURAMBIT_BLENDER_THREADS) > 0
      ? Number(process.env.KURAMBIT_BLENDER_THREADS)
      : NodeOS.availableParallelism(),
  );
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
    /** Live Blender scene: run bpy code, auto-saving the .blend source; each call is the game's operation. */
    readonly code: (
      threadId: ThreadId,
      input: GameBlenderCodeInput,
    ) => Effect.Effect<GameBlenderCodeResult, GameOperationError>;
    /** Live Blender scene: see it as one image (viewport, camera, angles, frames). */
    readonly look: (
      threadId: ThreadId,
      input: GameBlenderLookInput,
    ) => Effect.Effect<GameBlenderLookResult, GameOperationError>;
    /** Live Blender scene: a model (or a human body it builds) rigged on a Mesh2Motion template or on chains, with its clips. */
    readonly character: (
      threadId: ThreadId,
      input: GameBlenderCharacterInput,
    ) => Effect.Effect<GameBlenderCharacterResult, GameOperationError>;
    /**
     * Live Blender scene: a move spec compiled onto a character as a clip, measured beside a
     * library clip and pictured (game_blender op animate).
     */
    readonly animate: (
      threadId: ThreadId,
      input: GameAnimateInput,
    ) => Effect.Effect<GameAnimateResult, GameOperationError>;
    /** Live Blender scene: meshes painted from their turnaround sheet (UV atlases, normal, ORM). */
    readonly paint: (
      threadId: ThreadId,
      input: GameBlenderPaintInput,
    ) => Effect.Effect<GameBlenderPaintResult, GameOperationError>;
    readonly scene: (
      threadId: ThreadId,
      input: GameBlenderSceneInput,
    ) => Effect.Effect<GameBlenderSceneResult, GameOperationError>;
    readonly assetsSearch: (
      threadId: ThreadId,
      input: GameBlenderAssetsSearchInput,
    ) => Effect.Effect<GameBlenderAssetsSearchResult, GameOperationError>;
    readonly assetsImport: (
      threadId: ThreadId,
      input: GameBlenderAssetsImportInput,
    ) => Effect.Effect<GameBlenderAssetsImportResult, GameOperationError>;
    /** Live Blender scene: export named objects (or every mesh) as a GLB under the engine directory. */
    readonly exportGlb: (
      threadId: ThreadId,
      input: GameBlenderExportInput,
    ) => Effect.Effect<GameBlenderExportResult, GameOperationError>;
    /** Installs an add-on of the list, as Settings → Game tools does, and reopens this game's Blender with it. */
    readonly addon: (
      threadId: ThreadId,
      input: { readonly install: string; readonly asked?: boolean },
    ) => Effect.Effect<{ readonly text: string }, GameOperationError>;
    /** Stop one game's live session by root; game_builds op stop calls this. */
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
  const library = yield* GameAssetLibrary.GameAssetLibrary;
  const templates = yield* GameTemplates.GameTemplates;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const freshEyes = yield* GameFreshEyes.GameFreshEyes;
  const sessions = new Map<string, Session>();
  /**
   * Blender's user folder (the pinned addon, MPFB2, preferences), one per Blender version for
   * every game: the same files in each game's folder came to ~90 MB a game.
   */
  const userResourcesOf = (version: string) =>
    NodePath.join(config.baseDir, "caches", "blender-user", version.replace(/[^\w.-]/g, "_"));
  /** Installing into the shared folder: one session start at a time writes it. */
  const userResourcesLock = yield* Semaphore.make(1);
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
   * The add-ons list in Kurambit's own Blender folder (BLENDER_USER_RESOURCES), never the user's:
   * while the toolchain holds an entry's verified zip it is installed once (a marker names the
   * zip), and after a Remove the next session takes it out again. A failed install never stops
   * the session; the op that needs the add-on then says why. Returns the ids installed.
   */
  const installAddons = (root: string, blender: string, homeDir: string, userResources: string) =>
    Effect.gen(function* () {
      const installed = new Set<string>();
      for (const { entry, zip } of yield* tools.addons) {
        const marker = NodePath.join(userResources, `${entry.id}.installed`);
        const have = yield* Effect.promise(() =>
          NodeFSP.readFile(marker, "utf8").catch(() => null),
        );
        const want = zip === null ? null : NodePath.basename(zip);
        if (have === want) {
          if (want !== null) installed.add(entry.id);
          continue;
        }
        const run = (args: ReadonlyArray<string>, operation: string) =>
          processes
            .run({
              root,
              executable: blender,
              args: ["--background", "--command", "extension", ...args],
              operation,
              timeoutMs: 180_000,
              env: sessionEnv(homeDir, userResources),
              envMode: "replace",
            })
            .pipe(
              Effect.map((result) => result.exitCode === 0 && !result.timedOut),
              Effect.orElseSucceed(() => false),
            );
        if (zip === null) {
          yield* run(
            ["remove", `user_default.${entry.extension}`],
            `blender-live-${entry.id}-remove`,
          );
          yield* Effect.promise(() => NodeFSP.rm(marker, { force: true }));
          continue;
        }
        if (
          !(yield* run(
            ["install-file", "--repo", "user_default", "--enable", zip],
            `blender-live-${entry.id}`,
          ))
        ) {
          yield* Effect.logWarning(`${entry.name} did not install into the live Blender`, { root });
          continue;
        }
        yield* Effect.promise(() => NodeFSP.writeFile(marker, want!).catch(() => undefined));
        installed.add(entry.id);
      }
      return installed as ReadonlySet<string>;
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
      // An add-on removed in Settings since it opened is still loaded in it: reopen without it.
      const removed =
        existing !== undefined &&
        (yield* tools.addons).some(
          ({ entry, zip }) => zip === null && existing.addons.has(entry.id),
        );
      if (
        existing !== undefined &&
        existing.blender.running() &&
        existing.broken === null &&
        stale === null &&
        !removed &&
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

  /** The pinned addon, enabled, and the add-ons list in the shared user folder; which of it is there. */
  const setUpUserResources = (
    root: string,
    blender: { readonly path: string; readonly version: string },
    homeDir: string,
    userResources: string,
    uv: UvPaths,
  ): Effect.Effect<ReadonlySet<string>, GameOperationError> =>
    Effect.gen(function* () {
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
        env: sessionEnv(homeDir, userResources),
        envMode: "replace",
      });
      const addonsDir = /KURAMBIT_ADDONS=(.+)/.exec(located.stdout)?.[1]?.trim();
      if (
        located.exitCode !== 0 ||
        addonsDir === undefined ||
        !NodePath.resolve(addonsDir).startsWith(NodePath.resolve(userResources) + NodePath.sep)
      )
        return yield* opError(
          "blender-live",
          located.logPath,
          "tool-failed",
          `Blender ${blender.version} did not report a user addon folder inside Kurambit's own Blender folder${addonsDir === undefined ? "" : ` (it reported ${addonsDir})`}, so the pinned addon cannot be installed without touching the user's real Blender settings.`,
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
            ...sessionEnv(homeDir, userResources),
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
        env: sessionEnv(homeDir, userResources),
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
      return yield* installAddons(root, blender.path, homeDir, userResources);
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
      const userResources = userResourcesOf(blender.version);
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
          // The session's record, logs and scratch live here; Blender's user folder is shared.
          await ensureGameDir(root, "builds/logs/blender-live");
          await NodeFSP.mkdir(NodePath.join(homeDir, "home/.config"), { recursive: true });
          await NodeFSP.mkdir(NodePath.join(homeDir, "runtime"), {
            recursive: true,
            mode: 0o700,
          });
          await NodeFSP.mkdir(userResources, { recursive: true });
          // The game's own copy of that folder from before it was shared: Kurambit's install only.
          await NodeFSP.rm(NodePath.join(homeDir, "blender"), { recursive: true, force: true });
          await NodeFSP.rm(NodePath.join(homeDir, "mpfb.installed"), { force: true });
        },
        catch: (cause) => opError("blender-live", homeDir, "io", undefined, cause),
      });
      const addons = yield* userResourcesLock.withPermits(1)(
        setUpUserResources(root, blender, homeDir, userResources, uv),
      );
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
      // next ensure or game_builds op stop something to reap.
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
      // Opened and saved over, so a live.blend leading out of the game is never adopted.
      const blendPath = yield* inGame(root, BLEND_REL);
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
                        : // Blender 5.3 defaults to Vulkan on Linux, which cannot open a
                          // window on Xvfb (the X connection drops at start); OpenGL there
                          // is the software GL sessionEnv asks for.
                          ["--gpu-backend", "opengl"]),
                      "--python",
                      bootPy,
                      "--",
                      token,
                    ],
                    cwd: root,
                    env: withBinDir(
                      { ...sessionEnv(homeDir, userResources), ...addonKeys },
                      uv.binDir,
                    ),
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
        addons,
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
      const refused = liveRefusal(text);
      if (refused !== null) return yield* opError("blender-live", name, "invalid-input", refused);
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
            (text.trim() === ""
              ? `Blender reported an error for '${name}'.`
              : `${pythonFailure(text) ?? ""}${text.slice(0, 4000)}`),
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
    Effect.map(
      availableEngine(manifest.engine.name),
      (engine) => gamePaths(engine, manifestProject(manifest)).blender,
    );

  const saveBlend = (root: string): Effect.Effect<string, GameOperationError> =>
    Effect.gen(function* () {
      const absolute = NodePath.join(root, BLEND_REL);
      yield* Effect.tryPromise({
        try: async () => {
          await ensureGameDir(root, NodePath.posix.dirname(BLEND_REL));
          insideGame(root, BLEND_REL);
        },
        catch: (cause) =>
          isGameOperationError(cause)
            ? cause
            : opError("blender-live", BLEND_REL, "io", undefined, cause),
      });
      // Compressed: live.blend is committed with the game after every exec, and
      // an uncompressed scene adds ~10 MB of history each time.
      const text = yield* callText(root, "execute_blender_code", {
        code: `import bpy\n${KEEP_CLIPS}bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(absolute)}, compress=True)\nprint("STUDIO_SAVED")\n`,
      });
      if (!text.includes("STUDIO_SAVED"))
        return yield* opError("blender-live", BLEND_REL, "command-failed", text.slice(0, 1000));
      // What the session holds is now what is on disk.
      const session = sessions.get(root);
      if (session !== undefined) yield* Effect.promise(() => session.blend.hold());
      return BLEND_REL;
    });

  /**
   * One kit entry in the live scene: its one result line, decoded; its refusal as the
   * reason it names; anything it raised fails the call with the traceback already.
   */
  /**
   * A Poly Haven texture laid on parts goes under their own materials (kurambit.scan), from the
   * library's index and its pinned files; null when the id is no indexed texture, which the
   * add-on then imports as it does models and skies.
   */
  const scanTexture = (
    root: string,
    id: string,
    applyTo: ReadonlyArray<string>,
    tile: number | undefined,
  ) =>
    Effect.gen(function* () {
      const libraryId = id.startsWith("polyhaven-")
        ? id
        : `polyhaven-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const found = yield* library.entry(libraryId).pipe(Effect.option);
      if (found._tag === "None" || !found.value.kinds.includes("texture")) return null;
      const pack = found.value;
      const pick = (pattern: RegExp) => pack.files?.find((file) => pattern.test(file.path))?.path;
      const maps = [pick(/_(albedo|diff|diffuse|color|col)_/i), pick(/_nor_gl_/i), pick(/_arm_/i)];
      if (maps.some((path) => path === undefined))
        return yield* opError(
          "blender-assets-import",
          root,
          "tool-failed",
          `${pack.id} has no colour, OpenGL normal and ARM maps to scan with; pick another texture.`,
        );
      const [color, normal, arm] = yield* Effect.forEach(maps, (path) =>
        library.packFile(pack.id, path!),
      );
      const made = yield* kitCall(
        root,
        "blender-assets-import",
        decodeScanned,
        `from kurambit.protocol import entry\nentry(kurambit.scan)(${pyJson(applyTo)}, ${pyJson(color)}, ${pyJson(normal)}, ${pyJson(arm)}, ${tile ?? pack.tileMetres ?? 1})`,
      );
      const blend = yield* saveBlend(root);
      const credited = yield* library.credit(root, pack, "Blender assets import");
      return {
        text: [
          `${pack.title} (${pack.id}, ${LIBRARY_LICENCES[pack.licence].name}) is under ${made.materials.join(", ")} on ${someNames(made.objects)}: its grain at ${made.metres} m a tile over each material's own colour and roughness, ${made.size} px maps shared by every material that takes it, on a "scan" UV map the export ships.`,
          ...(made.dimmed.length === 0
            ? []
            : [
                `${made.dimmed.join(", ")} ${made.dimmed.length === 1 ? "is" : "are"} lighter than the scan can carry and come out a little darker.`,
              ]),
          "targetSize sets the metres a tile covers (a small or stylised model often wants it larger than life). To change a scanned material's colour or roughness: kurambit.scan(names, off=True) in op code puts it back, change it, then import again.",
          credited,
          `Saved .blend source: ${blend}`,
        ].join("\n"),
        blend,
      };
    });

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
   * One kit entry in a one-shot, factory-startup Blender under the session's isolated folders,
   * behind the memory gate: run.py's `pass` or `paint`. With `copy`, it opens a copy of
   * the saved live scene, which the live scene saves itself: Blender remaps its relative paths
   * (library textures) for the copy's folder, so the run resolves the same files the scene does.
   * Its one result line comes back undecoded; a refusal fails with the reason it names.
   */
  const oneShot = (
    root: string,
    out: string,
    job: {
      readonly entry: "pass" | "paint";
      readonly operation: string;
      readonly copy: boolean;
      readonly room: MemoryRoom;
      readonly timeoutMs: number;
      readonly params: Record<string, unknown>;
    },
  ): Effect.Effect<unknown, GameOperationError> =>
    Effect.gen(function* () {
      const blender = yield* tools.executable("blender");
      const kit = yield* kitDirectory;
      const run = NodeCrypto.randomUUID();
      const copy = NodePath.join(out, `scene.${run}.blend`);
      const paramsFile = NodePath.join(out, `params.${run}.json`);
      if (job.copy) {
        const saved = yield* callText(root, "execute_blender_code", {
          code: `import bpy\n${KEEP_CLIPS}bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(copy)}, copy=True, compress=True)\nprint("STUDIO_SAVED")\n`,
        });
        if (!saved.includes("STUDIO_SAVED"))
          return yield* opError(job.operation, copy, "command-failed", saved.slice(0, 1000));
      }
      yield* Effect.tryPromise({
        try: () => NodeFSP.writeFile(paramsFile, JSON.stringify({ ...job.params, out })),
        catch: (cause) => opError(job.operation, out, "io", undefined, cause),
      });
      const result = yield* gate
        .admit(
          `blender-pipeline-${job.entry}`,
          root,
          job.room,
          processes.run({
            root,
            executable: blender.path,
            args: [
              "-b",
              "--factory-startup",
              ...(job.copy ? [copy] : []),
              "--python-exit-code",
              "1",
              "--python",
              NodePath.join(kit, "run.py"),
              "--",
              job.entry,
              paramsFile,
            ],
            operation: `blender-pipeline-${job.entry}`,
            timeoutMs: job.timeoutMs,
            env: sessionEnv(homeDirOf(root), userResourcesOf(blender.version)),
            envMode: "replace",
          }),
        )
        // The copy is the size of the scene; what the run wrote is what the caller keeps.
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
          job.operation,
          root,
          isReason(output.reason) ? output.reason : "invalid-input",
          output.text.slice(0, 2000),
        );
      if (output.kind === "none" || result.exitCode !== 0)
        return yield* opError(
          job.operation,
          result.logPath,
          "tool-failed",
          `${result.timedOut ? `Blender did not finish in ${Math.round(job.timeoutMs / 1000)} s` : "Blender failed"}: ${commandDetail(result).slice(-2000)}`,
          result,
        );
      return output.value;
    });

  /**
   * The one-shot pass on a copy of the saved scene: the style pass and the measurement.
   * It writes the GLB to `glb`, a name of this run's that the caller renames into place; its
   * result is returned as it measured it.
   */
  const runPass = (
    root: string,
    out: string,
    glb: string,
    params: Record<string, unknown>,
  ): Effect.Effect<typeof PassResult.Type, GameOperationError> =>
    oneShot(root, out, {
      entry: "pass",
      operation: "blender-review",
      copy: true,
      room: PASS_ROOM,
      timeoutMs: 180_000,
      params: { ...params, glb },
    }).pipe(
      Effect.flatMap((value) =>
        decodePass(value).pipe(
          Effect.mapError((cause) =>
            opError(
              "blender-review",
              root,
              "tool-failed",
              `The pipeline pass's result did not match its protocol: ${cause.message.slice(0, 600)}`,
              cause,
            ),
          ),
        ),
      ),
    );

  /**
   * Each named clip found in `packs` (standardClipPacks: STYLE.json's on the standard skeleton,
   * else the library's), the standard armature's pack first; "pack:Clip" picks any library
   * animation pack on the standard skeleton.
   */
  const resolveClips = (root: string, names: ReadonlyArray<string>, packs: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const refuse = (detail: string) =>
        Effect.fail(opError("blender-character", root, "invalid-input", detail));
      const ordered = [...packs].toSorted(
        (a, b) => Number(b === STANDARD_ARMATURE.pack) - Number(a === STANDARD_ARMATURE.pack),
      );
      const isClips = (id: string) => {
        const pack = LIBRARY_CATALOG.find((candidate) => candidate.id === id);
        return pack?.rig === STANDARD_RIG && pack.kinds.includes("animation");
      };
      const picked = names.flatMap((wanted) => {
        const colon = wanted.indexOf(":");
        return colon > 0 && isClips(wanted.slice(0, colon)) ? [wanted.slice(0, colon)] : [];
      });
      const withClips = [...new Set([...ordered.filter(isClips), ...picked])];
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
            `${wanted}: ${named} is not a library animation pack on ${STANDARD_RIG} (${withClips.join(", ")}).`,
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
   * The lock's rig check skips an armature marked on its own rig (kurambit_rig). One that carries
   * library clips, or none of its own, gets a note: those clips fit only the lock's rig.
   */
  const rigNotes = (candidate: Candidate) =>
    Object.keys(candidate.creatures ?? {}).flatMap((name) => {
      const note = ownRigNote(name, candidate.ownClips?.[name] ?? { own: [], library: [] });
      return note === null ? [] : [note];
    });

  /** A review's reference: a picture in the game (the person's, or a sheet drawn for this subject). */
  const referenceOf = (realRoot: string, reference: string) =>
    Effect.gen(function* () {
      const path = yield* inGame(realRoot, reference);
      if (!/\.(png|jpe?g|webp)$/i.test(path))
        return yield* opError(
          "blender-review",
          reference,
          "invalid-input",
          "A reference is a picture (PNG, JPEG, WebP).",
        );
      const exists = yield* Effect.promise(() =>
        NodeFSP.stat(path).then(
          (stat) => stat.isFile(),
          () => false,
        ),
      );
      if (!exists)
        return yield* opError(
          "blender-review",
          reference,
          "invalid-path",
          `${reference} is not a file.`,
        );
      return { path, name: reference };
    });

  /**
   * The pass of these objects as they are now: the one an earlier review or export of this key
   * ran with this kit (pass.json), or a new one; its ledger fit to a sidecar and its concept read,
   * kept as candidate.json. A review renders it, an export ships it. Runs under the pipeline lock.
   */
  const passed = (
    root: string,
    realRoot: string,
    style: GameStyle | null,
    target: ReadonlyArray<string> | null,
    operation: "blender-review" | "blender-export",
  ) =>
    Effect.gen(function* () {
      const kit = yield* kitVersionOf;
      const digest = yield* liveDigest(root, target);
      const key = reviewKey(digest.perObject, styleHash(style));
      const out = yield* candidateDir(realRoot, key);
      const found = yield* Effect.promise(() => readPassRecord(out));
      const record: PassRecord =
        // A pass the kit has changed since measures what the kit no longer makes: run it again.
        found !== null && found.kit === kit
          ? found
          : yield* Effect.gen(function* () {
              // A new pass replaces the GLB: nothing may promote what an earlier pass wrote.
              yield* Effect.promise(() => NodeFSP.rm(candidateJsonPath(out), { force: true }));
              const glb = NodePath.join(out, `candidate.${NodeCrypto.randomUUID()}.glb`);
              return yield* Effect.gen(function* () {
                const rig = style?.rig === undefined ? null : resolveRig(style.rig);
                const engine = yield* availableEngine((yield* projects.read(root)).engine.name);
                const pass = yield* runPass(root, out, glb, {
                  images: engineProfile(engine).compressedModels ? "WEBP" : "AUTO",
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
                const armatures = Object.keys({ ...live, ...pass.armatures });
                const made: PassRecord = {
                  ...pass,
                  key,
                  kit,
                  digest: digest.perObject,
                  at: DateTime.formatIso(yield* DateTime.now),
                  subject: subjectName(
                    armatures.length === 1 ? armatures[0]! : (target?.[0] ?? digest.objects[0]!),
                  ),
                };
                yield* Effect.tryPromise({
                  try: () => NodeFSP.rename(glb, NodePath.join(out, CANDIDATE_GLB)),
                  catch: (cause) => opError(operation, out, "io", undefined, cause),
                });
                yield* writeText(passJsonPath(out), encodePassRecord(made), operation);
                return made;
              }).pipe(Effect.ensuring(Effect.promise(() => NodeFSP.rm(glb, { force: true }))));
            });
      const ledger = ledgerParts(record.parts);
      if ("refusal" in ledger)
        return yield* opError(operation, root, "invalid-input", ledger.refusal);
      // The concept is read every time, so one added since is beside the next render.
      const concept = yield* Effect.promise(() => conceptOf(realRoot, record.subject));
      const candidate: Candidate = { ...record, parts: ledger.parts, concept: concept.ref };
      yield* writeText(candidateJsonPath(out), encodeCandidate(candidate), operation);
      return { key, out, candidate, concept };
    });

  /** The locked part of a review: the pass of this key, its composite rendered in a throwaway scene of the live session. */
  const reviewed = (
    root: string,
    realRoot: string,
    style: GameStyle | null,
    input: GameBlenderLookInput,
  ) =>
    Effect.gen(function* () {
      const { key, out, candidate, concept } = yield* passed(
        root,
        realRoot,
        style,
        input.target ?? null,
        "blender-review",
      );
      const image = NodePath.join(out, REVIEW_PNG);
      const view = style?.view ?? "perspective";
      const reference =
        input.reference === undefined ? null : yield* referenceOf(realRoot, input.reference);
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
          ...(reference === null ? {} : { reference }),
        })})`,
      );
      const png = yield* Effect.tryPromise({
        try: () => NodeFSP.readFile(rendered.image),
        catch: (cause) => opError("blender-review", rendered.image, "io", undefined, cause),
      });
      const bytes = yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(out, CANDIDATE_GLB)).then((stat) => stat.size),
      );
      return { key, candidate, concept, rendered, png, bytes };
    });

  /**
   * Look's review mode: digest the objects, reuse the pass of that key or run it, then
   * render its composite in a throwaway scene of the live session.
   */
  /**
   * With fresh, the look's picture also goes to a separate model (GameFreshEyes); its defects
   * are a field of their own, which the look's verdict shows whole (a review's measurements
   * fill the result's byte cap, and a cap once cut them away). The picture is kept under
   * builds/logs/fresh-eyes.
   */
  const freshLook = (
    threadId: ThreadId,
    root: string,
    input: GameBlenderLookInput,
    result: GameBlenderLookResult,
  ) =>
    input.fresh !== true
      ? Effect.succeed(result)
      : Effect.gen(function* () {
          const image =
            result.review !== undefined
              ? NodePath.join(root, result.review.image)
              : result.screenshot !== undefined
                ? yield* Effect.promise(async () => {
                    const dir = NodePath.join(root, "builds", "logs", "fresh-eyes");
                    await NodeFSP.mkdir(dir, { recursive: true });
                    const file = NodePath.join(dir, `look-${Date.now()}.png`);
                    await NodeFSP.writeFile(file, Buffer.from(result.screenshot!.data, "base64"));
                    return file;
                  })
                : null;
          const seen =
            image === null
              ? "Fresh eyes need a picture, and this look made none."
              : yield* freshEyes.review({ threadId, root, images: [image], about: input.about });
          return { ...result, fresh: seen };
        });

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
      // A character's review is its hero sheet (heroSheets.ts), kept where Art shows it.
      const heroSheet =
        candidate.measured.kind === "character"
          ? yield* Effect.tryPromise({
              try: () => keepHeroSheet(realRoot, candidate.subject, rendered.image),
              catch: (cause) => opError("blender-review", root, "io", undefined, cause),
            })
          : null;
      const notes = rigNotes(candidate);
      const text = [
        `Review of ${someNames(candidate.objects)} (key ${key.slice(0, 12)}), exactly what game_blender op export would write. Image: ${imageRel}.`,
        ...(concept.section === null
          ? []
          : [`Concept (${candidate.concept}):\n${concept.section}`]),
        measurementText(candidate, styleBudgets(style), bytes),
        ...(rendered.facts === undefined || rendered.facts.length === 0
          ? []
          : [`Seen in the pictures:\n${rendered.facts.map((fact) => `- ${fact}`).join("\n")}`]),
        ...(rendered.problems === undefined || rendered.problems.length === 0
          ? []
          : [
              `The image has errors:\n${rendered.problems.map((problem) => `- ${problem}`).join("\n")}`,
            ]),
        ...notes.map((note) => `Note: ${note}`),
        candidate.refusals.length === 0
          ? "game_blender op export writes exactly this."
          : `The export refuses it, as the file would be broken in the game:\n${refusalLines(candidate)}`,
        ...(heroSheet === null ? [] : [`Kept for Art as ${heroSheet}.`]),
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

  /** A scratch folder of one paint run under the pipeline's logs. */
  const sheetRunDir = (realRoot: string, kind: string, name: string) =>
    Effect.tryPromise({
      try: () =>
        ensureGameDir(
          realRoot,
          `${PIPELINE_DIR}/${kind}-${name}-${NodeCrypto.randomUUID().slice(0, 8)}`,
        ),
      catch: (cause) => opError(`blender-${kind}`, PIPELINE_DIR, "invalid-path", undefined, cause),
    });

  /** The atlas side: the asked size within STYLE.json's budget.texture, which is its default. */
  const atlasSize = (style: GameStyle | null, asked: number | undefined) => {
    const budget = styleBudgets(style).texture;
    return { size: Math.max(256, Math.min(asked ?? budget, budget)), budget };
  };

  const paletteNote = (style: GameStyle | null) =>
    Array.isArray(style?.palette) && style.palette.length > 0
      ? [
          `${GAME_STYLE_FILE} has a palette, so the export's style pass snaps each face to it by the paint under it: the painted detail ships only in a game without a palette.`,
        ]
      : [];

  const relativeTo = (realRoot: string, file: string) =>
    NodePath.relative(realRoot, file).split(NodePath.sep).join("/");

  const removeScratch = (out: string, keep: ReadonlyArray<string>) =>
    Effect.promise(() =>
      NodeFSP.readdir(out)
        .then((names) =>
          Promise.all(
            names
              .filter((name) => !keep.includes(name))
              .map((name) =>
                NodeFSP.rm(NodePath.join(out, name), { force: true, recursive: true }),
              ),
          ),
        )
        .catch(() => undefined),
    );

  const paintModel = (root: string, input: GameBlenderPaintInput) =>
    Effect.gen(function* () {
      const realRoot = yield* realRootOf(root);
      const style = yield* readGameStyle(realRoot);
      const { size, budget } = atlasSize(style, input.size);
      const sheet = yield* sheetSource(realRoot, input.sheet, "blender-paint");
      const digest = yield* liveDigest(root, input.objects);
      const out = yield* sheetRunDir(realRoot, "paint", "model");
      const alignmentFile = NodePath.join(out, "alignment.png");
      const painted = yield* oneShot(root, out, {
        entry: "paint",
        operation: "blender-paint",
        copy: true,
        room: SHEET_ROOM,
        timeoutMs: PAINT_TIMEOUT_MS,
        params: {
          objects: digest.objects,
          expectedDigest: digest.perObject,
          sheet: sheet.file,
          views: input.views ?? null,
          noMirror: input.noMirror ?? null,
          pose: input.pose ?? null,
          size,
        },
      }).pipe(
        // A model refused for its fit is shown against the sheet, so the agent sees what to fix.
        Effect.catch((error) =>
          Effect.flatMap(
            Effect.promise(() =>
              NodeFSP.access(alignmentFile).then(
                () => true,
                () => false,
              ),
            ),
            (drawn) =>
              Effect.fail(
                drawn
                  ? opError(
                      error.operation,
                      error.path,
                      error.reason,
                      `${error.detail ?? ""} Each view's outline of the model over the sheet: ${relativeTo(realRoot, alignmentFile)}.`,
                    )
                  : error,
              ),
          ),
        ),
        Effect.flatMap(decodePainted),
        Effect.mapError(protocolError("blender-paint", root)),
      );
      const name = painted.name;
      // The live scene has a file before the textures' paths are made relative to it.
      yield* saveBlend(root);
      const adopted = yield* kitCall(
        root,
        "blender-paint",
        decodeAdopted,
        `import kurambit.paint\nkurambit.paint.adopt(${pyJson({
          library: painted.library,
          meshes: painted.meshes,
          expectedDigest: digest.perObject,
          dest: yield* inGame(realRoot, `${TEXTURES_DIR}/${name}`),
          stamp: sheet.stamp,
        })})`,
      ).pipe(Effect.ensuring(removeScratch(out, ["alignment.png"])));
      const blend = yield* saveBlend(root);
      const alignment = relativeTo(realRoot, alignmentFile);
      const views = painted.views
        .map(
          (view) =>
            `${view.label} (columns ${view.columns.join("-")}, ${Math.round(view.overlap * 100)}% overlap)`,
        )
        .join(", ");
      return {
        text: [
          `Painted ${someNames(adopted.objects)} from ${sheet.path}, ${sheetCredit(sheet)}.`,
          `Views read: ${views}${painted.mirrored === null ? "" : `; the ${painted.mirrored} side is the other side mirrored`}. Each view's outline of the model over the sheet: ${alignment}.`,
          `${Math.round(painted.seen * 100)}% of the surface was painted from a view; the rest (inside sleeves, tops of shoulders) took its material's colour.`,
          `${painted.head ? `Textures: ${size} px for the body and ${Math.max(Math.floor(size / 2), 256)} px for the head (its own atlas)` : `Textures: ${size} px`}${input.size !== undefined && input.size > budget ? ` (${GAME_STYLE_FILE}'s budget.texture is ${budget})` : ""}: albedo, a detail normal map and ORM, under ${TEXTURES_DIR}/${name}/.`,
          ...painted.notes,
          ...paletteNote(style),
          `Saved .blend source: ${blend}. Look at it (game_blender op look with mode review, which also shows the ¾ view the sheet never drew), then game_blender op export.`,
        ].join("\n"),
        alignment,
        blend,
      };
    });

  /**
   * The template's meshopt decoder, copied into a game whose loader predates compressed exports,
   * and what to change so its next export ships compressed.
   */
  const offerMeshoptDecoder = (realRoot: string, engineDir: string) =>
    Effect.gen(function* () {
      const template = yield* templates.directory;
      const target = NodePath.join(realRoot, engineDir, MESHOPT_DECODER);
      const present = yield* Effect.tryPromise(async () => {
        insideGame(realRoot, `${engineDir}/${MESHOPT_DECODER}`);
        if ((await NodeFSP.stat(target).catch(() => null)) === null) {
          await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
          await NodeFSP.copyFile(NodePath.join(template, THREE_RUNTIME_1, MESHOPT_DECODER), target);
        }
        return true;
      }).pipe(Effect.orElseSucceed(() => false));
      return `This game's ${engineDir}/${MESHOPT_LOADER} has no meshopt decoder, so the geometry shipped quantized but not meshopt-compressed. To ship it smaller, ${present ? "" : `copy three.js 0.180's examples/jsm/libs/meshopt_decoder.module.js to ${engineDir}/${MESHOPT_DECODER}, `}add import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"${present ? ` (now in ${engineDir}/${MESHOPT_DECODER})` : ""}, make the loader new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder), and export again.`;
    });

  return GameBlender.of({
    code: (threadId, input) =>
      projects.exclusive(threadId, "Blender code", (root) =>
        holding(
          root,
          Effect.gen(function* () {
            const text = yield* callText(root, "execute_blender_code", { code: input.code });
            const blend = yield* saveBlend(root);
            return { output: `${text}\nSaved .blend source: ${blend}` };
          }),
        ),
      ),
    look: (threadId, input) =>
      projects.exclusive(threadId, "Blender look", (root) =>
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
              // The model sheet and the review say "side" for the right profile; the addon does not.
              ...(input.views === undefined
                ? {}
                : { views: input.views.map((view) => (view === "side" ? "right" : view)) }),
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
          }).pipe(Effect.flatMap((result) => freshLook(threadId, root, input, result))),
        ),
      ),
    animate: (threadId, input) =>
      projects.exclusive(threadId, "Animate", (root) =>
        holding(
          root,
          Effect.gen(function* () {
            const fail = (reason: GameOperationError["reason"], detail: string) =>
              Effect.fail(opError("blender-animate", root, reason, detail));
            const realRoot = yield* realRootOf(root);
            const packs = standardClipPacks(yield* readGameStyle(realRoot));
            // The bar: the named library clip, or the one sharing the most words with the move's name.
            let barName = input.bar ?? null;
            if (barName === null && packs.length > 0) {
              const wanted = new Set([
                ...clipWords(input.clip),
                ...(typeof input.spec["name"] === "string" ? clipWords(input.spec["name"]) : []),
              ]);
              let best: { name: string; score: number } | null = null;
              for (const id of packs)
                for (const entry of yield* library.packClips(id))
                  for (const clip of entry.clips) {
                    const score = clipWords(clip).filter((word) => wanted.has(word)).length;
                    if (
                      score > 0 &&
                      (best === null ||
                        score > best.score ||
                        (score === best.score && clip.length < best.name.length))
                    )
                      best = { name: `${id}:${clip}`, score };
                  }
              barName = best?.name ?? null;
            }
            const bar =
              barName === null
                ? null
                : (yield* resolveClips(root, [barName], packs).pipe(
                    Effect.mapError((cause) =>
                      opError(
                        "blender-animate",
                        root,
                        "invalid-input",
                        cause.detail ?? cause.message,
                      ),
                    ),
                  ))[0]!;
            const clipDir = `${ANIMATE_DIR}/${input.clip}`;
            const passes = yield* Effect.promise(() =>
              NodeFSP.readdir(NodePath.join(realRoot, clipDir)).catch(() => [] as string[]),
            );
            const pass = `${clipDir}/${1 + Math.max(0, ...passes.map(Number).filter(Number.isInteger))}`;
            const out = yield* Effect.tryPromise({
              try: () => ensureGameDir(realRoot, pass),
              catch: (cause) => opError("blender-animate", pass, "invalid-path", undefined, cause),
            });
            yield* writeText(
              NodePath.join(out, "spec.json"),
              `${JSON.stringify(input.spec, null, 1)}\n`,
              "blender-animate",
            );
            const made = yield* kitCall(
              root,
              "blender-animate",
              decodeAnimated,
              `kurambit.animate(${pyJson({
                armature: input.character,
                clip: input.clip,
                spec: input.spec,
                out,
                bar: bar === null ? null : { path: bar.path, clip: bar.name, pack: bar.pack },
              })})`,
            );
            const blend = yield* saveBlend(root);
            const screenshots = yield* Effect.forEach(made.images, (image) =>
              Effect.tryPromise({
                try: () => NodeFSP.readFile(image.path),
                catch: (cause) => opError("blender-animate", image.path, "io", undefined, cause),
              }).pipe(
                Effect.map((png) => ({
                  mimeType: "image/png" as const,
                  data: png.toString("base64"),
                  width: image.width,
                  height: image.height,
                })),
              ),
            );
            if (screenshots.length === 0)
              return yield* fail("tool-failed", "The Blender kit drew no pictures of the move.");
            return {
              text: [
                ...made.summary,
                ...(bar === null
                  ? [
                      `No bar: no clip in ${packs.join(", ") || "the lock's animation packs"} shares a word with ${input.clip}; pass bar (a library clip name) to measure one beside it.`,
                    ]
                  : []),
                `Pass ${pass}: spec.json, bundle.json (every number) and the pictures, in order: contact sheet (front, side, 3/4; beats marked), onion strip, footprint (top down) and curves. Saved .blend source: ${blend}.`,
                `Read the pictures and the numbers, change the spec, and animate ${input.clip} again; stop when neither improves. The clip is ${made.action} in the scene and ships with the character: game_blender op look with mode review, then game_blender op export.`,
              ].join("\n"),
              action: made.action,
              pass,
              images: made.images.map((image) => `${pass}/${NodePath.basename(image.path)}`),
              warnings: made.warnings,
              screenshots,
            } satisfies GameAnimateResult;
          }),
        ),
      ),
    character: (threadId, input) =>
      projects.exclusive(threadId, "Blender character", (root) =>
        holding(
          root,
          Effect.gen(function* () {
            const fail = (reason: GameOperationError["reason"], detail: string) =>
              Effect.fail(opError("blender-character", root, reason, detail));
            if (input.body === "none")
              return yield* fail(
                "invalid-input",
                'body "none" is retired: model the body static (or start from body mpfb, studio or library), then rig it with rig "human".',
              );
            if (input.body === undefined && input.rig === undefined)
              return yield* fail(
                "invalid-input",
                'Pass rig (a template such as "human", or "chains") to rig a model in the scene, or body to build a human and rig it.',
              );
            if (input.body !== undefined && input.rig !== undefined && input.rig !== "human")
              return yield* fail(
                "invalid-input",
                `A body is a human, rigged on the human template; rig "${input.rig}" rigs a model already in the scene.`,
              );
            const chains = input.chains?.filter((chain) => "kind" in chain);
            if (input.chains !== undefined && chains?.length !== input.chains.length)
              return yield* fail(
                "invalid-input",
                'Spring chains on the standard skeleton are retired: model hair and cloth with the body (they are weighted with it), or describe a model\'s own chains ({name, kind, parent, part, points}) with rig "chains".',
              );
            if (chains !== undefined && input.rig !== "chains")
              return yield* fail(
                "invalid-input",
                `chains describe a model no template fits: pass rig "chains" with them, or a template with joints.`,
              );
            let body: Record<string, unknown> | null = null;
            if (input.body !== undefined) {
              const realRoot = yield* realRootOf(root);
              const inputBody = input.body;
              if ("library" in inputBody) {
                const { pack: id, file } = inputBody.library;
                const pack = LIBRARY_CATALOG.find((candidate) => candidate.id === id);
                if (pack === undefined)
                  return yield* fail("invalid-input", `${id} is not a library pack.`);
                body = {
                  library: yield* library.packFile(id, file),
                  pack: id,
                  licence: pack.licence,
                };
              } else if ("studio" in inputBody) {
                body = { studio: inputBody.studio };
              } else if ("mpfb" in inputBody) {
                const mpfb = (yield* tools.addon("mpfb"))!;
                if (mpfb.zip === null) {
                  // A small official add-on a route needs installs on first need; the rest ask
                  // first, as does one the person removed.
                  if (GameToolchain.addonAsksFirst(mpfb.entry) || mpfb.removed)
                    return yield* fail(
                      "tool-missing",
                      addonAsk(
                        "An mpfb body",
                        mpfb.entry,
                        `Meanwhile use a library body: ${LIBRARY_BODY}, or body studio.`,
                      ),
                    );
                  yield* tools.install(mpfb.entry.id);
                }
                // A session opened before the install has no MPFB2 yet; its scene is saved, so reopen it.
                if (!(yield* ensure(root)).addons.has("mpfb")) {
                  yield* drop(root);
                  if (!(yield* ensure(root)).addons.has("mpfb"))
                    return yield* fail(
                      "tool-failed",
                      "MPFB2 is installed, but it could not be installed into this game's live Blender; see the blender-live-mpfb log under builds/logs. Library and studio bodies work meanwhile.",
                    );
                }
                body = { mpfb: inputBody.mpfb };
              } else {
                const relative = inputBody.game;
                const real = yield* Effect.promise(() =>
                  NodeFSP.realpath(NodePath.resolve(realRoot, relative)).catch(() => null),
                );
                if (
                  real === null ||
                  !staysInsideGame(realRoot, relative) ||
                  !/\.(glb|gltf)$/i.test(real)
                )
                  return yield* fail(
                    "invalid-input",
                    `${relative} is not a .glb or .gltf file in this game; a game body is a game-relative path to an earlier export.`,
                  );
                body = { game: real };
              }
            }
            const manifest = yield* library.packFile(MESH2MOTION_PACK, "manifest.json");
            const params = {
              name: input.name,
              joints: input.joints ?? null,
              rigid: input.rigid ?? {},
              clips: input.clips ?? [],
              pack: NodePath.dirname(manifest),
            };
            const made = yield* kitCall(
              root,
              "blender-character",
              decodeRigged,
              body === null
                ? `kurambit.rig(${pyJson({
                    ...params,
                    objects: input.objects ?? [input.name],
                    template: input.rig,
                    chains: chains ?? null,
                  })})`
                : `kurambit.character(${pyJson({
                    ...params,
                    body,
                    objects: input.objects ?? [],
                    height: input.height ?? null,
                  })})`,
            );
            const blend = yield* saveBlend(root);
            const rigid = Object.entries(made.rigid);
            return {
              text: [
                `${made.armature}: ${someNames(made.meshes)} on ${made.template === "chains" ? "chains" : `the ${made.template} template`}, ${made.bones} bones, weighted by ${made.weights}.`,
                ...(rigid.length === 0
                  ? []
                  : [`Rigid: ${rigid.map(([part, bone]) => `${part} on ${bone}`).join(", ")}.`]),
                `Bones by chain: ${Object.entries(made.chains)
                  .map(([name, bones]) => `${name} ${bones.join(" ")}`)
                  .join("; ")}.`,
                `Clips: ${made.clips.join(", ") || "none"}. How each moves the model:`,
                ...made.notes,
                `Saved .blend source: ${blend}. Look at the clips with game_blender op look, then game_blender op export.`,
              ].join("\n"),
              armature: made.armature,
              meshes: made.meshes,
              clips: made.clips,
              chains: made.chains,
              facts: made.facts,
            };
          }),
        ),
      ),
    scene: (threadId, input) =>
      projects.exclusive(threadId, "Blender scene", (root) =>
        holding(
          root,
          Effect.gen(function* () {
            const text = yield* callText(root, "get_scene_info", { ...input });
            return { text };
          }),
        ),
      ),
    assetsSearch: (threadId, input) =>
      projects.exclusive(threadId, "Blender assets search", (root) =>
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
      ),
    assetsImport: (threadId, input) =>
      projects.exclusive(threadId, "Blender assets import", (root) =>
        holding(
          root,
          Effect.gen(function* () {
            const id = input.id;
            if (id === undefined)
              return yield* opError(
                "blender-assets-import",
                root,
                "invalid-input",
                `source ${input.source} takes id: the asset id game_blender op asset_search listed.`,
              );
            const source = input.source;
            if (source === "polyhaven" && input.applyTo !== undefined) {
              const scanned = yield* scanTexture(root, id, input.applyTo, input.targetSize);
              if (scanned !== null) return scanned;
            }
            // A library file is fetched and checked against its pin before the live scene changes.
            const libraryFile =
              source === "library"
                ? yield* Effect.gen(function* () {
                    const pack = yield* library.entry(id);
                    // The person's library switch holds here too: Blender is no way round it.
                    if (!modelChoice(yield* projects.read(root)).library && !isClipPack(pack))
                      return yield* opError(
                        "blender-assets-import",
                        root,
                        "invalid-input",
                        `${id}: ${LIBRARY_OFF_REFUSAL}`,
                      );
                    if (input.path === undefined || !/\.(glb|gltf|fbx)$/i.test(input.path))
                      return yield* opError(
                        "blender-assets-import",
                        root,
                        "invalid-input",
                        "source library takes path: a .glb, .gltf or .fbx file of the entry, as game_assets op search with pack lists it.",
                      );
                    return { pack, file: yield* library.packFile(pack.id, input.path) };
                  })
                : undefined;
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
            const text =
              libraryFile !== undefined
                ? `${yield* callText(root, "execute_blender_code", {
                    code: `import json\nimport kurambit.skeleton\nnew, clips = kurambit.skeleton.import_model(${pyJson(libraryFile.file)})\nprint(f"Imported {len(new)} objects and {len(clips)} clips")`,
                  })}\nFrom library entry ${libraryFile.pack.id}: ${input.path}.`
                : yield* callText(root, "import_asset", {
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
            // An armature the import brings with clips of its own (an animated Poly Pizza
            // animal) enters on its own rig under the one own-rig rule (ownRigNote): it is
            // marked, so STYLE.json's rig no longer governs it and the review checks it again.
            const clipsOf = /STUDIO_IMPORT_CLIPS (\{.*\})/.exec(
              yield* callText(root, "execute_blender_code", {
                code: [
                  "import bpy, json",
                  "from kurambit.digest import exported_actions",
                  `before_actions = set(${knownActions})`,
                  `names = ${pyJson(Object.keys(armatures))}`,
                  "print('STUDIO_IMPORT_CLIPS ' + json.dumps({n: [a.name for a in exported_actions(bpy.data.objects[n]) if a.name not in before_actions] for n in names if n in bpy.data.objects}))",
                ].join("\n"),
              }),
            )?.[1];
            const importedClips = (() => {
              try {
                return clipsOf === undefined
                  ? {}
                  : (JSON.parse(clipsOf) as Record<string, ReadonlyArray<string>>);
              } catch {
                return {};
              }
            })();
            const ownRig = Object.keys(armatures).filter(
              (name) =>
                (importedClips[name]?.length ?? 0) > 0 &&
                ownRigNote(name, { own: importedClips[name] ?? [], library: [] }) === null,
            );
            // The import stays in the live scene, stamped with its source and licence: the
            // export composes the ledger from the stamps, after a review like anything built here.
            // Its clips are stamped too, so a rigged import's animations are credited to it, not
            // called made here; a clip keyed later on its armature carries no stamp and is.
            const licence =
              libraryFile === undefined
                ? importLicence(source, id, text)
                : `${LIBRARY_LICENCES[libraryFile.pack.licence].name}${libraryFile.pack.credit === undefined ? "" : `, credit: ${libraryFile.pack.credit}`}`;
            const stampOf = (what: "mesh" | "clips") =>
              JSON.stringify(
                JSON.stringify({
                  what,
                  from: libraryFile?.pack.id ?? source,
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
                `for n in ${pyJson(ownRig)}: bpy.data.objects[n]['kurambit_rig'] = n`,
                // Its clips belong to it alone: an animal on the same bone names never takes them.
                `for n, names in ${pyJson(Object.fromEntries(ownRig.map((name) => [name, importedClips[name] ?? []])))}.items():\n    for c in names:\n        if c in bpy.data.actions: bpy.data.actions[c]['kurambit_owner'] = n`,
                `for a in [a for a in bpy.data.actions if a.name not in before_actions]: a['kurambit_source'] = ${stampOf("clips")}`,
                "print(f'STUDIO_STAMPED {len(added)}')",
              ].join("\n"),
            });
            const count = Number(/STUDIO_STAMPED (\d+)/.exec(stamped)?.[1] ?? 0);
            const blend = yield* saveBlend(root);
            // A library entry is credited on the credits screen as its add would credit it.
            const credited =
              libraryFile === undefined || count === 0
                ? ""
                : `\n${yield* library.credit(root, libraryFile.pack, "Blender assets import")}`;
            return {
              text: `${text}${credited}\nSaved .blend source: ${blend}\n${count === 0 ? "The import added no model to the scene (an HDRI or a texture)." : `The import stays in the live scene, marked with its source and licence (${licence})${ownRig.length === 0 ? "" : `; ${ownRig.join(", ")} came with clips of ${ownRig.length === 1 ? "its" : "their"} own (${ownRig.map((name) => (importedClips[name] ?? []).slice(0, 6).join(", ")).join("; ")}), so ${ownRig.length === 1 ? "it enters" : "they enter"} on ${ownRig.length === 1 ? "its" : "their"} own rig (kurambit_rig) and plays only those clips`}; review and export it like anything you build (game_blender op look with mode review, then game_blender op export).`}`,
              blend,
            };
          }),
        ),
      ),
    paint: (threadId, input) =>
      projects.exclusive(threadId, "Blender paint", (root) =>
        holding(root, pipelineLocked(root)(paintModel(root, input))),
      ),
    exportGlb: (threadId, input) =>
      projects.exclusive(threadId, "Blender export", (root) =>
        holding(
          root,
          Effect.gen(function* () {
            // The export ships the pass of these objects as they are now, the one a review rendered
            // or a new one; a review is only for looking at it.
            const manifest = yield* projects.read(root);
            const engineDir = manifestProject(manifest);
            const realRoot = yield* realRootOf(root);
            const style = yield* readGameStyle(realRoot);
            const { key, out, candidate } = yield* passed(
              root,
              realRoot,
              style,
              input.objects ?? null,
              "blender-export",
            );
            if (candidate.refusals.length > 0)
              return yield* opError(
                "blender-export",
                root,
                "invalid-input",
                `The file would be broken in the game; fix it and export again:\n${refusalLines(candidate)}`,
              );
            const file = input.file ?? `${yield* assetDirOf(manifest)}/${candidate.subject}.glb`;
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
            const profile = engineProfile(yield* availableEngine(manifest.engine.name));
            const compress = profile.compressedModels;
            if (input.simplify !== undefined && !compress)
              return yield* opError(
                "blender-export",
                root,
                "invalid-input",
                `simplify is for three.js games; ${profile.displayName} makes its own levels of detail when it imports the model.`,
              );
            const reviewedBytes = yield* Effect.tryPromise({
              try: () => NodeFSP.readFile(NodePath.join(out, CANDIDATE_GLB)),
              catch: (cause) => opError("blender-export", file, "io", undefined, cause),
            });
            // A game made before compressed exports has a loader with no meshopt decoder: its model
            // ships quantized but not meshopt-compressed, and the decoder is put in its vendor folder.
            // Kurambit's runtime decodes them.
            const decodes =
              compress &&
              (manifestRuntime(manifest) !== null ||
                (yield* Effect.promise(() =>
                  NodeFSP.readFile(
                    NodePath.join(realRoot, engineDir, MESHOPT_LOADER),
                    "utf8",
                  ).catch(() => ""),
                )).includes("setMeshoptDecoder"));
            const decoderNote =
              compress && !decodes ? yield* offerMeshoptDecoder(realRoot, engineDir) : null;
            const measuredTriangles = candidate.measured.triangles;
            const simplify =
              input.simplify !== undefined && input.simplify < measuredTriangles
                ? { ratio: input.simplify / measuredTriangles }
                : undefined;
            // The browser downloads the model: its geometry and clips ship meshopt-compressed (its
            // images are already WebP from the pass), so nothing needs compressing after the export.
            const shippedBytes = compress
              ? yield* packGlb(
                  reviewedBytes,
                  { meshopt: decodes, ...(simplify === undefined ? {} : { simplify }) },
                  (detail, cause) =>
                    opError(
                      "blender-export",
                      file,
                      "tool-failed",
                      `gltfpack could not compress the reviewed model: ${detail}`,
                      cause,
                    ),
                )
              : reviewedBytes;
            const shippedDoc = glbJson(shippedBytes);
            const shippedTriangles =
              shippedDoc === null ? measuredTriangles : gltfTriangles(shippedDoc);
            // Written beside the target and renamed over it, so a game never loads half a model.
            const glb = yield* Effect.tryPromise({
              try: async () => {
                const staged = `${absolute}.${NodeCrypto.randomUUID()}.part`;
                try {
                  await NodeFSP.writeFile(staged, shippedBytes);
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
              sidecarText({
                ...sidecarOf(
                  candidate,
                  {
                    name: NodePath.posix.basename(file),
                    sha256: glb.sha256,
                    bytes: glb.bytes,
                  },
                  // Made in Blender whichever way the agent was free to choose.
                  characterRoute(manifest) === "code" ? "code" : "blender",
                ),
                triangles: shippedTriangles,
              }),
              "blender-export",
            );
            // A rendered review of what shipped is kept for Art under the file's name.
            const sheet = NodePath.join(out, REVIEW_PNG);
            if (
              candidate.measured.kind === "character" &&
              (yield* Effect.promise(() =>
                NodeFSP.lstat(sheet).then(
                  (stat) => stat.isFile(),
                  () => false,
                ),
              ))
            )
              yield* Effect.tryPromise({
                try: () => keepHeroSheet(realRoot, NodePath.posix.basename(file, ".glb"), sheet),
                catch: (cause) => opError("blender-export", file, "io", undefined, cause),
              });
            // Shipped: Art stops listing this review as a model still being made.
            yield* writeText(exportedMarkPath(out), `${file}\n`, "blender-export");
            const credited = yield* recordProvenance(
              realRoot,
              [{ first: file, line: ledgerLine(file, candidate) }],
              EXPORT_TOOL,
            );
            const blend = yield* saveBlend(root);
            return {
              text:
                [
                  `Exported ${someNames(candidate.objects)} (pass ${key.slice(0, 12)}): ${file} (${(glb.bytes / 1048576).toFixed(2)} MB${compress ? `, compressed from ${(reviewedBytes.byteLength / 1048576).toFixed(2)} MB: ${decodes ? "meshopt geometry and clips" : "quantized geometry"}, WebP images` : ""}) and its sidecar ${sidecar}.`,
                  ...(input.simplify === undefined
                    ? []
                    : simplify === undefined
                      ? [
                          `simplify ${input.simplify} keeps all ${measuredTriangles} triangles: the model has no more.`,
                        ]
                      : [
                          `Simplified from ${measuredTriangles} to ${shippedTriangles} triangles (asked for at most ${input.simplify}${shippedTriangles > input.simplify ? ": the simplifier stops before it moves the surface by more than 1% of the model's size" : ""}).`,
                        ]),
                  ...(decoderNote === null ? [] : [decoderNote]),
                  credited,
                ].join(" ") +
                `\n${measurementText(candidate, styleBudgets(style), reviewedBytes.byteLength)}${rigNotes(
                  candidate,
                )
                  .map((note) => `\nNote: ${note}`)
                  .join(
                    "",
                  )}\nSaved .blend source: ${blend}\n${afterAddingArt(profile)}${profile.sidecarLoad === null ? "" : ` ${profile.sidecarLoad(candidate.subject, sidecar.slice(engineDir.length + 1))}`}`,
              blend,
              export: file,
              sidecar,
            };
          }).pipe(pipelineLocked(root)),
        ),
      ),
    addon: (threadId, input) =>
      projects.exclusive(threadId, "Blender add-on", (root) =>
        Effect.gen(function* () {
          const found = yield* tools.addon(input.install);
          if (found === null)
            return yield* opError(
              "blender-addon",
              input.install,
              "invalid-input",
              `${input.install} is not on the add-ons list; op addon's install names those it has.`,
            );
          const had = found.zip !== null;
          // The person's yes is needed for a large or unofficial add-on, and to undo their Remove.
          if (
            !had &&
            input.asked !== true &&
            (GameToolchain.addonAsksFirst(found.entry) || found.removed)
          )
            return yield* opError(
              "blender-addon",
              input.install,
              "tool-missing",
              `${found.removed ? `The person removed ${found.entry.name} in Settings → Game tools.` : `${found.entry.name} is a download the person agrees to first.`} ${GameToolchain.addonAbout(found.entry)} Ask them whether to add it${found.removed ? " back" : ""}; on their yes, call game_blender op addon {"install": "${found.entry.id}", "asked": true}.`,
            );
          if (!had) yield* tools.install(found.entry.id);
          // The scene is saved after every change, so the next call opens a Blender that has it.
          yield* drop(root);
          return {
            text: `${GameToolchain.addonAbout(found.entry)} ${had ? "It was already installed" : "Installed"}; this game's Blender opens with it on its next call. The person can remove it in Settings → Game tools.`,
          };
        }),
      ),
    stop: drop,
  });
});

export const layer = Layer.effect(GameBlender, make);
