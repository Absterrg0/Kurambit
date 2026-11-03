// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Writes PNGs into the game folder; the Blender script answers with one JSON line.
// game_blender_render_sprites: 2D sprites from the live Blender scene, correct by construction.
// A weak model's hand-written camera, light and anchor code crops heads, drifts and renders
// near-black; here the camera is fitted to the subject across every frame, so none of that can happen.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import {
  GameOperationError,
  type GameBlenderRenderSpritesInput,
  type GameBlenderRenderSpritesResult,
  type GameEngineId,
  type GameManifest,
} from "@kurambit/contracts";
import { laneLibrary } from "./run/roles.ts";
import { decodePng, measure, type Rgba } from "./run/spriteFacts.ts";
import {
  colourHex,
  contactSheet,
  darkest,
  downscale,
  encodePng,
  frameCameras,
  hardAlpha,
  hexColour,
  colourCounts,
  lightness,
  outline,
  quantize,
  sheet,
  travel,
} from "./spriteRender.ts";
import {
  spriteRenderCode,
  spriteRenderOutput,
  type SpriteFit,
  type SpriteView,
} from "./spriteRenderPy.ts";

const OP = "blender-render-sprites";
const TOOL = "game_blender_render_sprites";
const BLEND_REL = "art/blender/live.blend";
const SCRATCH = "builds/logs/sprite-render";
/**
 * The first Blender command's renders, before per-render time is known: the pinned server gives
 * each command 180 s, and a render costs about a second or two before its pixels count.
 */
const FIRST_CALL_RENDERS = 8;
const RENDER_PIXELS_PER_CALL = 8 * 256 * 256;
/** Seconds of rendering later commands aim for, sized from the first command's per-render time. */
const SECONDS_PER_CALL = 90;
const MAX_RENDERS = 128;
/** Output pixels per call, so the palette and measuring passes stay well under a second on the server. */
const MAX_OUTPUT_PIXELS = 4 * 1024 * 1024;
/** Blender-rendered pixels per call (output times supersample squared), which bounds render time and downscaling. */
const MAX_RENDERED_PIXELS = 32 * 1024 * 1024;
/** The outline without a palette: a frame's darkest colour unless that is lighter than this OKLab L. */
const OUTLINE_MAX_LIGHTNESS = 0.3;
const NEAR_BLACK = 0x14141a;
const SPLIT = "split by view, and give each call its own output";
const MAX_RENDER_SIDE = 2048;
const PALETTE_FILES = 400;
const PALETTE_PIXELS = 16 * 1024 * 1024;
const PALETTE_COLOURS = 1024;

const fail = (path: string, reason: GameOperationError["reason"], detail: string) =>
  new GameOperationError({ operation: OP, path, reason, detail });

const io = (path: string) => (cause: unknown) =>
  new GameOperationError({ operation: OP, path, reason: "io", cause });

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const cleanRelative = (path: string) =>
  path.split("/").every((s) => SEGMENT.test(s) && s !== "." && s !== "..");

/**
 * Makes `relative` under the real game root one real folder at a time and refuses a symbolic
 * link or a file on the way, so nothing is written outside the game.
 */
const realDir = (realRoot: string, relative: string) =>
  Effect.tryPromise({
    try: async () => {
      let current = realRoot;
      for (const segment of relative.split("/")) {
        current = NodePath.join(current, segment);
        let stat = await NodeFSP.lstat(current).catch(() => null);
        if (stat === null) {
          await NodeFSP.mkdir(current).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          stat = await NodeFSP.lstat(current);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      }
      return current;
    },
    catch: io(relative),
  }).pipe(
    Effect.filterOrFail(
      (dir): dir is string => dir !== null,
      () =>
        fail(
          relative,
          "symlink",
          `${relative} passes through a symbolic link or a file; nothing was written.`,
        ),
    ),
  );

/** Writes a file, refusing to follow a symbolic link planted at its name. */
const writeOwn = (path: string, bytes: Buffer) =>
  NodeFSP.writeFile(path, bytes, {
    flag:
      NodeFSP.constants.O_WRONLY |
      NodeFSP.constants.O_CREAT |
      NodeFSP.constants.O_TRUNC |
      (NodeFSP.constants.O_NOFOLLOW ?? 0),
  });

const pngsUnder = async (dir: string, out: string[], depth = 0): Promise<void> => {
  if (depth > 6 || out.length >= PALETTE_FILES) return;
  const entries = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= PALETTE_FILES) return;
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) await pngsUnder(full, out, depth + 1);
    else if (entry.isFile() && /\.png$/i.test(entry.name)) out.push(full);
  }
};

