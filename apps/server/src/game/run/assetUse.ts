// @effect-diagnostics nodeBuiltinImport:off -- Plain filesystem facts read from the game folder.
// Which asset files the game's own code loads, and how much it draws in code.
// A static scan, deterministic for a given folder: it states facts and never judges them.
// Reviewers act on these facts, so every doubt resolves toward "exists" and "possibly used":
// a false "missing" or "never referenced" would have a builder redo or delete good work.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface EngineFile {
  /** Path relative to the engine dir, always with forward slashes. */
  readonly path: string;
  /** Contents for the game's own source files; null for binaries and library code. */
  readonly text: string | null;
}

export interface AssetUse {
  readonly engine: "godot" | "web" | "unity";
  /** Set when the folder is past the scan's bounds; the other facts are then empty. */
  readonly tooLarge: string | null;
  readonly assets: number;
  readonly unused: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  readonly listed: number | null;
  readonly listedMissing: ReadonlyArray<string>;
  readonly unlisted: ReadonlyArray<string>;
  readonly unloaded: ReadonlyArray<string>;
  readonly drawn: ReadonlyArray<readonly [string, number]>;
}

const ASSET_EXT =
  "png|jpe?g|webp|svg|gif|bmp|tga|exr|hdr|ktx2|wav|ogg|mp3|flac|glb|gltf|fbx|obj|blend|dae";
const ASSET = new RegExp(`\\.(?:${ASSET_EXT})$`, "i");
const SOURCE_GODOT = /\.(gd|tscn|tres|gdshader|godot|import|uid|gltf|json|cfg)$/i;
const SOURCE_WEB = /\.(m?js|html?|css|json|gltf)$/i;
// Code is what can be "never loaded" and what drawing is counted in; data files are neither.
const CODE_GODOT = /\.(gd|tscn|tres|gdshader)$/;
const CODE_WEB = /\.(m?js|html?|css)$/;
const CODE_UNITY = /\.(cs|unity|prefab)$/;
// Unity's text-serialized scenes, prefabs and assets name files by GUID; .meta files map GUIDs to paths.
const SOURCE_UNITY = /\.(cs|unity|prefab|asset|mat|controller|anim)$/i;
const UNITY_VERSION_FILE = "ProjectSettings/ProjectVersion.txt";
const UNITY_BUILD_SCENES = "ProjectSettings/EditorBuildSettings.asset";
// The render pipeline assets (and what they name) load from these, not from any scene.
const UNITY_SETTINGS_ROOTS = [
  UNITY_BUILD_SCENES,
  "ProjectSettings/GraphicsSettings.asset",
  "ProjectSettings/QualitySettings.asset",
] as const;
// Generated or installed trees are not walked; a path into one is never reported missing.
const SKIP_DIRS = new Set([".godot", ".git", "builds", "node_modules"]);
// Third-party code: its files exist, but it is not the game's code or the game's art.
const LIBRARY_DIRS = new Set(["vendor", "lib", "node_modules"]);
const LIBRARY_FILE = /\.min\.m?js$|(?:^|\/)three\.(?:module|core)(?:\.min)?\.js$/;

const isLibrary = (path: string) =>
  LIBRARY_FILE.test(path) ||
  path
    .split("/")
    .slice(0, -1)
    .some((dir) => LIBRARY_DIRS.has(dir));
