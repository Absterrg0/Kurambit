// Request shapes per adapter, against bodies built from each provider's documented API: these
// protect the person's money (what is asked, how much) and their key (where it goes).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { ArtContext, ArtHttpRequest, ArtReference, ArtRequest } from "./adapter.ts";
import { isProviderUrl, makeArtHttp } from "./adapter.ts";
import {
  codexSavedImagePaths,
  codexTurnFailure,
} from "../../../textGeneration/CodexTextGeneration.ts";
import { elevenlabs, elevenLabsRequest } from "./elevenlabs.ts";
import { google, googleRequest } from "./google.ts";
import { meshy, meshyMeshRequest } from "./meshy.ts";
import { openai, openAiRequest } from "./openai.ts";
import {
  tripo,
  tripoMeshBody,
  tripoModelUrls,
  tripoPresets,
  tripoRetargetBody,
  tripoRigBody,
  tripoTextureBody,
} from "./tripo.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const reference: ArtReference = {
  path: "art/key.png",
  absolute: "/games/g/art/key.png",
  mime: "image/png",
  bytes: PNG,
};
const request = (overrides: Partial<ArtRequest> = {}): ArtRequest => ({
  lane: "image",
  prompt: "a red slime",
  candidates: 1,
  options: {},
  references: [],
  ...overrides,
});
/** A request as routing asks a provider's refusal: its pictures counted. */
const asked = (art: ArtRequest) => ({ ...art, references: art.references.length });

/** A context whose HTTP records every call and answers from `answers`, in order. */
const recording = (answers: ReadonlyArray<unknown>) => {
  const calls: Array<{ provider: string; request: ArtHttpRequest }> = [];
  let next = 0;
  const answer = () => Effect.succeed(answers[next++] ?? {});
  const context: ArtContext = {
    key: "test-key",
    http: {
      json: (provider, req) => {
        calls.push({ provider, request: req });
        return answer();
      },
      bytes: (provider, req) => {
        calls.push({ provider, request: req });
        return Effect.succeed(new Uint8Array([1, 2, 3]));
      },
      download: () => Effect.succeed(new Uint8Array([7, 7])),
    },
    codexImages: null,
    scratch: "/tmp/none",
    readFile: () => Effect.succeed(PNG),
  };
  return { calls, context };
};

