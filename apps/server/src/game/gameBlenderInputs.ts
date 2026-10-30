// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the native filesystem boundary for staged Blender inputs.
// Bounded named local inputs for one Blender run. The service stages each
// source under scratch and exposes the staged path as ASSET_INPUTS[name] to
// the bpy script, so a new asset can reuse geometry, UVs, textures or clips.
// Supplying a source only records it; it never proves the script used it.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { NodeIO } from "@gltf-transform/core";
import * as Schema from "effect/Schema";
import { GameOperationError, GAME_BLENDER_INPUT_BOUNDS } from "@t3tools/contracts";
import { insideGame } from "./GameProjectService.ts";
import { PNG } from "pngjs";

const isGameOperationError = Schema.is(GameOperationError);

export const BLENDER_INPUT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BLENDER_INPUT_EXTENSIONS = [".gltf", ".glb", ".png", ".jpg", ".jpeg"] as const;
const BLENDER_DEPENDENCY_EXTENSIONS = [".bin", ".png", ".jpg", ".jpeg"] as const;

export interface BlenderInputBinding {
  readonly name: string;
  /** Normalized supplied path: `res://…` or game-relative with forward slashes. */
  readonly path: string;
}

const fail = (path: string, detail: string): GameOperationError =>
  new GameOperationError({ operation: "blender", path, reason: "invalid-input", detail });

const isRemoteUri = (value: string): boolean =>
  value.startsWith("data:") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);

const safeSegments = (relative: string): boolean => {
  if (relative.length === 0 || relative.length > 500) return false;
  if (relative.includes("\\") || relative.startsWith("/")) return false;
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
};

const lowerExtension = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
};

/** Lexical game-absolute path for one supplied input, before filesystem checks. */
export const resolveBlenderInputAbsolute = (
  root: string,
  godotProject: string,
  supplied: string,
  inputName: string,
): { readonly absolute: string; readonly display: string } => {
  if (typeof supplied !== "string" || supplied.length === 0 || supplied.length > 500)
    throw fail(inputName, `Input '${inputName}' needs a path of 1–500 characters.`);
  if (supplied.includes("\\"))
    throw fail(inputName, `Input '${inputName}' must use forward slashes, not backslashes.`);
  if (supplied.startsWith("res://")) {
    const rest = supplied.slice("res://".length);
    if (!safeSegments(rest))
      throw fail(
        inputName,
        `Input '${inputName}' path '${supplied}' escapes the game or is not a plain res:// file path.`,
      );
    const extension = lowerExtension(rest);
    if (!(BLENDER_INPUT_EXTENSIONS as readonly string[]).includes(extension))
      throw fail(
        inputName,
        `Input '${inputName}' type '${extension || "(none)"}' is not supported; use .gltf, .glb, .png, .jpg or .jpeg.`,
      );
    const gameRelative = `${godotProject}/${rest}`;
    let absolute: string;
    try {
      absolute = insideGame(root, gameRelative);
    } catch {
      throw fail(inputName, `Input '${inputName}' path '${supplied}' is outside the game.`);
    }
    return { absolute, display: `res://${rest}` };
  }
  if (isRemoteUri(supplied))
    throw fail(
      inputName,
      `Input '${inputName}' path '${supplied}' is a remote URI; only game-local files are staged.`,
    );
  if (!safeSegments(supplied))
    throw fail(
      inputName,
      `Input '${inputName}' path '${supplied}' escapes the game or is not a plain game-relative file path.`,
    );
  const extension = lowerExtension(supplied);
  if (!(BLENDER_INPUT_EXTENSIONS as readonly string[]).includes(extension))
    throw fail(
      inputName,
      `Input '${inputName}' type '${extension || "(none)"}' is not supported; use .gltf, .glb, .png, .jpg or .jpeg.`,
    );
  let absolute: string;
  try {
    absolute = insideGame(root, supplied);
  } catch {
    throw fail(inputName, `Input '${inputName}' path '${supplied}' is outside the game.`);
  }
  return { absolute, display: supplied.replaceAll("\\", "/") };
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const pngDimensions = (bytes: Buffer): { width: number; height: number } => {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new Error("not a PNG");
  if (bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("no IHDR");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new Error("bad PNG size");
  return { width, height };
};

const jpegDimensions = (bytes: Buffer): { width: number; height: number } => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG");
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error("bad JPEG");
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) throw new Error("bad JPEG");
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (width <= 0 || height <= 0) throw new Error("bad JPEG size");
      return { width, height };
    }
    offset += 2 + length;
  }
  throw new Error("no JPEG frame");
};

