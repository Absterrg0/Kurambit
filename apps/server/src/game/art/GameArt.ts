// @effect-diagnostics nodeBuiltinImport:off -- Generated files are written into the game folder with the game's no-follow staged writes.
// @effect-diagnostics globalDate:off -- The day's spend starts at the person's local midnight.
// Generated art: one service for every lane (images, characters, creatures, models, textures,
// audio). Each lane goes to a provider adapter (art/providers/<id>.ts), chosen by the person's
// Settings (auto: GAME_ART_LANE_ORDER, their own keys first). A generation is a durable record
// (game_art_generations): it is written before the provider is asked, each change rewrites it,
// and a restart resumes polling every one still making. Files land in the game under
// art/generated/<lane>/<name>/ with a <name>.generation.json beside them (source, AI flag,
// cost, licence), which the import reads to stamp the ledger, and then go through the same
// pipeline as everything else (conform, style pass, review, export).
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient } from "effect/http";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import {
  GAME_ART_EVENT,
  GAME_ART_LANE_ORDER,
  GAME_ART_PROVIDERS,
  GameGeneration,
  GameOperationError,
  type GameArtLane,
  type GameArtLanes,
  type GameArtProviderId,
  type GameArtProviderStatus,
  type GameArtProvidersResult,
  type GameCharacterRoute,
  type GameGenerateInput,
  type GameGenerateResult,
  type GameGenerateWaitInput,
  type GameGenerationChangeResult,
  type GameGenerationsResult,
  type ServerSettings,
  type ThreadId,
} from "@kurambit/contracts";
import type {
  ProviderImageGenerationInput,
  ProviderImageGenerationResult,
} from "@kurambit/provider-core/server/driver";
import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import { GameCaller } from "../GameCaller.ts";
import * as GameAssetLibrary from "../GameAssetLibrary.ts";
import {
  LIBRARY_CATALOG,
  LIBRARY_RIG_JOINTS,
  STANDARD_ARMATURE,
  STANDARD_RIG,
} from "../assetLibraryCatalog.ts";
import { motionClipName } from "../generatedSource.ts";
import { glbJson, gltfMeshSize, readGltfJson } from "../gltfJson.ts";
import * as GameOperations from "../GameOperations.ts";
import { ensureGameDir } from "../gameKeptSaves.ts";
import { lockCharacterRouteRefusal } from "../gameStyle.ts";
import { isPathInside } from "../gameNativeUserDir.ts";
import {
  type ArtAdapter,
  type ArtContext,
  type ArtFile,
  type ArtReference,
  type ArtRemote,
  type ArtRequest,
  type ArtRestore,
  type ArtStep,
  ArtProviderError,
  makeArtHttp,
  pendingStage,
  readPng,
  roundUsd,
} from "./providers/adapter.ts";
import { ART_ADAPTERS } from "./providers/index.ts";

export class GameArt extends Context.Service<
  GameArt,
  {
    /**
     * Starts a generation and answers at once with its record (state making). `route` is the
     * game's character route: off the generated route, characters and creatures are refused
     * before anything is asked or spent.
     */
    readonly generate: (
      root: string,
      threadId: ThreadId,
      input: GameGenerateInput,
      route: GameCharacterRoute,
    ) => Effect.Effect<GameGenerateResult, GameOperationError>;
    /** Until done, choosing (the person's pick), failed or cancelled, or `seconds` pass. */
    readonly wait: (
      root: string,
      input: GameGenerateWaitInput,
    ) => Effect.Effect<GameGenerateResult, GameOperationError>;
    readonly list: (root: string) => Effect.Effect<GameGenerationsResult, GameOperationError>;
    /** The person's pick of a candidate; Keep going's autopilot takes the first on its own. */
    readonly choose: (
      root: string,
      id: string,
      candidate: number,
    ) => Effect.Effect<GameGenerationChangeResult, GameOperationError>;
    readonly cancel: (
      root: string,
      id: string,
    ) => Effect.Effect<GameGenerationChangeResult, GameOperationError>;
    /**
     * The finished generation of this game that delivered `path` (game-relative), with its
     * licence and a creature's body plan; null when none did. The pipeline trusts a generated
     * file by this row, never by a record file or a custom property in the scene.
     */
    readonly delivered: (
      root: string,
      id: string,
      path: string,
    ) => Effect.Effect<GameArtDelivered | null, GameOperationError>;
    readonly providers: Effect.Effect<GameArtProvidersResult, GameOperationError>;
    /** The lane map alone, from saved keys and Codex's sign-in: no network, for game_status. */
    readonly lanes: Effect.Effect<GameArtLanes, GameOperationError>;
    /**
     * Who renders the pictures on a card: a landed motion's strip, a model's views before its rig.
     * GameBlender reads this service's records, so it cannot be one of its dependencies;
     * GameService, which holds both, hands them in at start.
     */
    readonly renderWith: (renderers: ArtRenderers) => Effect.Effect<void>;
  }
>()("kurambit/game/art/GameArt") {}

/** Renders strips of motion clips on the bodies their GLBs hold into `out` (all game-relative). */
export type MotionStripRender = (
  root: string,
  clips: ReadonlyArray<{ readonly path: string; readonly label: string }>,
  out: string,
) => Effect.Effect<void, GameOperationError>;

/** Renders a model's front, side and back, textured and in clay, into `out` (game-relative). */
export type ModelViewsRender = (
  root: string,
  model: string,
  out: string,
) => Effect.Effect<void, GameOperationError>;

export interface ArtRenderers {
  readonly motionStrip: MotionStripRender;
  readonly modelViews: ModelViewsRender;
}

export interface GameArtDelivered {
  readonly generation: GameGeneration;
  readonly licence: string;
  /** A creature's body plan, as it was asked for. */
  readonly body: string | null;
  /** How the provider normalized an uploaded mesh it rigged; the import undoes it. */
  readonly restore: ArtRestore | null;
}

/**
 * What GameArt reads from the rest of the server: the person's Codex (for images on their
 * plan) and whether a thread's turn is a Keep going step. A service of its own so the
 * generation record's logic is tested without a provider registry or a run.
 */
export class GameArtHost extends Context.Service<
  GameArtHost,
  {
    /** The person's Codex, ready to make images, or why not. */
    readonly codex: Effect.Effect<
      | {
          readonly ready: true;
          readonly generateImages: (
            input: ProviderImageGenerationInput,
          ) => Effect.Effect<ProviderImageGenerationResult, ArtProviderError>;
        }
      | { readonly ready: false; readonly message: string }
    >;
    /** True while the thread's turn is a Keep going step's: nobody is there to pick. */
    readonly keepGoingStep: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** A library pack's picture of its look, as `pack/path` and its absolute cached file. */
    readonly packPicture: (
      pack: string,
    ) => Effect.Effect<{ readonly path: string; readonly file: string }, GameOperationError>;
    /** The standard armature's GLB in the library cache: the body a motion is made on by default. */
    readonly standardBody: Effect.Effect<string, GameOperationError>;
  }
>()("kurambit/game/art/GameArt/GameArtHost") {}

const GENERATED_DIR = "art/generated";
const DEFAULT_WAIT_SECONDS = 120;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const POLL_RETRIES = 6;
/**
 * How long a generation may take from its start, restarts included, before it is given up with
 * its estimate counted. 3D runs several provider tasks; Meshy asks for an hour per task.
 */
const LANE_DEADLINE: Readonly<Record<GameArtLane, Duration.Duration>> = {
  image: Duration.minutes(30),
  texture: Duration.minutes(30),
  sfx: Duration.minutes(10),
  music: Duration.minutes(15),
  voice: Duration.minutes(10),
  model: Duration.minutes(90),
  character: Duration.minutes(150),
  creature: Duration.minutes(150),
  motion: Duration.minutes(30),
};
const LIST_LIMIT = 50;
const KEY_CHECK_TTL_MS = 10 * 60_000;
const REFERENCE_MIME: Readonly<Record<string, ArtReference["mime"]>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const MULTI_CANDIDATE_LANES: ReadonlyArray<GameArtLane> = ["image", "texture"];
const CHANGED_LABEL = "Changed";
const AS_IT_WAS_LABEL = "As it was";
/** The one candidate of a model the person looks at before it is rigged. */
const RIG_THIS_LABEL = "Rig this";
/** The game mesh a character or creature is rigged from: what Tripo takes. */
const MESH_BYTES = 150 * 1024 * 1024;
const RIGGED_LANES: ReadonlySet<GameArtLane> = new Set(["character", "creature"]);

/** The game image an edit changes; null for anything else. */
const editOf = (meta: Meta): string | null =>
  typeof meta.options.edit === "string" ? meta.options.edit : null;

/**
 * An edit as every image provider is asked it: the image to change goes first, the change is
 * one instruction, and everything it does not name stays as it was.
 */
const editPrompt = (change: string, transparent: boolean, styled: boolean): string =>
  [
    "Change image 1 as asked below, and keep everything else in it exactly as it is: its subject, composition, framing, art style, palette, lighting and level of detail.",
    ...(styled
      ? ["The other images are references for the look only; do not copy what they show."]
      : []),
    "",
    `The change: ${change}`,
    ...(transparent
      ? [
          "",
          "Cut the subject out: keep only the subject, whole and unchanged, on a fully transparent background, with nothing behind it (no backdrop, floor, shadow or frame).",
        ]
      : []),
  ].join("\n");

/** Uthana's limits on what a motion is made from: a body under 30 MB, a video in these formats. */
const MOTION_BODY_BYTES = 30 * 1024 * 1024;
const MOTION_VIDEO_BYTES = 128 * 1024 * 1024;
const MOTION_VIDEO = /\.(mp4|mov|avi)$/i;