describe("art adapters: request shapes", () => {
  it("OpenAI generates without references and edits with them, transparent and sized by aspect", () => {
    const plain = openAiRequest(
      request({ candidates: 3, options: { aspect: "16:9", transparent: true } }),
      3,
      "k",
    );
    assert.strictEqual(plain.url, "https://api.openai.com/v1/images/generations");
    assert.deepStrictEqual(plain.json, {
      model: "gpt-image-2.5-sunburst",
      prompt: "a red slime",
      n: 3,
      size: "1536x864",
      quality: "high",
      output_format: "png",
      background: "transparent",
    });
    assert.deepStrictEqual(plain.headers, { authorization: "Bearer k" });
    const edit = openAiRequest(request({ references: [reference, reference] }), 1, "k");
    assert.strictEqual(edit.url, "https://api.openai.com/v1/images/edits");
    assert.strictEqual(edit.form?.getAll("image[]").length, 2);
    assert.strictEqual(edit.form?.get("model"), "gpt-image-2.5-sunburst");
  });

  it.effect("OpenAI asks again one at a time when n comes back short, and prices from usage", () =>
    Effect.gen(function* () {
      const image = { b64_json: Buffer.from(PNG).toString("base64") };
      const usage = {
        output_tokens: 1000,
        input_tokens_details: { image_tokens: 0, text_tokens: 100 },
      };
      const { calls, context } = recording([
        { data: [image], usage },
        { data: [image], usage },
      ]);
      const step = yield* openai.start(context, request({ candidates: 2 }));
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(step.kind, "done");
      if (step.kind !== "done") return;
      assert.strictEqual(step.candidates.length, 2);
      // 1000 × $30/M + 100 × $5/M, twice.
      assert.strictEqual(step.costUsd, 0.061);
    }),
  );

  it("Google sends inline references and the aspect, and refuses a transparent background", () => {
    const body = googleRequest(
      request({ references: [reference], options: { aspect: "3:4" } }),
      "k",
    );
    assert.strictEqual(
      body.url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent",
    );
    assert.deepStrictEqual(body.headers, { "x-goog-api-key": "k" });
    assert.deepStrictEqual(body.json.contents[0]?.parts[1], {
      inlineData: { mimeType: "image/png", data: Buffer.from(PNG).toString("base64") },
    });
    assert.deepStrictEqual(body.json.generationConfig.imageConfig, {
      aspectRatio: "3:4",
      imageSize: "1K",
    });
    assert.match(
      google.refuse?.(asked({ ...request(), options: { transparent: true } })) ?? "",
      /transparent/,
    );
  });

  it.effect(
    "Tripo uploads the concept as the generation's input, then rigs on Unreal names and retargets presets",
    () =>
      Effect.gen(function* () {
        const { calls, context } = recording([
          { code: 0, data: { file_token: "file_1" } },
          { code: 0, data: { task_id: "t_mesh" } },
        ]);
        const step = yield* tripo.start(
          context,
          request({
            lane: "character",
            references: [reference],
            options: { polycount: 8000, height: 1.8, lowPoly: true },
          }),
        );
        assert.strictEqual(calls[0]?.request.url, "https://openapi.tripo3d.ai/v3/files");
        assert.isTrue(calls[0]?.request.form?.has("file"));
        assert.strictEqual(
          calls[1]?.request.url,
          "https://openapi.tripo3d.ai/v3/generation/image-to-model",
        );
        assert.deepStrictEqual(calls[1]?.request.json, {
          model: "v3.1-20260211",
          input: "file_1",
          texture: true,
          pbr: true,
          smart_low_poly: true,
          face_limit: 8000,
          auto_size: true,
        });
        assert.strictEqual(step.kind, "making");
        assert.deepStrictEqual(tripoRigBody({ lane: "character", body: null, mesh: "t_mesh" }), {
          input: "t_mesh",
          model: "v3.0-20260909",
          rig_type: "biped",
          spec: "unreal",
          out_format: "glb",
        });
        assert.deepStrictEqual(tripoRigBody({ lane: "creature", body: "quadruped", mesh: "t" }), {
          input: "t",
          model: "v2.5-20260210",
          rig_type: "quadruped",
          out_format: "glb",
        });
        assert.deepStrictEqual(tripoRetargetBody("t_rig", ["preset:idle", "preset:walk"]), {
          input: "t_rig",
          animations: ["preset:idle", "preset:walk"],
          animate_in_place: true,
          export_with_geometry: true,
          out_format: "glb",
        });
        assert.deepStrictEqual(
          tripoPresets(request({ lane: "character", options: { clips: ["Jump", "slash"] } })),
          { presets: ["preset:jump", "preset:slash"] },
        );
        assert.deepStrictEqual(
          tripoPresets(
            request({ lane: "creature", options: { body: "serpentine", clips: ["walk"] } }),
          ),
          { presets: ["preset:serpentine:march"] },
        );
        assert.match(
          tripo.refuse?.(asked(request({ lane: "character", options: { clips: ["backflip"] } }))) ??
            "",
          /no "backflip" clip.*idle, walk, run/,
        );
        assert.match(
          tripo.refuse?.(
            asked(request({ lane: "creature", options: { body: "avian", clips: ["fly"] } })),
          ) ?? "",
          /no clips for a avian body/,
        );
        assert.propertyVal(
          tripoMeshBody(request({ lane: "model" }), null),
          "prompt",
          "a red slime",
        );
        assert.deepStrictEqual(
          tripoModelUrls({
            model_url: "https://cdn.tripo3d.ai/output/x.glb",
            rendered_image_url: "https://cdn.tripo3d.ai/output/x.webp",
          }),
          ["https://cdn.tripo3d.ai/output/x.glb"],
        );
        // Mesh $0.30 + rig $0.25 + three default clips at $0.10; low-poly adds $0.10.
        assert.strictEqual(
          tripo.estimate({ ...request({ lane: "character" }), references: 1 }),
          0.85,
        );
        assert.strictEqual(
          tripo.estimate({
            ...request({ lane: "character", options: { lowPoly: true } }),
            references: 1,
          }),
          0.95,
        );
        // Parts: an untextured mesh $0.20 + parts $0.20, then a texture task $0.10.
        const parts = request({ lane: "model", options: { parts: true, polycount: 30000 } });
        assert.strictEqual(tripo.estimate({ ...parts, references: 1 }), 0.5);
        assert.deepStrictEqual(tripoMeshBody(parts, "file_1"), {
          model: "v3.1-20260211",
          input: "file_1",
          texture: false,
          pbr: false,
          generate_parts: true,
          face_limit: 30000,
          auto_size: true,
        });
        assert.deepStrictEqual(
          tripoTextureBody({ mesh: "t_parts", texturePrompt: { image: "file_1" } }),
          {
            input: "t_parts",
            model: "v3.0-20250812",
            pbr: true,
            texture_prompt: { image: "file_1" },
          },
        );
        // A game mesh is uploaded, not made: the rig and the creature's one preset.
        assert.strictEqual(
          tripo.estimate({
            ...request({
              lane: "creature",
              options: { mesh: "art/dragon.glb", body: "quadruped" },
            }),
            references: 0,
          }),
          0.35,
        );
        assert.match(
          tripo.refuse?.(
            asked(request({ lane: "model", options: { parts: true, lowPoly: true } })),
          ) ?? "",
          /parts or smart low-poly/,
        );
      }),
  );

  it.effect(
    "Tripo polls without buying, names the next stage for advance to start, adds up the credits, and says why a task failed",
    () =>
      Effect.gen(function* () {
        const mesh = {
          stage: "mesh",
          task: "t_mesh",
          mesh: "t_mesh",
          rig: null,
          lane: "character",
          body: null,
          clips: ["preset:idle"],
          credits: 0,
        };
        const { calls, context } = recording([
          { code: 0, data: { task_id: "t_mesh", status: "unknown", progress: 50 } },
          {
            code: 0,
            data: {
              status: "success",
              credits_consumed: 40,
              output: { model_url: "https://cdn.tripo3d.ai/m.glb" },
            },
          },
          { code: 0, data: { task_id: "t_rig" } },
        ]);
        const unknown = yield* tripo.poll!(context, mesh);
        assert.strictEqual(unknown.kind, "making");
        if (unknown.kind !== "making") return;
        assert.strictEqual(unknown.remote.unknown, 1);
        const meshDone = yield* tripo.poll!(context, unknown.remote);
        // The poll only read: the rig is named, not bought.
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(meshDone.kind, "making");
        if (meshDone.kind !== "making") return;
        assert.deepInclude(meshDone.remote, { stage: "mesh", pending: "rig", credits: 40 });
        const rigging = yield* tripo.advance!(context, meshDone.remote);
        assert.strictEqual(calls[2]?.request.url, "https://openapi.tripo3d.ai/v3/animations/rig");
        assert.strictEqual(rigging.kind, "making");
        if (rigging.kind !== "making") return;
        assert.deepInclude(rigging.remote, {
          stage: "rig",
          task: "t_rig",
          credits: 40,
          pending: null,
        });

        const retargeted = recording([
          {
            code: 0,
            data: {
              status: "success",
              credits_consumed: 10,
              output: { model_url: "https://cdn.tripo3d.ai/a.glb" },
            },
          },
        ]);
        const done = yield* tripo.poll!(retargeted.context, {
          ...rigging.remote,
          stage: "retarget",
          task: "t_ret",
          credits: 65,
        });
        assert.strictEqual(done.kind, "done");
        if (done.kind !== "done") return;
        assert.strictEqual(done.costUsd, 0.75);
        assert.strictEqual(done.candidates[0]?.length, 1);

        const failed = recording([
          { code: 0, data: { status: "failed", error_code: 2001, error_message: "not riggable" } },
        ]);
        const error = yield* tripo.poll!(failed.context, { ...rigging.remote, credits: 40 }).pipe(
          Effect.flip,
        );
        assert.match(error.reason, /rig task ended failed: not riggable/);
        assert.strictEqual(error.costUsd, 0.4);
      }),
  );

  it.effect("Meshy names the refine of a text preview, and advance sends it on v2", () =>
    Effect.gen(function* () {
      const { calls, context } = recording([
        { id: "t_prev", status: "SUCCEEDED" },
        { result: "t_ref" },
      ]);
      const polled = yield* meshy.poll!(context, {
        stage: "mesh",
        kind: "text-to-3d",
        task: "t_prev",
        lane: "model",
        height: null,
        clips: [],
        rig: null,
      });
      assert.strictEqual(
        calls[0]?.request.url,
        "https://api.meshy.ai/openapi/v2/text-to-3d/t_prev",
      );
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(polled.kind, "making");
      if (polled.kind !== "making") return;
      assert.strictEqual(polled.remote.pending, "refine");
      const step = yield* meshy.advance!(context, polled.remote);
      assert.strictEqual(calls[1]?.request.url, "https://api.meshy.ai/openapi/v2/text-to-3d");
      assert.deepStrictEqual(calls[1]?.request.json, {
        mode: "refine",
        preview_task_id: "t_prev",
        enable_pbr: true,
      });
      assert.strictEqual(step.kind, "making");
    }),
  );

  it("Meshy picks its endpoint by reference count and refuses creatures and tiles", () => {
    assert.strictEqual(
      meshyMeshRequest(request({ lane: "model", references: [reference] })).url,
      "https://api.meshy.ai/openapi/v1/image-to-3d",
    );
    const multi = meshyMeshRequest(
      request({
        lane: "character",
        references: [reference, reference],
        options: { polycount: 12000 },
      }),
    );
    assert.strictEqual(multi.url, "https://api.meshy.ai/openapi/v1/multi-image-to-3d");
    assert.deepStrictEqual(multi.body, {
      image_urls: [
        `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
        `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
      ],
      should_texture: true,
      enable_pbr: true,
      target_formats: ["glb"],
      ai_model: "meshy-7.1",
      topology: "triangle",
      should_remesh: true,
      target_polycount: 12000,
      pose_mode: "a-pose",
    });
    assert.strictEqual(
      meshyMeshRequest(request({ lane: "model" })).url,
      "https://api.meshy.ai/openapi/v2/text-to-3d",
    );
    assert.deepStrictEqual(
      meshyMeshRequest(
        request({
          lane: "model",
          references: [reference],
          options: { lowPoly: true, polycount: 50000 },
        }),
      ).body,
      {
        image_url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
        should_texture: true,
        enable_pbr: true,
        target_formats: ["glb"],
        model_type: "smart-topology",
        ai_model: "meshy-t2.5",
        target_polycount: 30000,
      },
    );
    // Smart Topology: 15 credits for the textured mesh, not 30.
    assert.strictEqual(
      meshy.estimate({ ...request({ lane: "model", options: { lowPoly: true } }), references: 1 }),
      0.3,
    );
    assert.match(
      meshy.refuse?.({
        ...request({ lane: "model", options: { lowPoly: true } }),
        references: 2,
      }) ?? "",
      /one picture/,
    );
    assert.match(meshy.refuse?.(asked(request({ lane: "creature" }))) ?? "", /Tripo/);
    assert.match(meshy.refuse?.(asked(request({ lane: "texture" }))) ?? "", /tileable/);
  });

  it("ElevenLabs asks sfx, music and voice with their models, and prices by length", () => {
    const sfx = elevenLabsRequest(
      { ...request({ lane: "sfx", options: { seconds: 3, loop: true } }) },
      "k",
    );
    assert.strictEqual(
      sfx.url,
      "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
    );
    assert.deepStrictEqual(sfx.json, {
      text: "a red slime",
      model_id: "eleven_text_to_sound_v3",
      duration_seconds: 3,
      loop: true,
      prompt_influence: 0.3,
    });
    assert.strictEqual(sfx.headers["xi-api-key"], "k");
    const music = elevenLabsRequest(request({ lane: "music", options: { seconds: 120 } }), "k");
    assert.deepStrictEqual(music.json, {
      prompt: "a red slime",
      music_length_ms: 120_000,
      model_id: "music_v2_5",
    });
    assert.strictEqual(
      elevenlabs.estimate({
        ...request({ lane: "music", options: { seconds: 120 } }),
        references: 0,
      }),
      0.3,
    );
    assert.match(elevenlabs.laneLicence?.music ?? "", /Studio Games/);
  });
});