/** The palette's opaque colours, most used first: a PNG, a folder of PNGs, or a pack id added to this game. */
const paletteOf = (realRoot: string, lane: string, spec: string) =>
  Effect.gen(function* () {
    const relative =
      spec.includes("/") || /\.png$/i.test(spec) ? spec : `${laneLibrary(lane)}/${spec}`;
    if (!cleanRelative(relative))
      return yield* fail(
        spec,
        "invalid-path",
        "palette must be a game-relative PNG or folder, or a library pack id.",
      );
    const real = yield* Effect.promise(() =>
      NodeFSP.realpath(NodePath.join(realRoot, relative)).catch(() => null),
    );
    if (real === null)
      return yield* fail(
        relative,
        "invalid-input",
        `No palette at ${relative}. Pass a PNG or folder in this game, or a pack id added with game_assets_add.`,
      );
    if (!real.startsWith(`${realRoot}${NodePath.sep}`))
      return yield* fail(relative, "invalid-path", "The palette must be inside the game.");
    const files: string[] = [];
    const stat = yield* Effect.tryPromise({ try: () => NodeFSP.stat(real), catch: io(relative) });
    if (stat.isDirectory()) yield* Effect.promise(() => pngsUnder(real, files));
    else files.push(real);
    const images: Rgba[] = [];
    let pixels = 0;
    for (const file of files) {
      const bytes = yield* Effect.promise(() => NodeFSP.readFile(file).catch(() => null));
      if (bytes === null) continue;
      const decoded = yield* Effect.promise(() => decodePng(bytes, PALETTE_PIXELS - pixels));
      if ("skip" in decoded) continue;
      pixels += decoded.width * decoded.height;
      images.push(decoded);
      if (pixels >= PALETTE_PIXELS) break;
    }
    const colours = colourCounts(images)
      .slice(0, PALETTE_COLOURS)
      .map(([c]) => c);
    if (colours.length === 0)
      return yield* fail(
        relative,
        "invalid-input",
        `${relative} holds no readable opaque PNG pixels to take a palette from.`,
      );
    return { relative, colours, files: images.length };
  });

const viewsOf = (input: GameBlenderRenderSpritesInput): SpriteView[] => {
  const tilt = input.elevation ?? 0;
  const named = {
    front: [0, tilt],
    back: [180, tilt],
    right: [90, tilt],
    left: [-90, tilt],
    top: [0, 90],
    isometric: [45, input.elevation ?? 30],
  } as const;
  return (input.views ?? ["right"]).map((view) =>
    typeof view === "string"
      ? { name: view, azimuth: named[view][0], elevation: named[view][1] }
      : view,
  );
};

const spanText = (files: ReadonlyArray<string>) =>
  files.length === 1 ? files[0]! : `${files[0]} … ${NodePath.basename(files.at(-1)!)}`;

/** Where the agent's own words start on a provenance line; a re-render keeps what follows. */
const FILL_MARKERS = ["Depicts / loaded by: ", "Loaded by: "];
const suffixOf = (line: string) => {
  for (const marker of FILL_MARKERS) {
    const at = line.lastIndexOf(marker);
    if (at >= 0) return { at, marker, rest: line.slice(at + marker.length) };
  }
  return null;
};

