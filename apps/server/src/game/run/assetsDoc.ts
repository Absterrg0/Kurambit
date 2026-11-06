// @effect-diagnostics nodeBuiltinImport:off -- ASSETS.md is read from the game folder.
// The one reader of ASSETS.md, the game's file-to-use map: what the asset facts,
// the model facts and the image facts take as listed. Its writers (the library's
// add, Blender's sprite render, imports) emit the three forms read here.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const ASSET_EXT =
  "png|jpe?g|webp|svg|gif|bmp|tga|exr|hdr|ktx2|wav|ogg|mp3|flac|glb|gltf|fbx|obj|blend|dae";

// A path character in ASSETS.md; ".." ends a path, so "a_0.png..a_5.png" reads as a span.
const LISTED_PATH = `(?:res://)?(?!\\[)(?:[\\w/@*\\[\\]-]|\\.(?!\\.))*?\\.(?:${ASSET_EXT})\\b`;
const LISTED_TOKEN = new RegExp(
  `(${LISTED_PATH})(?:\\s*(?:…|\\.{2,3})\\s*(${LISTED_PATH}))?`,
  "gi",
);

// `*` and `[0-5]` are globs; everything else is literal.
const globSource = (glob: string) =>
  glob.replace(/\[([\w-]+)\]|\*|[.+?^${}()|[\]\\]/g, (m, cls: string | undefined) =>
    cls !== undefined ? `[${cls}]` : m === "*" ? "[^/]*" : `\\${m}`,
  );

/** `a_0.png … a_5.png`: the differing middle of two names, as digits where both are digits. */
const spanSource = (first: string, last: string) => {
  const dir = first.slice(0, first.lastIndexOf("/") + 1);
  const a = first.slice(dir.length);
  const b = last.slice(last.lastIndexOf("/") + 1);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s])
    s += 1;
  while (p > 0 && /\d/.test(a[p - 1] ?? "")) p -= 1;
  while (s > 0 && /\d/.test(a[a.length - s] ?? "")) s -= 1;
  const digits = /^\d+$/.test(a.slice(p, a.length - s)) && /^\d+$/.test(b.slice(p, b.length - s));
  return `${globSource(dir + a.slice(0, p))}${digits ? "\\d+" : "[^/]+"}${globSource(a.slice(a.length - s))}`;
};

/**
 * The engine-dir files (paths relative to it) an ASSETS.md names, and its
 * entries that name none: plain paths, `dir/*.ext` globs (a library folder add)
 * and `a_0.png … a_7.png` spans (rendered frames) alike.
 */
export const listedIn = (assetsMd: string, assets: ReadonlyArray<string>, lane: string) => {
  const inList = new Set<string>();
  const missing = new Set<string>();
  const clean = (token: string) => {
    const path = token.replace(/^res:\/\//, "").replace(/^\.\//, "");
    return path.startsWith(`${lane}/`) ? path.slice(lane.length + 1) : path;
  };
  for (const m of assetsMd.matchAll(LISTED_TOKEN)) {
    const token = m[1] ?? "";
    const path = clean(token);
    const name = path.slice(path.lastIndexOf("/") + 1);
    // A stray extension or a name fragment is not a file entry.
    if (/^[._]/.test(path) || /^[._]/.test(name)) continue;
    const last = m[2] === undefined ? undefined : clean(m[2]);
    const source = last !== undefined ? spanSource(path, last) : globSource(path);
    let re: RegExp;
    try {
      re = new RegExp(path.includes("/") ? `^${source}$` : `(?:^|/)${source}$`);
    } catch {
      continue;
    }
    const hits = assets.filter((asset) => re.test(asset));
    // Entries outside the engine dir (key art, .blend sources) are not part of the build.
    if (
      hits.length === 0 &&
      path.includes("/") &&
      !token.startsWith(`${lane}/`) &&
      !path.startsWith("assets/") &&
      !token.startsWith("res://")
    )
      continue;
    for (const hit of hits) inList.add(hit);
    if (hits.length === 0) missing.add(last === undefined ? path : `${path} … ${last}`);
  }
  return { inList, missing };
};

/** ASSETS.md's text, or null when the game has none; any other read failure throws. */
export const readAssetsDoc = (root: string): Promise<string | null> =>
  NodeFSP.readFile(NodePath.join(root, "ASSETS.md"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
