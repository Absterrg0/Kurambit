// @effect-diagnostics nodeBuiltinImport:off -- Plain filesystem facts read from the game folder.
// Which asset files the game's own code loads, and how much it draws in code.
// A static scan, deterministic for a given folder: it states facts and never judges them.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface EngineFile {
  /** Path relative to the engine dir, always with forward slashes. */
  readonly path: string;
  /** Contents for source files; null for binaries. */
  readonly text: string | null;
}

export interface AssetUse {
  readonly engine: "godot" | "web";
  readonly assets: number;
  readonly unused: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  readonly listed: number | null;
  readonly listedMissing: ReadonlyArray<string>;
  readonly unlisted: ReadonlyArray<string>;
  readonly unloaded: ReadonlyArray<string>;
  readonly drawn: ReadonlyArray<readonly [string, number]>;
}

const ASSET =
  /\.(png|jpe?g|webp|svg|gif|bmp|tga|exr|hdr|ktx2|wav|ogg|mp3|flac|glb|gltf|fbx|obj|blend|dae)$/i;
const SOURCE_GODOT = /\.(gd|tscn|tres|gdshader|godot|import|uid|gltf)$/i;
const SOURCE_WEB = /\.(m?js|html?|css|json|gltf)$/i;
const SKIP_DIRS = new Set([".godot", ".git", "builds", "vendor", "node_modules"]);

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Ref = { readonly exact: string } | { readonly pattern: RegExp };
/** One literal in source and every engine path it could resolve to. */
type Reference = { readonly raw: string; readonly refs: ReadonlyArray<Ref> };

const norm = (path: string) => NodePath.posix.normalize(path).replace(/^\.\//, "");

// A literal built into a path at runtime (format specifiers, template slots,
// or concatenation right after it) names a family of files, not one.
const toRef = (literal: string, concatenated: boolean, slot: RegExp): Ref => {
  if (slot.test(literal)) {
    const parts = literal.split(slot).map(escapeRe);
    return { pattern: new RegExp(`^${parts.join(".*")}$`) };
  }
  if (concatenated || literal.endsWith("/"))
    return { pattern: new RegExp(`^${escapeRe(literal)}`) };
  return { exact: literal };
};

const GODOT_LITERAL = /(["'])\*?((?:res|uid):\/\/[^"'\n]*)\1(\s*\+)?/g;
const GODOT_SLOT = /%[-+0-9.]*[a-z]|\{[^}]*\}/i;

const godotRefs = (
  text: string,
  uids: ReadonlyMap<string, string>,
  imported: ReadonlyMap<string, string>,
) => {
  const refs: Reference[] = [];
  for (const m of text.matchAll(GODOT_LITERAL)) {
    const raw = m[2] ?? "";
    if (raw.startsWith("uid://")) {
      const path = uids.get(raw);
      if (path !== undefined) refs.push({ raw, refs: [{ exact: path }] });
      continue;
    }
    const ref = toRef(raw.slice("res://".length), m[3] !== undefined, GODOT_SLOT);
    refs.push({
      raw,
      refs: ["exact" in ref ? { exact: imported.get(ref.exact) ?? norm(ref.exact) } : ref],
    });
  }
  return refs;
};

const WEB_LITERAL = /(["'`])([^"'`\n]{1,200}?)\1(\s*\+)?|url\(\s*([^)"'\s]+)\s*\)/g;
const WEB_SLOT = /\$\{[^}]*\}/;

