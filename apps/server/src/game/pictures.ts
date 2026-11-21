// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Reads the game's template and files, writes PNG sheets into the game folder.
// game_assets op pictures: flat art (cards, tiles, tokens, icons, UI art) and drawn animations made
// as pictures. The agent writes one template in HTML and CSS or SVG; the server's headless browser
// draws it once per row of data, with nothing from the network, and the pictures are laid in
// texture sheets beside one .sheet.json map that shell/sheets.js plays.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { PNG } from "pngjs";
import * as Effect from "effect/Effect";
import {
  GameOperationError,
  type GameEngineId,
  type GamePicturesInput,
  type GamePicturesResult,
  type GameStyle,
  GAME_STYLE_DEFAULT_BUDGET,
} from "@kurambit/contracts";
import { chromiumChildEnv, type GameBrowser } from "./gameChromium.ts";
import { gamePaths } from "./engineProfile.ts";
import { recordProvenance, writeOwn } from "./assetProvenance.ts";
import { contactSheet, downscale, encodePng, type Rgba } from "./rgba.ts";

const OP = "game-pictures";
const TOOL = "game_assets op pictures";
const SCRATCH = "builds/logs/pictures";
/** Clear pixels round every picture in a sheet, so a mipmap never reads its neighbour. */
const GUTTER = 2;
/** The page's own origin: the game folder answers it, and every other request is refused. */
const ORIGIN = "http://game.localhost";
const PAGE = "__kurambit_picture.html";
/** Pixels a contact sheet aims at, so the whole set fits one look. */
const CONTACT_PIXELS = 1280 * 1280;

const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

const fail = (path: string, reason: GameOperationError["reason"], detail: string) =>
  new GameOperationError({ operation: OP, path, reason, detail });

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** The page for one row: its {{key}}s filled, the row as window.row, a clear page of the size. */
export const picturePage = (
  template: string,
  row: Readonly<Record<string, unknown>>,
  [width, height]: readonly [number, number],
) => {
  const missing = new Set<string>();
  const filled = template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in row)) missing.add(key);
    return escape(row[key]);
  });
  const base = `<style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent}</style><script>window.row=${JSON.stringify(row).replace(/</g, "\\u003c")}</script>`;
  const html = /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(filled)
    ? `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${filled.replace(/^\s*<\?xml[^>]*>/, "")}</body></html>`
    : /<head[\s>]/i.test(filled)
      ? filled.replace(/<head([^>]*)>/i, `<head$1><meta charset="utf-8">${base}`)
      : `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${filled}</body></html>`;
  return { html, missing: [...missing] };
};

/** Every picture in grid cells of one size, as many sheets as the side allows. */
export const packSheets = (
  pictures: ReadonlyArray<Rgba>,
  [width, height]: readonly [number, number],
  side: number,
) => {
  const cellW = width + GUTTER * 2;
  const cellH = height + GUTTER * 2;
  const columns = Math.max(1, Math.floor(side / cellW));
  const rows = Math.max(1, Math.floor(side / cellH));
  const perSheet = columns * rows;
  const sheets: Array<Rgba> = [];
  const placed: Array<{ image: number; x: number; y: number }> = [];
  for (let start = 0; start < pictures.length; start += perSheet) {
    const count = Math.min(perSheet, pictures.length - start);
    const used = Math.min(columns, count);
    const sheet = {
      width: used * cellW,
      height: Math.ceil(count / columns) * cellH,
      data: new Uint8Array(used * cellW * Math.ceil(count / columns) * cellH * 4),
    };
    for (let k = 0; k < count; k += 1) {
      const x = (k % columns) * cellW + GUTTER;
      const y = Math.floor(k / columns) * cellH + GUTTER;
      const picture = pictures[start + k]!;
      for (let row = 0; row < height; row += 1)
        sheet.data.set(
          picture.data.subarray(row * width * 4, (row + 1) * width * 4),
          ((y + row) * sheet.width + x) * 4,
        );
      placed.push({ image: sheets.length, x, y });
    }
    sheets.push(sheet);
  }
  return { sheets, placed };
};

