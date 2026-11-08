// @effect-diagnostics nodeBuiltinImport:off -- The tests make real game folders on disk.
// Money and data only: the daily limit refuses, a generation still making when the server
// stopped is polled again, and files never leave the game (a taken name gets a new folder).
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ThreadId, type GameCharacterRoute } from "@kurambit/contracts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GameOperations from "../GameOperations.ts";
import * as GameArt from "./GameArt.ts";

const THREAD = ThreadId.make("thread-art");
/** The host below resolves a thread to the folder its id names, so each test's game is its own. */
const inGame = (root: string) => ThreadId.make(root);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const tempGame = () =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = await NodeFSP.mkdtemp(
        NodePath.join(process.env.TMPDIR ?? NodeOS.tmpdir(), "art-test-"),
      );
      await NodeFSP.mkdir(NodePath.join(dir, "game"));
      return dir;
    }),
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );

/** Answers by URL: what each provider would have said. */
const fakeHttp = (answer: (url: string) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, answer(request.url))),
    ),
  );

const layer = (input: {
  readonly base: string;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly answer?: (url: string) => Response;
  readonly sql?: Layer.Layer<SqlClient.SqlClient>;
  readonly route?: GameCharacterRoute;
}) =>
  GameArt.layerWithHost.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GameArt.GameArtHost, {
          codex: Effect.succeed({ ready: false as const, message: "no codex in tests" }),
          keepGoingStep: () => Effect.succeed(false),
          packPicture: () => Effect.die("no library in tests"),
          standardBody: Effect.die("no library in tests"),
          gameRoot: (threadId) => Effect.succeed(threadId),
          characterRoute: () => Effect.succeed(input.route ?? "library"),
        }),
        Layer.mock(GameOperations.GameOperations)({
          current: () => null,
          events: Stream.empty,
          changed: () => Effect.void,
        }),
        fakeHttp(input.answer ?? (() => new Response("{}", { status: 500 }))),
        input.sql ?? SqlitePersistence.layerMemory,
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest(input.settings ?? {})),
    Layer.provideMerge(ServerConfig.layerTest(input.base, input.base)),
    Layer.provideMerge(NodeServices.layer),
  );

const openAiImages = (count: number) => () =>
  Response.json({
    data: Array.from({ length: count }, () => ({ b64_json: PNG.toString("base64") })),
    usage: { output_tokens: 100, input_tokens_details: { image_tokens: 0, text_tokens: 10 } },
  });