// Page-relative loader paths and module-relative imports look the same in
// source, so each reference may resolve against either base.
const webRefs = (text: string, from: string) => {
  const refs: Reference[] = [];
  for (const m of text.matchAll(WEB_LITERAL)) {
    const raw = (m[2] ?? m[4] ?? "").split(/[?#]/)[0] ?? "";
    const concatenated = m[3] !== undefined;
    if (raw.length === 0 || /\s|^[a-z]+:|^\/\//i.test(raw)) continue;
    const pathLike =
      ASSET.test(raw) ||
      SOURCE_WEB.test(raw) ||
      ((concatenated || raw.endsWith("/")) && raw.includes("/"));
    if (!pathLike) continue;
    const bases = raw.startsWith("/") ? [""] : [NodePath.posix.dirname(from), ""];
    const candidates = bases
      .map((base) => norm(NodePath.posix.join(base, raw.replace(/^\//, ""))))
      .filter((joined) => !joined.startsWith("../"))
      .map((joined) => toRef(joined, concatenated, WEB_SLOT));
    if (candidates.length > 0) refs.push({ raw, refs: candidates });
  }
  return refs;
};

const count = (text: string, re: RegExp) => [...text.matchAll(re)].length;

// Only constructor arguments that name a texture map count as textured.
const flatMaterials = (text: string) => {
  let n = 0;
  for (const m of text.matchAll(
    /Mesh(?:Basic|Lambert|Phong|Standard|Physical|Toon)Material\s*\(/g,
  )) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
      i += 1;
    }
    if (!/\bmap\b|Map\s*:/.test(text.slice(start, i))) n += 1;
  }
  return n;
};

const drawnGodot = (path: string, text: string): Array<readonly [string, number]> => {
  if (path.endsWith(".tscn") || path.endsWith(".tres"))
    return [
      ["ColorRect", count(text, /type="ColorRect"/g)],
      ["Polygon2D", count(text, /type="Polygon2D"/g)],
      ["procedural meshes", count(text, /type="(?:\w+Mesh|CSG\w+3D)"/g)],
    ];
  if (!path.endsWith(".gd")) return [];
  const calls = [
    ...text.matchAll(
      /\bdraw_(rect|circle|polygon|colored_polygon|line|polyline|multiline|arc)\s*\(/g,
    ),
  ];
  return [
    ...["rect", "circle", "polygon", "colored_polygon", "line", "polyline", "multiline", "arc"].map(
      (name) => [`draw_${name}`, calls.filter((c) => c[1] === name).length] as const,
    ),
    ["ColorRect", count(text, /\bColorRect\.new\s*\(/g)],
    ["Polygon2D", count(text, /\bPolygon2D\.new\s*\(/g)],
    [
      "procedural meshes",
      count(
        text,
        /\b(?:(?:Box|Sphere|Cylinder|Capsule|Plane|Quad|Prism|Torus)Mesh|ImmediateMesh|ArrayMesh|SurfaceTool|CSG\w+3D)\.new\s*\(/g,
      ),
    ],
  ];
};

const drawnWeb = (path: string, text: string): Array<readonly [string, number]> =>
  /\.m?js$/.test(path)
    ? [
        [
          "primitive geometries",
          count(
            text,
            /\b(?:Box|Sphere|Cylinder|Cone|Plane|Circle|Ring|Torus|TorusKnot|Capsule|Tetrahedron|Octahedron|Icosahedron|Dodecahedron)Geometry\s*\(/g,
          ),
        ],
        ["materials without a texture map", flatMaterials(text)],
        ["2D canvas contexts", count(text, /getContext\(\s*["'`]2d/g)],
        [
          "2D canvas draw calls",
          count(
            text,
            /\.(?:fillRect|strokeRect|arc|ellipse|lineTo|bezierCurveTo|quadraticCurveTo|roundRect)\s*\(/g,
          ),
        ],
      ]
    : [];

const ASSET_TOKEN =
  /(?:res:\/\/)?[\w./@-]*\.(?:png|jpe?g|webp|svg|gif|bmp|tga|exr|hdr|ktx2|wav|ogg|mp3|flac|glb|gltf|fbx|obj|blend|dae)\b/gi;

/** Pure: the same files always give the same facts. */
export const scanAssetUse = (
  files: ReadonlyArray<EngineFile>,
  lane: string,
  assetsMd: string | null,
): AssetUse => {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const engine = byPath.has("project.godot") ? "godot" : "web";
  const isSource = (path: string) =>
    (engine === "godot" ? SOURCE_GODOT : SOURCE_WEB).test(path) &&
    !path.endsWith(".import") &&
    !path.endsWith(".uid");
  const assets = files
    .map((f) => f.path)
    .filter((p) => ASSET.test(p))
    .sort();

  // Godot names files by uid as well as by path, and imported copies point back at their source.
  const uids = new Map<string, string>();
  const imported = new Map<string, string>();
  for (const f of files) {
    if (f.text === null) continue;
    if (f.path.endsWith(".uid")) uids.set(f.text.trim(), f.path.slice(0, -".uid".length));
    else if (f.path.endsWith(".import")) {
      const source = f.path.slice(0, -".import".length);
      const uid = /^uid="(uid:\/\/[^"]+)"/m.exec(f.text)?.[1];
      if (uid !== undefined) uids.set(uid, source);
      for (const m of f.text.matchAll(/"res:\/\/(\.godot\/imported\/[^"]+)"/g))
        imported.set(m[1] ?? "", source);
    } else if (f.path.endsWith(".tscn") || f.path.endsWith(".tres")) {
      const uid = /^\[gd_\w+[^\]]*\buid="(uid:\/\/[^"]+)"/m.exec(f.text)?.[1];
      if (uid !== undefined) uids.set(uid, f.path);
    }
  }

  const refsOf = new Map<string, ReadonlyArray<Reference>>();
  for (const f of files)
    if (f.text !== null && isSource(f.path))
      refsOf.set(
        f.path,
        engine === "godot" ? godotRefs(f.text, uids, imported) : webRefs(f.text, f.path),
      );

  const matches = (ref: Reference, path: string) =>
    ref.refs.some((r) => ("exact" in r ? r.exact === path : r.pattern.test(path)));

  // Loaded code is what the engine reaches from its entry point; a global
  // class_name script counts once a loaded file names it.
  const roots =
    engine === "godot"
      ? ["project.godot"]
      : byPath.has("index.html")
        ? ["index.html"]
        : [...refsOf.keys()].filter((p) => /\.html?$/.test(p));
  const classNames = new Map<string, string>();
  if (engine === "godot")
    for (const [path] of refsOf) {
      const name = /^class_name\s+(\w+)/m.exec(byPath.get(path)?.text ?? "")?.[1];
      if (name !== undefined) classNames.set(path, name);
    }
  const loaded = new Set<string>(
    roots.length > 0 ? roots.filter((r) => refsOf.has(r)) : refsOf.keys(),
  );
  for (let grew = true; grew;) {
    grew = false;
    const loadedText = [...loaded].map((p) => byPath.get(p)?.text ?? "").join("\n");
    for (const [path] of refsOf) {
      if (loaded.has(path)) continue;
      const name = classNames.get(path);
      const reached =
        [...loaded].some((from) => (refsOf.get(from) ?? []).some((ref) => matches(ref, path))) ||
        (name !== undefined && new RegExp(`\\b${name}\\b`).test(loadedText));
      if (reached) {
        loaded.add(path);
        grew = true;
      }
    }
  }

  const loadedRefs = [...loaded].flatMap((p) => refsOf.get(p) ?? []);
  const used = new Set(assets.filter((a) => loadedRefs.some((ref) => matches(ref, a))));
  const all = files.map((f) => f.path);
  const missing = new Set<string>();
  for (const [from, refs] of refsOf) {
    if (!loaded.has(from)) continue;
    for (const ref of refs) {
      if (all.some((p) => matches(ref, p))) continue;
      const first = ref.refs[0];
      if (
        first === undefined ||
        ("exact" in first && !ASSET.test(first.exact) && !isSource(first.exact))
      )
        continue;
      missing.add(`${ref.raw} in ${from}`);
    }
  }

  let listed: number | null = null;
  const listedMissing: string[] = [];
  const inList = new Set<string>();
  if (assetsMd !== null) {
    for (const m of assetsMd.matchAll(ASSET_TOKEN)) {
      const token = m[0].replace(/^res:\/\//, "").replace(/^\.\//, "");
      const path = token.startsWith(`${lane}/`) ? token.slice(lane.length + 1) : token;
      const hits = path.includes("/")
        ? assets.filter((a) => a === path)
        : assets.filter((a) => a.endsWith(`/${path}`) || a === path);
      // Entries outside the engine dir (key art, .blend sources) are not part of the build.
      if (
        hits.length === 0 &&
        path.includes("/") &&
        !token.startsWith(`${lane}/`) &&
        !path.startsWith("assets/") &&
        !m[0].startsWith("res://")
      )
        continue;
      for (const hit of hits) inList.add(hit);
      if (hits.length === 0) listedMissing.push(path);
    }
    listed = inList.size + new Set(listedMissing).size;
  }

  const drawn = new Map<string, number>();
  for (const path of [...loaded].sort()) {
    const text = byPath.get(path)?.text ?? "";
    for (const [name, n] of engine === "godot" ? drawnGodot(path, text) : drawnWeb(path, text))
      if (n > 0) drawn.set(name, (drawn.get(name) ?? 0) + n);
  }

  return {
    engine,
    assets: assets.length,
    unused: assets.filter((a) => !used.has(a)),
    missing: [...missing].sort(),
    listed,
    listedMissing: [...new Set(listedMissing)].sort(),
    unlisted: assetsMd === null ? [] : assets.filter((a) => !inList.has(a)),
    unloaded: [...refsOf.keys()].filter((p) => !loaded.has(p)).sort(),
    drawn: [...drawn.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
};

const readEngine = async (dir: string): Promise<EngineFile[]> => {
  const files: EngineFile[] = [];
  const visit = async (rel: string) => {
    const entries = await NodeFSP.readdir(NodePath.join(dir, rel), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const full = NodePath.join(dir, path);
      const source = SOURCE_GODOT.test(path) || SOURCE_WEB.test(path);
      const size = source ? ((await NodeFSP.stat(full).catch(() => null))?.size ?? 0) : 0;
      // Large data files (baked glTF buffers, big JSON) are skipped rather than read.
      const text =
        source && size < 2_000_000 ? await NodeFSP.readFile(full, "utf8").catch(() => null) : null;
      files.push({ path, text });
    }
  };
  await visit("");
  return files;
};

export const readAssetUse = async (root: string, lane: string): Promise<AssetUse> =>
  scanAssetUse(
    await readEngine(NodePath.join(root, lane)),
    lane,
    await NodeFSP.readFile(NodePath.join(root, "ASSETS.md"), "utf8").catch(() => null),
  );

const list = (paths: ReadonlyArray<string>, max = 6) =>
  paths.length === 0
    ? "none"
    : `${paths.slice(0, max).join(", ")}${paths.length > max ? ` (+${paths.length - max} more)` : ""}`;

/** A few bounded sentences; paths are relative to the engine dir. */
export const assetUseSummary = (use: AssetUse, lane: string): string => {
  const entry = use.engine === "godot" ? "project.godot" : "index.html";
  const listed =
    use.listed === null
      ? "ASSETS.md missing."
      : `ASSETS.md names ${use.listed} files; listed but not on disk: ${list(use.listedMissing)}; on disk but not listed: ${list(use.unlisted)}.`;
  const drawn =
    use.drawn.length === 0 ? "none" : use.drawn.map(([name, n]) => `${name} ${n}`).join(", ");
  return [
    `Asset use (static scan of ${lane}/, code reached from ${entry}): ${use.assets} asset files, ${use.assets - use.unused.length} referenced by loaded code; never referenced: ${list(use.unused)}.`,
    `Loaded code references missing files: ${list(use.missing)}.`,
    listed,
    `Drawn in loaded code: ${drawn}.`,
    use.unloaded.length > 0 ? `Code the game never loads: ${list(use.unloaded, 4)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
};
