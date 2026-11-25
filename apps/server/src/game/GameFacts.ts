// @effect-diagnostics nodeBuiltinImport:off -- A measurement writes the harness's bots into a build's copy and moves their evidence into the game's logs on disk.
// A build's facts: measured once per engine-project tree and harness, in a
// copy of the build (GameBuildCopies), never in the game folder, and kept in
// one table. Nothing that matters lives only in memory: a measure writes the
// build's row first (owed), each tier is written as it lands, and a reconcile
// at startup measures every row with tiers still owed. In memory is only the
// keyed jobs, one per key, that Stop game clears for its game. A job runs in
// the server's one play lane (playLane.ts) at the priority of who asked: one
// measurement at a time, the most urgent first, and one outranked gives way
// mid-tier and plans again from its row (every bot start still passes the
// memory gate). A tool or machine fault is stored as "not
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
import * as SqlClient from "effect/sql/SqlClient";
import {
  GAME_FACTS_BOUNDS,
  GAME_FACTS_EVENT,
  GameAssetUse,
  GameBuildFacts,
  GameBuildId,
  GameFactNotMeasured,
  GameFactPending,
  GamePerformance,
  GameQaReport,
  GameSavedPlaysReading,
  GameScreens,
  GamePlayerReport,
  type GameBotRunResult,
  GameEngineId,
  GameManifest,
  GameOperationError,
  manifestRuntime,
  noSavedPlays,
  SAVED_PLAYS_PER_BUILD,
} from "@kurambit/contracts";
import {
  bootsFact,
  faultOf,
  isStanding,
  machineBusy,
  type MachineLoad,
  notMeasured,
  tierFact,
  qaFact,
  screensFact,
  playerFact,
} from "./buildFacts.ts";
import * as GameBot from "./GameBot.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import { makeGameBrowser } from "./gameChromium.ts";
import { type LaneTicket, type PlayPriority, playLane } from "./playLane.ts";
import { engineProfile } from "./engineProfile.ts";
import { ensureGameDir } from "./gameKeptSaves.ts";
import { insideGame } from "./gamePath.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameTemplates from "./GameTemplates.ts";
import { runtimesDirectory, runtimeVersion } from "./gameRuntime.ts";
import { assetUseOf, PlayUse, readPlayUse, shippedFiles } from "./assetUse.ts";
import { performanceOf, readPlayPerf } from "./playPerf.ts";
import { replaySavedPlays, savedPlays } from "./playFiles.ts";

/**
 * Changes when the server's reading of a measurement changes; the masher's file is hashed besides.
 * A new tier needs no bump: planOf measures each fact a stored row lacks, and nothing else.
 */