/** One provenance line per strip, replaced in place when the same strip is rendered again, keeping what the agent filled in. */
const recordProvenance = (
  realRoot: string,
  lines: ReadonlyArray<{ first: string; line: string }>,
) =>
  Effect.gen(function* () {
    const path = NodePath.join(realRoot, "ASSETS.md");
    const stat = yield* Effect.promise(() => NodeFSP.lstat(path).catch(() => null));
    if (stat !== null && !stat.isFile())
      return `ASSETS.md is ${stat.isSymbolicLink() ? "a symbolic link" : "not a file"}; provenance was not written.`;
    const current =
      stat === null
        ? "# ASSETS\n"
        : yield* Effect.tryPromise({
            try: () => NodeFSP.readFile(path, "utf8"),
            catch: io("ASSETS.md"),
          });
    const kept = current.split("\n");
    while (kept.length > 0 && kept.at(-1) === "") kept.pop();
    const added: string[] = [];
    for (const { first, line } of lines) {
      const at = kept.findIndex(
        (l) => l.includes(TOOL) && (l.includes(`\`${first}\``) || l.includes(`\`${first} `)),
      );
      if (at < 0) {
        added.push(line);
        continue;
      }
      const old = suffixOf(kept[at]!);
      const fresh = suffixOf(line);
      kept[at] =
        old === null || fresh === null || old.rest === "(fill in)."
          ? line
          : `${line.slice(0, fresh.at + fresh.marker.length)}${old.rest}`;
    }
    const next = `${[...kept, ...added].join("\n")}\n`;
    yield* Effect.tryPromise({
      try: () => writeOwn(path, Buffer.from(next)),
      catch: io("ASSETS.md"),
    });
    return stat === null
      ? "ASSETS.md created with the provenance."
      : "ASSETS.md records the provenance.";
  });

/** How this game's engine puts a node's origin on the ground line `ground` rows from the top. */
const groundHint = (engine: GameEngineId, width: number, height: number, ground: number) => {
  const up = Number(((height - ground) / height).toFixed(4));
  if (engine === "three")
    return `three.js: sprite.center.set(0.5, ${up}) on a THREE.Sprite, or geometry.translate(0, ${Number((0.5 - up).toFixed(4))} * planeHeight, 0) on a plane, puts the object's position on the ground line.`;
  if (engine === "unity")
    return `Unity: set the sprite's Pivot to Custom (0.5, ${up}) in its import settings (Pixels Per Unit is yours to match the tiles) to put the transform on the ground line.`;
  return `Godot: Sprite2D offset (0, ${height / 2 - ground}) puts the node origin on the ground line (x=${width / 2} is already the origin).`;
};

export interface SpriteDeps {
  readonly callText: (
    root: string,
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<string, GameOperationError>;
  readonly manifest: (root: string) => Effect.Effect<GameManifest, GameOperationError>;
}

export const renderSprites = (
  deps: SpriteDeps,
  root: string,
  input: GameBlenderRenderSpritesInput,
): Effect.Effect<GameBlenderRenderSpritesResult, GameOperationError> =>
  Effect.gen(function* () {
    const manifest = yield* deps.manifest(root);
    const lane = manifest.godotProject;
    const output = input.output.trim().replace(/\.png$/i, "");
    if (!output.startsWith(`${lane}/`) || !cleanRelative(output))
      return yield* fail(
        input.output,
        "invalid-path",
        `output must be a game-relative path prefix under ${lane}/ such as ${lane}/assets/sprites/hero_walk (letters, digits, _ . -).`,
      );
    const dirRel = NodePath.posix.dirname(output);
    const base = NodePath.posix.basename(output);
    const views = viewsOf(input);
    if (new Set(views.map((v) => v.name)).size !== views.length)
      return yield* fail(input.output, "invalid-input", "Each view needs its own name.");
    const width = input.size ?? 64;
    const height = input.height ?? width;
    const pixel = input.pixelArt;
    const k =
      pixel === undefined
        ? 1
        : Math.max(
            1,
            Math.min(pixel.supersample ?? 4, Math.floor(MAX_RENDER_SIDE / Math.max(width, height))),
          );
    const explicitOutline = typeof pixel?.outline === "string" ? hexColour(pixel.outline) : null;
    if (typeof pixel?.outline === "string" && explicitOutline === null)
      return yield* fail(
        String(pixel.outline),
        "invalid-input",
        "outline takes true or a #rrggbb colour.",
      );
    const outlined = pixel?.outline !== undefined && pixel.outline !== false;
    const inset =
      (input.margin ??
        (pixel !== undefined
          ? Math.max(1, Math.round(Math.min(width, height) * 0.03))
          : Math.max(2, Math.round(Math.min(width, height) * 0.04)))) + (outlined ? 1 : 0);
    const anchorKinds = views.map((v) => input.anchor ?? (v.elevation >= 60 ? "center" : "feet"));

    const realRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(root),
      catch: io(root),
    });
    // Checked before anything renders, so a bad palette costs no Blender time.
    const palette =
      pixel?.palette === undefined ? null : yield* paletteOf(realRoot, lane, pixel.palette);
    const scratch = yield* realDir(realRoot, SCRATCH);
    const rawDir = NodePath.join(scratch, "raw");
    yield* Effect.tryPromise({
      try: () => NodeFSP.rm(rawDir, { recursive: true, force: true }),
      catch: io(`${SCRATCH}/raw`),
    });
    const raw = yield* realDir(realRoot, `${SCRATCH}/raw`);
    const outDir = yield* realDir(realRoot, dirRel);