describe("art adapters: the key goes only to the provider's hosts", () => {
  it("accepts only https on the provider's own hosts", () => {
    assert.isTrue(isProviderUrl("openai", "https://api.openai.com/v1/images/generations"));
    assert.isFalse(isProviderUrl("openai", "http://api.openai.com/v1/models"));
    assert.isFalse(isProviderUrl("openai", "https://api.openai.com.evil.example/v1"));
    assert.isFalse(isProviderUrl("tripo", "https://api.meshy.ai/openapi/v1/rigging"));
  });

  it.effect("sends nothing to another host, and downloads carry no credentials", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; headers: Record<string, string> }> = [];
      const http = makeArtHttp(
        HttpClient.make((req) => {
          seen.push({ url: req.url, headers: { ...req.headers } });
          return Effect.succeed(
            HttpClientResponse.fromWeb(req, new Response("{}", { status: 200 })),
          );
        }),
      );
      const refused = yield* http
        .json("meshy", {
          method: "GET",
          url: "https://evil.example/x",
          headers: { authorization: "Bearer k" },
        })
        .pipe(Effect.as("sent"), Effect.flip);
      assert.match(refused.reason, /not one of its hosts/);
      yield* http.download("https://assets.meshy.ai/x.glb");
      assert.deepStrictEqual(
        seen.map((call) => call.url),
        ["https://assets.meshy.ai/x.glb"],
      );
      assert.isUndefined(seen[0]?.headers.authorization);
    }),
  );
});

describe("Codex image items", () => {
  it("reads the saved paths of image generation items, in either field spelling", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "image_generation", saved_path: "/s/generated_images/a.png" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "imageGeneration", savedPath: "/s/generated_images/b.png" },
      }),
      "not json with image in it",
    ].join("\n");
    assert.deepStrictEqual(codexSavedImagePaths(stdout), [
      "/s/generated_images/a.png",
      "/s/generated_images/b.png",
    ]);
  });

  it("says why a turn failed in Codex's own words (a usage limit)", () => {
    const stdout = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit." } }),
    ].join("\n");
    assert.strictEqual(codexTurnFailure(stdout), "Codex: You've hit your usage limit.");
    assert.isNull(codexTurnFailure("plain text output"));
  });
});