const underSkipped = (path: string) => path.split("/").some((dir) => SKIP_DIRS.has(dir));
const hasExtension = (path: string) => /\.\w+$/.test(path.slice(path.lastIndexOf("/") + 1));

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const reverse = (text: string) => text.split("").toReversed().join("");
const norm = (path: string) => NodePath.posix.normalize(path).replace(/^\.\//, "");

type Ref =
  | { readonly kind: "exact"; readonly path: string }
  /** A folder, or the start of a path built at runtime: every file under it may be used. */
  | { readonly kind: "prefix"; readonly prefix: string }
  /** The tail of a path built at runtime, such as `+ "/enemy.glb"`. */
  | { readonly kind: "suffix"; readonly suffix: string }
  /** A path with runtime slots; its literal ends narrow the search before the pattern runs. */
  | {
      readonly kind: "family";
      readonly prefix: string;
      readonly suffix: string;
      readonly source: string;
    };
/** One literal in source and every engine path it could resolve to. */
type Reference = {
  readonly raw: string;
  readonly refs: ReadonlyArray<Ref>;
  /** Only a literal that names a file by its extension can be reported missing. */
  readonly reportable: boolean;
};

const refKey = (ref: Ref) =>
  ref.kind === "exact"
    ? `e:${ref.path}`
    : ref.kind === "prefix"
      ? `p:${ref.prefix}`
      : ref.kind === "suffix"
        ? `s:${ref.suffix}`
        : `f:${ref.source}`;

const family = (parts: ReadonlyArray<string>): Ref => ({
  kind: "family",
  prefix: parts[0] ?? "",
  suffix: parts.at(-1) ?? "",
  source: `^${parts.map(escapeRe).join(".*")}$`,
});

const GODOT_LITERAL = /(["'])\*?((?:res|uid):\/\/[^"'\n]*)\1(\s*\+)?/g;
const GODOT_SLOT = /%[-+0-9.]*[a-z]|\{[^}]*\}/i;
const EXT_RESOURCE = /^\[ext_resource\b[^\]\n]*\]/gm;

const godotRefs = (
  text: string,
  uids: ReadonlyMap<string, string>,
  imported: ReadonlyMap<string, string>,
  isSource: (path: string) => boolean,
) => {
  const refs: Reference[] = [];
  // Godot loads an ext_resource by uid first, so a stale path= beside a live uid is not missing.
  const body = text.replace(EXT_RESOURCE, (line) => {
    const uid = /\buid="(uid:\/\/[^"]+)"/.exec(line)?.[1];
    const path = uid === undefined ? undefined : uids.get(uid);
    if (uid === undefined || path === undefined) return line;
    refs.push({ raw: uid, refs: [{ kind: "exact", path }], reportable: false });
    return "";
  });
  for (const m of body.matchAll(GODOT_LITERAL)) {
    const raw = m[2] ?? "";
    if (raw.startsWith("uid://")) {
      const path = uids.get(raw);
      if (path !== undefined)
        refs.push({ raw, refs: [{ kind: "exact", path }], reportable: false });
      continue;
    }
    const literal = raw.slice("res://".length);
    if (GODOT_SLOT.test(literal)) {
      const parts = literal.split(GODOT_SLOT);
      const tail = parts.at(-1) ?? "";
      refs.push({ raw, refs: [family(parts)], reportable: ASSET.test(tail) || isSource(tail) });
    } else if (m[3] !== undefined) {
      refs.push({ raw, refs: [{ kind: "prefix", prefix: literal }], reportable: false });
    } else if (!hasExtension(literal)) {
      // A directory constant: whatever code joins onto it may load anything under it.
      const prefix = literal === "" || literal.endsWith("/") ? literal : `${literal}/`;
      refs.push({ raw, refs: [{ kind: "prefix", prefix }], reportable: false });
    } else {
      const path = imported.get(literal) ?? norm(literal);
      refs.push({
        raw,
        refs: [{ kind: "exact", path }],
        reportable: ASSET.test(path) || isSource(path),
      });
    }
  }
  return refs;
};