const insideRoot = (realRoot: string, relative: string) => {
  const full = NodePath.resolve(realRoot, relative);
  return full === realRoot || full.startsWith(realRoot + NodePath.sep) ? full : null;
};

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/** Sets every CSS and SVG animation on the page to `seconds`, then asks window.frame. */
const AT_TIME = `([seconds, index]) => {
  for (const a of document.getAnimations()) { a.pause(); a.currentTime = seconds * 1000; }
  for (const svg of document.querySelectorAll("svg")) if (svg.pauseAnimations) { svg.pauseAnimations(); svg.setCurrentTime(seconds); }
  if (typeof window.frame === "function") window.frame(seconds, index);
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
}`;

/** The fonts each text node drew with, from Chrome itself: [family, from the page's @font-face]. */
const fontsUsed = async (cdp: import("playwright-core").CDPSession) => {
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: "*",
  });
  const used = new Map<string, boolean>();
  for (const nodeId of nodeIds) {
    const { fonts } = await cdp
      .send("CSS.getPlatformFontsForNode", { nodeId })
      .catch(() => ({ fonts: [] }));
    for (const font of fonts) if (font.glyphCount > 0) used.set(font.familyName, font.isCustomFont);
  }
  return used;
};

export interface PicturesDeps {
  readonly browser: GameBrowser;
  readonly realRoot: string;
  readonly engine: GameEngineId;
  readonly project: string;
  readonly style: GameStyle | null;
}

