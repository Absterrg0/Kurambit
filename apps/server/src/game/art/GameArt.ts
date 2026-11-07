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
  type ArtStep,
  ArtProviderError,
  makeArtHttp,
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
    readonly providers: Effect.Effect<GameArtProvidersResult, GameOperationError>;
    /** The lane map alone, from saved keys and Codex's sign-in: no network, for game_status. */
    readonly lanes: Effect.Effect<GameArtLanes, GameOperationError>;
  }
>()("kurambit/game/art/GameArt") {}

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
  }
>()("kurambit/game/art/GameArt/GameArtHost") {}

const GENERATED_DIR = "art/generated";
const DEFAULT_WAIT_SECONDS = 120;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const POLL_RETRIES = 6;
const LIST_LIMIT = 50;
const KEY_CHECK_TTL_MS = 10 * 60_000;
const REFERENCE_MIME: Readonly<Record<string, ArtReference["mime"]>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const MULTI_CANDIDATE_LANES: ReadonlyArray<GameArtLane> = ["image", "texture"];

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

/** Local midnight today, as the ISO instant rows are compared with. */
const localMidnightIso = (nowMs: number): string => {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
};

/** The name's folder, numbered past every one already used (on disk or by a live generation). */
export const freeName = async (
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
export const writeGameFile = async (root: string, relative: string, bytes: Uint8Array) => {
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
  const keyChecks = new Map<
    GameArtProviderId,
    { key: string; at: number; status: GameArtProviderStatus }
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
  const quickReady = (all: ServerSettings, provider: GameArtProviderId) =>
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

  const setupHint = (lane: GameArtLane) => {
    const named = GAME_ART_LANE_ORDER[lane]
      .filter((provider) => ART_ADAPTERS[provider] !== undefined)
      .map((provider) =>
        provider === "codex" ? "sign in to Codex" : `a ${GAME_ART_PROVIDERS[provider].label} key`,
      );
    return `Nothing can make ${lane} yet: add ${named.join(" or ")} in Settings → Art providers.`;
  };

  const route = (all: ServerSettings, request: Omit<ArtRequest, "references">) =>
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

  // ── References ─────────────────────────────────────────────────────────
  const readReferences = (root: string, paths: ReadonlyArray<string>) =>
    Effect.forEach(paths, (path) =>
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
            `Reference ${cause instanceof Error ? cause.message : String(cause)}`,
            "invalid-path",
            path,
          ),
      }),
    );

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

  const recordFile = (row: Row, adapter: ArtAdapter | undefined) => {
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
      chosen: generation.chosen,
      chosenBy: generation.chosenBy,
      ai: true,
      costUsd: generation.costUsd,
      costEstimated: row.meta.costEstimated,
      licence:
        adapter?.laneLicence?.[generation.lane] ?? adapter?.licence ?? "Unknown provider terms.",
      createdAt: generation.createdAt,
    });
  };
  const writeRecordFile = (row: Row) =>
    gameIo(row.root, "art-record", () =>
      writeGameFile(
        row.root,
        `${row.meta.folder}/${row.generation.name}.generation.json`,
        new TextEncoder().encode(`${recordFile(row, ART_ADAPTERS[row.generation.provider])}\n`),
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

  const finish = (row: Row, step: Extract<ArtStep, { kind: "done" }>) =>
    Effect.gen(function* () {
      const written = yield* writeFiles(row, step.candidates);
      const estimated = step.costUsd === null && row.generation.estimateUsd !== null;
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
      const next = yield* touch(
        row,
        { costUsd, candidates: previews },
        { candidateFiles, costEstimated: estimated, job: row.meta.job },
      );
      if (written.length === 1) return yield* chooseUnlocked(next, 0, "only");
      if (next.meta.autopilot) return yield* chooseUnlocked(next, 0, "autopilot");
      const choosing = yield* touch(next, { state: "choosing" });
      yield* writeRecordFile(choosing);
      yield* save(choosing, countedOf(choosing.generation));
      return choosing;
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
      let step = yield* first(adapter, context);
      while (step.kind === "making") {
        const making = step;
        yield* locks.withLock(
          id,
          Effect.gen(function* () {
            const row = yield* loadOrFail(root, id, "art-drive");
            if (row.generation.state !== "making") return;
            const kept =
              making.files === undefined || making.files.length === 0
                ? []
                : (yield* writeFiles(row, [making.files])).flat().map((file) => file.path);
            if (kept.length === 0 && encodeJson(row.meta.job) === encodeJson(making.remote)) return;
            const next = yield* touch(
              row,
              {},
              { job: making.remote, kept: [...row.meta.kept, ...kept] },
            );
            yield* save(next, countedOf(next.generation));
          }),
        );
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

  const startDriver = (
    root: string,
    id: string,
    first: (adapter: ArtAdapter, context: ArtContext) => Effect.Effect<ArtStep, ArtProviderError>,
  ) =>
    FiberMap.run(fibers, id, drive(root, id, first), { onlyIfMissing: true }).pipe(Effect.asVoid);

  // ── generate ───────────────────────────────────────────────────────────
  const describe = (row: Row, spent: number | null, limit: number | null): string => {
    const g = row.generation;
    const label = GAME_ART_PROVIDERS[g.provider].label;
    const where = row.meta.folder;
    switch (g.state) {
      case "making":
        return `Making ${g.lane} "${g.name}" with ${label}${
          g.estimateUsd === null
            ? g.provider === "codex"
              ? " on the ChatGPT plan's Codex limits (no dollar cost)"
              : ""
            : `, estimated ${usd(g.estimateUsd)}`
        }${spent !== null && limit !== null ? ` (${usd(spent)} of the ${usd(limit)} daily limit spent today)` : ""}. Files land in ${where}/. Wait with game_generate_wait id ${g.id}.`;
      case "choosing":
        return `${g.candidates.length} candidates of "${g.name}" are ready (${g.candidates
          .map((candidate) => candidate.preview)
          .join(", ")}); the person picks one in the chat. Cost ${costText(row)}.`;
      case "done":
        return `"${g.name}" is in the game: ${g.files.join(", ")}${
          g.chosenBy === "autopilot"
            ? " (Keep going took the first candidate)"
            : g.chosenBy === "person"
              ? ` (the person picked candidate ${(g.chosen ?? 0) + 1})`
              : ""
        }. Cost ${costText(row)}. Recorded in ${where}/${g.name}.generation.json with its source, AI flag and licence.`;
      case "failed":
        return `"${g.name}" failed: ${g.error ?? "no reason given"}${g.costUsd ? ` Counted ${usd(g.costUsd)} against today (the provider may have charged for work it started).` : ""}`;
      case "cancelled":
        return `"${g.name}" was cancelled.${g.costUsd ? ` ${usd(g.costUsd)} counted against today for work already started.` : ""}`;
    }
  };
  const costText = (row: Row) =>
    row.generation.costUsd === null
      ? row.generation.provider === "codex"
        ? "no dollars (Codex plan usage)"
        : "unknown"
      : `${usd(row.generation.costUsd)}${row.meta.costEstimated ? " (estimated: the provider did not report it)" : ""}`;

  /**
   * Directions: one request per look, each to completion, as one step with a candidate each.
   * Codex runs them one at a time (one plan, one session at a time); the others together.
   */
  const directionsTogether = (
    adapter: ArtAdapter,
    context: ArtContext,
    requests: ReadonlyArray<ArtRequest>,
  ): Effect.Effect<ArtStep, ArtProviderError> =>
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
        }),
      { concurrency: adapter.id === "codex" ? 1 : "unbounded" },
    ).pipe(
      Effect.map((steps): ArtStep => {
        const costs = steps.map((step) => step.costUsd);
        return {
          kind: "done",
          candidates: steps.flatMap((step) => step.candidates.slice(0, 1)),
          costUsd: costs.every((cost) => cost === null)
            ? null
            : roundUsd(costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)),
        };
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
      // Each direction is its own request for one image: the person picks between looks,
      // never between samples of one prompt (which come back as near-copies).
      const prompts =
        directions.length === 0
          ? [input.prompt]
          : // The look leads: image models weight a prompt's start, and a style tacked on after a
            // long subject comes back in the model's own default rendering.
            directions.map(
              (direction) =>
                `Art style (follow it strictly, above everything else): ${direction.prompt}\n\n${input.prompt}\n\nRender every part of the image in that art style, not in a polished 3D movie style.`,
            );
      const base = { lane: input.lane, prompt: input.prompt, candidates: 1, options };
      const adapter = yield* route(all, base);
      const references = yield* readReferences(root, input.references ?? []);
      const requests: ReadonlyArray<ArtRequest> = prompts.map((prompt) => ({
        ...base,
        prompt,
        references,
      }));
      const estimates = prompts.map((prompt) =>
        adapter.estimate({ ...base, prompt, references: references.length }),
      );
      const estimate = estimates.some((value) => value === null)
        ? null
        : roundUsd(estimates.reduce<number>((sum, value) => sum + (value ?? 0), 0));
      const autopilot = directions.length > 1 && (yield* host.keepGoingStep(threadId));
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
            ...(directions.length === 0
              ? {}
              : { labels: directions.map((direction) => direction.label) }),
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
      yield* startDriver(root, id, (adapter, context) =>
        Effect.promise(() => NodeFSP.mkdir(context.scratch, { recursive: true })).pipe(
          Effect.andThen(
            requests.length === 1
              ? adapter.start(context, requests[0]!)
              : directionsTogether(adapter, context, requests),
          ),
        ),
      );
      return {
        text: describe(admitted.row, admitted.spent, limit),
        generation: admitted.row.generation,
      };
    });

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
          if (row.generation.state !== "making" || left <= 0)
            return { text: describe(row, null, null), generation: row.generation };
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
        WHERE root = ${root} ORDER BY created_at DESC LIMIT ${LIST_LIMIT}
      `.pipe(
        Effect.mapError(
          (cause) =>
            new GameOperationError({ operation: "art-list", path: root, reason: "io", cause }),
        ),
      );
      const all = yield* settings;
      return {
        generations: rows.flatMap((row) => {
          const decoded = toRow(row);
          return decoded === null ? [] : [decoded.generation];
        }),
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
          return { generation: (yield* chooseUnlocked(row, candidate, "person")).generation };
        }),
      );
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
      const quick = yield* quickReady(all, provider);
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
      const status: GameArtProviderStatus = yield* adapter.checkKey(context).pipe(
        Effect.timeout(Duration.seconds(8)),
        Effect.match({
          onSuccess: () => ({ provider, ready: true, message: "Key works." }),
          onFailure: (error) =>
            error instanceof ArtProviderError && error.transient !== true
              ? { provider, ready: false, message: `The key was refused: ${error.reason}` }
              : {
                  provider,
                  ready: true,
                  message: "Key saved; the provider could not be reached to check it.",
                },
        }),
      );
      keyChecks.set(provider, { key, at: now, status });
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

  return GameArt.of({ generate, wait, list, choose, cancel, providers, lanes });
});

/** The server's host: the provider registry's Codex and the run's in-flight step. */
export const layerHost = Layer.effect(
  GameArtHost,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return GameArtHost.of({
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