/** What the service keeps beside the provider's own job ids. */
const Meta = Schema.Struct({
  /** The provider's job record; null until a job exists (a synchronous request never has one). */
  job: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  /** Game-relative folder the files land in. */
  folder: Schema.String,
  autopilot: Schema.Boolean,
  /** Files already written while the job ran (a provider that deletes its files soon). */
  kept: Schema.Array(Schema.String),
  /** True when the recorded cost is the estimate because the provider did not report one. */
  costEstimated: Schema.Boolean,
  /** The candidates' files, by candidate, until one is chosen. */
  candidateFiles: Schema.Array(Schema.Array(Schema.String)),
  options: Schema.Record(Schema.String, Schema.Unknown),
  /** The directions' labels, by candidate; absent on a single asset (and on rows from before). */
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The style picture each direction was sent with (a game path or `library:pack/path`), by candidate. */
  styles: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.String))),
  /**
   * The person looks at the model before the rig: true until they pick "Rig this". While it waits
   * the row is choosing, its job holds the pending rig, and nothing runs, so a restart sends nothing.
   */
  review: Schema.optionalKey(Schema.Boolean),
  /** When the chain went on after the person's look: its deadline counts from here. */
  resumedAt: Schema.optionalKey(Schema.String),
  /** How the provider normalized an uploaded mesh it rigged (see ArtRestore). */
  restore: Schema.optionalKey(
    Schema.Struct({
      scale: Schema.Number,
      translation: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
    }),
  ),
  /** What was measured of a rigged game mesh against the file sent, for the done text. */
  meshNote: Schema.optionalKey(Schema.String),
  /** What the model stage cost, kept with the pending rig so a look resumed after a restart shows it. */
  spent: Schema.optionalKey(Schema.Struct({ usd: Schema.Number, estimated: Schema.Boolean })),
});
type Meta = typeof Meta.Type;
const decodeGeneration = Schema.decodeUnknownOption(Schema.fromJsonString(GameGeneration));
const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(Meta));
const encodeGeneration = Schema.encodeSync(Schema.fromJsonString(GameGeneration));
const encodeMeta = Schema.encodeSync(Schema.fromJsonString(Meta));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface Row {
  readonly generation: GameGeneration;
  readonly meta: Meta;
  readonly root: string;
}

const opError = (
  operation: string,
  detail: string,
  reason: GameOperationError["reason"] = "invalid-input",
  path = "",
) => new GameOperationError({ operation, path, reason, detail });

const usd = (value: number) => `$${value.toFixed(value < 0.1 && value > 0 ? 3 : 2)}`;
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const UNDONE =
  "a build from before them was restored (undo). Make it again if it is still wanted; restoring a later build brings them back.";

/** Local midnight today, as the ISO instant rows are compared with. */
const localMidnightIso = (nowMs: number): string => {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
};

/** The name's folder, numbered past every one already used (on disk or by a live generation). */
const freeName = async (
  root: string,
  lane: GameArtLane,
  name: string,
  taken: ReadonlySet<string>,
): Promise<string> => {
  for (let n = 1; n < 1000; n += 1) {
    const suffix = n === 1 ? "" : `_${n}`;
    const candidate = `${name.slice(0, 48 - suffix.length)}${suffix}`;
    if (taken.has(candidate)) continue;
    const exists = await NodeFSP.lstat(NodePath.join(root, GENERATED_DIR, lane, candidate)).then(
      () => true,
      () => false,
    );
    if (!exists) return candidate;
  }
  throw new Error(`Every numbered folder for ${name} is used.`);
};

/**
 * Writes one file into a checked folder of the game: staged beside the target (created
 * exclusively, so a planted link there is refused) and renamed over it (a link at the target
 * is replaced, never followed).
 */
