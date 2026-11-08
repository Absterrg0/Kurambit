// @effect-diagnostics nodeBuiltinImport:off -- A measurement writes the harness's bots into a build's copy and moves their evidence into the game's logs on disk.
// A build's facts: measured once per engine-project tree and harness, in a
// copy of the build (GameBuildCopies), never in the game folder, and kept in
// one table. Nothing that matters lives only in memory: a measure writes the
// build's row first (owed), each tier is written as it lands, and a reconcile
// at startup measures every row with tiers still owed. In memory is only the
// one keyed queue, one job per key, that runs one measurement at a time on
// the server (every bot start still passes the memory gate) and that Stop
// game clears for its game. A tool or machine fault is stored as "not
// measured": with `retry` when waiting may clear it (every measure tries
// again), as `standing` when it needs a person (their measure tries again).
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import {
  GAME_FACTS_BOUNDS,
  GAME_FACTS_EVENT,
  GameAssetFacts,
  GameAssetUse,
  GameBuildFacts,
  GameBuildId,
  GameFactNotMeasured,
  GameFactPending,
  GamePerformance,
  GameSceneReport,
  type GameBotRunResult,
  GameEngineId,
  GameManifest,
  GameOperationError,
  manifestProject,
} from "@kurambit/contracts";
import {
  bootsFact,
  busyReading,
  FREEZE_BAD,
  faultOf,
  firstResponseOf,
  isStanding,
  machineBusy,
  type MachineLoad,
  notMeasured,
  skilledFact,
  tierEvidenceOf,
  tierFact,
  tierWallSeconds,
  winnableOf,
} from "./buildFacts.ts";
import * as GameBot from "./GameBot.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import { makeGameBrowser } from "./gameChromium.ts";
import { engineProfile } from "./engineProfile.ts";
import { ensureGameDir } from "./gameKeptSaves.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProcesses from "./GameProcesses.ts";
import { findExecutable } from "./GameProcesses.ts";
import * as GameService from "./GameService.ts";
import { HOST_OS } from "./processHost.ts";
import * as GameTemplates from "./GameTemplates.ts";
import { measureAssets } from "./assetFacts.ts";
import { assetUseOf, generationsShipped, PlayUse, readPlayUse, shippedFiles } from "./assetUse.ts";
import { performanceOf, readPlayPerf } from "./playPerf.ts";
import { readSceneFile, SCENE_OLD_SHELL, sceneNotInEngine } from "./sceneReport.ts";
import { measureVideo, playSpan, stallWithin } from "./videoSignals.ts";

/**
 * Changes when the server's reading of a measurement changes; the bot files are hashed besides.
 * A new tier needs no bump: planOf measures each fact a stored row lacks, and nothing else.
 */
const FACTS_VERSION = 2;
/** A measurement's operations on copies are its own: no thread owns them. */
const OWNER = "game-facts:measure";
/** Measures started by a person that may wait for the one running. */
const QUEUE_LIMIT = 3;
const TIER_FILES = ["tier.mjs", "idle.mjs", "masher.mjs", "sensors.mjs"];

/** How long a tier waits for a busy machine to calm before it plays anyway, as the memory gate waits for memory. */
const IDLE_WAIT_MS = 120_000;
const IDLE_POLL = "5 seconds" as const;

/** Linux's CPU pressure: the 10 s average share and the cumulative stall (µs) of "some"; null elsewhere. */
const cpuPressure = Effect.promise(() =>
  NodeFSP.readFile("/proc/pressure/cpu", "utf8").then(
    (text) => {
      const some = /^some avg10=([\d.]+) .*\btotal=(\d+)/m.exec(text);
      return some === null ? null : { avg10: Number(some[1]) / 100, total: Number(some[2]) };
    },
    () => null,
  ),
);
const machineNow = (stalled: number | null): MachineLoad => ({
  cores: NodeOS.availableParallelism(),
  stalled,
  load: NodeOS.loadavg()[0] ?? 0,
});
/** `work` with how busy the machine was while it ran. */
const withMachine = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const from = yield* Clock.currentTimeMillis;
    const before = yield* cpuPressure;
    const value = yield* work;
    const ms = (yield* Clock.currentTimeMillis) - from;
    const after = yield* cpuPressure;
    const stalled =
      before === null || after === null || ms <= 0
        ? null
        : Math.min(1, Math.max(0, (after.total - before.total) / (ms * 1000)));
    return { value, machine: machineNow(stalled) };
  });
/** Waits a while for an idle machine; a tier that plays on a busy one anyway is classified so. */
const idleMachine = Effect.gen(function* () {
  const until = (yield* Clock.currentTimeMillis) + IDLE_WAIT_MS;
  for (;;) {
    const pressure = yield* cpuPressure;
    if (!machineBusy(machineNow(pressure?.avg10 ?? null))) return;
    if ((yield* Clock.currentTimeMillis) >= until) return;
    yield* Effect.sleep(IDLE_POLL);
  }
});

/** The random-input play's scene record as the scene fact. */
const sceneOf = (record: GameSceneReport | "no-shell" | null): Fact<"scene"> =>
  record === "no-shell"
    ? notMeasured(SCENE_OLD_SHELL, false)
    : record === null
      ? notMeasured("the random-input play's scene report could not be read", true)
      : { status: "measured", value: record };

/** A build GameBuilds resolved: its game, its commit and its content key. */
export interface ResolvedBuild {
  readonly root: string;
  readonly build: GameBuildId;
  readonly key: string;
  readonly engine: GameEngineId;
}