const formatMegapixels = (pixels: number): string => `${(pixels / 1_000_000).toFixed(1)} MP`;

/**
 * Header dimensions without decoding pixels, so an 8192x8192 PNG fails on its
 * 33-byte IHDR instead of a 256 MB RGBA buffer. Throws invalid-input past the
 * dimension or per-image pixel bounds, or when the header is not PNG/JPEG.
 */
const imageDimensions = (
  name: string,
  extension: ".png" | ".jpg",
  bytes: Buffer,
): { width: number; height: number } => {
  const max = GAME_BLENDER_INPUT_BOUNDS.maxImageDimension;
  try {
    const dims = extension === ".png" ? pngDimensions(bytes) : jpegDimensions(bytes);
    if (dims.width > max || dims.height > max)
      throw fail(
        name,
        `Input '${name}' image is ${dims.width}x${dims.height}, past the ${max}px bound; shrink it and retry.`,
      );
    const pixels = dims.width * dims.height;
    if (pixels > GAME_BLENDER_INPUT_BOUNDS.maxImagePixels)
      throw fail(
        name,
        `Input '${name}' image is ${dims.width}x${dims.height} (${formatMegapixels(pixels)}), past the ${formatMegapixels(GAME_BLENDER_INPUT_BOUNDS.maxImagePixels)} per-image bound; shrink it and retry.`,
      );
    return dims;
  } catch (cause) {
    if (isGameOperationError(cause)) throw cause;
    throw fail(name, `Input '${name}' does not decode as a supported image; check the file.`);
  }
};

/** Magic sniff for embedded/data-URI images, whose extension is unknown. */
const sniffImageExtension = (bytes: Uint8Array): ".png" | ".jpg" | null => {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)) return ".png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
  return null;
};

/**
 * Cheap header pixels without decoding: PNG IHDR or JPEG SOF, sniffed by
 * magic. Returns null when the bytes are not a readable PNG/JPEG header —
 * callers treat unreadable as unmeasurable, never as zero. Shared with the
 * asset import preflight so both paths agree on what "huge" means without a
 * second DIY parser; Blender staging keeps its own throwing wrapper above.
 */
export const sniffImagePixels = (
  bytes: Uint8Array,
): { readonly width: number; readonly height: number; readonly pixels: number } | null => {
  const extension = sniffImageExtension(bytes);
  if (extension === null) return null;
  try {
    const dims =
      extension === ".png" ? pngDimensions(Buffer.from(bytes)) : jpegDimensions(Buffer.from(bytes));
    if (dims.width <= 0 || dims.height <= 0) return null;
    return { width: dims.width, height: dims.height, pixels: dims.width * dims.height };
  } catch {
    return null;
  }
};

/** Full PNG decode after the header guards passed, so corrupt files still fail. */
const confirmPngDecodes = (name: string, bytes: Buffer): void => {
  try {
    PNG.sync.read(bytes);
  } catch {
    throw fail(name, `Input '${name}' does not decode as a supported image; check the file.`);
  }
  // JPEG has no installed decoder, so its header check above is the validation.
};

/** Shallow URI collection for one .gltf document: buffers plus images. */
const gltfUrisOf = (document: unknown): Array<{ uri: string; kind: "buffer" | "image" }> => {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return [];
  const record = document as Record<string, unknown>;
  const uris: Array<{ uri: string; kind: "buffer" | "image" }> = [];
  for (const key of ["buffers", "images"] as const) {
    const kind = key === "buffers" ? "buffer" : "image";
    const entries = record[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        const uri = (entry as Record<string, unknown>).uri;
        if (typeof uri === "string" && uri.length > 0) uris.push({ uri, kind });
      }
    }
  }
  return uris;
};

/**
 * Validate the request shape (count, names, paths, types) before touching
 * the filesystem. Filesystem, size and dependency checks happen in staging.
 */