const writeGameFile = async (root: string, relative: string, bytes: Uint8Array) => {
  const dir = await ensureGameDir(root, NodePath.dirname(relative));
  const target = NodePath.join(dir, NodePath.basename(relative));
  const realRoot = await NodeFSP.realpath(root);
  if (
    !isPathInside(NodePath.join(await NodeFSP.realpath(dir), NodePath.basename(relative)), realRoot)
  )
    throw new Error(`${relative} is outside the game folder; nothing is written there.`);
  const staged = NodePath.join(
    dir,
    `.${NodePath.basename(relative)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    await NodeFSP.writeFile(staged, bytes, { flag: "wx" });
    await NodeFSP.rename(staged, target);
  } catch (error) {
    await NodeFSP.rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
};

/** Removes a file the service wrote, if it is still a plain file inside the game. */
const removeGameFile = async (root: string, relative: string) => {
  const file = NodePath.join(root, relative);
  const stat = await NodeFSP.lstat(file).catch(() => null);
  if (stat === null || !stat.isFile()) return;
  const realRoot = await NodeFSP.realpath(root);
  if (
    !isPathInside(
      NodePath.join(await NodeFSP.realpath(NodePath.dirname(file)), NodePath.basename(file)),
      realRoot,
    )
  )
    return;
  await NodeFSP.rm(file, { force: true });
};

/** The files of a finished job, named in its folder: <name>[.<label>].<ext>, previews apart. */
const fileNames = (
  folder: string,
  name: string,
  candidates: ReadonlyArray<ReadonlyArray<ArtFile>>,
  taken: ReadonlySet<string>,
): ReadonlyArray<ReadonlyArray<{ readonly path: string; readonly file: ArtFile }>> => {
  const used = new Set(taken);
  const unique = (stem: string, ext: string) => {
    let path = `${folder}/${stem}.${ext}`;
    for (let n = 2; used.has(path); n += 1) path = `${folder}/${stem}_${n}.${ext}`;
    used.add(path);
    return path;
  };
  return candidates.map((files, index) =>
    files.map((file) => {
      const base = candidates.length > 1 ? `${name}.c${index + 1}` : name;
      const stem =
        file.role === "preview"
          ? `${base}.preview`
          : file.label === undefined
            ? base
            : `${base}.${file.label.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`;
      return { path: unique(stem, file.ext), file };
    }),
  );
};

interface DirectionsSettled {
  readonly step: Extract<ArtStep, { kind: "done" }>;
  /** The labels of the looks that came back, in candidate order. */
  readonly labels: ReadonlyArray<string>;
  readonly refused: ReadonlyArray<{ readonly label: string; readonly reason: string }>;
  /** Some look's cost is its estimate: the provider did not report it. */
  readonly estimated: boolean;
}

/** One result per direction, in order, into candidates, refusals and what is counted. */
const settleDirections = (
  results: ReadonlyArray<Result.Result<ArtStep, ArtProviderError>>,
  estimates: ReadonlyArray<number | null>,
  labels: ReadonlyArray<string>,
): Effect.Effect<DirectionsSettled, ArtProviderError> => {
  const arrived: Array<{ readonly files: ReadonlyArray<ArtFile>; readonly label: string }> = [];
  const refused: Array<{ readonly label: string; readonly reason: string }> = [];
  const costs: Array<number | null> = [];
  let estimated = false;
  results.forEach((result, index) => {
    const label = labels[index] ?? `Direction ${index + 1}`;
    if (Result.isFailure(result)) {
      refused.push({ label, reason: result.failure.reason.slice(0, 1000) });
      costs.push(result.failure.costUsd ?? null);
      return;
    }
    const step = result.success;
    // The loop runs every direction to done; a making step here is a bug, counted as sent.
    const files = step.kind === "done" ? step.candidates[0] : undefined;
    const reported = step.kind === "done" ? step.costUsd : null;
    const cost = reported ?? estimates[index] ?? null;
    if (reported === null && cost !== null) estimated = true;
    costs.push(cost);
    if (files === undefined || files.length === 0)
      refused.push({ label, reason: "The provider answered with no image." });
    else arrived.push({ files, label });
  });
  const costUsd = costs.every((cost) => cost === null)
    ? null
    : roundUsd(costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0));
  if (arrived.length === 0)
    return Effect.fail(
      new ArtProviderError({
        reason:
          `No direction came back. ${refused.map((refusal) => `${refusal.label}: ${refusal.reason}`).join(" ")}`.slice(
            0,
            2000,
          ),
        costUsd: costUsd ?? 0,
      }),
    );
  return Effect.succeed({
    step: { kind: "done", candidates: arrived.map((look) => look.files), costUsd },
    labels: arrived.map((look) => look.label),
    refused,
    estimated,
  });
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const operations = yield* GameOperations.GameOperations;
  const host = yield* GameArtHost;
  const http = makeArtHttp(yield* HttpClient.HttpClient);
  const config = yield* ServerConfig.ServerConfig;
  const scratchRoot = NodePath.join(config.stateDir, "art-scratch");
  const fibers = yield* FiberMap.make<string>();
  const locks = yield* KeyedLock.make<string>();
  // One gate for the day's spend: the sum and the insert that counts against it are one step.
  const spendGate = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<string>();
  const renderers = yield* Ref.make<ArtRenderers | null>(null);
  const keyChecks = new Map<
    GameArtProviderId,
    { key: string; at: number; status: GameArtProviderStatus; refused: boolean }
  >();

  const settings = settingsService.getSettings.pipe(
    Effect.mapError(
      (cause) =>
        new GameOperationError({ operation: "art-settings", path: "", reason: "io", cause }),
    ),
  );

  const keyOf = (all: ServerSettings, provider: GameArtProviderId): string | null => {
    const setting = GAME_ART_PROVIDERS[provider].keySetting;
    if (setting === null) return null;
    const value = all[setting];
    return value === "" ? null : value;
  };

  // ── Records ────────────────────────────────────────────────────────────
  const toRow = (row: {
    readonly root: string;
    readonly payload_json: string;
    readonly remote_json: string;
  }): Row | null => {
    const generation = decodeGeneration(row.payload_json);
    const meta = decodeMeta(row.remote_json);
    return Option.isSome(generation) && Option.isSome(meta)
      ? { generation: generation.value, meta: meta.value, root: row.root }
      : null;
  };
  const load = (root: string, id: string) =>
    sql<{ readonly root: string; readonly payload_json: string; readonly remote_json: string }>`
      SELECT root, payload_json, remote_json FROM game_art_generations
      WHERE id = ${id} AND root = ${root}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toRow(rows[0]))),
      Effect.mapError(
        (cause) =>
          new GameOperationError({ operation: "art-read", path: root, reason: "io", cause }),
      ),
    );
  const loadOrFail = (root: string, id: string, operation: string) =>
    load(root, id).pipe(
      Effect.flatMap((row) =>
        row === null
          ? Effect.fail(opError(operation, `No generation ${id} in this game.`))
          : Effect.succeed(row),
      ),
    );
  /** Rewrites a record: its payload, its job, and what it counts against the day. */
  const save = (row: Row, counted: number | null) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE game_art_generations SET
          state = ${row.generation.state},
          cost_usd = ${counted},
          payload_json = ${encodeGeneration(row.generation)},
          remote_json = ${encodeMeta(row.meta)},
          updated_at = ${row.generation.updatedAt}
        WHERE id = ${row.generation.id}
      `;
      yield* PubSub.publish(changes, row.generation.id);
      yield* operations.changed(
        row.root,
        GAME_ART_EVENT,
        `${row.generation.name}: ${row.generation.state}.`,
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GameOperationError({ operation: "art-save", path: row.root, reason: "io", cause }),
      ),
    );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  /** What a record counts against the day: the real cost, else the estimate. */
  const countedOf = (generation: GameGeneration) => generation.costUsd ?? generation.estimateUsd;

  const spentToday = Effect.gen(function* () {
    const since = localMidnightIso(yield* Clock.currentTimeMillis);
    const rows = yield* sql<{ readonly total: number | null }>`
      SELECT SUM(cost_usd) AS total FROM game_art_generations WHERE created_at >= ${since}
    `;
    return roundUsd(rows[0]?.total ?? 0);
  }).pipe(
    Effect.mapError(
      (cause) => new GameOperationError({ operation: "art-spend", path: "", reason: "io", cause }),
    ),
  );

  // ── Routing ────────────────────────────────────────────────────────────
  const codexReady = host.codex;
  /** Whether the provider can be asked now, without a network call: a key saved, Codex signed in. */
  const savedReady = (all: ServerSettings, provider: GameArtProviderId) =>
    Effect.gen(function* () {
      if (ART_ADAPTERS[provider] === undefined)
        return { ready: false, message: "Not available yet." };
      if (provider === "codex") {
        const codex = yield* codexReady;
        return codex.ready
          ? { ready: true, message: "Codex is installed and signed in." }
          : { ready: false, message: codex.message };
      }
      return keyOf(all, provider) === null
        ? // Settings shows it beside the key field and its "Get a key" link; the agent's refusal says where (setupHint).
          { ready: false, message: "No key saved." }
        : { ready: true, message: "Key saved." };
    });

  /**
   * Ready to route to, without a network call: a saved key, unless the provider refused this very
   * key (Settings' check) or said it cannot work now within the check's lifetime. Without this,
   * a refused key reads as ready to the agent (`artLanes`), which then pays for the steps before it.
   */
  const quickReady = (all: ServerSettings, provider: GameArtProviderId) =>
    Effect.gen(function* () {
      const saved = yield* savedReady(all, provider);
      const cached = keyChecks.get(provider);
      if (!saved.ready || cached === undefined || cached.key !== keyOf(all, provider)) return saved;
      if (cached.status.ready) return saved;
      const now = yield* Clock.currentTimeMillis;
      return cached.refused || now - cached.at < KEY_CHECK_TTL_MS
        ? { ready: false, message: cached.status.message }
        : saved;
    });

  const setupHint = (lane: GameArtLane) => {
    const named = GAME_ART_LANE_ORDER[lane]
      .filter((provider) => ART_ADAPTERS[provider] !== undefined)
      .map((provider) =>
        provider === "codex" ? "sign in to Codex" : `a ${GAME_ART_PROVIDERS[provider].label} key`,
      );
    return `Nothing can make ${lane} yet: add ${named.join(" or ")} in Settings → Art providers.`;
  };

  const route = (
    all: ServerSettings,
    request: Omit<ArtRequest, "references"> & { readonly references: number },
  ) =>
    Effect.gen(function* () {
      const choice = all.gameArtLanes[request.lane] ?? "auto";
      if (choice !== "auto") {
        const adapter = ART_ADAPTERS[choice];
        const label = GAME_ART_PROVIDERS[choice].label;
        if (adapter === undefined || !GAME_ART_PROVIDERS[choice].lanes.includes(request.lane))
          return yield* opError(
            "art-generate",
            `Settings → Art providers sends ${request.lane} to ${label}, which cannot make it yet; the person chooses another there.`,
            "setup-missing",
          );
        const refusal = adapter.refuse?.(request) ?? null;
        if (refusal !== null) return yield* opError("art-generate", refusal);
        const status = yield* quickReady(all, choice);
        if (!status.ready)
          return yield* opError(
            "art-generate",
            `Settings → Art providers sends ${request.lane} to ${label}: ${status.message}`,
            "setup-missing",
          );
        return adapter;
      }
      let refused: string | null = null;
      for (const provider of GAME_ART_LANE_ORDER[request.lane]) {
        const adapter = ART_ADAPTERS[provider];
        if (adapter === undefined || !(yield* quickReady(all, provider)).ready) continue;
        const refusal = adapter.refuse?.(request) ?? null;
        if (refusal !== null) {
          refused ??= refusal;
          continue;
        }
        return adapter;
      }
      return yield* opError("art-generate", refused ?? setupHint(request.lane), "setup-missing");
    });

  const contextFor = (
    all: ServerSettings,
    provider: GameArtProviderId,
    id: string,
  ): Effect.Effect<ArtContext> =>
    Effect.gen(function* () {
      const codex = provider === "codex" ? yield* codexReady : null;
      return {
        key: keyOf(all, provider),
        http,
        codexImages: codex !== null && codex.ready ? codex.generateImages : null,
        scratch: NodePath.join(scratchRoot, id),
        readFile: (path) =>
          Effect.tryPromise({
            try: () => NodeFSP.readFile(path).then((buffer) => new Uint8Array(buffer)),
            catch: () =>
              new ArtProviderError({ reason: `${NodePath.basename(path)} could not be read.` }),
          }),
      };
    });

  // ── Images sent with a request ─────────────────────────────────────────
  const readReference = (root: string, path: string, what = "Reference") =>
    Effect.tryPromise({
      try: async (): Promise<ArtReference> => {
        if (NodePath.isAbsolute(path) || path.split(/[\\/]/).includes(".."))
          throw new Error(`${path}: use a path inside the game.`);
        const realRoot = await NodeFSP.realpath(root);
        const absolute = await NodeFSP.realpath(NodePath.join(root, path)).catch(() => {
          throw new Error(`${path} does not exist.`);
        });
        if (!isPathInside(absolute, realRoot))
          throw new Error(`${path} resolves outside the game.`);
        const mime = REFERENCE_MIME[NodePath.extname(absolute).toLowerCase()];
        if (mime === undefined) throw new Error(`${path} is not a PNG, JPEG or WebP image.`);
        const stat = await NodeFSP.stat(absolute);
        if (!stat.isFile()) throw new Error(`${path} is not a file.`);
        if (stat.size > MAX_REFERENCE_BYTES) throw new Error(`${path} is larger than 20 MB.`);
        return { path, absolute, mime, bytes: new Uint8Array(await NodeFSP.readFile(absolute)) };
      },
      catch: (cause) =>
        opError(
          "art-generate",
          `${what} ${cause instanceof Error ? cause.message : String(cause)}`,
          "invalid-path",
          path,
        ),
    });

  const readReferences = (root: string, paths: ReadonlyArray<string>) =>
    Effect.forEach(paths, (path) => readReference(root, path));

  /** A plain file inside the game, as its real absolute path, or the refusal saying why not. */
  const gameUpload = (
    root: string,
    path: string,
    what: string,
    ext: { readonly test: RegExp; readonly name: string },
    limit: number,
  ) =>
    Effect.tryPromise({
      try: async () => {
        if (NodePath.isAbsolute(path) || path.split(/[\\/]/).includes(".."))
          throw new Error("use a path inside the game.");
        const realRoot = await NodeFSP.realpath(root);
        const absolute = await NodeFSP.realpath(NodePath.join(root, path)).catch(() => {
          throw new Error("does not exist.");
        });
        if (!isPathInside(absolute, realRoot)) throw new Error("resolves outside the game.");
        if (!ext.test.test(absolute)) throw new Error(`is not ${ext.name}.`);
        const stat = await NodeFSP.stat(absolute);
        if (!stat.isFile()) throw new Error("is not a file.");
        if (stat.size > limit)
          throw new Error(`is larger than ${Math.round(limit / 1024 / 1024)} MB.`);
        return absolute;
      },
      catch: (cause) =>
        opError(
          "art-generate",
          `${what} ${path} ${cause instanceof Error ? cause.message : String(cause)}`,
          "invalid-path",
          path,
        ),
    });

  /**
   * What a motion is made from: the game's character (an export on the standard skeleton, so the
   * clip comes back on the joints every humanoid here shares) or the standard body, and a video.
   */
  const motionUploads = (root: string, options: GameGenerateInput["options"] & {}) =>
    Effect.gen(function* () {
      let body: string;
      if (options.character === undefined) body = yield* host.standardBody;
      else {
        body = yield* gameUpload(
          root,
          options.character,
          "The character",
          { test: /\.glb$/i, name: "a .glb file" },
          MOTION_BODY_BYTES,
        );
        const read = yield* Effect.promise(() => readGltfJson(body, 8 * 1024 * 1024));
        const doc = (read.kind === "json" ? read.json : null) as {
          readonly nodes?: ReadonlyArray<{ readonly name?: string }>;
          readonly skins?: ReadonlyArray<{ readonly joints?: ReadonlyArray<number> }>;
        } | null;
        const joints = new Set(
          (doc?.skins ?? []).flatMap((skin) =>
            (skin.joints ?? []).map((index) => doc?.nodes?.[index]?.name ?? ""),
          ),
        );
        const missing = (LIBRARY_RIG_JOINTS[STANDARD_RIG] ?? []).filter(
          (joint) => !joints.has(joint),
        );
        if (missing.length > 0)
          return yield* opError(
            "art-generate",
            `${options.character} is not a character on the standard skeleton (it lacks ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ` and ${missing.length - 6} more` : ""}), so a motion made on it would not play on the game's humanoids. Pass a character game_blender_export wrote after game_blender_character, or leave character out for the standard body. Nothing was asked of a provider or spent.`,
            "invalid-input",
            options.character,
          );
      }
      const video =
        options.video === undefined
          ? undefined
          : yield* gameUpload(
              root,
              options.video,
              "The video",
              { test: MOTION_VIDEO, name: "an .mp4, .mov or .avi video" },
              MOTION_VIDEO_BYTES,
            );
      return { body, ...(video === undefined ? {} : { video }) };
    });

  /**
   * The game mesh a character or creature is rigged from: a GLB inside the game that holds a mesh
   * and no skin. A rigged one is refused: rigging it again would replace the skeleton it has.
   */
  const riggableMesh = (root: string, path: string) =>
    Effect.gen(function* () {
      const absolute = yield* gameUpload(
        root,
        path,
        "The mesh",
        { test: /\.glb$/i, name: "a .glb file" },
        MESH_BYTES,
      );
      const read = yield* Effect.promise(() => readGltfJson(absolute, 16 * 1024 * 1024));
      const doc = (read.kind === "json" ? read.json : null) as {
        readonly skins?: ReadonlyArray<{ readonly joints?: ReadonlyArray<number> }>;
      } | null;
      const refuse = (detail: string) =>
        opError(
          "art-generate",
          `The mesh ${path} ${detail} Nothing was asked of a provider or spent.`,
          "invalid-input",
          path,
        );
      if (doc === null) return yield* refuse("does not read as a GLB.");
      if (gltfMeshSize(doc) === null) return yield* refuse("holds no mesh.");
      const joints = (doc.skins ?? []).reduce((sum, skin) => sum + (skin.joints ?? []).length, 0);
      if ((doc.skins ?? []).length > 0)
        return yield* refuse(
          `is already rigged (${joints} joints): rigging it again would replace its skeleton. Keep its rig: game_blender_assets_import brings a library model in with its own rig and clips, and a rigged file already in the game is used as it is.`,
        );
      return absolute;
    });

  /**
   * A direction's style picture: a library pack's own picture, or a game image. A pack's picture is
   * read from the library cache, which is the server's, so it never needs a path inside the game.
   */
  const readStyle = (root: string, style: string) =>
    LIBRARY_CATALOG.some((pack) => pack.id === style)
      ? host.packPicture(style).pipe(
          Effect.mapError((error) =>
            opError(
              "art-generate",
              `Style ${style}: ${error.detail ?? error.message}`,
              error.reason,
              style,
            ),
          ),
          Effect.flatMap(({ path, file }) =>
            Effect.tryPromise({
              try: async (): Promise<ArtReference> => {
                const mime = REFERENCE_MIME[NodePath.extname(file).toLowerCase()];
                if (mime === undefined)
                  throw new Error(`${path} is not a PNG, JPEG or WebP image.`);
                const stat = await NodeFSP.stat(file);
                if (stat.size > MAX_REFERENCE_BYTES)
                  throw new Error(`${path} is larger than 20 MB.`);
                return {
                  path: `library:${style}/${path}`,
                  absolute: file,
                  mime,
                  bytes: new Uint8Array(await NodeFSP.readFile(file)),
                };
              },
              catch: (cause) =>
                opError(
                  "art-generate",
                  `Style ${style}: ${cause instanceof Error ? cause.message : String(cause)}`,
                  "io",
                  style,
                ),
            }),
          ),
        )
      : /^[a-z0-9][a-z0-9-]{1,63}$/.test(style)
        ? Effect.fail(
            opError(
              "art-generate",
              `Style ${style} is no library pack; pass a pack id game_assets_search lists, or a game image path.`,
              "invalid-input",
              style,
            ),
          )
        : readReference(root, style);

  // ── Files ──────────────────────────────────────────────────────────────
  const gameIo = <A>(root: string, operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new GameOperationError({
          operation,
          path: root,
          reason: "io",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

  const licenceOf = (row: Row) => {
    const adapter = ART_ADAPTERS[row.generation.provider];
    return (
      adapter?.laneLicence?.[row.generation.lane] ?? adapter?.licence ?? "Unknown provider terms."
    );
  };
  const recordFile = (row: Row) => {
    const generation = row.generation;
    return encodeJson({
      id: generation.id,
      lane: generation.lane,
      provider: generation.provider,
      providerLabel: GAME_ART_PROVIDERS[generation.provider].label,
      prompt: generation.prompt,
      references: generation.references,
      // The pipeline reads the body plan from here: a creature's sidecar names its own rig by it.
      options: row.meta.options,
      files: generation.files,
      candidates: row.meta.candidateFiles,
      ...(row.meta.labels === undefined
        ? {}
        : {
            directions: row.meta.labels.map((label, index) => ({
              label,
              style: row.meta.styles?.[index] ?? null,
            })),
          }),
      chosen: generation.chosen,
      chosenBy: generation.chosenBy,
      ai: true,
      costUsd: generation.costUsd,
      costEstimated: row.meta.costEstimated,
      licence: licenceOf(row),
      createdAt: generation.createdAt,
    });
  };
  const writeRecordFile = (row: Row) =>
    gameIo(row.root, "art-record", () =>
      writeGameFile(
        row.root,
        `${row.meta.folder}/${row.generation.name}.generation.json`,
        new TextEncoder().encode(`${recordFile(row)}\n`),
      ),
    );

  const writeFiles = (row: Row, candidates: ReadonlyArray<ReadonlyArray<ArtFile>>) =>
    gameIo(row.root, "art-files", async () => {
      const named = fileNames(
        row.meta.folder,
        row.generation.name,
        candidates,
        new Set(row.meta.kept),
      );
      for (const files of named)
        for (const { path, file } of files) await writeGameFile(row.root, path, file.bytes);
      return named.map((files) => files.map(({ path, file }) => ({ path, role: file.role })));
    });

  // ── State changes (each under the record's lock) ───────────────────────
  const touch = (row: Row, generation: Partial<GameGeneration>, meta: Partial<Meta> = {}) =>
    nowIso.pipe(
      Effect.map((updatedAt): Row => ({
        ...row,
        generation: { ...row.generation, ...generation, updatedAt },
        meta: { ...row.meta, ...meta },
      })),
    );

  /** Keeps candidate `index`, deletes the others' files, and the generation is done. */
  const chooseUnlocked = (row: Row, index: number, by: "person" | "autopilot" | "only") =>
    Effect.gen(function* () {
      const kept = row.meta.candidateFiles[index] ?? [];
      const others = row.meta.candidateFiles.flatMap((files, i) => (i === index ? [] : files));
      yield* gameIo(row.root, "art-choose", async () => {
        for (const file of others) await removeGameFile(row.root, file);
      });
      const next = yield* touch(row, {
        state: "done",
        chosen: index,
        chosenBy: by,
        files: [...row.meta.kept, ...kept],
        candidates:
          by === "only"
            ? row.generation.candidates
            : [row.generation.candidates[index]!].filter(Boolean),
      });
      yield* writeRecordFile(next);
      yield* save(next, countedOf(next.generation));
      return next;
    });

  const toChoosing = (row: Row) =>
    Effect.gen(function* () {
      const choosing = yield* touch(row, { state: "choosing" });
      yield* writeRecordFile(choosing);
      yield* save(choosing, countedOf(choosing.generation));
      return choosing;
    });

  const finish = (row: Row, step: Extract<ArtStep, { kind: "done" }>) =>
    Effect.gen(function* () {
      const edit = editOf(row.meta);
      // A transparent image or cut-out that came back opaque is neither: it fails, its cost
      // counted, rather than being passed off as one (and nothing fakes the alpha afterwards).
      if (row.meta.options.transparent === true) {
        const opaque = step.candidates
          .map((files) => files.find((file) => file.role === "asset"))
          .map((image) => (image === undefined ? null : readPng(image.bytes)))
          .find((png) => png === null || png.clear === 0);
        if (opaque !== undefined)
          return yield* fail(
            row,
            `${GAME_ART_PROVIDERS[row.generation.provider].label} answered ${
              opaque === null ? "an image that is not a PNG" : "an image with no transparent pixel"
            }, so ${edit === null ? "it has no transparent background" : "the background was not cut out"}. Nothing was written to the game${edit === null ? "" : `; ${edit} is unchanged`}.`,
            step.costUsd ?? row.generation.estimateUsd,
          );
      }
      const written = yield* writeFiles(row, step.candidates);
      const meshNote =
        typeof row.meta.options.mesh === "string"
          ? yield* meshKept(row, row.meta.options.mesh, step.candidates[0] ?? [])
          : undefined;
      // Directions mark it themselves when one of them reported no cost.
      const estimated =
        (step.costUsd === null && row.generation.estimateUsd !== null) || row.meta.costEstimated;
      const costUsd = step.costUsd ?? row.generation.estimateUsd;
      const candidateFiles = written.map((files) => files.map((file) => file.path));
      const previews = written.map((files, index) => {
        const label = row.meta.labels?.[index];
        return {
          preview:
            files.find((file) => file.role === "preview")?.path ??
            files.find((file) => /\.(png|jpe?g|webp)$/i.test(file.path))?.path ??
            files[0]!.path,
          ...(label === undefined ? {} : { label }),
        };
      });
      // An edit: the change, and the game's image as it was, which belongs to no generation and
      // so has no files here: picking it deletes only the change, and nothing ever touches it.
      const next = yield* touch(
        row,
        {
          costUsd,
          candidates:
            edit === null
              ? previews
              : [
                  { preview: previews[0]!.preview, label: CHANGED_LABEL },
                  { preview: edit, label: AS_IT_WAS_LABEL, original: true },
                ],
        },
        {
          candidateFiles: edit === null ? candidateFiles : [candidateFiles[0] ?? [], []],
          costEstimated: estimated,
          job: row.meta.job,
          ...(step.restore === undefined ? {} : { restore: step.restore }),
          ...(meshNote === undefined ? {} : { meshNote }),
        },
      );
      if (edit !== null)
        return next.meta.autopilot
          ? yield* chooseUnlocked(next, 0, "autopilot")
          : yield* toChoosing(next);
      // A direction set with refusals goes to the person even with one look left: they asked to choose.
      if (written.length === 1 && (next.generation.refused ?? []).length === 0)
        return yield* chooseUnlocked(next, 0, "only");
      if (next.meta.autopilot) return yield* chooseUnlocked(next, 0, "autopilot");
      return yield* toChoosing(next);
    });

  /**
   * The game's mesh is never rebuilt: what came back is measured against the file that was sent
   * (triangles and textures), and the done text says either that they are kept or what changed.
   */
  const meshKept = (row: Row, mesh: string, files: ReadonlyArray<ArtFile>) =>
    Effect.promise(async () => {
      const read = await readGltfJson(NodePath.join(row.root, mesh), 16 * 1024 * 1024);
      const sent = read.kind === "json" ? gltfMeshSize(read.json) : null;
      const rigged = files.find((file) => file.role === "asset" && file.ext === "glb");
      const back = rigged === undefined ? null : gltfMeshSize(glbJson(rigged.bytes));
      const label = GAME_ART_PROVIDERS[row.generation.provider].label;
      if (sent === null || back === null)
        return `${label}'s rigged file could not be compared with ${mesh}.`;
      if (back.triangles === sent.triangles && back.images >= sent.images)
        return `${label} kept ${mesh}'s ${sent.triangles} triangles and ${sent.images} ${sent.images === 1 ? "texture" : "textures"}, adding only the skeleton, its skin and the clips.`;
      return `${label}'s rigged file has ${back.triangles} triangles and ${back.images} textures where ${mesh} has ${sent.triangles} and ${sent.images}: ${label} changed the mesh. Look at it before using it, and say so to the person.`;
    });

  const fail = (row: Row, reason: string, cost: number | null | undefined) =>
    Effect.gen(function* () {
      // A failure the provider never charged for counts nothing; one after a job started may
      // have been charged for the stages before it, so it keeps its estimate unless told.
      const counted = cost ?? (row.meta.job === null ? 0 : row.generation.estimateUsd);
      const next = yield* touch(row, {
        state: "failed",
        error: reason.slice(0, 2000),
        costUsd: counted,
      });
      yield* save(next, counted);
      return next;
    });

  // ── The driver: one scoped fiber per generation still making ──────────
  const drive = (
    root: string,
    id: string,
    first: (adapter: ArtAdapter, context: ArtContext) => Effect.Effect<ArtStep, ArtProviderError>,
  ) =>
    Effect.gen(function* () {
      const initial = yield* loadOrFail(root, id, "art-drive");
      const adapter = ART_ADAPTERS[initial.generation.provider];
      if (adapter === undefined)
        return yield* locks.withLock(id, fail(initial, "This provider has no adapter.", 0));
      const context = yield* contextFor(yield* settings, initial.generation.provider, id);
      const pollOnce = (remote: ArtRemote) =>
        adapter.poll === undefined
          ? Effect.fail(
              new ArtProviderError({
                reason: `${GAME_ART_PROVIDERS[adapter.id].label} cannot be asked about a job again.`,
              }),
            )
          : adapter.poll(context, remote).pipe(
              Effect.retry({
                while: (error) => error.transient === true,
                schedule: Schedule.spaced(adapter.pollEvery),
                times: POLL_RETRIES,
              }),
            );
      const label = GAME_ART_PROVIDERS[adapter.id].label;
      const limit = LANE_DEADLINE[initial.generation.lane];
      // A look at the model may take the person days: the rig after it gets the lane's whole time.
      const deadline =
        Date.parse(initial.meta.resumedAt ?? initial.generation.createdAt) +
        Duration.toMillis(limit);
      const late = () =>
        new ArtProviderError({
          reason: `${label} took longer than ${Duration.format(limit)}; Kurambit stopped asking. It may still finish and be charged at ${label}.`,
          costUsd: initial.generation.estimateUsd,
        });
      // Sending a stage again could buy it twice, so only a rate limit (which both providers say
      // creates nothing) is retried; an unanswered start fails, and the estimate is counted.
      const advanceOnce = (remote: ArtRemote, stage: string) =>
        adapter.advance === undefined
          ? Effect.fail(new ArtProviderError({ reason: `${label} cannot start the ${stage}.` }))
          : adapter.advance(context, remote).pipe(
              Effect.retry({
                while: (error) => error.status === 429,
                schedule: Schedule.spaced(adapter.pollEvery),
                times: POLL_RETRIES,
              }),
              Effect.mapError((error) =>
                error.status !== undefined && error.status < 500
                  ? // A clean refusal created nothing; what the stages before it cost, the adapter says.
                    new ArtProviderError({
                      reason: error.reason,
                      ...(error.costUsd === undefined ? {} : { costUsd: error.costUsd }),
                    })
                  : new ArtProviderError({
                      reason: `${error.reason} ${label} may have started the ${stage} anyway, so it is not asked again.`,
                    }),
              ),
            );
      let step = yield* first(adapter, context).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(Math.max(0, deadline - (yield* Clock.currentTimeMillis))),
          orElse: () => Effect.fail(late()),
        }),
      );
      while (step.kind === "making") {
        const making = step;
        const live = yield* locks.withLock(
          id,
          Effect.gen(function* () {
            const row = yield* loadOrFail(root, id, "art-drive");
            if (row.generation.state !== "making") return null;
            const kept =
              making.files === undefined || making.files.length === 0
                ? []
                : (yield* writeFiles(row, [making.files])).flat().map((file) => file.path);
            if (kept.length === 0 && encodeJson(row.meta.job) === encodeJson(making.remote))
              return row;
            const next = yield* touch(
              row,
              {},
              {
                job: making.remote,
                kept: [...row.meta.kept, ...kept],
                ...(making.spent === undefined ? {} : { spent: making.spent }),
              },
            );
            yield* save(next, countedOf(next.generation));
            return next;
          }),
        );
        if (live === null) return;
        // The intent is saved above before the stage is sent: a restart finds it and stops.
        const stage = pendingStage(making.remote);
        // The person looks at the model before the rig is bought: the row waits as choosing,
        // with the rig still pending in its job, and this fiber ends.
        if (stage === "rig" && live.meta.review === true && (yield* awaitLook(live, making)))
          return;
        if (stage !== null) {
          step = yield* advanceOnce(making.remote, stage);
          continue;
        }
        if ((yield* Clock.currentTimeMillis) + Duration.toMillis(adapter.pollEvery) > deadline)
          return yield* late();
        yield* Effect.sleep(adapter.pollEvery);
        step = yield* pollOnce(making.remote);
      }
      const done = step;
      yield* locks.withLock(
        id,
        Effect.gen(function* () {
          const row = yield* loadOrFail(root, id, "art-drive");
          if (row.generation.state === "making") yield* finish(row, done);
        }),
      );
      if (initial.generation.lane === "motion") yield* addMotionStrip(root, id);
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        const failure = Cause.findErrorOption(cause);
        const reason =
          Option.isSome(failure) && failure.value instanceof ArtProviderError
            ? failure.value.reason
            : Option.isSome(failure) && Schema.is(GameOperationError)(failure.value)
              ? failure.value.message
              : "Kurambit failed while making it; nothing more will be asked of the provider.";
        const cost =
          Option.isSome(failure) && failure.value instanceof ArtProviderError
            ? failure.value.costUsd
            : undefined;
        return locks
          .withLock(
            id,
            load(root, id).pipe(
              Effect.flatMap((row) =>
                row === null || row.generation.state !== "making"
                  ? Effect.void
                  : fail(row, reason, cost),
              ),
            ),
          )
          .pipe(
            Effect.tap(() =>
              Option.isSome(failure)
                ? Effect.void
                : Effect.logWarning("art generation failed", { id, cause }),
            ),
            Effect.ignore,
          );
      }),
      Effect.ensuring(
        Effect.promise(() =>
          NodeFSP.rm(NodePath.join(scratchRoot, id), { recursive: true, force: true }).catch(
            () => undefined,
          ),
        ),
      ),
    );

  /**
   * A character's or creature's model is in: render it (best effort) and wait as choosing, with
   * one candidate the person picks to have it rigged. The day keeps the whole estimate reserved,
   * so "Rig this" never needs a second admission; the generation shows what the model cost, which
   * is what a cancel counts. False when there is no model file to show: the chain goes on.
   */
  const awaitLook = (row: Row, making: Extract<ArtStep, { kind: "making" }>) =>
    Effect.gen(function* () {
      const model = row.meta.kept.find((file) => /\.model\.(glb|gltf|fbx)$/i.test(file));
      if (model === undefined) return false;
      const out = `${row.meta.folder}/${row.generation.name}.model.png`;
      const render = (yield* Ref.get(renderers))?.modelViews ?? null;
      const rendered =
        render === null
          ? false
          : yield* render(row.root, model, out).pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logWarning("model views not rendered", {
                  id: row.generation.id,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            );
      return yield* locks.withLock(
        row.generation.id,
        Effect.gen(function* () {
          const now = yield* loadOrFail(row.root, row.generation.id, "art-drive");
          if (now.generation.state !== "making") return true;
          const kept = rendered ? [...now.meta.kept, out] : now.meta.kept;
          const next = yield* touch(
            now,
            {
              state: "choosing",
              candidates: [{ preview: rendered ? out : model, label: RIG_THIS_LABEL }],
              costUsd: making.spent?.usd ?? null,
            },
            { kept, candidateFiles: [kept], costEstimated: making.spent?.estimated ?? false },
          );
          yield* writeRecordFile(next);
          yield* save(next, next.generation.estimateUsd);
          return true;
        }),
      );
    });

  /**
   * A landed motion's review strip, rendered on the body its GLB holds and shown on its card in
   * place of a model chip. Best effort: without it the card shows the clip's files.
   */
  const addMotionStrip = (root: string, id: string) =>
    Effect.gen(function* () {
      const render = (yield* Ref.get(renderers))?.motionStrip ?? null;
      const row = yield* loadOrFail(root, id, "art-strip");
      if (render === null || row.generation.state !== "done") return;
      const clips = row.generation.files
        .filter((file) => /\.glb$/i.test(file))
        .map((path) => ({ path, label: motionClipName(row.generation.name, path) }));
      // A locomotion set shows its forward walk and run; one clip shows itself.
      const forward = clips.filter((clip) => /^(Walk|Run)_Fwd_Loop$/.test(clip.label));
      const shown = (forward.length > 0 ? forward : clips).slice(0, 2);
      if (shown.length === 0) return;
      const out = `${row.meta.folder}/${row.generation.name}.strip.png`;
      yield* render(root, shown, out);
      yield* locks.withLock(
        id,
        Effect.gen(function* () {
          const now = yield* loadOrFail(root, id, "art-strip");
          if (now.generation.state !== "done" || now.generation.files.includes(out)) return;
          const next = yield* touch(now, {
            files: [...now.generation.files, out],
            candidates: [{ preview: out }],
          });
          yield* writeRecordFile(next);
          yield* save(next, countedOf(next.generation));
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("motion strip not rendered", { id, cause })),
    );

  const startDriver = (
    root: string,
    id: string,
    first: (adapter: ArtAdapter, context: ArtContext) => Effect.Effect<ArtStep, ArtProviderError>,
  ) =>
    FiberMap.run(fibers, id, drive(root, id, first), { onlyIfMissing: true }).pipe(Effect.asVoid);

  // ── generate ───────────────────────────────────────────────────────────
  const describe = (row: Row, spent: number | null, limit: number | null): string => {
    const g = row.generation;
    const edit = editOf(row.meta);
    const label = GAME_ART_PROVIDERS[g.provider].label;
    const where = row.meta.folder;
    switch (g.state) {
      case "making":
        return `${
          typeof row.meta.options.mesh === "string"
            ? `Rigging ${row.meta.options.mesh} as ${g.lane} "${g.name}"`
            : `Making ${edit === null ? `${g.lane} "${g.name}"` : `a change to ${edit}${row.meta.options.transparent === true ? " (cut out)" : ""}`}`
        } with ${label}${
          g.estimateUsd === null
            ? g.provider === "codex"
              ? " on the ChatGPT plan's Codex limits (no dollar cost)"
              : ""
            : `, estimated ${usd(g.estimateUsd)}`
        }${
          // `spent` holds this generation's estimate too: the limit reserves it before it is spent.
          spent !== null && limit !== null
            ? ` (${usd(spent)} of the ${usd(limit)} daily limit used today${g.estimateUsd === null ? "" : ", counting this estimate"})`
            : ""
        }. Files land in ${where}/.${lookText(row)} Wait with game_generate_wait id ${g.id}.`;
      case "choosing":
        if (g.filesUndone === true)
          return `The candidates of "${g.name}" are no longer in the game: ${UNDONE}`;
        if (edit !== null)
          return `The change to ${edit} is ready (${g.candidates[0]?.preview ?? ""}); the person picks "${CHANGED_LABEL}" or "${AS_IT_WAS_LABEL}" in the chat. Until then the game keeps ${edit}. Cost ${costText(row)}.`;
        if (row.meta.review === true)
          return `The model of "${g.name}" is ready (${g.candidates[0]?.preview ?? ""}: front, side and back, textured and in clay). The person looks at it and picks "${RIG_THIS_LABEL}" or Cancel in the chat; nothing more is asked of ${label} until then. Cost so far ${costText(row)}${
            g.estimateUsd !== null && g.costUsd !== null && g.estimateUsd > g.costUsd
              ? `; the rig and its clips add about ${usd(roundUsd(g.estimateUsd - g.costUsd))}`
              : ""
          }. After "${RIG_THIS_LABEL}", game_generate_wait id ${g.id} waits for the rig.`;
        return `${g.candidates.length} ${g.candidates.length === 1 ? "candidate" : "candidates"} of "${g.name}" ${g.candidates.length === 1 ? "is" : "are"} ready (${g.candidates
          .map((candidate) => candidate.preview)
          .join(", ")})${refusedText(g)}; the person picks one in the chat. Cost ${costText(row)}.`;
      case "done":
        if (g.filesUndone === true)
          return `"${g.name}" was made (${g.files.join(", ")}), but its files are no longer in the game: ${UNDONE}`;
        if (edit !== null) return editDone(row, edit);
        return `"${g.name}" is in the game: ${g.files.join(", ")}${
          row.meta.resumedAt !== undefined
            ? " (the person looked at the model and had it rigged)"
            : RIGGED_LANES.has(g.lane) &&
                row.meta.autopilot &&
                typeof row.meta.options.mesh !== "string"
              ? " (Keep going's autopilot had it rigged without stopping for the person's look at the model)"
              : ""
        }${
          g.chosenBy === "autopilot"
            ? " (Keep going took the first candidate)"
            : g.chosenBy === "person"
              ? ` (the person picked candidate ${(g.chosen ?? 0) + 1})`
              : ""
        }. Cost ${costText(row)}. Recorded in ${where}/${g.name}.generation.json with its source, AI flag and licence.${row.meta.meshNote === undefined ? "" : ` ${row.meta.meshNote}`}${nextStep(g)}`;
      case "failed":
        return `"${g.name}" failed: ${g.error ?? "no reason given"}${g.costUsd ? ` Counted ${usd(g.costUsd)} against today (the provider may have charged for work it started).` : ""}`;
      case "cancelled":
        return `"${g.name}" was cancelled.${g.costUsd ? ` ${usd(g.costUsd)} counted against today for work already started.` : ""}`;
    }
  };
  /**
   * A settled edit: the person kept the change (the agent wires it in where the original was
   * used) or the image as it was (nothing to do). The style anchor's palette is read from it.
   */
  const editDone = (row: Row, edit: string) => {
    const g = row.generation;
    const cost = `Cost ${costText(row)}.`;
    const changed = g.files.find((file) => /\.(png|jpe?g|webp)$/i.test(file));
    if (g.chosen !== 0 || changed === undefined)
      return `The person kept ${edit} as it was; the change was deleted, and the game needs nothing more. ${cost}`;
    return `The change to ${edit} is in the game: ${changed}${
      g.chosenBy === "autopilot"
        ? ` (Keep going took "${CHANGED_LABEL}")`
        : ` (the person picked "${CHANGED_LABEL}")`
    }. ${edit} is unchanged. ${cost} Recorded in ${row.meta.folder}/${g.name}.generation.json. Next: point the game at ${changed} wherever it uses ${edit} (or copy it over ${edit} when the game reads that path), and if ${edit} is STYLE.json's anchor, read the palette again from the new file with kurambit.palette_of and update STYLE.json.`;
  };
  /** What a character or creature does between its model and its rig, while it is making. */
  const lookText = (row: Row) => {
    const g = row.generation;
    if (!RIGGED_LANES.has(g.lane) || typeof row.meta.options.mesh === "string") return "";
    if (row.meta.review === true)
      return ` It stops after the model: the person looks at it and picks "${RIG_THIS_LABEL}" (or Cancel) in the chat before the rig is bought.`;
    if (row.meta.autopilot && row.meta.resumedAt === undefined)
      return " Keep going's autopilot has it rigged without stopping for the person's look at the model.";
    return "";
  };
  /** Where a delivered file goes next, so the agent reads the call instead of guessing it. */
  const nextStep = (g: GameGeneration) => {
    if (g.lane === "motion") {
      const clips = g.files.filter((file) => /\.glb$/i.test(file));
      const names = clips.map((file) => motionClipName(g.name, file));
      return ` Clip${clips.length === 1 ? "" : "s"} ${names.join(", ")}, on the standard skeleton: every humanoid in the game can play ${clips.length === 1 ? "it" : "them"}. Next: game_blender_character with clips that list ${clips.length === 1 ? "this file" : "the files the game needs"} beside the clips the character keeps (replace: true rebuilds one already made): ${clips.map((file) => JSON.stringify(file)).join(", ")}.`;
    }
    // The model the person looked at before its rig is not what the game takes.
    const model =
      g.files.find((file) => /\.(glb|gltf|fbx)$/i.test(file) && !/\.model\.[a-z]+$/i.test(file)) ??
      g.files.find((file) => /\.(glb|gltf|fbx)$/i.test(file));
    if (model === undefined)
      return " Next: load it in the game from where it is (game_import first where the engine has an import step).";
    return g.lane === "character"
      ? ` Next: game_blender_character with body {game: "${model}"}.`
      : ` Next: game_blender_assets_import with source "generated" and path "${model}".`;
  };
  const refusedText = (g: GameGeneration) =>
    (g.refused ?? []).length === 0
      ? ""
      : `; ${g.refused!.map((refusal) => `"${refusal.label}" was refused by the provider (${refusal.reason})`).join("; ")}`;
  const costText = (row: Row) =>
    row.generation.costUsd === null
      ? row.generation.provider === "codex"
        ? "no dollars (Codex plan usage)"
        : "unknown"
      : `${usd(row.generation.costUsd)}${row.meta.costEstimated ? " (estimated: the provider did not report it)" : ""}`;

  /**
   * Directions: one request per look, each to completion. Codex runs them one at a time (one
   * plan, one session at a time); the others together. Each settles on its own: every look that
   * came back is a candidate, a refused one is named with the provider's reason, and only when
   * none came back does the generation fail. What is counted: each look's reported cost (its
   * estimate when the provider said none), and what a refusal reported it cost.
   */
  const directionsTogether = (
    adapter: ArtAdapter,
    context: ArtContext,
    requests: ReadonlyArray<ArtRequest>,
    estimates: ReadonlyArray<number | null>,
    labels: ReadonlyArray<string>,
  ): Effect.Effect<DirectionsSettled, ArtProviderError> =>
    Effect.forEach(
      requests,
      (request) =>
        Effect.gen(function* () {
          let step = yield* adapter.start(context, request);
          while (step.kind === "making") {
            if (adapter.poll === undefined)
              return yield* new ArtProviderError({
                reason: `${GAME_ART_PROVIDERS[adapter.id].label} cannot be asked about a job again.`,
              });
            yield* Effect.sleep(adapter.pollEvery);
            step = yield* adapter.poll(context, step.remote);
          }
          return step;
        }).pipe(Effect.result),
      { concurrency: adapter.id === "codex" ? 1 : "unbounded" },
    ).pipe(Effect.flatMap((results) => settleDirections(results, estimates, labels)));

  /** Before the files land: which looks came back (their labels), which were refused, and why. */
  const recordDirections = (root: string, id: string, settled: DirectionsSettled) =>
    locks.withLock(
      id,
      Effect.gen(function* () {
        const row = yield* loadOrFail(root, id, "art-drive");
        if (row.generation.state !== "making") return;
        const next = yield* touch(
          row,
          settled.refused.length === 0 ? {} : { refused: settled.refused },
          { labels: settled.labels, costEstimated: settled.estimated },
        );
        yield* save(next, countedOf(next.generation));
      }),
    );

  const generate: GameArt["Service"]["generate"] = (root, threadId, input, characterRoute) =>
    Effect.gen(function* () {
      // Before any provider is asked: the person's route decides who makes characters.
      if (input.lane === "character" || input.lane === "creature") {
        const refused = lockCharacterRouteRefusal("generated-body", characterRoute);
        if (refused !== null)
          return yield* opError(
            "art-generate",
            `Nothing was asked of a provider or spent. ${refused}`,
          );
      }
      const all = yield* settings;
      const directions = input.directions ?? [];
      const options = input.options ?? {};
      if (directions.length > 0 && !MULTI_CANDIDATE_LANES.includes(input.lane))
        return yield* opError(
          "art-generate",
          input.lane === "sfx" || input.lane === "music" || input.lane === "voice"
            ? `Directions are for images and textures; ask ${input.lane} one at a time.`
            : `Directions are for images: make 2-4 concept images in distinct directions in the image lane, let the person pick one, then make the ${input.lane} from it with the picked image as a reference.`,
        );
      if (options.edit !== undefined) {
        if (!MULTI_CANDIDATE_LANES.includes(input.lane))
          return yield* opError(
            "art-generate",
            `edit changes an image or a texture, not ${input.lane}; make the ${input.lane} again from a picture instead.`,
          );
        if (directions.length > 0)
          return yield* opError(
            "art-generate",
            "An edit is one change: drop directions, and the person picks between the change and the image as it was.",
          );
      }
      if (options.mesh !== undefined) {
        if (!RIGGED_LANES.has(input.lane))
          return yield* opError(
            "art-generate",
            `mesh is a game model rigged as a character or a creature, not made into a ${input.lane}. Nothing was asked of a provider or spent.`,
          );
        if ((input.references ?? []).length > 0)
          return yield* opError(
            "art-generate",
            "The mesh is the model: leave references out. Nothing was asked of a provider or spent.",
          );
        if (options.lowPoly === true || options.parts === true)
          return yield* opError(
            "art-generate",
            "The game's mesh is rigged as it is, never rebuilt: lowPoly and parts make a new model. Leave them out, or make a new model without mesh. Nothing was asked of a provider or spent.",
          );
      }
      if (options.parts === true && input.lane !== "model")
        return yield* opError(
          "art-generate",
          `parts are for a model with moving parts (a door, a turret, a wheel); a ${input.lane} moves by its rig. Nothing was asked of a provider or spent.`,
        );
      if (options.lowPoly === true && input.lane !== "model" && !RIGGED_LANES.has(input.lane))
        return yield* opError(
          "art-generate",
          `lowPoly is topology for characters, creatures and models, not ${input.lane}.`,
        );
      const base = { lane: input.lane, prompt: input.prompt, candidates: 1, options };
      const adapter = yield* route(all, {
        ...base,
        references: (input.references ?? []).length,
      });
      if (input.lane === "motion" && (input.references ?? []).length > 0)
        return yield* opError(
          "art-generate",
          "A motion is made from words or a video, not from pictures: leave references out (options.character names the body it is made on).",
        );
      // Read before anything is asked: an image that is not there is refused with nothing spent.
      const edited =
        options.edit === undefined
          ? null
          : yield* readReference(root, options.edit, "The image to change:");
      const editedSize =
        edited !== null && edited.mime === "image/png" ? readPng(edited.bytes) : null;
      const references = yield* readReferences(root, input.references ?? []);
      const uploads =
        input.lane === "motion"
          ? yield* motionUploads(root, options)
          : options.mesh !== undefined
            ? { mesh: yield* riggableMesh(root, options.mesh) }
            : undefined;
      const styles = yield* Effect.forEach(directions, (direction) =>
        direction.style === undefined ? Effect.succeed(null) : readStyle(root, direction.style),
      );
      // A character or creature made while the person directs stops after its paid model, so they
      // look at it before the rig is bought; Keep going's autopilot goes on without stopping.
      const madeBody = RIGGED_LANES.has(input.lane) && options.mesh === undefined;
      const autopilot =
        (directions.length > 1 || edited !== null || madeBody) &&
        (yield* host.keepGoingStep(threadId));
      const review = madeBody && !autopilot;
      // Each direction is its own request for one image: the person picks between looks,
      // never between samples of one prompt (which come back as near-copies).
      const requests: ReadonlyArray<ArtRequest> =
        directions.length === 0
          ? [
              edited === null
                ? {
                    ...base,
                    references,
                    ...(uploads === undefined ? {} : { uploads }),
                    ...(review ? { review: true } : {}),
                  }
                : {
                    ...base,
                    prompt: editPrompt(
                      input.prompt,
                      options.transparent === true,
                      references.length > 0,
                    ),
                    references: [edited, ...references],
                  },
            ]
          : directions.map((direction, index) => {
              const style = styles[index] ?? null;
              // The look leads: image models weight a prompt's start, and a style tacked on after a
              // long subject comes back in the model's own default rendering. Words alone still
              // drift back to that polish; a picture of the look, sent first, holds it.
              const prompt =
                style === null
                  ? `Art style (follow it strictly, above everything else): ${direction.prompt}\n\n${input.prompt}\n\nRender every part of the image in that art style, not in a polished 3D movie style.`
                  : `Image 1 is the art style to copy exactly: ${direction.prompt}. Copy its rendering, shapes, materials, palette, lighting and level of detail; do not copy what it shows, nor any text or logo on it.${references.length === 0 ? "" : " The other images show what to draw, not how."}\n\n${input.prompt}\n\nRender every part of the image in the art style of image 1, not in a polished 3D movie style.`;
              return {
                ...base,
                prompt,
                references: style === null ? references : [style, ...references],
              };
            });
      const estimates = requests.map((request) =>
        adapter.estimate({
          ...request,
          references: request.references.length,
          ...(editedSize === null ? {} : { edited: editedSize }),
        }),
      );
      const estimate = estimates.some((value) => value === null)
        ? null
        : roundUsd(estimates.reduce<number>((sum, value) => sum + (value ?? 0), 0));
      const id = NodeCrypto.randomUUID();
      const limit = all.gameArtDailyLimitUsd;
      const admitted = yield* spendGate.withPermits(1)(
        Effect.gen(function* () {
          const spent = yield* spentToday;
          if (estimate !== null && estimate > 0 && spent + estimate > limit)
            return yield* opError(
              "art-generate",
              `Over the daily art limit: ${usd(spent)} spent today, and this would cost about ${usd(estimate)}, past the ${usd(limit)} limit. The person can raise it in Settings → Art providers.`,
              "setup-missing",
            );
          const live = yield* sql<{ readonly name: string }>`
            SELECT json_extract(payload_json, '$.name') AS name FROM game_art_generations
            WHERE root = ${root} AND json_extract(payload_json, '$.lane') = ${input.lane}
              AND state IN ('making', 'choosing')
          `.pipe(Effect.orElseSucceed(() => []));
          const name = yield* gameIo(root, "art-generate", () =>
            freeName(root, input.lane, input.name, new Set(live.map((row) => row.name))),
          );
          const now = yield* nowIso;
          const generation: GameGeneration = {
            id,
            threadId,
            lane: input.lane,
            provider: adapter.id,
            name,
            prompt: input.prompt,
            references: references.map((reference) => reference.path),
            state: "making",
            candidates: [],
            chosen: null,
            chosenBy: null,
            files: [],
            estimateUsd: estimate,
            costUsd: null,
            error: null,
            createdAt: now,
            updatedAt: now,
          };
          const meta: Meta = {
            job: null,
            folder: `${GENERATED_DIR}/${input.lane}/${name}`,
            autopilot,
            kept: [],
            costEstimated: false,
            candidateFiles: [],
            options,
            ...(review ? { review: true } : {}),
            ...(directions.length === 0
              ? {}
              : {
                  labels: directions.map((direction) => direction.label),
                  ...(styles.every((style) => style === null)
                    ? {}
                    : { styles: styles.map((style) => style?.path ?? null) }),
                }),
          };
          yield* sql`
            INSERT INTO game_art_generations
              (id, root, thread_id, state, cost_usd, payload_json, remote_json, created_at, updated_at)
            VALUES (${id}, ${root}, ${threadId}, 'making', ${estimate}, ${encodeGeneration(generation)},
              ${encodeMeta(meta)}, ${now}, ${now})
          `.pipe(
            Effect.mapError(
              (cause) =>
                new GameOperationError({
                  operation: "art-generate",
                  path: root,
                  reason: "io",
                  cause,
                }),
            ),
          );
          return {
            row: { generation, meta, root } satisfies Row,
            spent: roundUsd(spent + (estimate ?? 0)),
          };
        }),
      );
      yield* operations.changed(root, GAME_ART_EVENT, `Making ${admitted.row.generation.name}.`);
      const labels = directions.map((direction) => direction.label);
      yield* startDriver(root, id, (adapter, context) =>
        Effect.promise(() => NodeFSP.mkdir(context.scratch, { recursive: true })).pipe(
          Effect.andThen(
            requests.length === 1
              ? adapter.start(context, requests[0]!)
              : directionsTogether(adapter, context, requests, estimates, labels).pipe(
                  Effect.flatMap((settled) =>
                    recordDirections(root, id, settled).pipe(
                      Effect.mapError(
                        (error) =>
                          new ArtProviderError({
                            reason: error.message,
                            costUsd: settled.step.costUsd,
                          }),
                      ),
                      Effect.as(settled.step),
                    ),
                  ),
                ),
          ),
        ),
      );
      return {
        text: describe(admitted.row, admitted.spent, limit),
        generation: admitted.row.generation,
      };
    });

  /**
   * A checkpoint restore (undo) puts art/ back as a build had it, so files a generation wrote
   * after that build are removed while its row still lists them. Checked when read, so a later
   * restore that brings them back reads as it is.
   */
  const withUndone = (row: Row): Effect.Effect<Row> => {
    const files =
      row.generation.state === "done"
        ? row.generation.files
        : row.generation.state === "choosing"
          ? row.meta.candidateFiles.flat()
          : [];
    if (files.length === 0) return Effect.succeed(row);
    return Effect.promise(async () => {
      for (const file of files)
        if (
          await NodeFSP.lstat(NodePath.join(row.root, file)).then(
            () => true,
            () => false,
          )
        )
          return false;
      return true;
    }).pipe(
      Effect.map((undone) =>
        undone ? { ...row, generation: { ...row.generation, filesUndone: true } } : row,
      ),
    );
  };

  const delivered: GameArt["Service"]["delivered"] = (root, id, path) =>
    load(root, id).pipe(
      Effect.map((row) =>
        row === null || row.generation.state !== "done" || !row.generation.files.includes(path)
          ? null
          : {
              generation: row.generation,
              licence: licenceOf(row),
              body: typeof row.meta.options.body === "string" ? row.meta.options.body : null,
              restore: row.meta.restore ?? null,
            },
      ),
    );

  // ── wait, list, choose, cancel ─────────────────────────────────────────
  const wait: GameArt["Service"]["wait"] = (root, input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const deadline =
          (yield* Clock.currentTimeMillis) + (input.seconds ?? DEFAULT_WAIT_SECONDS) * 1000;
        while (true) {
          const row = yield* loadOrFail(root, input.id, "art-wait");
          const left = deadline - (yield* Clock.currentTimeMillis);
          if (row.generation.state !== "making" || left <= 0) {
            const read = yield* withUndone(row);
            return { text: describe(read, null, null), generation: read.generation };
          }
          // Every change wakes the wait; one for another generation is read and ignored.
          yield* PubSub.take(subscription).pipe(Effect.timeoutOption(Duration.millis(left)));
        }
      }),
    );

  const list: GameArt["Service"]["list"] = (root) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly root: string;
        readonly payload_json: string;
        readonly remote_json: string;
      }>`
        SELECT root, payload_json, remote_json FROM game_art_generations
        WHERE root = ${root} AND (
          state IN ('making', 'choosing') OR id IN (
            SELECT id FROM game_art_generations WHERE root = ${root}
            ORDER BY created_at DESC LIMIT ${LIST_LIMIT}
          )
        )
        ORDER BY created_at DESC
      `.pipe(
        Effect.mapError(
          (cause) =>
            new GameOperationError({ operation: "art-list", path: root, reason: "io", cause }),
        ),
      );
      const all = yield* settings;
      const decoded = rows.flatMap((row) => {
        const read = toRow(row);
        return read === null ? [] : [read];
      });
      return {
        generations: yield* Effect.forEach(decoded, (row) =>
          withUndone(row).pipe(Effect.map((read) => read.generation)),
        ),
        spentTodayUsd: yield* spentToday,
        dailyLimitUsd: all.gameArtDailyLimitUsd,
      };
    });

  const choose: GameArt["Service"]["choose"] = (root, id, candidate) =>
    Effect.gen(function* () {
      const caller = yield* GameCaller;
      if (caller.kind === "agent")
        return yield* opError("art-choose", "Only the person picks a candidate, in the chat.");
      return yield* locks.withLock(
        id,
        Effect.gen(function* () {
          const row = yield* loadOrFail(root, id, "art-choose");
          if (row.generation.state !== "choosing")
            return yield* opError(
              "art-choose",
              `"${row.generation.name}" is ${row.generation.state}; there is nothing to pick.`,
            );
          if (
            !Number.isInteger(candidate) ||
            candidate < 0 ||
            candidate >= row.meta.candidateFiles.length
          )
            return yield* opError("art-choose", `There is no candidate ${candidate + 1}.`);
          if ((yield* withUndone(row)).generation.filesUndone === true)
            return yield* opError(
              "art-choose",
              `The candidates of "${row.generation.name}" are no longer in the game: ${UNDONE}`,
            );
          if (row.meta.review === true) return { generation: yield* rigAfterLook(row) };
          return { generation: (yield* chooseUnlocked(row, candidate, "person")).generation };
        }),
      );
    });

  /**
   * "Rig this": the chain goes on from its saved job, whose rig is still pending. The row is
   * making again before the driver starts, and the driver sends the rig once, as after any stage.
   * The model's files stay and join what the rig delivers.
   */
  const rigAfterLook = (row: Row) =>
    Effect.gen(function* () {
      const job = row.meta.job;
      if (job === null || pendingStage(job) === null)
        return yield* opError("art-choose", `"${row.generation.name}" has no rig waiting.`);
      const next = yield* touch(
        row,
        { state: "making", candidates: [], costUsd: null },
        {
          review: false,
          candidateFiles: [],
          costEstimated: false,
          resumedAt: yield* nowIso,
        },
      );
      yield* save(next, next.generation.estimateUsd);
      yield* startDriver(row.root, row.generation.id, () =>
        Effect.succeed({ kind: "making", remote: job } satisfies ArtStep),
      );
      return next.generation;
    });

  const cancel: GameArt["Service"]["cancel"] = (root, id) =>
    locks.withLock(
      id,
      Effect.gen(function* () {
        const row = yield* loadOrFail(root, id, "art-cancel");
        if (row.generation.state === "making") {
          yield* FiberMap.remove(fibers, id);
          const adapter = ART_ADAPTERS[row.generation.provider];
          if (row.meta.job !== null && adapter?.cancel !== undefined)
            yield* adapter.cancel(yield* contextFor(yield* settings, adapter.id, id), row.meta.job);
          // Work the provider was already asked for is still counted: it may be charged.
          const next = yield* touch(row, {
            state: "cancelled",
            costUsd: row.generation.estimateUsd,
          });
          yield* save(next, row.generation.estimateUsd);
          return { generation: next.generation };
        }
        if (row.generation.state === "choosing") {
          yield* gameIo(root, "art-cancel", async () => {
            for (const file of row.meta.candidateFiles.flat()) await removeGameFile(root, file);
            await removeGameFile(root, `${row.meta.folder}/${row.generation.name}.generation.json`);
          });
          const next = yield* touch(row, { state: "cancelled", candidates: [] });
          yield* save(next, countedOf(row.generation));
          return { generation: next.generation };
        }
        return yield* opError(
          "art-cancel",
          `"${row.generation.name}" is already ${row.generation.state}.`,
        );
      }),
    );

  // ── providers ──────────────────────────────────────────────────────────
  const checkedStatus = (all: ServerSettings, provider: GameArtProviderId) =>
    Effect.gen(function* () {
      const quick = yield* savedReady(all, provider);
      const adapter = ART_ADAPTERS[provider];
      const key = keyOf(all, provider);
      if (!quick.ready || key === null || adapter === undefined)
        return { provider, ...quick } satisfies GameArtProviderStatus;
      if (adapter.checkKey === undefined)
        return {
          provider,
          ready: true,
          message: "Key saved, not checked.",
        } satisfies GameArtProviderStatus;
      const now = yield* Clock.currentTimeMillis;
      const cached = keyChecks.get(provider);
      if (cached !== undefined && cached.key === key && now - cached.at < KEY_CHECK_TTL_MS)
        return cached.status;
      const context = yield* contextFor(all, provider, "key-check");
      const { status, refused } = yield* adapter.checkKey(context).pipe(
        Effect.timeout(Duration.seconds(8)),
        Effect.match({
          onSuccess: (answer) => ({
            refused: false,
            status: (answer === undefined
              ? { provider, ready: true, message: "Key works." }
              : {
                  provider,
                  ready: answer.ready,
                  message: answer.note,
                }) satisfies GameArtProviderStatus,
          }),
          onFailure: (error) =>
            error instanceof ArtProviderError && error.transient !== true
              ? {
                  refused: true,
                  status: {
                    provider,
                    ready: false,
                    message: `The key was refused: ${error.reason}`,
                  } satisfies GameArtProviderStatus,
                }
              : {
                  refused: false,
                  status: {
                    provider,
                    ready: true,
                    message: "Key saved; the provider could not be reached to check it.",
                  } satisfies GameArtProviderStatus,
                },
        }),
      );
      keyChecks.set(provider, { key, at: now, status, refused });
      return status;
    });

  const providers: GameArt["Service"]["providers"] = Effect.gen(function* () {
    const all = yield* settings;
    const ids = Object.keys(GAME_ART_PROVIDERS) as ReadonlyArray<GameArtProviderId>;
    const statuses = yield* Effect.forEach(ids, (provider) => checkedStatus(all, provider), {
      concurrency: "unbounded",
    });
    const ready = new Set(
      statuses.filter((status) => status.ready).map((status) => status.provider),
    );
    return { providers: statuses, lanes: laneMap(all, ready), spentTodayUsd: yield* spentToday };
  });

  const laneMap = (all: ServerSettings, ready: ReadonlySet<GameArtProviderId>): GameArtLanes =>
    Object.fromEntries(
      (Object.keys(GAME_ART_LANE_ORDER) as ReadonlyArray<GameArtLane>).map((lane) => {
        const choice = all.gameArtLanes[lane] ?? "auto";
        if (choice !== "auto") return [lane, ready.has(choice) ? choice : null];
        return [lane, GAME_ART_LANE_ORDER[lane].find((provider) => ready.has(provider)) ?? null];
      }),
    ) as GameArtLanes;

  const lanes: GameArt["Service"]["lanes"] = Effect.gen(function* () {
    const all = yield* settings;
    const ready = new Set<GameArtProviderId>();
    for (const provider of Object.keys(GAME_ART_PROVIDERS) as ReadonlyArray<GameArtProviderId>)
      if ((yield* quickReady(all, provider)).ready) ready.add(provider);
    return laneMap(all, ready);
  });

  // ── Recovery: every record still making resumes polling its provider ──
  const recover = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly root: string;
      readonly payload_json: string;
      readonly remote_json: string;
    }>`
      SELECT root, payload_json, remote_json FROM game_art_generations WHERE state = 'making'
    `;
    for (const raw of rows) {
      const row = toRow(raw);
      if (row === null || (yield* FiberMap.has(fibers, row.generation.id))) continue;
      const adapter = ART_ADAPTERS[row.generation.provider];
      const job = row.meta.job;
      const stage = job === null ? null : pendingStage(job);
      // A model saved for the person's look was never sent its rig (the look is what sends it):
      // the stop before the look is taken again, so a restart neither buys nor fails anything.
      if (job !== null && stage === "rig" && row.meta.review === true) {
        const spent = row.meta.spent;
        yield* startDriver(row.root, row.generation.id, () =>
          Effect.succeed({
            kind: "making",
            remote: job,
            ...(spent === undefined ? {} : { spent }),
          } satisfies ArtStep),
        );
        continue;
      }
      if (stage !== null) {
        yield* locks.withLock(
          row.generation.id,
          fail(
            row,
            `The server stopped while starting the ${stage}. ${GAME_ART_PROVIDERS[row.generation.provider].label} may have started it already, so Kurambit does not ask again; make it again if it is still wanted.`,
            row.generation.estimateUsd,
          ),
        );
        continue;
      }
      if (job === null || adapter?.poll === undefined) {
        yield* locks.withLock(
          row.generation.id,
          fail(
            row,
            "The server stopped while the provider was making it, and this provider cannot be asked about it again. Make it again if it is still wanted.",
            row.generation.estimateUsd,
          ),
        );
        continue;
      }
      yield* startDriver(row.root, row.generation.id, (adapter, context) =>
        adapter.poll === undefined
          ? Effect.fail(new ArtProviderError({ reason: "This provider cannot be asked again." }))
          : adapter.poll(context, job),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("art generations could not be recovered", { cause }),
    ),
  );
  // Before the service is handed out: a generation started after this is never mistaken for
  // one the last server left behind. Each resumed driver is its own fiber.
  yield* recover;

  return GameArt.of({
    generate,
    wait,
    list,
    choose,
    cancel,
    delivered,
    providers,
    lanes,
    renderWith: (set) => Ref.set(renderers, set),
  });
});