type Fact<K extends keyof GameBuildFacts> = GameBuildFacts[K];
const Stored = Schema.Struct({
  build: GameBuildId,
  /** Where the build was asked for, so a reconcile after a restart can measure what is owed. */
  root: Schema.optionalKey(Schema.String),
  engine: Schema.optionalKey(GameEngineId),
  measuredAt: Schema.NullOr(Schema.String),
  renderer: Schema.NullOr(Schema.String),
  boots: Schema.optionalKey(GameBuildFacts.fields.boots),
  idle: Schema.optionalKey(GameBuildFacts.fields.idle),
  masher: Schema.optionalKey(GameBuildFacts.fields.masher),
  skilled: Schema.optionalKey(GameBuildFacts.fields.skilled),
  liveness: Schema.optionalKey(GameBuildFacts.fields.liveness),
  firstResponse: Schema.optionalKey(GameBuildFacts.fields.firstResponse),
  assets: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ status: Schema.Literal("measured"), value: GameAssetFacts }),
      GameFactNotMeasured,
      GameFactPending,
    ]),
  ),
  use: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ status: Schema.Literal("measured"), value: GameAssetUse }),
      GameFactNotMeasured,
      GameFactPending,
    ]),
  ),
  performance: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ status: Schema.Literal("measured"), value: GamePerformance }),
      GameFactNotMeasured,
      GameFactPending,
    ]),
  ),
  scene: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ status: Schema.Literal("measured"), value: GameSceneReport }),
      GameFactNotMeasured,
      GameFactPending,
    ]),
  ),
  /** Each play's own use record, so a tier measured again replaces only its own. */
  plays: Schema.optionalKey(
    Schema.Struct({
      idle: Schema.optionalKey(PlayUse),
      masher: Schema.optionalKey(PlayUse),
      skilled: Schema.optionalKey(PlayUse),
    }),
  ),
  /** The facts not measured for a standing tool or machine fault: a person's measure tries them again. */
  standing: Schema.optionalKey(Schema.Array(Schema.String)),
});
type Stored = typeof Stored.Type;
type Found = { readonly harness: string; readonly stored: Stored };
const StoredJson = Schema.fromJsonString(Stored);
const decodeStored = Schema.decodeUnknownOption(StoredJson);
const encodeStored = Schema.encodeSync(StoredJson);

/** What the run video's sidecar says (frameVideo.ts): each frame's counter, game time and wall ms. */
const decodeSidecar = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      frames: Schema.optionalKey(
        Schema.Array(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])),
      ),
    }),
  ),
);

const decodeCopyManifest = Schema.decodeUnknownSync(Schema.fromJsonString(GameManifest));

/**
 * The facts a tier's run writes. assets is static: read from the copy, never played. use is
 * every play's together: each play tier writes it again with its own record added.
 */
type Tier = "assets" | "boots" | "idle" | "masher" | "skilled";
type FactName =
  | "assets"
  | "boots"
  | "idle"
  | "masher"
  | "skilled"
  | "liveness"
  | "firstResponse"
  | "use"
  | "performance"
  | "scene";
const TIER_FACTS: Readonly<Record<Tier, ReadonlyArray<FactName>>> = {
  assets: ["assets"],
  boots: ["boots"],
  idle: ["idle", "use"],
  masher: ["masher", "liveness", "firstResponse", "performance", "scene", "use"],
  skilled: ["skilled", "use"],
};
const TIERS: ReadonlyArray<Tier> = ["assets", "boots", "idle", "masher", "skilled"];
const FACT_NAMES: ReadonlyArray<FactName> = [...new Set(TIERS.flatMap((tier) => TIER_FACTS[tier]))];
/**
 * Asset use is read from a browser page's requests, performance and the scene
 * report from its shell; an engine whose game plays in its own process says
 * why it has none of them, and never owes them.
 */
const BROWSER_ONLY: ReadonlySet<FactName> = new Set(["use", "performance", "scene"]);
const browserOnly = (engine: GameEngineId, fact: "use" | "performance" | "scene") =>
  engineProfile(engine).play === "browser"
    ? null
    : notMeasured(
        fact === "use"
          ? `${engineProfile(engine).displayName} games play in the engine's own process, where Kurambit does not record which files load; asset use is measured for games that play in a browser`
          : fact === "performance"
            ? `${engineProfile(engine).displayName} games play in the engine's own process, which does not report its frame times to Kurambit yet; performance is measured for games that play in a browser`
            : sceneNotInEngine(engine),
        false,
      );
const useNotMeasured = (engine: GameEngineId) => browserOnly(engine, "use");
const factsOf = (engine: GameEngineId | undefined): ReadonlyArray<FactName> =>
  engine !== undefined && useNotMeasured(engine) !== null
    ? FACT_NAMES.filter((name) => !BROWSER_ONLY.has(name))
    : FACT_NAMES;
/** About how long each tier takes, for the message. */
const TIER_SECONDS: Readonly<Record<Tier, number>> = {
  assets: 2,
  boots: 20,
  idle: 80,
  masher: 85,
  skilled: 80,
};

/** One measurement asked for: queued until it holds the server's one permit, then running. */
interface Job {
  readonly build: ResolvedBuild;
  /** A person asked: standing faults are tried again. */
  person: boolean;
  /** Only a newer turn build's measure asked: a newer one drops it while it waits. */
  supersedable: boolean;
  /** What it measures, known once it runs. */
  tiers: ReadonlySet<Tier> | null;
  running: boolean;
  stopped: boolean;
  fiber: Fiber.Fiber<void> | null;
  readonly done: Deferred.Deferred<void>;
}