const WEB_LITERAL = /(["'`])([^"'`\n]{1,200}?)\1(\s*\+)?|url\(\s*([^)"'\s]+)\s*\)/g;
const WEB_SLOT = /\$\{[^}]*\}/;
const IMPORT_MAP = /<script\b[^>]*\btype\s*=\s*["']?importmap\b[^>]*>([\s\S]*?)<\/script>/gi;
const isWebPath = (path: string) => ASSET.test(path) || SOURCE_WEB.test(path);

/** Bare module specifiers the page maps to files; trailing-slash keys map whole folders. */
const importMapOf = (files: ReadonlyArray<EngineFile>) => {
  const map = new Map<string, string>();
  for (const f of files) {
    if (f.text === null || !/\.html?$/.test(f.path)) continue;
    for (const m of f.text.matchAll(IMPORT_MAP)) {
      let imports: unknown;
      try {
        imports = (JSON.parse(m[1] ?? "") as { imports?: unknown }).imports;
      } catch {
        continue;
      }
      if (typeof imports !== "object" || imports === null) continue;
      for (const [key, target] of Object.entries(imports)) {
        if (typeof target !== "string" || /^[a-z][\w+.-]*:|^\/\//i.test(target)) continue;
        const base = target.startsWith("/") ? "" : NodePath.posix.dirname(f.path);
        const path = norm(NodePath.posix.join(base, target.replace(/^\//, "")));
        if (!map.has(key))
          map.set(key, target.endsWith("/") && !path.endsWith("/") ? `${path}/` : path);
      }
    }
  }
  return map;
};

const mapImport = (raw: string, importMap: ReadonlyMap<string, string>) => {
  if (/^\.{0,2}\//.test(raw)) return undefined;
  const exact = importMap.get(raw);
  if (exact !== undefined) return exact;
  let best: string | undefined;
  for (const key of importMap.keys())
    if (key.endsWith("/") && raw.startsWith(key) && key.length > (best?.length ?? 0)) best = key;
  return best === undefined ? undefined : `${importMap.get(best)}${raw.slice(best.length)}`;
};

// Page-relative loader paths and module-relative imports look the same in
// source, so each reference may resolve against either base.
const webRefs = (text: string, from: string, importMap: ReadonlyMap<string, string>) => {
  const refs: Reference[] = [];
  // Inline data URIs are long quote-free runs that only slow the literal search.
  const body = text.replace(IMPORT_MAP, "").replace(/(["'])data:[^"'\n]*\1/g, '""');
  for (const m of body.matchAll(WEB_LITERAL)) {
    const raw = (m[2] ?? m[4] ?? "").split(/[?#]/)[0] ?? "";
    if (raw.length === 0 || /\s|^[a-z][\w+.-]*:|^\/\//i.test(raw)) continue;
    const before =
      m[1] !== undefined && /\+\s*$/.test(body.slice(Math.max(0, m.index - 64), m.index));
    const after = m[3] !== undefined;
    if (before) {
      // The tail of a built-up path names no whole file, so it is never missing.
      if (!after && isWebPath(raw) && !WEB_SLOT.test(raw))
        refs.push({ raw, refs: [{ kind: "suffix", suffix: raw }], reportable: false });
      continue;
    }
    const mapped = mapImport(raw, importMap);
    const slotted = WEB_SLOT.test(raw);
    const named = isWebPath(raw);
    // A folder string, or the start of a path finished at runtime.
    const folder = !named && raw.includes("/") && (after || slotted || /^[\w@./-]+$/.test(raw));
    if (!named && !folder) continue;
    const joined =
      mapped !== undefined
        ? [mapped]
        : (raw.startsWith("/") ? [""] : [NodePath.posix.dirname(from), ""])
            .map((base) => NodePath.posix.join(base, raw.replace(/^\//, "")))
            .map((path) => (raw.endsWith("/") && !path.endsWith("/") ? `${path}/` : path))
            .map(norm)
            .filter((path) => !path.startsWith("../") && path !== "..");
    const candidates: Ref[] = [];
    for (const path of joined) {
      if (named && !after) {
        candidates.push(
          slotted ? family(path.split(WEB_SLOT)) : { kind: "exact", path: path.replace(/\/$/, "") },
        );
        continue;
      }
      const prefix = slotted
        ? (path.split(WEB_SLOT)[0] ?? "")
        : after || path.endsWith("/")
          ? path
          : `${path}/`;
      // "./" or "/" alone would mark every file used, which says nothing.
      if (prefix !== "" && prefix !== "/") candidates.push({ kind: "prefix", prefix });
    }
    if (candidates.length > 0) refs.push({ raw, refs: candidates, reportable: named && !after });
  }
  return refs;
};

// Matching work (paths visited and patterns tested) a scan may spend before it gives up.
const MAX_MATCH_WORK = 1_000_000;

/**
 * Paths sorted forward and reversed, so prefix and suffix lookups are a binary search.
 * Each distinct reference is matched once: a repeat only says whether it found anything.
 */
const pathIndex = (paths: ReadonlyArray<string>) => {
  const forward = [...paths].sort();
  const backward = paths.map(reverse).sort();
  let work = 0;
  const range = (sorted: ReadonlyArray<string>, start: string) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((sorted[mid] ?? "") < start) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < sorted.length && (sorted[i] ?? "").startsWith(start); i += 1)
      out.push(sorted[i] ?? "");
    work += out.length;
    return out;
  };
  const all = new Set(paths);
  const found = new Map<string, boolean>();
  const match = (ref: Ref): ReadonlyArray<string> => {
    if (ref.kind === "exact") return all.has(ref.path) ? [ref.path] : [];
    if (ref.kind === "prefix") return range(forward, ref.prefix);
    if (ref.kind === "suffix") return range(backward, reverse(ref.suffix)).map(reverse);
    const re = new RegExp(ref.source);
    const candidates =
      ref.prefix.length >= ref.suffix.length
        ? range(forward, ref.prefix)
        : range(backward, reverse(ref.suffix)).map(reverse);
    return candidates.filter((path) => re.test(path));
  };
  return {
    /** Calls onPath for each match the first time a reference is seen; true when it matched. */
    visit: (ref: Ref, onPath: (path: string) => void): boolean => {
      const key = refKey(ref);
      const seen = found.get(key);
      if (seen !== undefined) return seen;
      const paths = work > MAX_MATCH_WORK ? [] : match(ref);
      for (const path of paths) onPath(path);
      found.set(key, paths.length > 0);
      return paths.length > 0;
    },
    exhausted: () => work > MAX_MATCH_WORK,
  };
};

const count = (text: string, re: RegExp) => [...text.matchAll(re)].length;

// Only an object literal without a texture map counts; a variable argument may carry one.
const flatMaterials = (text: string) => {
  let n = 0;
  for (const m of text.matchAll(
    /Mesh(?:Basic|Lambert|Phong|Standard|Physical|Toon)Material\s*\(\s*\{/g,
  )) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") depth -= 1;
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

const UNITY_GUID = /\bguid: ([0-9a-f]{32})\b/g;
const CS_ASSET_PATH = /"(Assets\/[^"\n]{1,200})"/g;
// The literal's `$` marks an interpolated string; a `+` after it a path built at runtime.
const CS_RESOURCES =
  /\bResources\.Load(?:All|Async)?\s*(?:<[^>]*>)?\s*\(\s*(\$?)"([^"\n]{1,200})"\s*(\+?)/g;
// A disabled build scene is listed but never built, so it is no entry point.
const DISABLED_SCENE = /^( *)- enabled: 0[^\n]*\n(?:\1 {2}[^\n]*(?:\n|$))*/gm;

/**
 * C# with comments removed and string and character literals emptied, so a
 * word inside either is never read as a declaration.
 */
const csCode = (text: string): string =>
  text.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|@"(?:[^"]|"")*"|\$?"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
    (m) => (m.startsWith("/") ? " " : '""'),
  );

const unityRefs = (text: string, path: string, guids: ReadonlyMap<string, string>) => {
  const refs: Reference[] = [];
  if (!path.endsWith(".cs")) {
    const scanned = path === UNITY_BUILD_SCENES ? text.replace(DISABLED_SCENE, "") : text;
    // GUIDs of packages and built-in resources have no .meta here; they are not the game's files.
    for (const m of scanned.matchAll(UNITY_GUID)) {
      const target = guids.get(m[1] ?? "");
      if (target !== undefined)
        refs.push({ raw: target, refs: [{ kind: "exact", path: target }], reportable: false });
    }
    return refs;
  }
  for (const m of text.matchAll(CS_ASSET_PATH)) {
    const raw = norm(m[1] ?? "");
    refs.push(
      hasExtension(raw)
        ? { raw, refs: [{ kind: "exact", path: raw }], reportable: true }
        : {
            raw,
            refs: [{ kind: "prefix", prefix: `${raw.replace(/\/$/, "")}/` }],
            reportable: false,
          },
    );
  }
  // Resources.Load names a path under any Resources/ folder, without its extension.
  // A literal that is only the start of the path (concatenated or interpolated) names
  // every file below that start.
  for (const m of text.matchAll(CS_RESOURCES)) {
    const interpolated = m[1] === "$";
    const literal = m[2] ?? "";
    const name = interpolated ? literal.split("{")[0]! : literal;
    const partial = m[3] === "+" || (interpolated && name !== literal);
    refs.push({
      raw: literal,
      refs: [
        {
          kind: "family",
          prefix: "",
          suffix: "",
          source: partial
            ? `^(?:.*/)?Resources/${escapeRe(name)}`
            : `^(?:.*/)?Resources/${escapeRe(name)}(?:\\.[^/]+|/.*)?$`,
        },
      ],
      reportable: false,
    });
  }
  return refs;
};

const drawnUnity = (path: string, text: string): Array<readonly [string, number]> =>
  path.endsWith(".cs")
    ? [
        ["CreatePrimitive calls", count(text, /\bGameObject\.CreatePrimitive\s*\(/g)],
        ["procedural meshes", count(text, /\bnew\s+Mesh\s*\(/g)],
      ]
    : [
        [
          "built-in primitive meshes",
          count(text, /m_Mesh: \{fileID: 102(?:02|06|07|08|09|10), guid: 0{16}e0{15}/g),
        ],
      ];

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

const listedIn = (assetsMd: string, assets: ReadonlyArray<string>, lane: string) => {
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

const tooLargeUse = (engine: AssetUse["engine"], tooLarge: string): AssetUse => ({
  engine,
  tooLarge,
  assets: 0,
  unused: [],
  missing: [],
  listed: null,
  listedMissing: [],
  unlisted: [],
  unloaded: [],
  drawn: [],
});

/** Pure: the same files always give the same facts. */
export const scanAssetUse = (
  files: ReadonlyArray<EngineFile>,
  lane: string,
  assetsMd: string | null,
): AssetUse => {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const engine = byPath.has("project.godot")
    ? "godot"
    : byPath.has(UNITY_VERSION_FILE)
      ? "unity"
      : "web";
  const code = engine === "godot" ? CODE_GODOT : engine === "unity" ? CODE_UNITY : CODE_WEB;
  const isSource = (path: string) =>
    (engine === "godot" ? SOURCE_GODOT : engine === "unity" ? SOURCE_UNITY : SOURCE_WEB).test(
      path,
    ) &&
    !path.endsWith(".import") &&
    !path.endsWith(".uid") &&
    // Editor-only scripts never ship in the player.
    !(engine === "unity" && /(^|\/)Editor\//.test(path));
  const assets = files
    .map((f) => f.path)
    .filter((p) => ASSET.test(p) && !isLibrary(p))
    .sort();
  const assetSet = new Set(assets);

  // Godot names files by uid as well as by path, and imported copies point back at their source.
  const uids = new Map<string, string>();
  const imported = new Map<string, string>();
  for (const f of files) {
    if (f.text === null) continue;
    if (engine === "unity") {
      const guid = f.path.endsWith(".meta")
        ? /^guid: ([0-9a-f]{32})/m.exec(f.text)?.[1]
        : undefined;
      if (guid !== undefined) uids.set(guid, f.path.slice(0, -".meta".length));
      continue;
    }
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

  const importMap = engine === "web" ? importMapOf(files) : new Map<string, string>();
  const refsOf = new Map<string, ReadonlyArray<Reference>>();
  for (const f of files)
    if (f.text !== null && isSource(f.path) && !isLibrary(f.path))
      refsOf.set(
        f.path,
        engine === "godot" && !f.path.endsWith(".gltf")
          ? godotRefs(f.text, uids, imported, isSource)
          : engine === "unity"
            ? unityRefs(f.text, f.path, uids)
            : webRefs(f.text, f.path, importMap),
      );

  const classNames = new Map<string, string>();
  for (const [path] of refsOf) {
    const text = byPath.get(path)?.text ?? "";
    // A C# file may declare several types; every one of them names the file.
    const names =
      engine === "godot"
        ? [/^class_name\s+(\w+)/m.exec(text)?.[1]]
        : engine === "unity" && path.endsWith(".cs")
          ? [...csCode(text).matchAll(/\b(?:class|struct)\s+(\w+)/g)].map((m) => m[1])
          : [];
    for (const name of names)
      if (name !== undefined && !classNames.has(name)) classNames.set(name, path);
  }

  // Loaded code is what the engine reaches from its entry point: project.godot names the
  // main scene and autoloads; Unity starts from the build's enabled scenes, its graphics
  // and quality settings (the render pipeline assets) and from scripts it runs on load. A global class_name (or C# class) counts once a loaded file names it.
  const roots =
    engine === "godot"
      ? ["project.godot"]
      : engine === "unity"
        ? [
            ...UNITY_SETTINGS_ROOTS,
            ...[...refsOf.keys()].filter((p) =>
              /\bRuntimeInitializeOnLoadMethod\b/.test(byPath.get(p)?.text ?? ""),
            ),
          ]
        : byPath.has("index.html")
          ? ["index.html"]
          : [...refsOf.keys()].filter((p) => /\.html?$/.test(p));
  const index = pathIndex(files.map((f) => f.path));
  const loaded = new Set<string>();
  const queue: string[] = [];
  const reach = (path: string) => {
    if (!refsOf.has(path) || loaded.has(path)) return;
    loaded.add(path);
    queue.push(path);
  };
  for (const root of roots.length > 0 ? roots : [...refsOf.keys()]) reach(root);
  const used = new Set<string>();
  const missing = new Set<string>();
  for (let from = queue.pop(); from !== undefined; from = queue.pop()) {
    for (const ref of refsOf.get(from) ?? []) {
      let found = false;
      for (const r of ref.refs)
        if (
          index.visit(r, (path) => {
            if (assetSet.has(path)) used.add(path);
            reach(path);
          })
        )
          found = true;
      if (
        !found &&
        ref.reportable &&
        !ref.refs.some(
          (r) => r.kind !== "suffix" && underSkipped(r.kind === "exact" ? r.path : r.prefix),
        )
      )
        missing.add(`${ref.raw} in ${from}`);
    }
    if (classNames.size > 0)
      for (const word of (byPath.get(from)?.text ?? "").split(/\W+/)) {
        const path = classNames.get(word);
        if (path !== undefined) reach(path);
      }
  }
  if (index.exhausted()) return tooLargeUse(engine, "too many path patterns to match");

  const listed = assetsMd === null ? null : listedIn(assetsMd, assets, lane);

  const drawn = new Map<string, number>();
  for (const path of [...loaded].sort()) {
    const text = byPath.get(path)?.text ?? "";
    for (const [name, n] of engine === "godot"
      ? drawnGodot(path, text)
      : engine === "unity"
        ? drawnUnity(path, text)
        : drawnWeb(path, text))
      if (n > 0) drawn.set(name, (drawn.get(name) ?? 0) + n);
  }

  return {
    engine,
    tooLarge: null,
    assets: assets.length,
    unused: assets.filter((a) => !used.has(a)),
    missing: [...missing].sort(),
    listed: listed === null ? null : listed.inList.size + listed.missing.size,
    listedMissing: listed === null ? [] : [...listed.missing].sort(),
    unlisted: listed === null ? [] : assets.filter((a) => !listed.inList.has(a)),
    unloaded: [...refsOf.keys()].filter((p) => code.test(p) && !loaded.has(p)).sort(),
    drawn: [...drawn.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
};

// The scan runs on the server's event loop. Past these bounds it states that it did
// not scan instead of reporting partial facts, which would read as false "unused".
const MAX_FILES = 20_000;
const MAX_SOURCE_BYTES = 6_000_000;
// Large data files (baked glTF buffers, big JSON) are skipped rather than read.
const MAX_FILE_BYTES = 2_000_000;

const readEngine = async (
  dir: string,
): Promise<{ files: EngineFile[]; tooLarge: string | null }> => {
  const files: EngineFile[] = [];
  let sourceBytes = 0;
  let tooLarge: string | null = null;
  // A Unity project is read from Assets/ and the settings it loads from only:
  // Library/, Temp/, Logs/ and the package cache are generated and huge.
  const unity = await isFile(NodePath.join(dir, UNITY_VERSION_FILE));
  const visit = async (rel: string) => {
    const entries = await NodeFSP.readdir(NodePath.join(dir, rel), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (tooLarge !== null) return;
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(path);
        continue;
      }
      const full = NodePath.join(dir, path);
      // A linked file is a file; a linked folder is not followed.
      if (!entry.isFile() && !(entry.isSymbolicLink() && (await isFile(full)))) continue;
      if (files.length >= MAX_FILES) {
        tooLarge = `more than ${MAX_FILES} files`;
        return;
      }
      const source = unity
        ? SOURCE_UNITY.test(path) || path.endsWith(".meta")
        : (SOURCE_GODOT.test(path) || SOURCE_WEB.test(path)) && !isLibrary(path);
      const size = source ? ((await NodeFSP.stat(full).catch(() => null))?.size ?? 0) : 0;
      const read = source && size < MAX_FILE_BYTES;
      if (read) sourceBytes += size;
      if (sourceBytes > MAX_SOURCE_BYTES) {
        tooLarge = `more than ${MAX_SOURCE_BYTES / 1_000_000} MB of source`;
        return;
      }
      const text = read ? await NodeFSP.readFile(full, "utf8").catch(() => null) : null;
      files.push({ path, text });
    }
  };
  if (!unity) {
    await visit("");
    return { files, tooLarge };
  }
  await visit("Assets");
  files.push({ path: UNITY_VERSION_FILE, text: null });
  for (const path of UNITY_SETTINGS_ROOTS)
    files.push({
      path,
      text: await NodeFSP.readFile(NodePath.join(dir, path), "utf8").catch(() => null),
    });
  return { files, tooLarge };
};

const isFile = (full: string) =>
  NodeFSP.stat(full).then(
    (stat) => stat.isFile(),
    () => false,
  );

export const readAssetUse = async (root: string, lane: string): Promise<AssetUse> => {
  const { files, tooLarge } = await readEngine(NodePath.join(root, lane));
  if (tooLarge !== null)
    return tooLargeUse(
      files.some((f) => f.path === "project.godot")
        ? "godot"
        : files.some((f) => f.path === UNITY_VERSION_FILE)
          ? "unity"
          : "web",
      tooLarge,
    );
  return scanAssetUse(
    files,
    lane,
    await NodeFSP.readFile(NodePath.join(root, "ASSETS.md"), "utf8").catch(() => null),
  );
};

const list = (paths: ReadonlyArray<string>, max = 6) =>
  paths.length === 0
    ? "none"
    : `${paths.slice(0, max).join(", ")}${paths.length > max ? ` (+${paths.length - max} more)` : ""}`;

const missingLine = (use: AssetUse) =>
  `Loaded code references missing files: ${list(use.missing)}.`;
const listedLine = (use: AssetUse) =>
  use.listed === null
    ? "ASSETS.md missing."
    : `ASSETS.md names ${use.listed} files; listed but not on disk: ${list(use.listedMissing)}; on disk but not listed: ${list(use.unlisted)}.`;
const tooLargeLine = (use: AssetUse, lane: string) =>
  `Asset use: ${lane}/ is too large to scan (${use.tooLarge}), so there are no asset facts.`;

/** A few bounded sentences; paths are relative to the engine dir. */
export const assetUseSummary = (use: AssetUse, lane: string): string => {
  if (use.tooLarge !== null) return tooLargeLine(use, lane);
  const entry =
    use.engine === "godot"
      ? "project.godot"
      : use.engine === "unity"
        ? `the enabled ${UNITY_BUILD_SCENES} scenes and the graphics and quality settings`
        : "index.html";
  const drawn =
    use.drawn.length === 0 ? "none" : use.drawn.map(([name, n]) => `${name} ${n}`).join(", ");
  return [
    `Asset use (static scan of ${lane}/, code reached from ${entry}): ${use.assets} asset files, ${use.assets - use.unused.length} referenced by loaded code; never referenced: ${list(use.unused)}.`,
    missingLine(use),
    listedLine(use),
    `Drawn in loaded code: ${drawn}.`,
    use.unloaded.length > 0 ? `Code the game never loads: ${list(use.unloaded, 4)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
};

/** The art stage: ASSETS.md against the disk, and files the code names that are not there. */
export const assetListSummary = (use: AssetUse, lane: string): string =>
  use.tooLarge !== null
    ? tooLargeLine(use, lane)
    : `${listedLine(use)} ${missingLine(use)} (paths relative to ${lane}/)`;