/** The server's host: the provider registry's Codex and the run's in-flight step. */
const layerHost = Layer.effect(
  GameArtHost,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const library = yield* GameAssetLibrary.GameAssetLibrary;
    return GameArtHost.of({
      packPicture: library.packPicture,
      standardBody: library.packFile(STANDARD_ARMATURE.pack, STANDARD_ARMATURE.file),
      codex: Effect.gen(function* () {
        const instances = yield* registry.listInstances;
        const codex = instances.filter(
          (instance) => instance.driverKind === "codex" && instance.enabled,
        );
        if (codex.length === 0)
          return {
            ready: false as const,
            message: "Codex is not set up: add it in Settings → Providers.",
          };
        let reason = "Codex is not ready.";
        for (const instance of codex) {
          const generateImages = instance.generateImages;
          const snapshot = yield* instance.snapshot.getSnapshot;
          if (generateImages === undefined) {
            reason =
              "This Codex sign-in does not offer image generation; sign in to Codex with the ChatGPT plan in Settings → Providers.";
            continue;
          }
          if (!snapshot.installed) {
            reason = "Codex is not installed: install it in Settings → Providers.";
            continue;
          }
          if (snapshot.auth.status !== "authenticated") {
            reason =
              "Codex is not signed in: sign in with the ChatGPT plan in Settings → Providers.";
            continue;
          }
          return {
            ready: true as const,
            generateImages: (input: ProviderImageGenerationInput) =>
              generateImages(input).pipe(
                Effect.mapError(
                  (error) => new ArtProviderError({ reason: error.detail ?? error.message }),
                ),
              ),
          };
        }
        return { ready: false as const, message: reason };
      }),
      keepGoingStep: (threadId) =>
        projections.getGameRunRecords(threadId, { steps: "in-flight" }).pipe(
          Effect.map((records) => {
            const run = records.gameRuns.findLast(
              (candidate) =>
                candidate.loop === "turns" &&
                candidate.status !== "ended" &&
                candidate.threadId === threadId &&
                candidate.inFlight !== null,
            );
            if (run === undefined) return false;
            const step = records.gameRunSteps.find(
              (candidate) => candidate.runId === run.id && candidate.seq === run.inFlight,
            );
            return step?.step.kind === "turn";
          }),
          // An unreadable run is no step: the person still picks.
          Effect.orElseSucceed(() => false),
        ),
    });
  }),
);

export const layerWithHost = Layer.effect(GameArt, make);
export const layer = layerWithHost.pipe(Layer.provide(layerHost));