    const objects = input.objects ?? [];
    const k2 = k * k;
    const outputPixels = (renders: number) => renders * width * height;
    const fitText = yield* deps.callText(root, "execute_blender_code", {
      code: spriteRenderCode({
        phase: "fit",
        objects,
        action: input.action ?? null,
        frames: input.frames ?? null,
        frameStart: input.frameStart ?? null,
        frameEnd: input.frameEnd ?? null,
        frameCount: input.frameCount ?? null,
        loop: input.loop ?? true,
        views,
      }),
    });
    const fitted = spriteRenderOutput(fitText) as
      | (Partial<SpriteFit> & {
          error?: string;
          missing?: string[];
          objects?: string[];
          collections?: string[];
          actions?: string[];
          roots?: string[];
        })
      | null;
    if (fitted === null) return yield* fail(OP, "command-failed", fitText.slice(0, 2000));
    if (fitted.error === "ambiguous")
      return yield* fail(
        "objects",
        "invalid-input",
        `Pass objects: the scene has ${(fitted.roots ?? []).length} top-level objects with geometry, and a sprite shows one subject. Top-level objects: ${(fitted.roots ?? []).join(", ")}. Collections: ${(fitted.collections ?? []).join(", ") || "none"}.`,
      );
    if (fitted.error === "tweak")
      return yield* fail(
        (fitted.objects ?? []).join(", "),
        "invalid-input",
        `${(fitted.objects ?? []).join(", ")} ${(fitted.objects ?? []).length === 1 ? "is" : "are"} in NLA tweak mode (editing a strip), which makes the active action read-only, so ${input.action} cannot play. Leave tweak mode first (in game_blender_code: obj.animation_data.use_tweak_mode = False); nothing was changed.`,
      );
    if (fitted.error === "missing")
      return yield* fail(
        (fitted.missing ?? []).join(", "),
        "invalid-input",
        `No object or collection named ${(fitted.missing ?? []).join(", ")}. Scene objects: ${(fitted.objects ?? []).join(", ")}. Collections: ${(fitted.collections ?? []).join(", ") || "none"}.`,
      );
    if (fitted.error === "empty")
      return yield* fail(
        objects.join(", ") || "scene",
        "invalid-input",
        `Nothing visible to render there (no mesh, curve or text with geometry). Scene objects: ${(fitted.objects ?? []).join(", ")}.`,
      );
    if (fitted.error === "action")
      return yield* fail(
        input.action ?? "",
        "invalid-input",
        `No action named ${input.action}. Actions in this file: ${(fitted.actions ?? []).join(", ") || "none"}.`,
      );
    const fit = fitted as SpriteFit;
    const frames = fit.frames;
    if (frames.length * views.length > MAX_RENDERS)
      return yield* fail(
        input.output,
        "invalid-input",
        `${frames.length} frames x ${views.length} views is over ${MAX_RENDERS} renders; ${SPLIT}.`,
      );
    const renders = frames.length * views.length;
    if (
      outputPixels(renders) > MAX_OUTPUT_PIXELS ||
      outputPixels(renders) * k2 > MAX_RENDERED_PIXELS
    )
      return yield* fail(
        input.output,
        "invalid-input",
        `${renders} renders of ${width}x${height}${k > 1 ? ` (rendered at ${width * k}x${height * k})` : ""} are over the ${
          outputPixels(renders) > MAX_OUTPUT_PIXELS
            ? `${MAX_OUTPUT_PIXELS / (1024 * 1024)}M output pixels`
            : `${MAX_RENDERED_PIXELS / (1024 * 1024)}M rendered pixels`
        } one call takes; ${SPLIT}, or render fewer frames.`,
      );
    const moved = travel(fit, anchorKinds);
    if (moved !== null)
      return yield* fail(
        input.action ?? input.output,
        "invalid-input",
        `This clip moves the character (root motion): in view ${moved.view} its whole silhouette travels ${moved.distance.toFixed(2)} units across the frames, more than half its ${moved.size.toFixed(2)}-unit size, so a fitted camera would shrink it and it would slide across the canvas. Use an in-place clip, or render a copy of the clip with the root's location keys removed; the game moves the sprite.`,
      );
    const framing = frameCameras(fit, width, height, inset, anchorKinds, input.pixelsPerUnit);
    if (framing === null)
      return yield* fail(
        input.output,
        "invalid-input",
        "The margin leaves no room on the canvas, or the subject has no size.",
      );
    if (framing.need.width > width || framing.need.height > height)
      return yield* fail(
        input.output,
        "invalid-input",
        `At pixelsPerUnit ${framing.pixelsPerUnit} this subject needs a ${framing.need.width}x${framing.need.height} canvas (with the ${inset} px margin), more than ${width}x${height}. Pass size ${framing.need.width}${framing.need.height === framing.need.width ? "" : ` and height ${framing.need.height}`}, or keep the size and pass a smaller pixelsPerUnit for every strip of this character.`,
      );