export const validateBlenderInputs = (
  raw: ReadonlyArray<{ readonly name: string; readonly path: string }> | undefined,
  inputId: string,
): Array<BlenderInputBinding> => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length === 0)
    throw fail(inputId, "Inputs must name at least one local model or image.");
  if (raw.length > GAME_BLENDER_INPUT_BOUNDS.maxInputs)
    throw fail(
      inputId,
      `Too many inputs: ${raw.length} were supplied but at most ${GAME_BLENDER_INPUT_BOUNDS.maxInputs} are staged.`,
    );
  const seen = new Set<string>();
  const bindings: Array<BlenderInputBinding> = [];
  for (const entry of raw) {
    const name = (entry as { name?: unknown }).name;
    const path = (entry as { path?: unknown }).path;
    if (typeof name !== "string" || !BLENDER_INPUT_NAME_PATTERN.test(name))
      throw fail(
        inputId,
        `Input name '${String(name)}' must match [A-Za-z0-9_-]{1,64}; rename it and retry.`,
      );
    if (seen.has(name))
      throw fail(inputId, `Duplicate input name '${name}'; names must be distinct.`);
    seen.add(name);
    if (typeof path !== "string")
      throw fail(inputId, `Input '${name}' needs a game-local file path.`);
    // Extension and escaping are checked again with the manifest's project
    // root during staging; this early pass keeps the message stable.
    if (isRemoteUri(path) && !path.startsWith("res://"))
      throw fail(
        inputId,
        `Input '${name}' path '${path}' is a remote URI; only game-local files are staged.`,
      );
    const extension = lowerExtension(
      path.startsWith("res://") ? path.slice("res://".length) : path,
    );
    if (!(BLENDER_INPUT_EXTENSIONS as readonly string[]).includes(extension))
      throw fail(
        inputId,
        `Input '${name}' type '${extension || "(none)"}' is not supported; use .gltf, .glb, .png, .jpg or .jpeg.`,
      );
    bindings.push({ name, path });
  }
  return bindings;
};

/** One staged input: the scratch file Blender reads for one named source. */
export interface StagedBlenderInput {
  readonly name: string;
  /** Normalized supplied path, persisted on the asset for traceability. */
  readonly binding: BlenderInputBinding;
  /** Absolute scratch path exposed as ASSET_INPUTS[name]. */
  readonly staged: string;
}

/**
 * Resolve, validate and stage every named input under `temporary/inputs`.
 * Only reads game files; never writes them. Throws a Blender invalid-input
 * failure before the caller launches Blender, so bad inputs never touch the
 * live .blend, .glb, script, thumbnail or manifest.
 */
