// Google's Nano Banana 2.1 through the Gemini API's generateContent: synchronous, one image per
// call (candidates are separate calls), up to 14 references as inline images. The image guide now
// shows the Interactions API, but generateContent stays fully supported and its reference
// (ai.google.dev/api/generate-content) documents responseModalities, imageConfig and inlineData;
// Interactions would also store every request unless told not to. It documents no transparent
// background, so a transparent request is refused rather than quietly opaque.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  type ArtAdapter,
  type ArtContext,
  type ArtFile,
  type ArtRequest,
  ArtProviderError,
  base64,
  field,
  fromBase64,
  requireKey,
  roundUsd,
} from "./adapter.ts";

export const GOOGLE_IMAGE_MODEL = "gemini-nano-banana-2.1";
const BASE = "https://generativelanguage.googleapis.com/v1beta";
/** USD per 1K image (Nano Banana 2.1, paid tier, 2026-11); input tokens are a rounding error. */
const PER_IMAGE_1K = 0.0336;
const PER_REFERENCE = 0.001;

export const googleRequest = (request: ArtRequest, key: string) => ({
  method: "POST" as const,
  url: `${BASE}/models/${GOOGLE_IMAGE_MODEL}:generateContent`,
  headers: { "x-goog-api-key": key },
  json: {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              request.lane === "texture" && request.options.seamless !== false
                ? `${request.prompt}\n\nA seamless, tileable texture: flat, evenly lit, edges that wrap without a seam.`
                : request.prompt,
          },
          ...request.references.slice(0, 14).map((reference) => ({
            inlineData: { mimeType: reference.mime, data: base64(reference.bytes) },
          })),
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: request.options.aspect ?? "1:1", imageSize: "1K" },
    },
  },
});

const imageOf = (answer: unknown): ArtFile | null => {
  const parts = field(answer, "candidates", 0, "content", "parts");
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const data = field(part, "inlineData", "data") ?? field(part, "inline_data", "data");
    const mime = field(part, "inlineData", "mimeType") ?? field(part, "inline_data", "mime_type");
    if (typeof data === "string")
      return {
        role: "asset",
        ext: mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png",
        bytes: fromBase64(data),
      };
  }
  return null;
};

const start = (context: ArtContext, request: ArtRequest) =>
  Effect.gen(function* () {
    const key = yield* requireKey("google", context);
    const candidates: Array<ReadonlyArray<ArtFile>> = [];
    for (let index = 0; index < request.candidates; index += 1) {
      const answer = yield* context.http.json("google", googleRequest(request, key));
      const image = imageOf(answer);
      if (image === null) {
        const finish = field(answer, "candidates", 0, "finishReason");
        if (candidates.length > 0) break;
        return yield* new ArtProviderError({
          reason: `Google answered without an image${typeof finish === "string" ? ` (${finish})` : ""}.`,
        });
      }
      candidates.push([image]);
    }
    // Google's answer reports tokens, not dollars: the service records the price table's
    // estimate, marked as one.
    return { kind: "done" as const, candidates, costUsd: null };
  });

export const google: ArtAdapter = {
  id: "google",
  estimate: (request) =>
    roundUsd(request.candidates * PER_IMAGE_1K + request.references * PER_REFERENCE),
  refuse: (request) =>
    request.lane !== "image" && request.lane !== "texture"
      ? `Google makes images and textures, not ${request.lane}.`
      : request.options.transparent === true
        ? "Google's image model makes no transparent background. Choose OpenAI or Codex for images in Settings → Art providers, or ask without a transparent background."
        : null,
  start,
  pollEvery: Duration.seconds(5),
  licence:
    "Gemini API output: Google claims no ownership; paid keys only for users in the EEA, Switzerland and the UK. Carries a SynthID watermark.",
  checkKey: (context) =>
    requireKey("google", context).pipe(
      Effect.flatMap((key) =>
        context.http.json("google", {
          method: "GET",
          url: `${BASE}/models`,
          headers: { "x-goog-api-key": key },
        }),
      ),
      Effect.asVoid,
    ),
};
