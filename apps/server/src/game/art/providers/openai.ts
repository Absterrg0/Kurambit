// OpenAI's GPT Image: synchronous, base64 in the answer. Generations without references, edits
// with up to 16 (the key art, a concept). Candidates through `n`; if fewer come back, the rest
// are asked one at a time. The cost is read from the answer's token usage at list price. A
// change to a game image (options.edit) is the same edits call with that image first: the API
// edits the first image and reads the rest as references, and `background: "transparent"` cuts
// it out on the 2.5 models.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { GameArtOptions } from "@kurambit/contracts";
import {
  type ArtAdapter,
  type ArtContext,
  type ArtFile,
  type ArtRequest,
  ArtProviderError,
  field,
  fromBase64,
  numberField,
  readPng,
  requireKey,
  roundUsd,
} from "./adapter.ts";

export const OPENAI_IMAGE_MODEL = "gpt-image-2.5-sunburst";
const BASE = "https://api.openai.com/v1";
const QUALITY = "high";

/** USD per million tokens (GPT Image 2.5, 2026-11). */
const PRICE = { imageInput: 8, textInput: 5, imageOutput: 30 } as const;
/** USD per image at 1024², quality high, before input; larger sizes scale by pixels. */
const OUTPUT_HIGH_1024 = 0.053;
/** A reference costs about this in image input tokens. */
const PER_REFERENCE = 0.012;

/** Sizes by aspect: multiples of 16, within the documented pixel bounds. */
export const openAiSize = (options: GameArtOptions): string => {
  switch (options.aspect) {
    case "16:9":
      return "1536x864";
    case "9:16":
      return "864x1536";
    case "4:3":
      return "1280x960";
    case "3:4":
      return "960x1280";
    default:
      return "1024x1024";
  }
};
/**
 * An edit keeps the size of the image it changes, when that size is one the API takes (edges in
 * multiples of 16, at most 3840, between 1:3 and 3:1, 655,360 to 8,294,400 pixels); otherwise
 * the API sizes it ("auto"). An aspect asked outright wins.
 */
export const openAiEditSize = (request: ArtRequest): string => {
  if (request.options.aspect !== undefined) return openAiSize(request.options);
  const first = request.references[0];
  const png = first?.mime === "image/png" ? readPng(first.bytes) : null;
  if (png === null) return "auto";
  const { width, height } = png;
  const area = width * height;
  return width % 16 === 0 &&
    height % 16 === 0 &&
    Math.max(width, height) <= 3840 &&
    Math.max(width, height) <= 3 * Math.min(width, height) &&
    area >= 655_360 &&
    area <= 8_294_400
    ? `${width}x${height}`
    : "auto";
};
const pixels = (size: string) => {
  const [w, h] = size.split("x").map(Number);
  return (w ?? 1024) * (h ?? 1024);
};

const promptOf = (request: ArtRequest | Omit<ArtRequest, "references">) =>
  request.lane === "texture" && request.options.seamless !== false
    ? `${request.prompt}\n\nA seamless, tileable texture: flat, evenly lit, edges that wrap without a seam.`
    : request.prompt;

const costOf = (answer: unknown): number | null => {
  const output = numberField(answer, "usage", "output_tokens");
  if (output === null) return null;
  const image = numberField(answer, "usage", "input_tokens_details", "image_tokens") ?? 0;
  const text = numberField(answer, "usage", "input_tokens_details", "text_tokens") ?? 0;
  return roundUsd(
    (output * PRICE.imageOutput + image * PRICE.imageInput + text * PRICE.textInput) / 1_000_000,
  );
};

const imagesOf = (answer: unknown): ReadonlyArray<ArtFile> => {
  const data = field(answer, "data");
  if (!Array.isArray(data)) return [];
  return data.flatMap((item): ReadonlyArray<ArtFile> => {
    const b64 = field(item, "b64_json");
    return typeof b64 === "string" ? [{ role: "asset", ext: "png", bytes: fromBase64(b64) }] : [];
  });
};

/** One call for `n` images: the body every test fixture checks. */
export const openAiRequest = (request: ArtRequest, n: number, key: string) => {
  const size =
    request.options.edit === undefined ? openAiSize(request.options) : openAiEditSize(request);
  const transparent = request.options.transparent === true;
  const headers = { authorization: `Bearer ${key}` };
  if (request.references.length === 0)
    return {
      method: "POST" as const,
      url: `${BASE}/images/generations`,
      headers,
      json: {
        model: OPENAI_IMAGE_MODEL,
        prompt: promptOf(request),
        n,
        size,
        quality: QUALITY,
        output_format: "png",
        ...(transparent ? { background: "transparent" } : {}),
      },
    };
  const form = new FormData();
  form.append("model", OPENAI_IMAGE_MODEL);
  form.append("prompt", promptOf(request));
  form.append("n", String(n));
  form.append("size", size);
  form.append("quality", QUALITY);
  form.append("output_format", "png");
  if (transparent) form.append("background", "transparent");
  for (const reference of request.references.slice(0, 16))
    form.append(
      "image[]",
      new Blob([reference.bytes], { type: reference.mime }),
      reference.path.split("/").pop() ?? "reference.png",
    );
  return { method: "POST" as const, url: `${BASE}/images/edits`, headers, form };
};

const start = (context: ArtContext, request: ArtRequest) =>
  Effect.gen(function* () {
    const key = yield* requireKey("openai", context);
    const answer = yield* context.http.json(
      "openai",
      openAiRequest(request, request.candidates, key),
    );
    const images = [...imagesOf(answer)];
    let cost = costOf(answer);
    // A model that ignores `n` answers one image: the rest are asked one at a time.
    while (images.length > 0 && images.length < request.candidates) {
      const more = yield* context.http.json("openai", openAiRequest(request, 1, key));
      const extra = imagesOf(more);
      if (extra.length === 0) break;
      images.push(...extra);
      const moreCost = costOf(more);
      cost = cost === null || moreCost === null ? null : roundUsd(cost + moreCost);
    }
    if (images.length === 0)
      return yield* new ArtProviderError({
        reason: "OpenAI answered without an image.",
        costUsd: cost,
      });
    return { kind: "done" as const, candidates: images.map((image) => [image]), costUsd: cost };
  });

export const openai: ArtAdapter = {
  id: "openai",
  estimate: (request) =>
    roundUsd(
      request.candidates * OUTPUT_HIGH_1024 * (pixels(openAiSize(request.options)) / 1024 ** 2) +
        request.references * PER_REFERENCE,
    ),
  refuse: (request) =>
    request.lane === "image" || request.lane === "texture"
      ? null
      : `OpenAI makes images and textures, not ${request.lane}.`,
  start,
  pollEvery: Duration.seconds(5),
  licence: "OpenAI API output: assigned to the user under OpenAI's terms; no attribution required.",
  checkKey: (context) =>
    requireKey("openai", context).pipe(
      Effect.flatMap((key) =>
        context.http.json("openai", {
          method: "GET",
          url: `${BASE}/models`,
          headers: { authorization: `Bearer ${key}` },
        }),
      ),
      Effect.asVoid,
    ),
};
