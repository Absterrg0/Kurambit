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
import { ThreadId } from "@kurambit/contracts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GameOperations from "../GameOperations.ts";
import * as GameArt from "./GameArt.ts";

const THREAD = ThreadId.make("thread-art");
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
}) =>
  GameArt.layerWithHost.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GameArt.GameArtHost, {
          codex: Effect.succeed({ ready: false as const, message: "no codex in tests" }),
          keepGoingStep: () => Effect.succeed(false),
          packPicture: () => Effect.die("no library in tests"),
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
  it.live("refuses over the daily limit, with the numbers, and records nothing", () =>
    Effect.gen(function* () {
      const base = yield* tempGame();
      const root = NodePath.join(base, "game");
      const art = yield* GameArt.GameArt;
      const refused = yield* art
        .generate(root, THREAD, {
          lane: "music",
          prompt: "a calm loop",
          name: "theme",
          options: { seconds: 120 },
        })
        .pipe(Effect.flip);
      assert.match(refused.message, /\$0\.00 spent today.*\$0\.30.*\$0\.10 limit/);
      assert.deepStrictEqual((yield* art.list(root)).generations, []);
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
          const started = yield* art.generate(root, THREAD, {
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
          const ready = yield* art.wait(root, { id: started.generation.id, seconds: 30 });
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
          const picked = yield* art.choose(root, started.generation.id, 1);
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
            .generate(root, THREAD, {
              lane: "image",
              prompt: "x",
              name: "x",
              references: ["../secret.png"],
            })
            .pipe(Effect.flip);
          assert.match(escaped.message, /inside the game/);
          const started = yield* art.generate(root, THREAD, {
            lane: "image",
            prompt: "x",
            name: "x",
          });
          const ended = yield* art.wait(root, { id: started.generation.id, seconds: 30 });
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
            const ended = yield* art.wait(root, { id: generation.id, seconds: 30 });
            assert.strictEqual(ended.generation.state, "done");
            assert.deepStrictEqual(ended.generation.files, ["art/generated/model/crate/crate.glb"]);
            assert.strictEqual(ended.generation.costUsd, 0.3);
            assert.match(ended.text, /estimated/);
            assert.include(asked, "https://openapi.tripo3d.com/v3/tasks/t_crate");
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
                      output: { pbr_model: "https://cdn.tripo.example/crate.glb" },
                    },
                  })
                : new Response(new Uint8Array([1, 2, 3]));
            },
          }),
        );
      }).pipe(Effect.provide(sql));
    }).pipe(Effect.scoped),
  );
});
