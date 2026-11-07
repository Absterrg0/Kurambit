// Request shapes per adapter, against bodies built from each provider's documented API: these
// protect the person's money (what is asked, how much) and their key (where it goes).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { ArtContext, ArtHttpRequest, ArtReference, ArtRequest } from "./adapter.ts";
import { isProviderUrl, makeArtHttp } from "./adapter.ts";
import { codexSavedImagePaths } from "../../../textGeneration/CodexTextGeneration.ts";
import { elevenlabs, elevenLabsRequest } from "./elevenlabs.ts";
import { google, googleRequest } from "./google.ts";
import { meshy, meshyMeshRequest } from "./meshy.ts";
import { openai, openAiRequest } from "./openai.ts";
import { tripo, tripoMeshBody, tripoModelUrls, tripoRetargetBody, tripoRigBody } from "./tripo.ts";

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
      inline_data: { mime_type: "image/png", data: Buffer.from(PNG).toString("base64") },
    });
    assert.deepStrictEqual(body.json.generationConfig.imageConfig, {
      aspectRatio: "3:4",
      imageSize: "1K",
    });
    assert.match(
      google.refuse?.({ ...request(), options: { transparent: true } }) ?? "",
      /transparent/,
    );
  });

  it.effect(
    "Tripo uploads the concept, generates low poly, then rigs on Unreal names and retargets",
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
            options: { polycount: 8000, height: 1.8 },
          }),
        );
        assert.strictEqual(calls[0]?.request.url, "https://openapi.tripo3d.com/v3/files");
        assert.strictEqual(
          calls[1]?.request.url,
          "https://openapi.tripo3d.com/v3/generation/image-to-model",
        );
        assert.deepStrictEqual(calls[1]?.request.json, {
          model: "v3.1-20260211",
          file_token: "file_1",
          texture: true,
          pbr: true,
          smart_low_poly: true,
          face_limit: 8000,
          auto_size: true,
        });
        assert.strictEqual(step.kind, "making");
        assert.deepStrictEqual(
          tripoRigBody({ lane: "character", body: null, mesh: "t_mesh" }, 1.8),
          {
            input: "t_mesh",
            model: "v3.0-20260909",
            rig_type: "biped",
            spec: "unreal",
            out_format: "glb",
            height: 1.8,
          },
        );
        assert.strictEqual(
          tripoRigBody({ lane: "creature", body: "quadruped", mesh: "t" }).rig_type,
          "quadruped",
        );
        assert.deepStrictEqual(tripoRetargetBody("t_rig", ["Walk", "attack 1"]).animations, [
          "preset:walk",
          "preset:attack_1",
        ]);
        assert.propertyVal(
          tripoMeshBody(request({ lane: "model" }), null),
          "prompt",
          "a red slime",
        );
        assert.deepStrictEqual(
          tripoModelUrls({
            pbr_model: "https://cdn.tripo/x.glb",
            rendered_image: "https://cdn.tripo/x.webp",
          }),
          ["https://cdn.tripo/x.glb"],
        );
        // Mesh $0.30 + low poly $0.10 + rig $0.25 + three default clips at $0.10.
        assert.strictEqual(
          tripo.estimate({ ...request({ lane: "character" }), references: 1 }),
          0.95,
        );
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
    assert.match(meshy.refuse?.(request({ lane: "creature" })) ?? "", /Tripo/);
    assert.match(meshy.refuse?.(request({ lane: "texture" })) ?? "", /tileable/);
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
});