const FACTS_VERSION = 5;
/** A measurement's operations on copies are its own: no thread owns them. */
const OWNER = "game-facts:measure";
/** Measures started by a person that may wait behind each other. */
const QUEUE_LIMIT = 3;
/** The harness's random-input bot, a stepped one (templates/bot-kit/masher.mjs). */
const MASHER = "masher.mjs";
/** Where a copy holds the harness's own masher. */
const HARNESS_KIT = ".studio/bot/harness-kit";

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
/** `work` (a play) with how busy the machine was while it ran. */
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
  runtime: Schema.optionalKey(Schema.String),
  boots: Schema.optionalKey(GameBuildFacts.fields.boots),
  masher: Schema.optionalKey(GameBuildFacts.fields.masher),
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
  qa: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ status: Schema.Literal("measured"), value: GameQaReport }),
      GameFactNotMeasured,
      GameFactPending,
    ]),
  ),
  savedPlays: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ status: Schema.Literal("measured"), value: GameSavedPlaysReading }),
      GameFactNotMeasured,
      GameFactPending,
    ]),
  ),
  screens: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ status: Schema.Literal("measured"), value: GameScreens }),
      GameFactNotMeasured,
      GameFactPending,
    ]),
  ),
  player: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ status: Schema.Literal("measured"), value: GamePlayerReport }),
      GameFactNotMeasured,
      GameFactPending,
    ]),
  ),
  /** Each play's own use record, so a tier measured again replaces only its own. */
  plays: Schema.optionalKey(
    Schema.Struct({
      masher: Schema.optionalKey(PlayUse),
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

const decodeCopyManifest = Schema.decodeUnknownSync(Schema.fromJsonString(GameManifest));

/**
 * The facts a tier's run writes: only what a person acts on. The boot check (with the QA play),
 * the game's saved plays replayed, then the random-input play (errors, freezes, frame rate).
 * use is that play's record against what the build ships (the generation cards read it).
 */
type Tier = "boots" | "replays" | "masher";
type FactName =
  | "boots"
  | "masher"
  | "use"
  | "performance"
  | "qa"
  | "screens"
  | "player"
  | "savedPlays";
const TIER_FACTS: Readonly<Record<Tier, ReadonlyArray<FactName>>> = {
  // The boot check plays the QA play and the other screen sizes too (GameEngine.checkIn), so
  // their reports land with it.
  boots: ["boots", "qa", "screens", "player"],
  replays: ["savedPlays"],
  masher: ["masher", "performance", "use"],
};
const TIERS: ReadonlyArray<Tier> = ["boots", "replays", "masher"];
/**
 * A build no saved play was replayed on: the game had none (or none when it was measured). The
 * fact is then not shown.
 */
const NONE_SAVED = notMeasured(
  "no saved play was replayed on this build",
  false,
  false,
  "no-saved-plays",
);
const FACT_NAMES: ReadonlyArray<FactName> = [...new Set(TIERS.flatMap((tier) => TIER_FACTS[tier]))];
/** Each tier's step as the measuring line names it. */
const TIER_STEP: Readonly<Record<Tier, string>> = {
  boots: "checking it starts",
  replays: "replaying the saved plays",
  masher: "playing it with random input",
};

/** What a running measure is doing, by the step it is on and how many are done: never a time left. */
const measuringMessage = (
  tiers: ReadonlySet<Tier> | null,
  owed: (tier: Tier) => boolean,
): string => {
  if (tiers === null) return "Measuring: getting a copy of the build ready.";
  const steps = TIERS.filter((tier) => tiers.has(tier));
  const at = steps.findIndex(owed);
  if (at === -1) return "Measuring: saving the readings.";
  return `Measuring: ${TIER_STEP[steps[at]!]} (step ${at + 1} of ${steps.length}).`;
};

/** One measurement asked for: queued until it holds the play lane, then running. */
interface Job {
  readonly build: ResolvedBuild;
  /** Its place in the play lane, raised when someone more urgent asks for the same build. */
  readonly ticket: LaneTicket;
  /** A person asked: standing faults are tried again. */
  person: boolean;
  /** Only a newer turn build's measure asked: a newer one drops it while it waits. */
  supersedable: boolean;
  /** What it measures, known once it runs. */
  tiers: ReadonlySet<Tier> | null;
  /** Facts this measure has saved so far: each shows as it lands, not when the job ends. */
  readonly written: Set<FactName>;
  /** Holding the lane now; false again while it waits after giving way. */
  running: boolean;
  stopped: boolean;
  fiber: Fiber.Fiber<void> | null;
  readonly done: Deferred.Deferred<void>;
  /**
   * Its boot check (with the QA play) and its saved plays are in, or it had none to do: what
   * keep going judges and proposes by.
   */
  readonly booted: Deferred.Deferred<void>;
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
     * reason waiting clears, an older harness; a
     * person's also what a standing fault kept) and returns at once, or after
     * `waitFor` if it finishes sooner. Measures go by who asked: a person's,
     * then a chat turn's (`supersede`), then the rest, and past its boot check
     * a measure no person asked for goes with the rest; a running one that a
     * more urgent one outranks gives way at once and goes on after it. A
     * person's measure waits behind at most three others of theirs; past that
     * it starts nothing and says so. With `supersede` (a chat turn's newest
     * build), it drops the game's other queued measures that asked the same:
     * only the newest turn is worth the wait. A running measure, a person's
     * and a run's are never dropped. `upTo: "boots"` waits only for the
     * boot check, the QA play and the saved plays, the readings keep going
     * judges a step by; the random-input play goes on behind it.
     */
    readonly measure: (
      build: ResolvedBuild,
      options?: {
        readonly waitFor?: Duration.Input;
        readonly queue?: "person" | "background";
        readonly supersede?: boolean;
        readonly upTo?: "boots";
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
  const engines = yield* GameEngine.GameEngine;
  const copies = yield* GameBuildCopies.GameBuildCopies;
  const bots = yield* GameBot.GameBot;
  const operations = yield* GameOperations.GameOperations;
  const gameBrowser = yield* makeGameBrowser;
  const scope = yield* Effect.scope;
  // Missing templates fail a measure (its bots cannot be copied), never the server's start.
  const templates = yield* (yield* GameTemplates.GameTemplates).directory.pipe(
    Effect.tapError((error) =>
      Effect.logWarning("game facts: the starter templates are unavailable", error),
    ),
    Effect.orElseSucceed(() => NodePath.join(import.meta.dirname, "missing-templates")),
  );
  const masher = NodePath.join(templates, "bot-kit", MASHER);
  // Facts are comparable only when the same bots and bounds measured them.
  const harness = yield* Effect.promise(async () => {
    const hash = NodeCrypto.createHash("sha256");
    const { masherSeconds, startSeconds } = GAME_FACTS_BOUNDS;
    hash.update(`${FACTS_VERSION}\0${masherSeconds},${startSeconds}\0`);
    hash.update(await NodeFSP.readFile(masher).catch(() => Buffer.from(MASHER)));
    return hash.digest("hex").slice(0, 12);
  });
  /** A job per facts key, registered before anything yields, removed when it ends. */
  const jobs = new Map<string, Job>();
  const personWaiting = () => [...jobs.values()].filter((job) => job.person && !job.running).length;

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
    const owedTier = (tier: Tier) =>
      job?.tiers != null &&
      job.tiers.has(tier) &&
      // Asset use is rewritten after every play, so a tier is done once its own facts are in.
      TIER_FACTS[tier].some((fact) => fact !== "use" && !job.written.has(fact));
    const pending = (fact: FactName) =>
      TIERS.some((tier) => owedTier(tier) && TIER_FACTS[tier].includes(fact));
    const get = <K extends FactName>(fact: K): Fact<K> =>
      pending(fact) ? { status: "pending" } : ((stored?.[fact] as Fact<K> | undefined) ?? NEVER);
    const facts = {
      boots: get("boots"),
      masher: get("masher"),
      use: get("use"),
      performance: get("performance"),
      qa: get("qa"),
      screens: get("screens"),
      // Facts stored before the first minute was measured say so; measuring again fills it.
      player:
        stored !== undefined && stored.player === undefined && !pending("player")
          ? notMeasured("measured before the first minute was measured", true)
          : get("player"),
      savedPlays: pending("savedPlays")
        ? ({ status: "pending" } as const)
        : (stored?.savedPlays ?? NONE_SAVED),
    };
    // A game with no saved plays is not an incomplete measurement.
    const counted = Object.entries(facts).flatMap(([name, fact]) =>
      name === "savedPlays" && noSavedPlays(facts) ? [] : [fact],
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
    const ahead = job === undefined ? 0 : playLane.ahead(job.ticket);
    const message =
      state === "queued"
        ? ahead > 0
          ? `Queued behind ${ahead} other play${ahead === 1 ? "" : "s"}.`
          : "Queued: it starts when the play before it ends."
        : state === "measuring"
          ? measuringMessage(job?.tiers ?? null, owedTier)
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
      ...(stored?.runtime === undefined ? {} : { runtime: stored.runtime }),
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
      const tier = async <F extends GameBuildFacts["masher"]>(fact: F): Promise<F> =>
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
      const screens = facts.screens;
      return {
        ...facts,
        masher: await tier(facts.masher),
        screens:
          screens.status !== "measured"
            ? screens
            : {
                ...screens,
                value: {
                  ...screens.value,
                  sizes: await Promise.all(
                    screens.value.sizes.map(async (size) =>
                      size.frame === null || (await exists(size.frame))
                        ? size
                        : { ...size, frame: null },
                    ),
                  ),
                },
              },
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

  /** Which plays the game has saved now (playFiles.ts); "" for none or unreadable. */
  const savedSetOf = (root: string) =>
    Effect.promise(() =>
      savedPlays(root).then(
        (saved) => saved.set,
        () => "",
      ),
    );

  // What a measurement must do: everything under a new harness, else each
  // tier never measured or not measured for a reason waiting clears (and,
  // for a person, a standing fault they may have fixed).
  const planOf = (
    found: Found | null,
    person: boolean,
    runtime: string | null,
    savedSet: string,
  ): ReadonlySet<Tier> => {
    if (found === null || found.harness !== harness) return new Set(TIERS);
    // The same files on another runtime are another game to play: its readings are stale.
    if (runtime !== null && found.stored.runtime !== undefined && found.stored.runtime !== runtime)
      return new Set(TIERS);
    const stored = found.stored;
    const standing = new Set(stored.standing ?? []);
    const needs = (name: FactName) => {
      const fact = stored[name];
      return (
        fact === undefined ||
        fact.status === "pending" ||
        (fact.status === "not-measured" && (fact.retry || (person && standing.has(name))))
      );
    };
    const tiers = new Set<Tier>();
    for (const tier of TIERS)
      if (tier !== "replays" && TIER_FACTS[tier].some(needs)) tiers.add(tier);
    // The saved plays are replayed again whenever they are not the ones last replayed here; a
    // row from before saved plays existed replayed none.
    const replayed = stored.savedPlays;
    const replayedSet =
      replayed === undefined ||
      (replayed.status === "not-measured" && replayed.cause === "no-saved-plays")
        ? ""
        : replayed.status === "measured"
          ? replayed.value.set
          : null;
    if (replayedSet === null ? needs("savedPlays") : replayedSet !== savedSet) tiers.add("replays");
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

  // The build's own game.json names its engine folder; a copy that cannot say keeps the engine's default.
  const projectOf = (copy: string, engine: GameEngineId) =>
    Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(copy, "game.json"), "utf8")
        .then((text) => decodeCopyManifest(text).project)
        .catch(() => ""),
    ).pipe(Effect.map((project) => project || engineProfile(engine).projectDirectory));

  /** The runtime the copy's plays load now, for a game that loads one (gameRuntime.ts). */
  const runtimeOf = (copy: string, engine: GameEngineId) =>
    Effect.promise(async () => {
      const major = await NodeFSP.readFile(NodePath.join(copy, "game.json"), "utf8")
        .then((text) => manifestRuntime(decodeCopyManifest(text)))
        .catch(() => null);
      return major === null ? null : runtimeVersion(runtimesDirectory(templates), engine, major);
    });

  /**
   * The screen sizes' frames, kept in the game's logs beside the build's other evidence: a
   * check of the copy left them in the copy, and a game_check that stands for it in the game.
   */
  const keepScreenFrames = (
    root: string,
    copy: string,
    key: string,
    fact: Fact<"screens">,
  ): Effect.Effect<Fact<"screens">> =>
    fact.status !== "measured"
      ? Effect.succeed(fact)
      : Effect.promise(async () => {
          const folder = `builds/logs/game-screens-${key.split(":")[1]?.slice(0, 12) ?? "x"}`;
          const logs = await ensureGameDir(root, folder).catch(() => null);
          const sizes = await Promise.all(
            fact.value.sizes.map(async (size) => {
              if (size.frame === null || logs === null) return { ...size, frame: null };
              const name = `${size.name}.png`;
              for (const from of [copy, root])
                try {
                  const source = insideGame(from, size.frame);
                  await NodeFSP.rm(NodePath.join(logs, name), { force: true });
                  await NodeFSP.copyFile(source, NodePath.join(logs, name));
                  return { ...size, frame: `${folder}/${name}` };
                } catch {
                  // Not in this checkout: the other one ran the check.
                }
              return { ...size, frame: null };
            }),
          );
          return { ...fact, value: { ...fact.value, sizes } };
        });

  const measureJob = (
    build: ResolvedBuild,
    tiers: ReadonlySet<Tier>,
    found: Found | null,
    written: Set<FactName>,
    booted: Deferred.Deferred<void>,
    afterBoots: Effect.Effect<void>,
  ) =>
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
        // Whole or not at all, should the job give way as it saves.
        const write = (patch: Partial<Record<FactName, unknown>>) =>
          Effect.uninterruptible(
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
              for (const name of names) written.add(name);
              yield* announce(`Build ${build.build.slice(0, 8)}: ${names.join(", ")} measured.`);
            }),
          );

        // A browser game's bots draw with the backend the server probed; its
        // renderer is recorded, so facts from the GPU and from SwiftShader are
        // never compared as alike.
        const backend = yield* gameBrowser(OWNER, root).pipe(Effect.option);
        const software = Option.isSome(backend) && backend.value.software;
        {
          const { runtime: _measuredWith, ...rest } = stored;
          const runtime = yield* runtimeOf(copy, build.engine);
          stored = {
            ...rest,
            renderer: Option.isSome(backend)
              ? (backend.value.renderer ?? (software ? "SwiftShader (software)" : null))
              : null,
            ...(runtime === null ? {} : { runtime }),
          };
        }
        if (tiers.has("boots")) {
          // A clean game_check of these very files already booted them (GameEngine.cleanCheckOf).
          const checked = yield* engines.cleanCheckOf(copy);
          const facts =
            checked !== null
              ? {
                  boots: bootsFact(checked, "from game_check on the same files"),
                  qa: qaFact(checked),
                  screens: yield* keepScreenFrames(root, copy, key, screensFact(checked)),
                  player: playerFact(checked),
                }
              : yield* step(engines.checkIn(copy, OWNER)).pipe(
                  Effect.flatMap((result) =>
                    Effect.map(
                      keepScreenFrames(root, copy, key, screensFact(result)),
                      (screens) => ({
                        boots: bootsFact(result),
                        qa: qaFact(result),
                        screens,
                        player: playerFact(result),
                      }),
                    ),
                  ),
                  Effect.catchTags({
                    GameOperationError: (error) => {
                      const fault = faultOf(error);
                      return Effect.succeed({
                        boots: fault ?? {
                          status: "measured" as const,
                          value: {
                            ok: false,
                            detail: (error.detail ?? error.reason).slice(0, 300),
                          },
                        },
                        qa: fault ?? notMeasured("the boot check failed before the QA play", false),
                        screens:
                          fault ??
                          notMeasured("the boot check failed before the other screen sizes", false),
                        player:
                          fault ??
                          notMeasured("the boot check failed before the first minute", false),
                      });
                    },
                  }),
                );
          yield* write(facts);
        }
        // The harness's own masher, fresh from the server's templates, never the game's.
        const kitWritten = yield* Effect.promise(async () => {
          const dir = NodePath.join(copy, HARNESS_KIT);
          await NodeFSP.rm(dir, { recursive: true, force: true });
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.copyFile(masher, NodePath.join(dir, MASHER));
        }).pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        );
        const boots = stored.boots;
        const unbooted = boots?.status === "measured" && !boots.value.ok;
        const unstarted = unbooted
          ? notMeasured("the build failed its boot check", false)
          : boots?.status !== "measured"
            ? notMeasured(
                `its boot check was not measured${boots?.status === "not-measured" ? `: ${boots.why}` : ""}`,
                true,
                false,
                boots?.status === "not-measured" ? boots.cause : undefined,
              )
            : null;
        const blocked =
          unstarted ??
          (!kitWritten
            ? notMeasured("the harness's bots could not be written into the build's copy", true)
            : null);

        // Every saved play, replayed in this copy inside the lane's hold. A replay never
        // waits on real time, so it is measured on a software renderer too.
        if (tiers.has("replays")) {
          const saved = yield* Effect.promise(() =>
            savedPlays(root).catch(() => ({ plays: [], set: "" })),
          );
          // Each replay is announced as it starts: a bring-in's check counts them for the person.
          const of = Math.min(saved.plays.length, SAVED_PLAYS_PER_BUILD);
          let replaying = 0;
          yield* write({
            savedPlays:
              saved.plays.length === 0
                ? NONE_SAVED
                : (unstarted ??
                  (yield* replaySavedPlays(saved, (play) =>
                    announce(
                      `Build ${build.build.slice(0, 8)}: test play ${(replaying += 1)} of ${of}.`,
                    ).pipe(Effect.andThen(step(engines.replayIn(copy, play)))),
                  ).pipe(
                    Effect.map((value) => ({ status: "measured" as const, value })),
                    Effect.catchTags({
                      GameOperationError: (error) =>
                        Effect.succeed(
                          faultOf(error) ??
                            notMeasured(
                              `the saved plays could not be replayed: ${(error.detail ?? error.reason).split("\n")[0]}`,
                              false,
                            ),
                        ),
                    }),
                  ))),
          });
        }
        yield* Deferred.succeed(booted, undefined);
        // A judge or a turn waits on a boot check, never on this build's random-input play:
        // theirs goes first, and this goes on after them (a person who asked keeps their rank).
        yield* afterBoots;

        // Each bot run says how busy the machine was, so a run slowed by other
        // work is never read as the game's slowness; it waits a while for an
        // idle machine first and holds the copy's one engine step.
        const runBot = (file: string, seconds: number, options?: { readonly realTime: boolean }) =>
          Effect.andThen(
            idleMachine,
            withMachine(step(bots.runIn(copy, { file, seconds }, options))).pipe(
              Effect.map(({ value, machine }) => ({ value, machine: { ...machine, software } })),
            ),
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
        // Asset use after the random-input play: its record against what the build ships.
        const useAfter = (evidence: string | null, none: ReturnType<typeof notMeasured>) =>
          Effect.gen(function* () {
            const record =
              evidence === null ? null : yield* Effect.promise(() => readPlayUse(root, evidence));
            const plays: { masher?: PlayUse } = record === null ? {} : { masher: record };
            stored = { ...stored, plays };
            const recorded = Object.values(plays);
            if (recorded.length === 0) return { use: none };
            const project = yield* projectOf(copy, build.engine);
            const files = yield* Effect.promise(() => shippedFiles(copy, build.engine, project));
            return {
              use: {
                status: "measured" as const,
                value: assetUseOf(files, recorded),
              },
            };
          });
        // Why a build has no use when no play left a record: the play's own reason.
        const noRecord = (fact: Fact<"masher">) =>
          fact.status === "not-measured"
            ? notMeasured(`its plays were not measured: ${fact.why}`, fact.retry, false, fact.cause)
            : fact.status === "measured" && fact.value.ending === "did-not-boot"
              ? notMeasured("no play loaded the game's page: it did not boot", false)
              : notMeasured("the plays' record of what the game loaded could not be kept", true);

        if (tiers.has("masher")) {
          if (blocked !== null)
            yield* write({
              masher: blocked,
              performance: blocked,
              ...(yield* useAfter(null, blocked)),
            });
          else {
            const playSeconds = GAME_FACTS_BOUNDS.masherSeconds;
            // Its span is game seconds on the run's own clock: a slow machine plays the same run,
            // only later. Drawing on a GPU it steps at a person's pace, so the same play's frame
            // times are the performance fact; in software they are not read, so it hurries.
            const run = yield* runBot(`${HARNESS_KIT}/${MASHER}`, playSeconds, {
              realTime: !software,
            }).pipe(
              Effect.flatMap(({ value: result, machine }) =>
                Effect.map(moveEvidence(root, key, "masher", result), (evidence) => ({
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
            const measuredRun = run.fact.status === "measured" && run.result !== null;
            const notFromRun =
              run.fact.status === "not-measured"
                ? notMeasured(
                    `the random-input run was not measured: ${run.fact.why}`,
                    run.fact.retry,
                    isStanding(run.fact),
                    run.fact.cause,
                  )
                : notMeasured("the random-input run was not measured", true);
            // Performance is the page's own stats from the same play. In software its frame
            // times are not read, but what a frame draws still is, from any run that left its
            // record.
            const performance =
              Option.isSome(backend) && backend.value.software
                ? performanceOf(
                    run.result === null || run.evidence === null
                      ? null
                      : yield* Effect.promise(() => readPlayPerf(root, run.evidence!)),
                    backend.value,
                    run.machine,
                  )
                : !measuredRun || run.evidence === null
                  ? notFromRun
                  : performanceOf(
                      yield* Effect.promise(() => readPlayPerf(root, run.evidence!)),
                      Option.isSome(backend)
                        ? backend.value
                        : { software: false, renderer: null, probe: "" },
                      run.machine,
                    );
            yield* write({
              masher: run.fact,
              performance,
              ...(yield* useAfter(run.evidence, noRecord(run.fact))),
            });
          }
        }
      }),
    );

  // A job: its row first (so the work is owed even across a restart), then
  // its turn in the play lane, then the plan read fresh, then the tiers. A
  // job that gives way to a more urgent play is interrupted and runs this
  // again on its next turn: the tier it was in was never written, so the
  // fresh plan measures it again and nothing it finished.
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
      yield* playLane.hold(
        job.ticket,
        Effect.gen(function* () {
          if (job.stopped) return;
          job.running = true;
          const found = yield* load(build.key);
          const tiers = planOf(
            found,
            job.person,
            yield* runtimeOf(build.root, build.engine),
            yield* savedSetOf(build.root),
          );
          job.tiers = tiers;
          job.written.clear();
          if (!tiers.has("boots") && !tiers.has("replays"))
            yield* Deferred.succeed(job.booted, undefined);
          if (tiers.size === 0) return;
          yield* operations.changed(
            build.root,
            GAME_FACTS_EVENT,
            `Measuring build ${build.build.slice(0, 8)}.`,
          );
          yield* measureJob(
            build,
            tiers,
            found,
            job.written,
            job.booted,
            Effect.suspend(() => playLane.lower(job.ticket, job.person ? "person" : "background")),
          );
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.suspend(() => {
              job.running = false;
              return job.stopped
                ? Effect.void
                : operations.changed(
                    build.root,
                    GAME_FACTS_EVENT,
                    `Build ${build.build.slice(0, 8)}: measuring paused for a more urgent play.`,
                  );
            }),
          ),
        ),
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
          Deferred.doneUnsafe(job.booted, Effect.void);
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
      // Nothing owed starts no job: a job that plans nothing ends at once, and a reader that
      // caught it queued would never hear that it ended unless its build's facts moved.
      if (!jobs.has(build.key)) {
        const found = yield* load(build.key);
        const owes =
          found === null ||
          planOf(
            found,
            person,
            yield* runtimeOf(build.root, build.engine),
            yield* savedSetOf(build.root),
          ).size > 0;
        if (!owes) return yield* read(build);
      }
      const supersede = options.supersede === true && !person;
      // A superseding measure is a chat turn's newest build (GameBuilds).
      const priority: PlayPriority = person ? "person" : supersede ? "turn" : "background";
      // Decided and registered in one step, with nothing yielding between: a
      // job not yet running cannot start while it is dropped (runJob reads
      // `stopped` and sets `running` with no yield between).
      const asked = yield* Effect.suspend(
        (): Effect.Effect<{
          job: Job | null;
          dropped: ReadonlyArray<Job>;
          queued: boolean;
        }> => {
          const existing = jobs.get(build.key);
          if (existing !== undefined) {
            if (person) existing.person = true;
            if (!supersede) existing.supersedable = false;
            return Effect.as(playLane.raise(existing.ticket, priority), {
              job: existing,
              dropped: [],
              queued: false,
            });
          }
          if (person && personWaiting() >= QUEUE_LIMIT)
            return Effect.succeed({ job: null, dropped: [], queued: false });
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
            ticket: playLane.ticket(priority),
            person,
            supersedable: supersede,
            tiers: null,
            written: new Set(),
            running: false,
            stopped: false,
            fiber: null,
            done: Deferred.makeUnsafe<void>(),
            booted: Deferred.makeUnsafe<void>(),
          };
          jobs.set(build.key, fresh);
          return Effect.forkIn(runJob(fresh), scope).pipe(
            Effect.map((fiber) => {
              fresh.fiber = fiber;
              return { job: fresh, dropped, queued: true };
            }),
          );
        },
      );
      yield* Effect.forEach(asked.dropped, drop, { discard: true });
      // A build read before this, as a turn's lands, says "never" until told:
      // queued behind another measure, nothing else would tell it for minutes.
      if (asked.queued)
        yield* operations.changed(
          build.root,
          GAME_FACTS_EVENT,
          `Build ${build.build.slice(0, 8)} queued to measure.`,
        );
      const job = asked.job;
      if (job === null) {
        const facts = yield* read(build);
        return {
          ...facts,
          message: `Queued behind ${QUEUE_LIMIT} measurements already; try again shortly.`,
        };
      }
      if (options.waitFor !== undefined)
        yield* Deferred.await(options.upTo === "boots" ? job.booted : job.done).pipe(
          Effect.timeoutOption(options.waitFor),
          Effect.ignore,
        );
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
          // Saved plays are replayed when a build is measured, never owed by a row from before.
          !FACT_NAMES.some((name) => name !== "savedPlays" && stored[name] === undefined) ||
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