export class GameFacts extends Context.Service<
  GameFacts,
  {
    /** The harness id facts are measured under now. */
    readonly harness: string;
    /** The build's facts as stored, with what a measurement in flight will add; starts nothing. */
    readonly read: (build: ResolvedBuild) => Effect.Effect<GameBuildFacts>;
    /** The facts of many builds at once, for the list. */
    readonly readMany: (
      builds: ReadonlyArray<ResolvedBuild>,
    ) => Effect.Effect<ReadonlyMap<string, GameBuildFacts>>;
    /**
     * Measures what the build lacks (never measured, not measured with a
     * reason waiting clears, an older harness, a changed tester bot; a
     * person's also what a standing fault kept) and returns at once, or after
     * `waitFor` if it finishes sooner. A person's measure waits behind at
     * most three others; past that it starts nothing and says so. With
     * `supersede` (a chat turn's newest build), it drops the game's other
     * queued measures that asked the same: only the newest turn is worth the
     * wait. A running measure, a person's and a run's are never dropped.
     */
    readonly measure: (
      build: ResolvedBuild,
      options?: {
        readonly waitFor?: Duration.Input;
        readonly queue?: "person" | "background";
        readonly supersede?: boolean;
      },
    ) => Effect.Effect<GameBuildFacts>;
    /**
     * The builds whose row still owes a tier (asked for, never measured), so
     * a reconcile after a restart measures them again: no owed work lives
     * only in memory.
     */
    readonly owed: Effect.Effect<ReadonlyArray<ResolvedBuild>>;
  }