export const renderPictures = (deps: PicturesDeps, input: GamePicturesInput) =>
  Effect.gen(function* () {
    const { realRoot } = deps;
    const [width, height] = input.size;
    const frames = input.frames ?? 1;
    const fps = input.fps ?? 12;
    const names = new Set<string>();
    for (const row of input.rows) {
      const name = String(row.name);
      if (names.has(name))
        return yield* fail(input.output, "invalid-input", `two rows are named ${name}`);
      names.add(name);
    }
    const inline = /[<>]/.test(input.template);
    const templatePath = inline ? null : insideRoot(realRoot, input.template);
    if (!inline && (templatePath === null || !/\.(html?|svg)$/i.test(input.template)))
      return yield* fail(
        input.template,
        "invalid-input",
        "template is inline HTML or SVG, or a game path to a .html or .svg file",
      );
    const template =
      templatePath === null
        ? input.template
        : yield* Effect.tryPromise({
            try: () => NodeFSP.readFile(templatePath, "utf8"),
            catch: () => fail(input.template, "io", `${input.template} could not be read`),
          });
    // Relative URLs in the template resolve from its own folder (the game root when inline).
    const folder =
      templatePath === null
        ? ""
        : NodePath.relative(realRoot, NodePath.dirname(templatePath)).split(NodePath.sep).join("/");
    const pageUrl = `${ORIGIN}/${folder === "" ? "" : `${folder}/`}${PAGE}`;
    const side = deps.style?.budget?.texture ?? GAME_STYLE_DEFAULT_BUDGET.texture;
    if (width + GUTTER * 2 > side || height + GUTTER * 2 > side)
      return yield* fail(
        input.output,
        "invalid-input",
        `a ${width}x${height} picture does not fit a sheet ${side} px on a side (STYLE.json budget.texture): draw it smaller, or raise the budget`,
      );
    const nearest = deps.style?.mode === "pixel" || deps.style?.shape?.edges === "voxel";
    const paths = gamePaths(deps.engine, deps.project);
    const outDirRel = `${paths.assets}/sheets`;

    const rendered = yield* Effect.tryPromise({
      try: async () => {
        const { chromium } = loadPlaywright();
        const browser = await chromium
          .launch({
            executablePath: deps.browser.executable,
            headless: true,
            chromiumSandbox: deps.browser.sandbox,
            args: [...deps.browser.args],
            env: chromiumChildEnv(),
          })
          .catch(async (cause: unknown) => {
            throw new Error(await deps.browser.launchFailure(cause));
          });
        try {
          const context = await browser.newContext({
            viewport: { width, height },
            deviceScaleFactor: 1,
            serviceWorkers: "block",
          });
          const loaded = new Set<string>();
          const refused = new Set<string>();
          let current = "";
          await context.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== ORIGIN) {
              refused.add(url.origin);
              return route.abort();
            }
            if (url.pathname.endsWith(`/${PAGE}`))
              return route.fulfill({ status: 200, contentType: "text/html", body: current });
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
            const file = insideRoot(realRoot, relative);
            const real = file === null ? null : await NodeFSP.realpath(file).catch(() => null);
            if (real === null || insideRoot(realRoot, NodePath.relative(realRoot, real)) === null)
              return route.fulfill({ status: 404, body: "" });
            loaded.add(relative);
            return route.fulfill({
              status: 200,
              contentType:
                TYPES[NodePath.extname(real).toLowerCase()] ?? "application/octet-stream",
              body: await NodeFSP.readFile(real),
            });
          });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(String(error.message).slice(0, 200)));
          const cdp = await context.newCDPSession(page);
          const fonts = new Map<string, boolean>();
          const pictures: Array<Array<Rgba>> = [];
          for (const row of input.rows) {
            const { html, missing } = picturePage(template, row, input.size);
            if (missing.length > 0)
              throw new Missing(`row ${String(row.name)} has no ${missing.join(", ")}`);
            current = html;
            await page.goto(pageUrl, { waitUntil: "load" });
            await page.evaluate("document.fonts.ready.then(() => true)");
            if (frames > 1 || row === input.rows[0])
              for (const [family, custom] of await fontsUsed(cdp)) fonts.set(family, custom);
            const shots: Array<Rgba> = [];
            for (let i = 0; i < frames; i += 1) {
              await page.evaluate(`(${AT_TIME})([${i / fps}, ${i}])`);
              const png = PNG.sync.read(await page.screenshot({ omitBackground: true }));
              shots.push({ width: png.width, height: png.height, data: new Uint8Array(png.data) });
            }
            pictures.push(shots);
          }
          return { pictures, fonts, loaded, refused, errors };
        } finally {
          await browser.close().catch(() => undefined);
        }
      },
      catch: (cause) =>
        cause instanceof Missing
          ? fail(input.output, "invalid-input", cause.message)
          : new GameOperationError({
              operation: OP,
              path: input.output,
              reason: "tool-failed",
              detail: `The headless browser could not draw the pictures: ${String(cause instanceof Error ? cause.message : cause).slice(0, 300)}`,
              cause,
            }),
    });
    const system = [...rendered.fonts].filter(([, custom]) => !custom).map(([family]) => family);
    if (system.length > 0)
      return yield* fail(
        input.output,
        "invalid-input",
        `The text drew with ${system.join(", ")}, a font of this computer, not one the game ships: the pictures would change from machine to machine and its licence is unknown. Put a font file in the game (game_assets op search "font"), load it with @font-face from a path in the game, and name it in font-family.`,
      );

    const all = rendered.pictures.flat();
    const { sheets, placed } = packSheets(all, input.size, side);
    const outDir = NodePath.join(realRoot, outDirRel);
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(outDir, { recursive: true }),
      catch: () => fail(outDirRel, "io", `${outDirRel} could not be made`),
    });
    const imageNames = sheets.map((_, i) => `${input.output}${i === 0 ? "" : `_${i + 1}`}.png`);
    const frameNames = input.rows.flatMap((row) =>
      frames === 1
        ? [String(row.name)]
        : Array.from({ length: frames }, (_, i) => `${String(row.name)}_${i}`),
    );
    const map = {
      version: 1,
      frame: [width, height],
      pivot: input.pivot ?? [0.5, 0.5],
      filter: nearest ? "nearest" : "linear",
      images: imageNames,
      frames: placed.map((at, i) => ({ name: frameNames[i]!, ...at })),
      ...(frames === 1
        ? {}
        : {
            clips: Object.fromEntries(
              input.rows.map((row, r) => [
                String(row.name),
                {
                  frames: Array.from({ length: frames }, (_, i) => r * frames + i),
                  fps,
                  loop: input.loop ?? true,
                },
              ]),
            ),
          }),
    };
    const sheetRel = `${outDirRel}/${input.output}.sheet.json`;
    yield* Effect.tryPromise({
      try: async () => {
        for (const [i, sheet] of sheets.entries())
          await writeOwn(NodePath.join(outDir, imageNames[i]!), encodePng(sheet));
        await writeOwn(
          NodePath.join(realRoot, sheetRel),
          Buffer.from(`${JSON.stringify(map, null, 1)}\n`),
        );
      },
      catch: () => fail(sheetRel, "io", `${sheetRel} could not be written`),
    });

    // The whole set in one picture, scaled so it fits one look.
    const scale = Math.max(1, Math.ceil(Math.sqrt((all.length * width * height) / CONTACT_PIXELS)));
    const small = rendered.pictures.map((shots) =>
      shots.map((shot) => downscale(shot, scale, "area")),
    );
    const contact = contactSheet(
      frames === 1 ? [small.flat()] : small,
      small.map(() => -1),
    );
    const contactName = `${input.output}-contact.png`;
    const contactRel = `${SCRATCH}/${contactName}`;
    const contactPng = encodePng(contact.image);
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(NodePath.join(realRoot, SCRATCH), { recursive: true });
        await writeOwn(NodePath.join(realRoot, contactRel), contactPng);
      },
      catch: () => fail(contactRel, "io", `${contactRel} could not be written`),
    });

    const fontList = [...rendered.fonts.keys()];
    const files = [...rendered.loaded].filter((file) => file !== "favicon.ico");
    const provenance = yield* recordProvenance(
      realRoot,
      [
        {
          first: sheetRel,
          line: `- \`${sheetRel}\` and ${imageNames.map((n) => `\`${outDirRel}/${n}\``).join(", ")} — ${input.rows.length} ${frames === 1 ? (input.rows.length === 1 ? "picture" : "pictures") : `animations of ${frames} frames`} of ${width}x${height}, drawn by ${TOOL} from ${templatePath === null ? "an inline template" : `\`${input.template}\``}${fontList.length === 0 ? "" : `; fonts ${fontList.join(", ")}`}${files.length === 0 ? "" : `; files ${files.slice(0, 12).join(", ")}`}. Licence: made in this game; the fonts and files keep their own (their lines). Depicts / loaded by: (fill in).`,
        },
      ],
      TOOL,
    );
    const text = [
      `Drew ${input.rows.length} row${input.rows.length === 1 ? "" : "s"}${frames === 1 ? "" : ` x ${frames} frames at ${fps} fps`} at ${width}x${height} into ${sheets.length} sheet${sheets.length === 1 ? "" : "s"} of at most ${side} px (STYLE.json budget.texture): ${sheetRel}.`,
      `Frames: ${frameNames.slice(0, 8).join(", ")}${frameNames.length > 8 ? ", ..." : ""}; filter ${map.filter}.`,
      rendered.errors.length === 0
        ? null
        : `Page errors: ${rendered.errors.slice(0, 3).join("; ")}`,
      rendered.refused.size === 0
        ? null
        : `Refused (no network): ${[...rendered.refused].slice(0, 4).join(", ")}; what they held is missing from the pictures.`,
      `In the game: ASSETS = { ${input.output}: "${NodePath.posix.relative(deps.project, sheetRel)}" }, then ctx.assets.sheet("${input.output}") (shell/sheets.js).`,
      `Contact sheet: ${contactRel} (attached${scale > 1 ? `, at 1/${scale}` : ""}). Look at every picture before you use them.`,
      provenance,
    ]
      .filter((line) => line !== null)
      .join("\n");
    return {
      text,
      sheet: sheetRel,
      images: imageNames.map((n) => `${outDirRel}/${n}`),
      contactSheet: contactRel,
      screenshot: {
        mimeType: "image/png" as const,
        data: contactPng.toString("base64"),
        width: contact.image.width,
        height: contact.image.height,
      },
    } satisfies GamePicturesResult;
  });

class Missing extends Error {}
