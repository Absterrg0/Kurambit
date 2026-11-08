// @effect-diagnostics nodeBuiltinImport:off -- Codex reports its saved images as native paths.
// Codex's image generation on the person's ChatGPT plan: their own Codex, run hidden and
// one-shot in a private folder of the server's (never the game), read-only, with the references
// attached. No key and no dollar cost: it counts against the plan's Codex limits. A change to a
// game image (options.edit) attaches that image first and names its path for the image tool.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { type ArtAdapter, type ArtContext, type ArtRequest, ArtProviderError } from "./adapter.ts";

const TIMEOUT_MS = 8 * 60_000;

const codexPrompt = (request: ArtRequest): string => {
  const count = request.candidates;
  const edited = request.options.edit === undefined ? undefined : request.references[0];
  // An edit: the image tool edits the images it is given by path, the first one being changed.
  const lines =
    edited === undefined
      ? [
          `Use $imagegen to generate ${count === 1 ? "one image" : `${count} separate images, one call each, as alternative takes`} of:`,
          "",
          request.prompt,
          "",
        ]
      : [
          `Use $imagegen to edit the image at ${edited.absolute}: pass that path as the first of referenced_image_paths${
            request.references.length > 1
              ? `, then ${request.references
                  .slice(1)
                  .map((reference) => reference.absolute)
                  .join(", ")} as references`
              : ""
          }. Make one image.`,
          "",
          request.prompt,
          "",
        ];
  if (request.lane === "texture" && request.options.seamless !== false)
    lines.push(
      "It is a seamless, tileable texture: flat, evenly lit, edges that wrap without a seam.",
    );
  if (request.options.transparent === true)
    lines.push(
      edited === undefined
        ? "Use a transparent background."
        : "Set transparent_background to true: the background is cut out.",
    );
  if (request.options.aspect !== undefined && request.options.aspect !== "1:1")
    lines.push(`Aspect ratio ${request.options.aspect}.`);
  if (request.references.length > 0 && edited === undefined)
    lines.push(
      "The attached images are references: match their look (palette, shapes, rendering style); pass them to the image tool as referenced images.",
    );
  lines.push(
    "",
    "Only generate the images. Do not run commands, read or write files, or do anything else. When done, reply with the word done.",
  );
  return lines.join("\n");
};

/** The image format by its first bytes; null when it is none of PNG, JPEG, WebP. */
const imageKind = (bytes: Uint8Array): "png" | "jpg" | "webp" | null => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "webp";
  return null;
};

const start = (context: ArtContext, request: ArtRequest) =>
  Effect.gen(function* () {
    if (context.codexImages === null)
      return yield* new ArtProviderError({
        reason:
          "Codex is not ready: install Codex and sign in with your ChatGPT plan in Settings → Providers.",
      });
    const { files } = yield* context.codexImages({
      cwd: context.scratch,
      prompt: codexPrompt(request),
      referencePaths: request.references.map((reference) => reference.absolute),
      timeoutMs: TIMEOUT_MS,
    });
    // Only Codex's own saved images are read: a path it reports elsewhere is not one. The
    // paths come from the model's output stream, so each is resolved first: a `..` or a link
    // past generated_images/ is judged by where it really leads.
    const saved = (yield* Effect.forEach(files, (file) =>
      NodePath.isAbsolute(file)
        ? Effect.promise(() => NodeFSP.realpath(file).catch(() => null))
        : Effect.succeed(null),
    )).filter(
      (file): file is string =>
        file !== null &&
        NodePath.dirname(file).split(NodePath.sep).includes("generated_images") &&
        /\.(png|jpe?g|webp)$/i.test(file),
    );
    const candidates = yield* Effect.forEach(saved.slice(0, request.candidates), (file) =>
      context.readFile(file).pipe(
        Effect.flatMap((bytes) => {
          const ext = imageKind(bytes);
          return ext === null
            ? Effect.fail(
                new ArtProviderError({
                  reason: `Codex saved ${NodePath.basename(file)}, which is not an image.`,
                }),
              )
            : Effect.succeed([{ role: "asset" as const, ext, bytes }]);
        }),
      ),
    );
    if (candidates.length === 0)
      return yield* new ArtProviderError({ reason: "Codex made no image." });
    return { kind: "done" as const, candidates, costUsd: null };
  });

export const codex: ArtAdapter = {
  id: "codex",
  estimate: () => null,
  refuse: (request) =>
    request.lane === "image" || request.lane === "texture"
      ? null
      : `Codex makes images and textures, not ${request.lane}.`,
  start,
  pollEvery: Duration.seconds(5),
  licence:
    "Codex image generation on the person's ChatGPT plan: output assigned to the user under OpenAI's terms; no attribution required.",
};