>()("kurambit/game/GameFacts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const game = yield* GameService.GameService;
  const copies = yield* GameBuildCopies.GameBuildCopies;
  const bots = yield* GameBot.GameBot;
  const operations = yield* GameOperations.GameOperations;
  const processes = yield* GameProcesses.GameProcesses;
  const gameBrowser = yield* makeGameBrowser;
  const scope = yield* Effect.scope;
  // Missing templates fail a measure (its bots cannot be copied), never the server's start.
  const templates = yield* (yield* GameTemplates.GameTemplates).directory.pipe(
    Effect.tapError((error) =>
      Effect.logWarning("game facts: the starter templates are unavailable", error),
    ),
    Effect.orElseSucceed(() => NodePath.join(import.meta.dirname, "missing-templates")),
  );
  const kit = NodePath.join(templates, "bot-kit");
  const boundsFile = `// Written by the harness for this measurement (GAME_FACTS_BOUNDS).\nexport const PLAY_SECONDS = { idle: ${GAME_FACTS_BOUNDS.idleSeconds}, masher: ${GAME_FACTS_BOUNDS.masherSeconds} };\nexport const START_SECONDS = ${GAME_FACTS_BOUNDS.startSeconds};\n`;
  // Facts are comparable only when the same bots and bounds measured them.
  const harness = yield* Effect.promise(async () => {
    const hash = NodeCrypto.createHash("sha256");
    const { idleSeconds, masherSeconds, skilledSeconds, startSeconds } = GAME_FACTS_BOUNDS;
    hash.update(
      `${FACTS_VERSION}\0${idleSeconds},${masherSeconds},${skilledSeconds},${startSeconds}\0`,
    );
    for (const file of TIER_FILES)
      hash.update(await NodeFSP.readFile(NodePath.join(kit, file)).catch(() => Buffer.from(file)));
    return hash.digest("hex").slice(0, 12);
  });
  const permit = yield* Semaphore.make(1);
  /** The one queue: a job per facts key, registered before anything yields, removed when it ends. */
  const jobs = new Map<string, Job>();
  const waiting = () => [...jobs.values()].filter((job) => !job.running).length;

  const decodeRow = (row: { readonly harness: string; readonly payload_json: string }) => {
    const stored = decodeStored(row.payload_json);
    return Option.isSome(stored) ? { harness: row.harness, stored: stored.value } : null;
  };
  const load = (key: string) =>
    sql<{ readonly harness: string; readonly payload_json: string }>`
      SELECT harness, payload_json FROM game_build_facts WHERE facts_key = ${key}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : decodeRow(rows[0]))),
      // An unreadable row is no facts: the next measure writes it again.
      Effect.orElseSucceed(() => null),
    );
  const save = (key: string, stored: Stored) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO game_build_facts (facts_key, harness, payload_json, updated_at)
        VALUES (${key}, ${harness}, ${encodeStored(stored)}, ${now})
        ON CONFLICT (facts_key) DO UPDATE SET
          harness = excluded.harness,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A build's facts could not be saved.", { key, cause }),
      ),
    );

  const NEVER = notMeasured("not measured yet", true);
  const view = (build: ResolvedBuild, found: Found | null): GameBuildFacts => {
    const job = jobs.get(build.key);
    const current = found !== null && found.harness === harness ? found.stored : null;
    const stored = found?.stored;
    const pending = (fact: FactName) =>
      job?.tiers != null &&
      TIERS.some((tier) => job.tiers!.has(tier) && TIER_FACTS[tier].includes(fact));
    const get = <K extends FactName>(fact: K): Fact<K> =>
      pending(fact) ? { status: "pending" } : ((stored?.[fact] as Fact<K> | undefined) ?? NEVER);
    const idle = get("idle");
    const masher = get("masher");
    const facts = {
      boots: get("boots"),
      idle,
      masher,
      skilled: get("skilled"),
      winnableWithoutSkill: winnableOf(idle, masher),
      liveness: get("liveness"),
      firstResponse: get("firstResponse"),
      assets: get("assets"),
      use: useNotMeasured(build.engine) ?? get("use"),
      performance: browserOnly(build.engine, "performance") ?? get("performance"),
      scene: browserOnly(build.engine, "scene") ?? get("scene"),
    };
    // An engine with no asset use or performance is not an incomplete measurement.
    const counted =
      useNotMeasured(build.engine) === null
        ? Object.values(facts)
        : Object.entries(facts).flatMap(([name, fact]) =>
            BROWSER_ONLY.has(name as FactName) ? [] : [fact],
          );
    const anyMeasured = FACT_NAMES.some((fact) => stored?.[fact] !== undefined);
    const state =
      job !== undefined
        ? job.running
          ? "measuring"
          : "queued"
        : found === null || !anyMeasured
          ? "never"
          : current === null
            ? "stale"
            : counted.every((fact) => fact.status === "measured")
              ? "measured"
              : "incomplete";
    const left =
      job === undefined
        ? 0
        : TIERS.filter((tier) => job.tiers === null || job.tiers.has(tier)).reduce(
            (sum, tier) => sum + TIER_SECONDS[tier],
            0,
          );
    const ahead = Math.max(0, waiting() - 1);
    const message =
      state === "queued"
        ? `Queued${ahead > 0 ? ` behind ${ahead} other measurement${ahead === 1 ? "" : "s"}` : ""}; about ${Math.max(1, Math.ceil(left / 60))} min once it starts.`
        : state === "measuring"
          ? `Measuring: about ${Math.max(1, Math.ceil(left / 60))} min left.`
          : state === "never"
            ? "Not measured yet: opening or playing the build measures it."
            : state === "stale"
              ? "Measured by an older harness: measuring again makes it comparable."
              : state === "incomplete"
                ? "Some facts were not measured; each says why."
                : "Measured.";
    return {
      build: build.build,
      key: build.key,
      harness: found?.harness ?? harness,
      state,
      measuredAt: stored?.measuredAt ?? null,
      renderer: stored?.renderer ?? null,
      ...facts,
      message,
    };
  };

  // Evidence follows the game-logs cleanup; a fact whose evidence was cleaned
  // keeps its reading and says where its evidence went.
  const withEvidence = (root: string, facts: GameBuildFacts) =>
    Effect.promise(async () => {
      const exists = (relative: string) =>
        NodeFSP.access(NodePath.join(root, relative)).then(
          () => true,
          () => false,
        );
      const tier = async <F extends GameBuildFacts["idle"] | GameBuildFacts["skilled"]>(
        fact: F,
      ): Promise<F> =>
        fact.status !== "measured" ||
        fact.value.evidence === null ||
        (await exists(fact.value.evidence))
          ? fact
          : ({
              ...fact,
              value: {
                ...fact.value,
                evidence: null,
                note: `${fact.value.note} (evidence removed by cleanup)`.trim(),
              },
            } as F);
      return {
        ...facts,
        idle: await tier(facts.idle),
        masher: await tier(facts.masher),
        skilled: await tier(facts.skilled),
      };
    });

  const read: GameFacts["Service"]["read"] = (build) =>
    Effect.flatMap(load(build.key), (found) => withEvidence(build.root, view(build, found)));

  const readMany: GameFacts["Service"]["readMany"] = (builds) =>
    Effect.gen(function* () {
      const keys = [...new Set(builds.map((build) => build.key))];
      const rows =
        keys.length === 0
          ? []
          : yield* sql<{
              readonly facts_key: string;
              readonly harness: string;
              readonly payload_json: string;
            }>`
              SELECT facts_key, harness, payload_json FROM game_build_facts
              WHERE facts_key IN ${sql.in(keys)}
            `.pipe(Effect.orElseSucceed(() => []));
      const found = new Map(
        rows.flatMap((row) => {
          const decoded = decodeRow(row);
          return decoded === null ? [] : [[row.facts_key, decoded] as const];
        }),
      );
      return new Map(
        builds.map((build) => [build.build, view(build, found.get(build.key) ?? null)]),
      );
    });

  // The tester's latest play bot on this game, with the hash of its file now.
  const currentBot = (root: string) =>
    Effect.gen(function* () {
      const latest = yield* bots.latestPlayBot(root);
      if (latest === null) return null;
      const text = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, latest.file)).catch(() => null),
      );
      if (text === null) return null;
      return {
        file: latest.file,
        decider: latest.decider,
        hash: NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16),
      };
    });

  // What a measurement must do: everything under a new harness, else each
  // tier never measured or not measured for a reason waiting clears (and,
  // for a person, a standing fault they may have fixed), and the skilled
  // tier again when the tester's bot changed.
  const planOf = (
    found: Found | null,
    bot: { readonly hash: string } | null,
    person: boolean,
    engine: GameEngineId,
  ): ReadonlySet<Tier> => {
    if (found === null || found.harness !== harness) return new Set(TIERS);
    const stored = found.stored;
    const standing = new Set(stored.standing ?? []);
    const owes = new Set(factsOf(engine));
    const needs = (name: FactName) => {
      const fact = stored[name];
      return (
        owes.has(name) &&
        (fact === undefined ||
          fact.status === "pending" ||
          (fact.status === "not-measured" && (fact.retry || (person && standing.has(name)))))
      );
    };
    const tiers = new Set<Tier>();
    for (const tier of TIERS) if (TIER_FACTS[tier].some(needs)) tiers.add(tier);
    const skilled = stored.skilled;
    const botChanged =
      bot === null
        ? skilled?.status === "measured"
        : skilled?.status !== "measured" || skilled.value.bot.hash !== bot.hash;
    if (botChanged) tiers.add("skilled");
    return tiers;
  };

  /** A tier's run folder, kept under the game's logs (checked inside the game: no link leads out). */
  const moveEvidence = (root: string, key: string, tier: Tier, result: GameBotRunResult) =>
    Effect.promise(async () => {
      const from = NodePath.dirname(result.tracePath);
      const name = `game-bot-facts-${key.split(":")[1]?.slice(0, 12) ?? "x"}-${tier}`;
      try {
        const logs = await ensureGameDir(root, "builds/logs");
        const to = NodePath.join(logs, name);
        await NodeFSP.rm(to, { recursive: true, force: true });
        await NodeFSP.rename(from, to).catch(async () => {
          // The copies live under Kurambit's folder, which may be another filesystem.
          await NodeFSP.cp(from, to, { recursive: true });
          await NodeFSP.rm(from, { recursive: true, force: true });
        });
        return `builds/logs/${name}`;
      } catch {
        return null;
      }
    });

  // On Linux a bot plays on Xvfb, where an engine may draw another way than
  // the game does (the profile's xvfbRenderer); elsewhere it draws as the game does.
  const rendererOf = (copy: string, engine: GameEngineId) => {
    const profile = engineProfile(engine);
    const renderer = profile.xvfbRenderer;
    return renderer === null || HOST_OS !== "linux"
      ? Effect.succeed(null)
      : Effect.promise(async () =>
          renderer.note(
            await NodeFSP.readFile(
              NodePath.join(copy, profile.projectDirectory, renderer.settings),
              "utf8",
            ).catch(() => ""),
          ),
        );
  };

  // The build's own game.json names its engine folder; a copy that cannot say keeps the engine's default.
  const projectOf = (copy: string, engine: GameEngineId) =>
    Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(copy, "game.json"), "utf8")
        .then((text) => manifestProject(decodeCopyManifest(text)))
        .catch(() => ""),
    ).pipe(Effect.map((project) => project || engineProfile(engine).projectDirectory));

  const measureJob = (build: ResolvedBuild, tiers: ReadonlySet<Tier>, found: Found | null) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, key } = build;
        const announce = (message: string) => operations.changed(root, GAME_FACTS_EVENT, message);
        const copy = yield* copies.lease(root, { oid: build.build, key });
        // Every engine step is the copy's only one: Play and a measurement never import at once.
        const step = <A, E>(work: Effect.Effect<A, E>) => copies.exclusive(copy, work);
        // A new harness measures from nothing: no older reading is kept beside newer ones.
        let stored: Stored =
          found !== null && found.harness === harness
            ? found.stored
            : { build: build.build, measuredAt: null, renderer: null };
        stored = { ...stored, root, engine: build.engine };
        const write = (patch: Partial<Record<FactName, unknown>>) =>
          Effect.gen(function* () {
            const names = Object.keys(patch) as FactName[];
            const standing = new Set(stored.standing ?? []);
            for (const name of names)
              if (isStanding(patch[name])) standing.add(name);
              else standing.delete(name);
            stored = {
              ...stored,
              ...(patch as Partial<Stored>),
              standing: [...standing],
              measuredAt: DateTime.formatIso(yield* DateTime.now),
            };
            yield* save(key, stored);
            yield* announce(`Build ${build.build.slice(0, 8)}: ${names.join(", ")} measured.`);
          });

        // The static tier reads the copy's files only: it needs no browser and no engine.
        if (tiers.has("assets"))
          yield* write({
            assets: {
              status: "measured",
              value: yield* measureAssets(copy, build.engine, yield* projectOf(copy, build.engine)),
            },
          });
        // A browser game's bots draw with the backend the server probed; its
        // renderer is recorded, so facts from the GPU and from SwiftShader are
        // never compared as alike. A static-only measure plays nothing and probes nothing.
        const plays = TIERS.some((tier) => tier !== "assets" && tiers.has(tier));
        const backend =
          plays && engineProfile(build.engine).play === "browser"
            ? yield* gameBrowser(OWNER, root).pipe(Effect.option)
            : Option.none();
        const software = Option.isSome(backend) && backend.value.software;
        if (plays)
          stored = {
            ...stored,
            renderer: Option.isSome(backend)
              ? (backend.value.renderer ?? (software ? "SwiftShader (software)" : null))
              : yield* rendererOf(copy, build.engine),
          };
        if (tiers.has("boots")) {
          const boots = yield* step(game.checkIn(copy, OWNER)).pipe(
            Effect.map(bootsFact),
            Effect.catchTags({
              GameOperationError: (error) =>
                Effect.succeed(
                  faultOf(error) ?? {
                    status: "measured" as const,
                    value: { ok: false, detail: (error.detail ?? error.reason).slice(0, 300) },
                  },
                ),
            }),
          );
          yield* write({ boots });
        }
        // The harness's own bots, fresh from the server's templates, never the game's.
        const kitWritten = yield* Effect.promise(async () => {
          const dir = NodePath.join(copy, ".studio", "bot", "kit");
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.cp(kit, dir, { recursive: true, force: true });
          await NodeFSP.writeFile(NodePath.join(dir, "tier-bounds.mjs"), boundsFile);
        }).pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        );
        const boots = stored.boots;
        const unbooted = boots?.status === "measured" && !boots.value.ok;
        const blocked = unbooted
          ? notMeasured("the build failed its boot check", false)
          : boots?.status !== "measured"
            ? notMeasured(
                `its boot check was not measured${boots?.status === "not-measured" ? `: ${boots.why}` : ""}`,
                true,
              )
            : !kitWritten
              ? notMeasured("the harness's bots could not be written into the build's copy", true)
              : null;

        // Each bot run waits a while for an idle machine and says how busy it was,
        // so a run slowed by other work is never read as the game's slowness.
        const runBot = (file: string, seconds: number, decider: "policy" | "jev") =>
          Effect.andThen(
            idleMachine,
            withMachine(step(game.botRunIn(copy, { file, seconds, mode: "play", decider }))),
          ).pipe(
            Effect.map(({ value, machine }) => ({ value, machine: { ...machine, software } })),
          );
        const didNotBoot = (error: GameOperationError) =>
          ({
            status: "measured",
            value: {
              ending: "did-not-boot",
              at: null,
              played: 0,
              note: (error.detail ?? error.reason).slice(0, 200),
              evidence: null,
            },
          }) as const;
        // Asset use after each play tier: every play's record so far, against what the build
        // ships. A browser engine only; the view says why the others have none.
        const useAfter = (
          play: "idle" | "masher" | "skilled",
          evidence: string | null,
          none: ReturnType<typeof notMeasured>,
        ) =>
          Effect.gen(function* () {
            if (useNotMeasured(build.engine) !== null) return {};
            const record =
              evidence === null ? null : yield* Effect.promise(() => readPlayUse(root, evidence));
            const plays: { [K in "idle" | "masher" | "skilled"]?: PlayUse } = {};
            for (const each of ["idle", "masher", "skilled"] as const) {
              const kept = each === play ? record : stored.plays?.[each];
              if (kept !== null && kept !== undefined) plays[each] = kept;
            }
            stored = { ...stored, plays };
            const recorded = Object.values(plays);
            if (recorded.length === 0) return { use: none };
            const project = yield* projectOf(copy, build.engine);
            const files = yield* Effect.promise(() => shippedFiles(copy, build.engine, project));
            const loaded = new Set(recorded.flatMap((each) => each.loaded));
            const generations = yield* Effect.promise(() =>
              generationsShipped(copy, files, loaded),
            );
            return {
              use: {
                status: "measured" as const,
                value: assetUseOf(files, recorded, generations),
              },
            };
          });
        // Why a build has no use when no play left a record: the plays' own reason.
        const noRecord = (fact: Fact<"idle"> | Fact<"masher"> | Fact<"skilled">) =>
          fact.status === "not-measured"
            ? notMeasured(`its plays were not measured: ${fact.why}`, fact.retry)
            : fact.status === "measured" && fact.value.ending === "did-not-boot"
              ? notMeasured("no play loaded the game's page: it did not boot", false)
              : notMeasured("the plays' record of what the game loaded could not be kept", true);

        const tier = (name: "idle" | "masher", playSeconds: number) =>
          runBot(`.studio/bot/kit/${name}.mjs`, tierWallSeconds(playSeconds), "policy").pipe(
            Effect.flatMap(({ value: result, machine }) =>
              Effect.map(moveEvidence(root, key, name, result), (evidence) => ({
                result,
                evidence,
                machine,
                fact: tierFact(result, playSeconds, evidence, machine),
              })),
            ),
            Effect.catchTags({
              GameOperationError: (error) =>
                Effect.succeed({
                  result: null,
                  evidence: null,
                  machine: null,
                  fact: faultOf(error) ?? didNotBoot(error),
                }),
            }),
          );

        if (tiers.has("idle")) {
          if (blocked !== null)
            yield* write({ idle: blocked, ...(yield* useAfter("idle", null, blocked)) });
          else {
            const run = yield* tier("idle", GAME_FACTS_BOUNDS.idleSeconds);
            yield* write({
              idle: run.fact,
              ...(yield* useAfter("idle", run.evidence, noRecord(run.fact))),
            });
          }
        }

        if (tiers.has("masher")) {
          if (blocked !== null)
            yield* write({
              masher: blocked,
              liveness: blocked,
              firstResponse: blocked,
              ...(browserOnly(build.engine, "performance") === null
                ? { performance: blocked, scene: blocked }
                : {}),
              ...(yield* useAfter("masher", null, blocked)),
            });
          else {
            const run = yield* tier("masher", GAME_FACTS_BOUNDS.masherSeconds);
            const notFromRun = (what: string) =>
              run.fact.status === "not-measured"
                ? notMeasured(
                    `the random-input run was not measured: ${run.fact.why}`,
                    run.fact.retry,
                    isStanding(run.fact),
                  )
                : notMeasured(what, true);
            const measuredRun = run.fact.status === "measured" && run.result !== null;
            const firstResponse =
              measuredRun && run.result !== null
                ? firstResponseOf(run.result, run.machine)
                : notFromRun("the random-input run was not measured");
            const read = !measuredRun
              ? notFromRun("the random-input run was not measured")
              : run.evidence === null
                ? notMeasured("the random-input run's video could not be kept", true)
                : yield* step(livenessOf(copy, NodePath.join(root, run.evidence), run.result!));
            const liveness =
              read.status === "measured" && read.value.longestFreeze >= FREEZE_BAD
                ? (busyReading("the picture stood still", run.machine) ?? read)
                : read;
            // Performance is the page's own stats from the same play, on a browser engine.
            const performance =
              browserOnly(build.engine, "performance") !== null
                ? {}
                : {
                    performance:
                      Option.isSome(backend) && backend.value.software
                        ? performanceOf(null, backend.value, run.machine)
                        : !measuredRun || run.evidence === null
                          ? notFromRun("the random-input run was not measured")
                          : performanceOf(
                              yield* Effect.promise(() => readPlayPerf(root, run.evidence!)),
                              Option.isSome(backend)
                                ? backend.value
                                : { software: false, renderer: null, probe: "" },
                              run.machine,
                            ),
                  };
            // The scene report is the page's own, from the same play, on a browser engine.
            const scene =
              browserOnly(build.engine, "scene") !== null
                ? {}
                : {
                    scene:
                      !measuredRun || run.evidence === null
                        ? notFromRun("the random-input run was not measured")
                        : sceneOf(yield* Effect.promise(() => readSceneFile(root, run.evidence!))),
                  };
            yield* write({
              masher: run.fact,
              liveness,
              firstResponse,
              ...performance,
              ...scene,
              ...(yield* useAfter("masher", run.evidence, noRecord(run.fact))),
            });
          }
        }

        if (tiers.has("skilled")) {
          const bot = yield* currentBot(root);
          if (blocked !== null)
            yield* write({ skilled: blocked, ...(yield* useAfter("skilled", null, blocked)) });
          else if (bot === null) {
            const skilled = notMeasured(
              "this game has no play bot yet (keep going writes one once, or ask your agent for one)",
              false,
            );
            // No play ran: the other plays' reason stands when they left no record either.
            const why = stored.use?.status === "not-measured" ? stored.use : noRecord(skilled);
            yield* write({ skilled, ...(yield* useAfter("skilled", null, why)) });
          } else {
            const copied = yield* Effect.promise(() =>
              NodeFSP.cp(
                NodePath.join(root, ".studio", "bot"),
                NodePath.join(copy, ".studio", "bot"),
                { recursive: true, force: true },
              ).then(
                () => true,
                () => false,
              ),
            );
            let evidence: string | null = null;
            const skilled = !copied
              ? notMeasured("the game's bot files could not be copied", true)
              : yield* runBot(
                  bot.file,
                  tierWallSeconds(GAME_FACTS_BOUNDS.skilledSeconds),
                  bot.decider,
                ).pipe(
                  Effect.flatMap(({ value: result, machine }) =>
                    Effect.map(moveEvidence(root, key, "skilled", result), (moved) => {
                      evidence = moved;
                      return skilledFact(result, bot, moved, machine);
                    }),
                  ),
                  Effect.catchTags({
                    GameOperationError: (error) =>
                      Effect.succeed(
                        faultOf(error) ?? {
                          status: "measured" as const,
                          value: { ...didNotBoot(error).value, bot, botWord: null },
                        },
                      ),
                  }),
                );
            yield* write({
              skilled,
              ...(yield* useAfter("skilled", evidence, noRecord(skilled))),
            });
          }
        }
      }),
    );

  // Liveness and the stall over the span of play only: from the start of play
  // to its end, or to the end of the tier's span when the game never ended.
  const livenessOf = (copy: string, evidence: string, result: GameBotRunResult) =>
    Effect.gen(function* () {
      const ffmpeg = yield* Effect.promise(() =>
        findExecutable("ffmpeg", {
          pathEnv: process.env.PATH ?? "",
          override: process.env.KURAMBIT_FFMPEG,
        }),
      );
      if (ffmpeg === null) return notMeasured("ffmpeg is not installed", false, true);
      const sidecar = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(evidence, "run.frames.json"), "utf8").catch(() => null),
      ).pipe(Effect.map((text) => (text === null ? null : Option.getOrNull(decodeSidecar(text)))));
      const frames = sidecar?.frames ?? [];
      // A missing or empty frame record is the encoder's failure, not the game's.
      if (frames.length === 0) return notMeasured("the run video's frame record is missing", true);
      const times = tierEvidenceOf(result.status.evidence);
      const from = times?.playingAt;
      if (from === null || from === undefined)
        return notMeasured("the random-input run reported no start of play", false);
      const to = times?.endedAt ?? from + GAME_FACTS_BOUNDS.masherSeconds;
      const span = playSpan(frames, from, to);
      if (span === null) return notMeasured("the run video has no frames of play", false);
      return yield* measureVideo(processes, {
        root: copy,
        ffmpeg,
        video: NodePath.join(evidence, "run.mp4"),
        span,
        workDir: NodePath.join(evidence, "signals"),
      }).pipe(
        Effect.map((signals): Fact<"liveness"> => ({
          status: "measured",
          value: { ...signals, longestStall: stallWithin(frames, from, to) },
        })),
        Effect.catchTags({
          GameOperationError: (error) =>
            Effect.succeed(faultOf(error) ?? notMeasured(error.message, true)),
        }),
      );
    });

  // A job: its row first (so the work is owed even across a restart), then
  // the permit, then the plan read fresh, then the tiers.
  const runJob = (job: Job) =>
    Effect.gen(function* () {
      const { build } = job;
      const before = yield* load(build.key);
      if (before === null || before.harness !== harness)
        yield* save(build.key, {
          build: build.build,
          root: build.root,
          engine: build.engine,
          measuredAt: null,
          renderer: null,
        });
      yield* permit.withPermits(1)(
        Effect.gen(function* () {
          if (job.stopped) return;
          job.running = true;
          const found = yield* load(build.key);
          const tiers = planOf(found, yield* currentBot(build.root), job.person, build.engine);
          job.tiers = tiers;
          if (tiers.size === 0) return;
          yield* operations.changed(
            build.root,
            GAME_FACTS_EVENT,
            `Measuring build ${build.build.slice(0, 8)}.`,
          );
          yield* measureJob(build, tiers, found);
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("A build's measurement failed.", { key: job.build.key, cause }),
      ),
      Effect.ensuring(
        Effect.suspend(() => {
          if (jobs.get(job.build.key) === job) jobs.delete(job.build.key);
          Deferred.doneUnsafe(job.done, Effect.void);
          return operations.changed(
            job.build.root,
            GAME_FACTS_EVENT,
            `Build ${job.build.build.slice(0, 8)}: measurement ended.`,
          );
        }),
      ),
    );

  // A dropped job's row owes nothing anymore: one that measured nothing goes,
  // so a restart does not measure a superseded build after all.
  const drop = (job: Job) =>
    Effect.gen(function* () {
      if (job.fiber !== null) yield* Fiber.interrupt(job.fiber);
      if (jobs.has(job.build.key)) return;
      yield* sql`
        DELETE FROM game_build_facts
        WHERE facts_key = ${job.build.key} AND harness = ${harness}
          AND json_extract(payload_json, '$.measuredAt') IS NULL
      `.pipe(Effect.ignore);
    });

  const measure: GameFacts["Service"]["measure"] = (build, options = {}) =>
    Effect.gen(function* () {
      const person = options.queue === "person";
      const supersede = options.supersede === true && !person;
      // Decided and registered in one step, with nothing yielding between: a
      // job not yet running cannot start while it is dropped (runJob reads
      // `stopped` and sets `running` with no yield between).
      const asked = yield* Effect.suspend(
        (): Effect.Effect<{ job: Job | null; dropped: ReadonlyArray<Job> }> => {
          const existing = jobs.get(build.key);
          if (existing !== undefined) {
            if (person) existing.person = true;
            if (!supersede) existing.supersedable = false;
            return Effect.succeed({ job: existing, dropped: [] });
          }
          if (person && waiting() >= QUEUE_LIMIT) return Effect.succeed({ job: null, dropped: [] });
          const dropped = supersede
            ? [...jobs.values()].filter(
                (job) =>
                  job.build.root === build.root && job.supersedable && !job.person && !job.running,
              )
            : [];
          for (const job of dropped) {
            job.stopped = true;
            jobs.delete(job.build.key);
          }
          const fresh: Job = {
            build,
            person,
            supersedable: supersede,
            tiers: null,
            running: false,
            stopped: false,
            fiber: null,
            done: Deferred.makeUnsafe<void>(),
          };
          jobs.set(build.key, fresh);
          return Effect.forkIn(runJob(fresh), scope).pipe(
            Effect.map((fiber) => {
              fresh.fiber = fiber;
              return { job: fresh, dropped };
            }),
          );
        },
      );
      yield* Effect.forEach(asked.dropped, drop, { discard: true });
      const job = asked.job;
      if (job === null) {
        const facts = yield* read(build);
        return {
          ...facts,
          message: `Queued behind ${QUEUE_LIMIT} measurements already; try again shortly.`,
        };
      }
      if (options.waitFor !== undefined)
        yield* Deferred.await(job.done).pipe(Effect.timeoutOption(options.waitFor), Effect.ignore);
      return yield* read(build);
    });

  // Stop game clears the game's measurements, queued and running.
  yield* copies.onStop((root) =>
    Effect.forEach(
      [...jobs.values()].filter((job) => job.build.root === root),
      (job) =>
        Effect.suspend(() => {
          job.stopped = true;
          if (jobs.get(job.build.key) === job) jobs.delete(job.build.key);
          return job.fiber === null ? Effect.void : Fiber.interrupt(job.fiber);
        }),
      { discard: true },
    ),
  );

  const owed: GameFacts["Service"]["owed"] = sql<{
    readonly facts_key: string;
    readonly harness: string;
    readonly payload_json: string;
  }>`
    SELECT facts_key, harness, payload_json FROM game_build_facts WHERE harness = ${harness}
  `.pipe(
    Effect.orElseSucceed(() => []),
    Effect.map((rows) =>
      rows.flatMap((row): ReadonlyArray<ResolvedBuild> => {
        const stored = decodeRow(row)?.stored;
        // Owed: a tier never measured. A retryable fault waits for the next open.
        if (
          stored?.root === undefined ||
          stored.engine === undefined ||
          !factsOf(stored.engine).some((name) => stored[name] === undefined) ||
          jobs.has(row.facts_key)
        )
          return [];
        return [
          { root: stored.root, build: stored.build, key: row.facts_key, engine: stored.engine },
        ];
      }),
    ),
  );

  return GameFacts.of({ harness, read, readMany, measure, owed });
});

export const layer = Layer.effect(GameFacts, make);