    const jobs = views.flatMap((_, vi) =>
      frames.map((frame, fi) => ({ view: vi, frame, path: NodePath.join(raw, `${vi}_${fi}.png`) })),
    );
    let perCall = Math.max(
      1,
      Math.min(FIRST_CALL_RENDERS, Math.floor(RENDER_PIXELS_PER_CALL / (width * k * height * k))),
    );
    for (let at = 0; at < jobs.length;) {
      const batch = jobs.slice(at, at + perCall);
      const text = yield* deps.callText(root, "execute_blender_code", {
        code: spriteRenderCode({
          phase: "render",
          // The fitted geometry, so the render draws exactly what was fitted.
          objects: fit.objects,
          // As the fit did: no action means each object's own animation, untouched.
          action: input.action ?? null,
          lighting: input.lighting ?? "studio",
          width: width * k,
          height: height * k,
          orthoScale: framing.orthoScale,
          cameras: framing.cameras,
          jobs: batch,
        }),
      });
      const done = spriteRenderOutput(text) as { written?: string[]; seconds?: number } | null;
      if (done?.written === undefined)
        return yield* fail(OP, "command-failed", text.slice(0, 2000));
      at += batch.length;
      if (typeof done.seconds === "number" && done.seconds > 0)
        perCall = Math.max(
          1,
          Math.min(64, Math.floor(SECONDS_PER_CALL / (done.seconds / batch.length))),
        );
    }

    // Every render back, then the pixel work over the whole set at once (one shared palette).
    const rows: Rgba[][] = [];
    for (const [vi] of views.entries()) {
      const row: Rgba[] = [];
      for (const [fi] of frames.entries()) {
        const file = NodePath.join(raw, `${vi}_${fi}.png`);
        const bytes = yield* Effect.tryPromise({
          try: () => NodeFSP.readFile(file),
          catch: io(file),
        });
        const decoded = yield* Effect.promise(() => decodePng(bytes));
        if ("skip" in decoded)
          return yield* fail(
            file,
            "command-failed",
            `Blender's render could not be read: ${decoded.skip}.`,
          );
        yield* Effect.yieldNow;
        let img = decoded;
        if (pixel !== undefined) {
          img = downscale(decoded, k, pixel.downscale ?? "area");
          hardAlpha(img);
        }
        row.push(img);
      }
      rows.push(row);
    }
    const all = rows.flat();
    let paletteText = "";
    if (pixel !== undefined) {
      const colors = pixel.colors ?? 16;
      const used = quantize(all, palette?.colours ?? null, colors);
      const own = palette === null ? darkest(used) : null;
      const line =
        explicitOutline ??
        (!outlined
          ? null
          : palette !== null
            ? darkest(palette.colours)
            : own !== null && lightness(own) <= OUTLINE_MAX_LIGHTNESS
              ? own
              : NEAR_BLACK);
      if (line !== null) for (const img of all) outline(img, line);
      paletteText = `Pixel art: rendered at ${width * k}x${height * k}, ${pixel.downscale ?? "area"} downscale by ${k}, hard alpha, ${used.length} colours ${
        palette === null
          ? "from a median cut of the frames' own colours"
          : `taken from ${palette.relative} (${palette.colours.length} colours over ${palette.files} PNGs)`
      }, shared by every frame${line === null ? "" : `, 1 px outline ${colourHex(line)}`}.`;
    }