export const stageBlenderInputs = async (input: {
  readonly root: string;
  readonly godotProject: string;
  readonly bindings: ReadonlyArray<BlenderInputBinding>;
  readonly temporary: string;
  readonly inputId: string;
}): Promise<Array<StagedBlenderInput>> => {
  const { root, godotProject, bindings, temporary, inputId } = input;
  if (bindings.length === 0) return [];
  const gameRoot = NodePath.resolve(root);
  const realRoot = await NodeFSP.realpath(root).catch(() => gameRoot);
  const inputsDir = NodePath.join(temporary, "inputs");
  await NodeFSP.mkdir(inputsDir, { recursive: true });
  const staged: Array<StagedBlenderInput> = [];
  let totalBytes = 0;
  let dependencyCount = 0;
  const io = new NodeIO();

  const trackBytes = (size: number, label: string): void => {
    if (!Number.isInteger(size) || size <= 0) throw fail(label, `Input '${label}' is empty.`);
    if (size > GAME_BLENDER_INPUT_BOUNDS.maxFileBytes)
      throw fail(
        label,
        `Input '${label}' is ${(size / 1_000_000).toFixed(1)} MB; one file may be at most ${(GAME_BLENDER_INPUT_BOUNDS.maxFileBytes / 1_000_000).toFixed(0)} MB.`,
      );
    totalBytes += size;
    if (totalBytes > GAME_BLENDER_INPUT_BOUNDS.maxTotalBytes)
      throw fail(
        inputId,
        `Inputs total ${(totalBytes / 1_000_000).toFixed(1)} MB; at most ${(GAME_BLENDER_INPUT_BOUNDS.maxTotalBytes / 1_000_000).toFixed(0)} MB are staged. Use fewer or smaller sources.`,
      );
  };

  let totalImagePixels = 0;
  const trackImagePixels = (dims: { width: number; height: number }): void => {
    totalImagePixels += dims.width * dims.height;
    if (totalImagePixels > GAME_BLENDER_INPUT_BOUNDS.maxTotalImagePixels)
      throw fail(
        inputId,
        `Inputs hold ${formatMegapixels(totalImagePixels)} of decoded images, past the ${formatMegapixels(GAME_BLENDER_INPUT_BOUNDS.maxTotalImagePixels)} total bound; use fewer or smaller sources.`,
      );
  };

  /** Header guards plus pixel budget for one image. PNG decode confirmation
   * waits until every image header in the run passed, so oversized totals
   * reject before time is spent decoding any pixels.
   */
  const pendingPngDecodes: Array<{ name: string; bytes: Buffer }> = [];
  const validateImageBytes = (name: string, extension: ".png" | ".jpg", bytes: Buffer): void => {
    const dims = imageDimensions(name, extension, bytes);
    trackImagePixels(dims);
    if (extension === ".png") pendingPngDecodes.push({ name, bytes });
  };

  /** Header guards plus pixel budget for an embedded/data-URI image. */
  const validateSniffedImageBytes = (name: string, bytes: Uint8Array): void => {
    const extension = sniffImageExtension(bytes);
    if (extension === null)
      throw fail(name, `Input '${name}' does not decode as a supported image; check the file.`);
    validateImageBytes(name, extension, Buffer.from(bytes));
  };

  const assertInsideGameFile = async (absolute: string, label: string): Promise<number> => {
    let link: boolean;
    try {
      link = (await NodeFSP.lstat(absolute)).isSymbolicLink();
    } catch {
      throw fail(label, `Input '${label}' is missing; check the game-relative path.`);
    }
    if (link)
      throw fail(label, `Input '${label}' is a symlink; only regular game files are staged.`);
    let stat: { isFile(): boolean; size: number };
    try {
      stat = await NodeFSP.stat(absolute);
    } catch {
      throw fail(label, `Input '${label}' is missing; check the game-relative path.`);
    }
    if (!stat.isFile()) throw fail(label, `Input '${label}' is not a regular file.`);
    let real: string;
    try {
      real = await NodeFSP.realpath(absolute);
    } catch {
      throw fail(label, `Input '${label}' is missing; check the game-relative path.`);
    }
    if (
      real !== realRoot &&
      real !== gameRoot &&
      !real.startsWith(realRoot + NodePath.sep) &&
      !real.startsWith(gameRoot + NodePath.sep)
    )
      throw fail(label, `Input '${label}' is outside the game; only game-local files are staged.`);
    return stat.size;
  };

  for (const binding of bindings) {
    const { absolute, display } = resolveBlenderInputAbsolute(
      root,
      godotProject,
      binding.path,
      binding.name,
    );
    const normalized: BlenderInputBinding = { name: binding.name, path: display };
    const extension = lowerExtension(
      display.startsWith("res://") ? display.slice("res://".length) : display,
    );
    const size = await assertInsideGameFile(absolute, binding.name);
    trackBytes(size, binding.name);

    if (extension === ".png" || extension === ".jpg" || extension === ".jpeg") {
      const bytes = await NodeFSP.readFile(absolute).catch(() => {
        throw fail(
          binding.name,
          `Input '${binding.name}' is missing; check the game-relative path.`,
        );
      });
      validateImageBytes(binding.name, extension === ".jpeg" ? ".jpg" : extension, bytes);
      const stagedPath = NodePath.join(inputsDir, `${binding.name}${extension}`);
      await NodeFSP.writeFile(stagedPath, bytes);
      staged.push({ name: binding.name, binding: normalized, staged: stagedPath });
      continue;
    }

    if (extension === ".glb") {
      const bytes = await NodeFSP.readFile(absolute).catch(() => {
        throw fail(
          binding.name,
          `Input '${binding.name}' is missing; check the game-relative path.`,
        );
      });
      try {
        const parsed = await io.readBinary(new Uint8Array(bytes));
        // Compressed texture bytes stay small in memory; the header guards
        // below reject oversized images before any pixel decode.
        for (const texture of parsed.getRoot().listTextures()) {
          const image = texture.getImage();
          if (image === null) continue;
          validateSniffedImageBytes(binding.name, image);
        }
      } catch (cause) {
        if (isGameOperationError(cause)) throw cause;
        throw fail(binding.name, `Input '${binding.name}' is not a readable GLB; check the file.`);
      }
      const stagedPath = NodePath.join(inputsDir, `${binding.name}.glb`);
      await NodeFSP.writeFile(stagedPath, bytes);
      staged.push({ name: binding.name, binding: normalized, staged: stagedPath });
      continue;
    }

    // .gltf plus its local .bin/image dependencies, repacked as one GLB so
    // the bpy importer reads a single self-contained file. Dependencies are
    // URIs, so they decode like NodeIO's resolver (mesh%20data.bin reads the
    // sibling "mesh data.bin"); contained ../ parents are allowed, while
    // remote, absolute, escaping and symlink-file sources are rejected. Files
    // load into an SDK resource map keyed by the original URI strings instead
    // of staged copies, so nothing writes beside the source.
    const text = await NodeFSP.readFile(absolute, "utf8").catch(() => {
      throw fail(binding.name, `Input '${binding.name}' is missing; check the game-relative path.`);
    });
    let document: unknown;
    try {
      document = JSON.parse(text) as unknown;
    } catch {
      throw fail(binding.name, `Input '${binding.name}' is not readable JSON glTF.`);
    }
    const uris = gltfUrisOf(document);
    const sourceDir = NodePath.dirname(absolute);
    const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
    const seenDeps = new Set<string>();
    for (const { uri, kind } of uris) {
      if (uri.startsWith("data:")) {
        // Inline images still count pixels: the SDK would hold the same
        // compressed bytes, and Blender decodes them on import.
        if (kind === "image") {
          const encoded = uri.match(/^data:.*;base64,(.*)$/s)?.[1];
          if (encoded !== undefined) {
            // Invalid base64 decodes to bytes the magic sniff rejects below.
            validateSniffedImageBytes(binding.name, Buffer.from(encoded, "base64"));
          }
        }
        continue;
      }
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri) || uri.startsWith("//"))
        throw fail(
          binding.name,
          `Input '${binding.name}' references remote '${uri}'; network assets are not fetched. Vendor the file into the game first.`,
        );
      // Strip query/fragment for the filesystem lookup; the resource map
      // below keeps the original URI string as its key, matching the SDK.
      const stripped = uri.split("?")[0]!.split("#")[0]!;
      let decoded: string;
      try {
        decoded = decodeURIComponent(stripped);
      } catch {
        throw fail(
          binding.name,
          `Input '${binding.name}' references unsafe '${uri}'; dependencies must be plain game-local paths.`,
        );
      }
      if (
        decoded.length === 0 ||
        decoded.length > 500 ||
        decoded.includes("\\") ||
        decoded.startsWith("/")
      )
        throw fail(
          binding.name,
          `Input '${binding.name}' references unsafe '${uri}'; dependencies must be plain game-local paths.`,
        );
      const depExtension = lowerExtension(decoded);
      if (!(BLENDER_DEPENDENCY_EXTENSIONS as readonly string[]).includes(depExtension))
        throw fail(
          binding.name,
          `Input '${binding.name}' dependency '${uri}' type '${depExtension || "(none)"}' is not supported; use .bin, .png, .jpg or .jpeg.`,
        );
      if (seenDeps.has(uri)) continue;
      seenDeps.add(uri);
      dependencyCount += 1;
      if (dependencyCount > GAME_BLENDER_INPUT_BOUNDS.maxDependencies)
        throw fail(
          inputId,
          `Too many glTF dependencies: at most ${GAME_BLENDER_INPUT_BOUNDS.maxDependencies} extra files are staged. Use fewer or smaller sources.`,
        );
      // Contained parents (../textures) resolve inside the game; escaping,
      // absolute and symlink-file sources fail the containment check below.
      const resolved = NodePath.resolve(sourceDir, decoded);
      if (resolved !== gameRoot && !resolved.startsWith(gameRoot + NodePath.sep))
        throw fail(
          binding.name,
          `Input '${binding.name}' dependency '${uri}' is outside the game.`,
        );
      const depSize = await assertInsideGameFile(resolved, binding.name).catch((cause) => {
        // Missing files name the dependency; symlink/outside findings keep
        // their own detail instead of collapsing into "missing".
        if (
          isGameOperationError(cause) &&
          cause.reason === "invalid-input" &&
          (cause.detail ?? "").includes("is missing")
        )
          throw fail(binding.name, `Input '${binding.name}' dependency '${uri}' is missing.`);
        throw cause;
      });
      trackBytes(depSize, binding.name);
      const depBytes = await NodeFSP.readFile(resolved).catch(() => {
        throw fail(binding.name, `Input '${binding.name}' dependency '${uri}' is missing.`);
      });
      if (depExtension === ".png" || depExtension === ".jpg" || depExtension === ".jpeg")
        validateImageBytes(
          binding.name,
          depExtension === ".jpeg" ? ".jpg" : depExtension,
          depBytes,
        );
      resources[uri] = Uint8Array.from(depBytes);
    }
    let glbBytes: Uint8Array;
    try {
      const parsed = await io.readJSON({
        json: document as Parameters<NodeIO["readJSON"]>[0]["json"],
        resources,
      });
      glbBytes = await io.writeBinary(parsed);
    } catch (cause) {
      if (isGameOperationError(cause)) throw cause;
      throw fail(
        binding.name,
        `Input '${binding.name}' glTF does not parse with its dependencies.`,
      );
    }
    const stagedPath = NodePath.join(inputsDir, `${binding.name}.glb`);
    await NodeFSP.writeFile(stagedPath, Buffer.from(glbBytes));
    staged.push({ name: binding.name, binding: normalized, staged: stagedPath });
  }
  // Every header and the run total passed: now confirm the PNGs decode.
  for (const pending of pendingPngDecodes) confirmPngDecodes(pending.name, pending.bytes);
  return staged;
};
