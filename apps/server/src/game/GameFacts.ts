// @effect-diagnostics nodeBuiltinImport:off -- A measurement writes the harness's bots into a build's copy and moves their evidence into the game's logs on disk.
// A build's facts: measured once per engine-project tree and harness, in a
// copy of the build (GameBuildCopies), never in the game folder, and kept in
// one table. One measurement runs at a time on the server; every bot start
// still passes the memory gate. A tier is written as soon as it is measured,
// so a restart loses only the tier in flight, and the next measure does what
// is missing. A tool or machine fault is stored as "not measured" with
// whether waiting can clear it, and every measure tries those again.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import {
  GAME_FACTS_BOUNDS,
  GAME_FACTS_EVENT,
  GameBuildFacts,
  GameBuildId,
  type GameBotRunResult,
  type GameEngineId,
  GameOperationError,
} from "@kurambit/contracts";
import {
  bootsFact,
  faultOf,
  firstResponseOf,
  notMeasured,
  skilledFact,
  tierEvidenceOf,
  tierFact,
  tierWallSeconds,
  winnableOf,
} from "./buildFacts.ts";
import * as GameBot from "./GameBot.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProcesses from "./GameProcesses.ts";
import { findExecutable } from "./GameProcesses.ts";
import * as GameService from "./GameService.ts";
import { resolveTemplatesDirectory } from "./templates.ts";
import { measureVideo, playSpan } from "./videoSignals.ts";

/** Changes when the server's reading of a measurement changes; the bot files are hashed besides. */
const FACTS_VERSION = 1;
/** A measurement's operations on copies are its own: no thread owns them. */
const OWNER = "game-facts:measure";
/** Measures started by a person that may wait for the one running. */
const QUEUE_LIMIT = 3;
const TIER_FILES = ["tier.mjs", "idle.mjs", "masher.mjs", "sensors.mjs"];

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
  measuredAt: Schema.NullOr(Schema.String),
  renderer: Schema.NullOr(Schema.String),
  boots: Schema.optionalKey(GameBuildFacts.fields.boots),
  idle: Schema.optionalKey(GameBuildFacts.fields.idle),
  masher: Schema.optionalKey(GameBuildFacts.fields.masher),
  skilled: Schema.optionalKey(GameBuildFacts.fields.skilled),
  liveness: Schema.optionalKey(GameBuildFacts.fields.liveness),
  firstResponse: Schema.optionalKey(GameBuildFacts.fields.firstResponse),
});
type Stored = typeof Stored.Type;
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
      longestStallMs: Schema.optionalKey(Schema.Number),
    }),
  ),
);

/** The facts a tier's run writes. */
type Tier = "boots" | "idle" | "masher" | "skilled";
const TIER_FACTS: Readonly<Record<Tier, ReadonlyArray<keyof Stored>>> = {
  boots: ["boots"],
  idle: ["idle"],
  masher: ["masher", "liveness", "firstResponse"],
  skilled: ["skilled"],
};
const TIERS: ReadonlyArray<Tier> = ["boots", "idle", "masher", "skilled"];
/** About how long each tier takes, for the message. */
const TIER_SECONDS: Readonly<Record<Tier, number>> = {
  boots: 20,
  idle: 80,
  masher: 85,
  skilled: 80,
};

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
     * reason waiting clears, an older harness, a changed tester bot) and
     * returns at once, or after `waitFor` if it finishes sooner. A person's
     * measure (`queue: "person"`) waits behind at most three others; past
     * that it starts nothing and says so.
     */
    readonly measure: (
      build: ResolvedBuild,
      options?: { readonly waitFor?: Duration.Input; readonly queue?: "person" | "background" },
    ) => Effect.Effect<GameBuildFacts>;
  }