    const files: string[] = [];
    const written = new Set<string>();
    for (const [vi, view] of views.entries()) {
      const stem = views.length === 1 ? base : `${base}_${view.name}`;
      for (const [fi, img] of rows[vi]!.entries()) {
        const name = `${stem}_${fi}.png`;
        yield* Effect.tryPromise({
          try: () => writeOwn(NodePath.join(outDir, name), encodePng(img)),
          catch: io(`${dirRel}/${name}`),
        });
        files.push(`${dirRel}/${name}`);
        written.add(name);
      }
    }
    // A shorter re-render leaves no stale higher frames for the engine or the facts to pick up.
    const stems = views.map((v) => (views.length === 1 ? base : `${base}_${v.name}`));
    const stale = (yield* Effect.promise(() =>
      NodeFSP.readdir(outDir).catch(() => [] as string[]),
    )).filter(
      (name) =>
        !written.has(name) &&
        stems.some((stem) => new RegExp(`^${stem.replace(/[.]/g, "\\.")}_\\d+\\.png$`).test(name)),
    );
    for (const name of stale) {
      for (const victim of [name, `${name}.import`]) {
        const full = NodePath.join(outDir, victim);
        const stat = yield* Effect.promise(() => NodeFSP.lstat(full).catch(() => null));
        if (stat?.isFile() === true)
          yield* Effect.tryPromise({
            try: () => NodeFSP.unlink(full),
            catch: io(`${dirRel}/${victim}`),
          });
      }
    }
    let sheetRel: string | undefined;
    if (input.sheet === true) {
      sheetRel = `${dirRel}/${base}_sheet.png`;
      yield* Effect.tryPromise({
        try: () => writeOwn(NodePath.join(outDir, `${base}_sheet.png`), encodePng(sheet(rows))),
        catch: io(sheetRel),
      });
    }
    // The outline grows the silhouette by a pixel, so the feet's outline row is the ground.
    const groundOf = (a: { y: number }) => a.y + (outlined ? 1 : 0);
    const contact = contactSheet(
      rows,
      framing.anchors.map((a) => (a.kind === "feet" ? groundOf(a) : -1)),
    );
    const contactRel = `${SCRATCH}/${base}-contact.png`;
    const contactPng = encodePng(contact.image);
    yield* Effect.tryPromise({
      try: () => writeOwn(NodePath.join(scratch, `${base}-contact.png`), contactPng),
      catch: io(contactRel),
    });
    yield* Effect.promise(() => NodeFSP.rm(raw, { recursive: true, force: true }));

    // Honest numbers on what was written, so a dark or empty render is visible without opening it.
    const measured = all.map((img) => measure(img));
    const lumas = measured.flatMap((m) => (m.luminance === null ? [] : [m.luminance]));
    const colours = colourCounts(all).length;
    const empty = measured.filter((m) => m.box === null).length;