describe("GameArt", () => {
  it.live("treats a key the provider refused as not set up, so nothing is routed to it", () => {
    const seen: string[] = [];
    return Effect.gen(function* () {
      const base = yield* tempGame();
      const root = NodePath.join(base, "game");
      const art = yield* GameArt.GameArt;
      // Saved and never checked, the key reads as ready.
      assert.strictEqual((yield* art.lanes).character, "tripo");
      const tripo = (yield* art.providers).providers.find((entry) => entry.provider === "tripo");
      assert.strictEqual(tripo?.ready, false);
      assert.match(tripo?.message ?? "", /refused/);
      // Once refused, the agent's artLanes and the route both know it.
      assert.strictEqual((yield* art.lanes).character, null);
      const before = seen.length;
      const refused = yield* art
        .generate(inGame(root), { lane: "character", prompt: "a cat", name: "cat" })
        .pipe(Effect.flip);
      assert.match(refused.message, /Tripo key|refused/);
      assert.strictEqual(seen.length, before);
      assert.deepStrictEqual((yield* art.list(inGame(root))).generations, []);
    }).pipe(
      Effect.provide(
        layer({
          base: NodePath.join(process.env.TMPDIR ?? NodeOS.tmpdir(), "art-test-refused"),
          settings: { gameTripoApiKey: "tcli_not_a_secret" },
          route: "generated",
          answer: (url) => {
            seen.push(url);
            return Response.json(
              { code: 1002, message: "Invalid API key. API key must start with 'tsk_'." },
              { status: 401 },
            );
          },
        }),
      ),
      Effect.scoped,
    );
  });

  it.live("refuses over the daily limit, with the numbers, and records nothing", () =>
    Effect.gen(function* () {
      const base = yield* tempGame();
      const root = NodePath.join(base, "game");
      const art = yield* GameArt.GameArt;
      const refused = yield* art
        .generate(inGame(root), {
          lane: "music",
          prompt: "a calm loop",
          name: "theme",
          options: { seconds: 120 },
        })
        .pipe(Effect.flip);
      assert.match(refused.message, /\$0\.00 spent today.*\$0\.30.*\$0\.10 limit/);
      assert.deepStrictEqual((yield* art.list(inGame(root))).generations, []);
    }).pipe(
      Effect.provide(
        layer({
          base: NodePath.join(process.env.TMPDIR ?? NodeOS.tmpdir(), "art-test-limit"),
          settings: { gameElevenLabsApiKey: "xi", gameArtDailyLimitUsd: 0.1 },
        }),
      ),
      Effect.scoped,
    ),
  );

  it.live("writes candidates inside the game, numbers a taken name, and keeps only the pick", () =>
    Effect.gen(function* () {
      const base = yield* tempGame();
      const root = NodePath.join(base, "game");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, "art/generated/image/hero"), { recursive: true }),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "look.png"), PNG));
      yield* Effect.provide(
        Effect.gen(function* () {
          const art = yield* GameArt.GameArt;
          const started = yield* art.generate(inGame(root), {
            lane: "image",
            prompt: "a hero",
            name: "hero",
            directions: [
              {
                label: "Warm toon",
                prompt: "chunky toon shading, warm palette",
                style: "look.png",
              },
              { label: "Cold low-poly", prompt: "flat low-poly, cold palette" },
            ],
          });
          assert.strictEqual(started.generation.name, "hero_2");
          // The limit reserves the estimate before it is spent; the text must not call it spent.
          assert.match(started.text, /daily limit used today, counting this estimate\)/);
          const ready = yield* art.wait(inGame(root), { id: started.generation.id, seconds: 30 });
          assert.strictEqual(ready.generation.state, "choosing");
          assert.deepStrictEqual(
            ready.generation.candidates.map((candidate) => candidate.preview),
            [
              "art/generated/image/hero_2/hero_2.c1.png",
              "art/generated/image/hero_2/hero_2.c2.png",
            ],
          );
          assert.deepStrictEqual(
            ready.generation.candidates.map((candidate) => candidate.label),
            ["Warm toon", "Cold low-poly"],
          );
          const picked = yield* art.choose(inGame(root), started.generation.id, 1);
          assert.strictEqual(picked.generation.chosenBy, "person");
          assert.deepStrictEqual(picked.generation.files, [
            "art/generated/image/hero_2/hero_2.c2.png",
          ]);
          const left = yield* Effect.promise(() =>
            NodeFSP.readdir(NodePath.join(root, "art/generated/image/hero_2")),
          );
          assert.deepStrictEqual(left.toSorted(), ["hero_2.c2.png", "hero_2.generation.json"]);
          const record = JSON.parse(
            yield* Effect.promise(() =>
              NodeFSP.readFile(
                NodePath.join(root, "art/generated/image/hero_2/hero_2.generation.json"),
                "utf8",
              ),
            ),
          );
          assert.strictEqual(record.ai, true);
          assert.strictEqual(record.provider, "openai");
          assert.deepStrictEqual(record.directions, [
            { label: "Warm toon", style: "look.png" },
            { label: "Cold low-poly", style: null },
          ]);
        }),
        layer({ base, settings: { gameOpenAiApiKey: "sk" }, answer: openAiImages(2) }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("refuses a character off the generated route before any provider is asked", () =>
    Effect.gen(function* () {
      const base = yield* tempGame();
      const root = NodePath.join(base, "game");
      const asked: string[] = [];
      yield* Effect.provide(
        Effect.gen(function* () {
          const art = yield* GameArt.GameArt;
          for (const lane of ["character", "creature"] as const) {
            const refused = yield* art
              .generate(inGame(root), { lane, prompt: "a knight", name: "knight" })
              .pipe(Effect.flip);
            assert.match(refused.message, /Nothing was asked of a provider or spent/);
            assert.match(refused.message, /only the person changes how characters are made/);
          }
          const listed = yield* art.list(inGame(root));
          assert.deepStrictEqual(listed.generations, []);
          assert.strictEqual(listed.spentTodayUsd, 0);
          assert.deepStrictEqual(asked, []);
        }),
        layer({
          base,
          settings: { gameTripoApiKey: "tk", gameMeshyApiKey: "mk" },
          answer: (url) => {
            asked.push(url);
            return new Response("{}", { status: 500 });
          },
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("keeps the looks that came back when one direction is refused, and counts them", () =>
    Effect.gen(function* () {
      const base = yield* tempGame();
      const root = NodePath.join(base, "game");
      let calls = 0;
      yield* Effect.provide(
        Effect.gen(function* () {
          const art = yield* GameArt.GameArt;
          const started = yield* art.generate(inGame(root), {
            lane: "image",
            prompt: "a hero",
            name: "hero",
            directions: [
              { label: "Warm toon", prompt: "chunky toon shading, warm palette" },
              { label: "Cold low-poly", prompt: "flat low-poly, cold palette" },
            ],
          });
          const ready = yield* art.wait(inGame(root), { id: started.generation.id, seconds: 30 });
          // One look is still the person's to take or leave: it waits on their pick.
          assert.strictEqual(ready.generation.state, "choosing");
          assert.strictEqual(ready.generation.candidates.length, 1);
          const kept = ready.generation.candidates[0]!.label!;
          const refused = ready.generation.refused ?? [];
          assert.strictEqual(refused.length, 1);
          assert.deepStrictEqual([kept, refused[0]!.label].toSorted(), [
            "Cold low-poly",
            "Warm toon",
          ]);
          assert.match(refused[0]!.reason, /safety system/);
          assert.match(ready.text, /was refused by the provider/);
          // The image that came back was paid for: it is counted, and it is on disk.
          const cost = ready.generation.costUsd ?? 0;
          assert.isAbove(cost, 0);
          assert.strictEqual((yield* art.list(inGame(root))).spentTodayUsd, cost);
          const preview = ready.generation.candidates[0]!.preview;
          yield* Effect.promise(() => NodeFSP.access(NodePath.join(root, preview)));
          const picked = yield* art.choose(inGame(root), started.generation.id, 0);
          assert.strictEqual(picked.generation.state, "done");
          // An undo that takes its files away reads as undone, not as a broken record.
          yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, preview)));
          const listed = (yield* art.list(inGame(root))).generations[0]!;
          assert.strictEqual(listed.filesUndone, true);
        }),
        layer({
          base,
          settings: { gameOpenAiApiKey: "sk" },
          answer: () => {
            calls += 1;
            return calls === 1
              ? openAiImages(1)()
              : Response.json(
                  {
                    error: {
                      message: "Your request was rejected by the safety system.",
                      code: "moderation_blocked",
                    },
                  },
                  { status: 400 },
                );
          },
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("never writes through a link out of the game, and refuses references outside it", () =>
    Effect.gen(function* () {
      const base = yield* tempGame();
      const root = NodePath.join(base, "game");
      const outside = NodePath.join(base, "outside");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(outside);
        await NodeFSP.mkdir(NodePath.join(root, "art"), { recursive: true });
        await NodeFSP.symlink(outside, NodePath.join(root, "art/generated"));
        await NodeFSP.writeFile(NodePath.join(base, "secret.png"), PNG);
      });
      yield* Effect.provide(
        Effect.gen(function* () {
          const art = yield* GameArt.GameArt;
          const escaped = yield* art
            .generate(inGame(root), {
              lane: "image",
              prompt: "x",
              name: "x",
              references: ["../secret.png"],
            })
            .pipe(Effect.flip);
          assert.match(escaped.message, /inside the game/);
          const started = yield* art.generate(inGame(root), {
            lane: "image",
            prompt: "x",
            name: "x",
          });
          const ended = yield* art.wait(inGame(root), { id: started.generation.id, seconds: 30 });
          assert.strictEqual(ended.generation.state, "failed");
          assert.match(ended.generation.error ?? "", /outside the game folder/);
          assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readdir(outside)), []);
        }),
        layer({ base, settings: { gameOpenAiApiKey: "sk" }, answer: openAiImages(1) }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("resumes polling a generation that was making when the server stopped", () =>
    Effect.gen(function* () {
      const base = yield* tempGame();
      const root = NodePath.join(base, "game");
      const now = DateTime.formatIso(yield* DateTime.now);
      const generation = {
        id: "gen-recover-1",
        threadId: THREAD,
        lane: "model",
        provider: "tripo",
        name: "crate",
        prompt: "a crate",
        references: [],
        state: "making",
        candidates: [],
        chosen: null,
        chosenBy: null,
        files: [],
        estimateUsd: 0.3,
        costUsd: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      const meta = {
        job: {
          stage: "mesh",
          task: "t_crate",
          mesh: "t_crate",
          rig: null,
          lane: "model",
          body: null,
          clips: [],
        },
        folder: "art/generated/model/crate",
        autopilot: false,
        kept: [],
        costEstimated: false,
        candidateFiles: [],
        options: {},
      };
      // One database across the "restart": the row is written before GameArt starts.
      const sql = SqlitePersistence.layerMemory;
      yield* Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;
        yield* client`
            INSERT INTO game_art_generations
              (id, root, thread_id, state, cost_usd, payload_json, remote_json, created_at, updated_at)
            VALUES (${generation.id}, ${root}, ${THREAD}, 'making', 0.3, ${JSON.stringify(generation)},
              ${JSON.stringify(meta)}, ${now}, ${now})
          `;
        const asked: string[] = [];
        yield* Effect.provide(
          Effect.gen(function* () {
            const art = yield* GameArt.GameArt;
            const ended = yield* art.wait(inGame(root), { id: generation.id, seconds: 30 });
            assert.strictEqual(ended.generation.state, "done");
            assert.deepStrictEqual(ended.generation.files, ["art/generated/model/crate/crate.glb"]);
            assert.strictEqual(ended.generation.costUsd, 0.3);
            assert.match(ended.text, /estimated/);
            assert.include(asked, "https://openapi.tripo3d.ai/v3/tasks/t_crate");
          }),
          layer({
            base,
            settings: { gameTripoApiKey: "tk" },
            sql: Layer.succeed(SqlClient.SqlClient, client),
            answer: (url) => {
              asked.push(url);
              return url.endsWith("/tasks/t_crate")
                ? Response.json({
                    code: 0,
                    data: {
                      status: "success",
                      output: { model_url: "https://cdn.tripo.example/crate.glb" },
                    },
                  })
                : new Response(new Uint8Array([1, 2, 3]));
            },
          }),
        );
      }).pipe(Effect.provide(sql));
    }).pipe(Effect.scoped),
  );

  /** A Tripo character row left `making` by a server that stopped, picked up by a new one. */
  const resumed = (input: {
    readonly id: string;
    readonly job: Record<string, unknown>;
    readonly createdAt?: string;
    readonly meta?: Record<string, unknown>;
    readonly answer: (url: string, method: string) => Response;
  }) =>
    Effect.gen(function* () {
      const base = yield* tempGame();
      const root = NodePath.join(base, "game");
      const now = DateTime.formatIso(yield* DateTime.now);
      const generation = {
        id: input.id,
        threadId: THREAD,
        lane: "character",
        provider: "tripo",
        name: "hero",
        prompt: "a hero",
        references: [],
        state: "making",
        candidates: [],
        chosen: null,
        chosenBy: null,
        files: [],
        estimateUsd: 0.85,
        costUsd: null,
        error: null,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      };
      const meta = {
        job: input.job,
        folder: "art/generated/character/hero",
        autopilot: false,
        kept: [],
        costEstimated: false,
        candidateFiles: [],
        options: {},
        ...input.meta,
      };
      const asked: string[] = [];
      const client = yield* SqlClient.SqlClient;
      yield* client`
        INSERT INTO game_art_generations
          (id, root, thread_id, state, cost_usd, payload_json, remote_json, created_at, updated_at)
        VALUES (${generation.id}, ${root}, ${THREAD}, 'making', 0.85, ${JSON.stringify(generation)},
          ${JSON.stringify(meta)}, ${now}, ${now})
      `;
      const ended = yield* Effect.provide(
        Effect.gen(function* () {
          const art = yield* GameArt.GameArt;
          return yield* art.wait(inGame(root), { id: generation.id, seconds: 30 });
        }),
        layer({
          base,
          settings: { gameTripoApiKey: "tk" },
          sql: Layer.succeed(SqlClient.SqlClient, client),
          answer: (url) => {
            asked.push(url);
            return input.answer(url, "");
          },
        }),
      );
      return { ended, asked };
    }).pipe(Effect.provide(SqlitePersistence.layerMemory), Effect.scoped);

  const meshJob = {
    stage: "mesh",
    task: "t_mesh",
    mesh: "t_mesh",
    rig: null,
    lane: "character",
    body: null,
    clips: ["preset:idle"],
    credits: 0,
  };

  it.live("starts a paid stage once: an unanswered start is not sent again, and counts", () =>
    Effect.gen(function* () {
      const { ended, asked } = yield* resumed({
        id: "gen-stage-once",
        job: meshJob,
        answer: (url) =>
          url.endsWith("/tasks/t_mesh")
            ? Response.json({ code: 0, data: { status: "success", credits_consumed: 40 } })
            : new Response("bad gateway", { status: 502 }),
      });
      assert.strictEqual(ended.generation.state, "failed");
      assert.match(ended.generation.error ?? "", /may have started the rig anyway/);
      assert.strictEqual(asked.filter((url) => url.endsWith("/animations/rig")).length, 1);
      assert.strictEqual(ended.generation.costUsd, 0.85);
    }),
  );

  it.live("never resends a stage whose start was saved before a restart", () =>
    Effect.gen(function* () {
      const { ended, asked } = yield* resumed({
        id: "gen-stage-intent",
        job: { ...meshJob, pending: "rig", credits: 40 },
        answer: () => Response.json({ code: 0, data: { task_id: "t_rig_again" } }),
      });
      assert.strictEqual(ended.generation.state, "failed");
      assert.match(ended.generation.error ?? "", /while starting the rig/);
      assert.deepStrictEqual(asked, []);
      assert.strictEqual(ended.generation.costUsd, 0.85);
    }),
  );

  it.live(
    "a model the person had not yet been shown before a restart waits for them, unrigged",
    () =>
      Effect.gen(function* () {
        const { ended, asked } = yield* resumed({
          id: "gen-look-restart",
          job: { ...meshJob, pending: "rig", credits: 30, review: true },
          meta: {
            review: true,
            kept: ["art/generated/character/hero/hero.model.glb"],
            spent: { usd: 0.3, estimated: false },
          },
          answer: () => Response.json({ code: 0, data: { task_id: "t_rig_unasked" } }),
        });
        assert.strictEqual(ended.generation.state, "choosing");
        assert.deepStrictEqual(asked, []);
        assert.strictEqual(ended.generation.candidates[0]?.label, "Rig this");
        assert.strictEqual(ended.generation.costUsd, 0.3);
      }),
  );

  it.live("gives up a job past its lane's deadline, counting the estimate", () =>
    Effect.gen(function* () {
      const { ended } = yield* resumed({
        id: "gen-too-late",
        job: meshJob,
        createdAt: DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 6 })),
        answer: () => Response.json({ code: 0, data: { status: "running" } }),
      });
      assert.strictEqual(ended.generation.state, "failed");
      assert.match(ended.generation.error ?? "", /took longer than/);
      assert.strictEqual(ended.generation.costUsd, 0.85);
    }),
  );
});