>()("kurambit/game/GameFacts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const game = yield* GameService.GameService;
  const copies = yield* GameBuildCopies.GameBuildCopies;
  const bots = yield* GameBot.GameBot;
  const operations = yield* GameOperations.GameOperations;
  const processes = yield* GameProcesses.GameProcesses;
  const templates = yield* resolveTemplatesDirectory().pipe(Effect.orDie);
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
  const jobs = yield* FiberMap.make<string, void>();
  const permit = yield* Semaphore.make(1);
  /** What each job in flight will measure, and whether it is still waiting for the permit. */
  const inFlight = new Map<string, { readonly tiers: ReadonlySet<Tier>; waiting: boolean }>();

  const load = (key: string) =>
    sql<{ readonly harness: string; readonly payload_json: string }>`
      SELECT harness, payload_json FROM game_build_facts WHERE facts_key = ${key}
    `.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (row === undefined) return null;
        const stored = decodeStored(row.payload_json);
        return Option.isSome(stored) ? { harness: row.harness, stored: stored.value } : null;
      }),
      // An unreadable row is no facts: the next measure writes it again.
      Effect.orElseSucceed(() => null),
    );
  const save = (key: string, stored: Stored) =>
    sql`
      INSERT INTO game_build_facts (facts_key, harness, payload_json, updated_at)
      VALUES (${key}, ${harness}, ${encodeStored(stored)}, ${stored.measuredAt ?? ""})
      ON CONFLICT (facts_key) DO UPDATE SET
        harness = excluded.harness,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A build's facts could not be saved.", { key, cause }),
      ),
    );

  const NEVER = notMeasured("not measured yet", true);
  const view = (
    build: ResolvedBuild,
    found: { readonly harness: string; readonly stored: Stored } | null,
  ): GameBuildFacts => {
    const job = inFlight.get(build.key);
    const stored = found?.stored;
    const pending = (fact: keyof Stored) =>
      job !== undefined &&
      TIERS.some((tier) => job.tiers.has(tier) && TIER_FACTS[tier].includes(fact));
    const get = <K extends "boots" | "idle" | "masher" | "skilled" | "liveness" | "firstResponse">(
      fact: K,
    ): Fact<K> =>
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
    };
    const all = Object.values(facts);
    const state =
      job !== undefined
        ? job.waiting
          ? "queued"
          : "measuring"
        : found === null
          ? "never"
          : found.harness !== harness
            ? "stale"
            : all.every((fact) => fact.status === "measured")
              ? "measured"
              : "incomplete";
    const left =
      job === undefined
        ? 0
        : TIERS.filter((tier) => job.tiers.has(tier)).reduce(
            (sum, tier) => sum + TIER_SECONDS[tier],
            0,
          );
    const queued = [...inFlight.values()].filter((entry) => entry.waiting).length;
    const message =
      state === "queued"
        ? `Queued behind ${Math.max(1, queued - 1)} other measurement${queued - 1 === 1 ? "" : "s"}; about ${Math.ceil(left / 60)} min once it starts.`
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
          const stored = decodeStored(row.payload_json);
          return Option.isSome(stored)
            ? [[row.facts_key, { harness: row.harness, stored: stored.value }] as const]
            : [];
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
  // tier never measured, one not measured for a reason waiting clears, and
  // the skilled tier again when the tester's bot changed.
  const planOf = (
    found: { readonly harness: string; readonly stored: Stored } | null,
    bot: { readonly hash: string } | null,
  ): ReadonlySet<Tier> => {
    if (found === null || found.harness !== harness) return new Set(TIERS);
    const stored = found.stored;
    const needs = (fact: Stored[keyof Stored] | undefined) =>
      fact === undefined ||
      typeof fact !== "object" ||
      fact === null ||
      !("status" in fact) ||
      fact.status === "pending" ||
      (fact.status === "not-measured" && fact.retry);
    const tiers = new Set<Tier>();
    for (const tier of TIERS)
      if (TIER_FACTS[tier].some((fact) => needs(stored[fact]))) tiers.add(tier);
    const skilled = stored.skilled;
    const botChanged =
      bot === null
        ? skilled?.status === "measured"
        : skilled?.status !== "measured" || skilled.value.bot.hash !== bot.hash;
    if (botChanged) tiers.add("skilled");
    // A build that did not boot gets nothing more until its boot is measured again.
    return tiers;
  };

  const moveEvidence = (root: string, key: string, tier: Tier, result: GameBotRunResult) =>
    Effect.promise(async () => {
      const from = NodePath.dirname(result.tracePath);
      const name = `game-bot-facts-${key.split(":")[1]?.slice(0, 12) ?? "x"}-${tier}`;
      const to = NodePath.join(root, "builds", "logs", name);
      try {
        await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
        await NodeFSP.rm(to, { recursive: true, force: true });
        await NodeFSP.rename(from, to).catch(async () => {
          // The copies live under Kurambit's folder, which may be another filesystem.
          await NodeFSP.cp(from, to, { recursive: true });
          await NodeFSP.rm(from, { recursive: true, force: true });
        });
        return NodePath.relative(root, to).split(NodePath.sep).join("/");
      } catch {
        return null;
      }
    });

  const rendererOf = (copy: string, engine: GameEngineId) =>
    engine !== "godot"
      ? Effect.succeed(null)
      : Effect.promise(async () => {
          const text = await NodeFSP.readFile(
            NodePath.join(copy, "godot", "project.godot"),
            "utf8",
          ).catch(() => "");
          const method = /^renderer\/rendering_method="([^"]+)"/m.exec(text)?.[1] ?? "forward_plus";
          return method === "gl_compatibility"
            ? null
            : "Compatibility; native exports draw Forward+";
        });

  const measureJob = (build: ResolvedBuild, tiers: ReadonlySet<Tier>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, key } = build;
        const announce = (message: string) => operations.changed(root, GAME_FACTS_EVENT, message);
        yield* copies.track(root, FiberMap.remove(jobs, key));
        const copy = yield* copies.lease(root, { oid: build.build, key });
        const loaded = yield* load(key);
        // A new harness measures from nothing: no older reading is kept beside newer ones.
        let stored: Stored =
          loaded !== null && loaded.harness === harness
            ? loaded.stored
            : { build: build.build, measuredAt: null, renderer: null };
        stored = { ...stored, renderer: yield* rendererOf(copy, build.engine) };
        const write = (patch: Partial<Stored>) =>
          Effect.gen(function* () {
            stored = { ...stored, ...patch, measuredAt: DateTime.formatIso(yield* DateTime.now) };
            yield* save(key, stored);
            yield* announce(
              `Build ${build.build.slice(0, 8)}: ${Object.keys(patch).join(", ")} measured.`,
            );
          });
        const notRun = (why: string, retry: boolean) => notMeasured(why, retry);

        if (tiers.has("boots")) {
          const boots = yield* game.checkIn(copy, OWNER).pipe(
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
        const boots = stored.boots;
        const unbooted = boots?.status === "measured" && !boots.value.ok;
        const blocked =
          unbooted || boots?.status !== "measured"
            ? notRun(
                unbooted
                  ? "the build failed its boot check"
                  : `its boot check was not measured${boots?.status === "not-measured" ? `: ${boots.why}` : ""}`,
                !unbooted,
              )
            : null;

        // The harness's own bots, fresh from the server's templates, never the game's.
        yield* Effect.tryPromise({
          try: async () => {
            const dir = NodePath.join(copy, ".studio", "bot", "kit");
            await NodeFSP.mkdir(dir, { recursive: true });
            await NodeFSP.cp(kit, dir, { recursive: true, force: true });
            await NodeFSP.writeFile(NodePath.join(dir, "tier-bounds.mjs"), boundsFile);
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "Build facts",
              path: copy,
              reason: "io",
              detail: "the harness's bots could not be written",
              cause,
            }),
        }).pipe(Effect.ignore);

        const runBot = (file: string, seconds: number, decider: "policy" | "jev") =>
          game.botRunIn(copy, { file, seconds, mode: "play", decider });
        const tier = (name: "idle" | "masher", playSeconds: number) =>
          runBot(`.studio/bot/kit/${name}.mjs`, tierWallSeconds(playSeconds), "policy").pipe(
            Effect.flatMap((result) =>
              Effect.map(moveEvidence(root, key, name, result), (evidence) => ({
                result,
                evidence,
                fact: tierFact(result, playSeconds, evidence),
              })),
            ),
            Effect.catchTags({
              GameOperationError: (error) =>
                Effect.succeed({
                  result: null,
                  evidence: null,
                  fact:
                    faultOf(error) ??
                    ({
                      status: "measured",
                      value: {
                        ending: "did-not-boot",
                        at: null,
                        played: 0,
                        note: (error.detail ?? error.reason).slice(0, 200),
                        evidence: null,
                      },
                    } as const),
                }),
            }),
          );

        if (tiers.has("idle")) {
          if (blocked !== null) yield* write({ idle: blocked });
          else yield* write({ idle: (yield* tier("idle", GAME_FACTS_BOUNDS.idleSeconds)).fact });
        }

        if (tiers.has("masher")) {
          if (blocked !== null)
            yield* write({ masher: blocked, liveness: blocked, firstResponse: blocked });
          else {
            const run = yield* tier("masher", GAME_FACTS_BOUNDS.masherSeconds);
            const firstResponse =
              run.result === null
                ? notRun("the random-input run was not measured", true)
                : run.fact.status === "measured"
                  ? firstResponseOf(run.result)
                  : notRun(
                      `the random-input run was not measured: ${run.fact.status === "not-measured" ? run.fact.why : ""}`,
                      run.fact.status === "not-measured" && run.fact.retry,
                    );
            const liveness =
              run.result === null || run.evidence === null || run.fact.status !== "measured"
                ? notRun("the random-input run has no play video", run.fact.status !== "measured")
                : yield* livenessOf(copy, NodePath.join(root, run.evidence), run.result);
            yield* write({ masher: run.fact, liveness, firstResponse });
          }
        }

        if (tiers.has("skilled")) {
          const bot = yield* currentBot(root);
          if (blocked !== null) yield* write({ skilled: blocked });
          else if (bot === null)
            yield* write({
              skilled: notRun(
                "this game has no play-mode bot yet (a tester writes one in a run)",
                false,
              ),
            });
          else {
            const copied = yield* Effect.promise(() =>
              NodeFSP.cp(
                NodePath.join(root, ".studio", "bot"),
                NodePath.join(copy, ".studio", "bot"),
                {
                  recursive: true,
                  force: true,
                },
              ).then(
                () => true,
                () => false,
              ),
            );
            const skilled = !copied
              ? notRun("the game's bot files could not be copied", true)
              : yield* runBot(
                  bot.file,
                  tierWallSeconds(GAME_FACTS_BOUNDS.skilledSeconds),
                  bot.decider,
                ).pipe(
                  Effect.flatMap((result) =>
                    Effect.map(moveEvidence(root, key, "skilled", result), (evidence) =>
                      skilledFact(result, bot, evidence),
                    ),
                  ),
                  Effect.catchTags({
                    GameOperationError: (error) =>
                      Effect.succeed(
                        faultOf(error) ?? {
                          status: "measured" as const,
                          value: {
                            ending: "did-not-boot" as const,
                            at: null,
                            played: 0,
                            note: (error.detail ?? error.reason).slice(0, 200),
                            evidence: null,
                            bot,
                            botWord: null,
                          },
                        },
                      ),
                  }),
                );
            yield* write({ skilled });
          }
        }
      }),
    );

  const livenessOf = (copy: string, evidence: string, result: GameBotRunResult) =>
    Effect.gen(function* () {
      const ffmpeg = yield* Effect.promise(() =>
        findExecutable("ffmpeg", {
          pathEnv: process.env.PATH ?? "",
          override: process.env.KURAMBIT_FFMPEG,
        }),
      );
      if (ffmpeg === null) return notMeasured("ffmpeg is not installed", false);
      const sidecar = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(evidence, "run.frames.json"), "utf8").catch(() => null),
      ).pipe(Effect.map((text) => (text === null ? null : Option.getOrNull(decodeSidecar(text)))));
      const frames = sidecar?.frames ?? [];
      const times = tierEvidenceOf(result.status.evidence);
      const span =
        times?.playingAt === null || times?.playingAt === undefined
          ? null
          : playSpan(frames, times.playingAt, times.endedAt);
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
          value: {
            ...signals,
            longestStall:
              typeof sidecar?.longestStallMs === "number"
                ? Number((sidecar.longestStallMs / 1000).toFixed(1))
                : 0,
          },
        })),
        Effect.catchTags({
          GameOperationError: (error) =>
            Effect.succeed(faultOf(error) ?? notMeasured(error.message, true)),
        }),
      );
    });

  const measure: GameFacts["Service"]["measure"] = (build, options = {}) =>
    Effect.gen(function* () {
      const existing = yield* FiberMap.get(jobs, build.key);
      if (Option.isNone(existing)) {
        const found = yield* load(build.key);
        const tiers = planOf(found, yield* currentBot(build.root));
        if (tiers.size === 0) return view(build, found);
        const waiting = [...inFlight.values()].filter((entry) => entry.waiting).length;
        if (options.queue === "person" && waiting >= QUEUE_LIMIT)
          return {
            ...view(build, found),
            message: `Queued behind ${waiting} measurements; try again shortly.`,
          };
        const entry = { tiers, waiting: true };
        inFlight.set(build.key, entry);
        yield* FiberMap.run(
          jobs,
          build.key,
          permit
            .withPermits(1)(
              Effect.suspend(() => {
                entry.waiting = false;
                return operations
                  .changed(
                    build.root,
                    GAME_FACTS_EVENT,
                    `Measuring build ${build.build.slice(0, 8)}.`,
                  )
                  .pipe(Effect.andThen(measureJob(build, tiers)));
              }),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("A build's measurement failed.", { key: build.key, cause }),
              ),
              Effect.ensuring(
                Effect.suspend(() => {
                  if (inFlight.get(build.key) === entry) inFlight.delete(build.key);
                  return operations.changed(
                    build.root,
                    GAME_FACTS_EVENT,
                    `Build ${build.build.slice(0, 8)} measured.`,
                  );
                }),
              ),
            ),
          { onlyIfMissing: true },
        );
      }
      if (options.waitFor !== undefined) {
        const fiber = yield* FiberMap.get(jobs, build.key);
        if (Option.isSome(fiber))
          yield* Fiber.await(fiber.value).pipe(
            Effect.timeoutOption(options.waitFor),
            Effect.ignore,
          );
      }
      return yield* read(build);
    });

  return GameFacts.of({ harness, read, readMany, measure });
});

export const layer = Layer.effect(GameFacts, make);