    // Without an action each object plays its own; the fit's action only gave the frame range.
    const playing =
      fit.action === null
        ? null
        : input.action === undefined
          ? `each object's own animation (frame range of ${fit.action})`
          : fit.action;
    const describe = [
      `objects ${fit.objects.join(", ")}`,
      playing === null ? null : `action ${playing}`,
      `frames ${frames.join(", ")}`,
      `${width}x${height}`,
      pixel === undefined
        ? "smooth"
        : `pixel art, ${palette === null ? "own palette" : `palette ${palette.relative}`}${outlined ? ", outlined" : ""}`,
    ]
      .filter((x) => x !== null)
      .join("; ");
    const provenance = yield* recordProvenance(realRoot, [
      ...views.map((view, vi) => {
        const strip = files.slice(vi * frames.length, (vi + 1) * frames.length);
        const anchor = framing.anchors[vi]!;
        return {
          first: strip[0]!,
          line: `- \`${spanText(strip)}\` — ${frames.length === 1 ? "sprite" : `${frames.length}-frame strip`}, view ${view.name}, ${anchor.kind === "feet" ? `ground line y=${groundOf(anchor)} at x=${anchor.x}` : `centred at ${anchor.x},${anchor.y}`}; rendered by ${TOOL} from ${BLEND_REL} (${describe}). Licence: that of the models rendered. Depicts / loaded by: (fill in).`,
        };
      }),
      ...(sheetRel === undefined
        ? []
        : [
            {
              first: sheetRel,
              line: `- \`${sheetRel}\` — sheet of the strips above, ${frames.length} columns (frames) x ${views.length} rows (${views.map((v) => v.name).join(", ")}) of ${width}x${height}; rendered by ${TOOL} from ${BLEND_REL}. Licence: that of the models rendered. Loaded by: (fill in).`,
            },
          ]),
    ]);

    const text = [
      `Rendered ${frames.length} frame${frames.length === 1 ? "" : "s"} x ${views.length} view${views.length === 1 ? "" : "s"} (${views.map((v) => `${v.name}: azimuth ${v.azimuth}, elevation ${v.elevation}`).join("; ")}) of ${fit.objects.join(", ")}${playing === null ? "" : ` playing ${playing}`}; frames ${frames.join(", ")}.`,
      ...views.map(
        (_, vi) => `- ${spanText(files.slice(vi * frames.length, (vi + 1) * frames.length))}`,
      ),
      ...(sheetRel === undefined
        ? []
        : [
            `Sheet: ${sheetRel} (${frames.length} columns x ${views.length} rows of ${width}x${height}).`,
          ]),
      ...(stale.length > 0
        ? [`Removed stale frames from an earlier render: ${stale.join(", ")}.`]
        : []),
      `One orthographic camera per view, fixed across every frame: nothing is cut off, ${inset} px clear on every side, ${framing.pixelsPerUnit} px per Blender unit in every frame and view (${input.pixelsPerUnit === undefined ? "fitted to this clip" : "as asked"}). Pass pixelsPerUnit: ${framing.pixelsPerUnit} for this character's other strips, so the body is the same size in all of them.`,
      ...views.map((v, vi) => {
        const a = framing.anchors[vi]!;
        const column = `x=${a.x} is ${a.onOrigin && fit.anchorObject !== null ? `${fit.anchorObject}'s origin` : "the middle of the subject"}`;
        return a.kind === "feet"
          ? `Anchor (${v.name}): ground line y=${groundOf(a)} (the red line on the contact sheet), ${column}, fixed in every frame: the lowest point across all frames rests on it, so any bob or lifted foot is the animation's own. ${groundHint(manifest.engine.name, width, height, groundOf(a))}`
          : `Anchor (${v.name}): ${a.x},${a.y}, the canvas centre (${column}), in every frame: the engine's default centred sprite puts the node origin there.`;
      }),
      ...(paletteText === "" ? [] : [paletteText]),
      `Measured: ${colours} colours over the strip; mean luminance of visible pixels ${Math.round(Math.min(...lumas))}-${Math.round(Math.max(...lumas))} (0-255)${empty > 0 ? `; ${empty} frames are empty` : ""}.`,
      `Contact sheet: ${contactRel} (attached; frames at ${contact.zoom}x). Look at it before you use the frames.`,
      `${provenance} Add what the frames depict and where the game loads them. Run game_import after.`,
    ].join("\n");
    return {
      text,
      files,
      ...(sheetRel === undefined ? {} : { sheet: sheetRel }),
      contactSheet: contactRel,
      screenshot: {
        mimeType: "image/png" as const,
        data: contactPng.toString("base64"),
        width: contact.image.width,
        height: contact.image.height,
      },
    };
  });
