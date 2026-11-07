// @effect-diagnostics nodeBuiltinImport:off -- Reads a build copy's files and its plays' use records from disk.
// Asset use, measured during the plays the facts already run: the files a browser game's page
// was served (gameWebServer) and the sounds that started playing (webPlaySession's tap), held
// against the files the build ships. Evidence for the next step, never a verdict: Keep going
// does not watch it.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GAME_ASSET_USE_CAP,
  GAME_MODEL_SIDECAR_SUFFIX,
  type GameAssetUse,
  type GameEngineId,
  type GameGenerationUse,
} from "@kurambit/contracts";
import { creditedLibraryFiles } from "./assetFacts.ts";
import { gamePaths } from "./engineProfile.ts";
import { fileSha256 } from "./fileHash.ts";
import { GENERATED_DIR } from "./generatedSource.ts";
import { walkFiles } from "./walkFiles.ts";

/** One play: the game-relative files its page loaded, and the sound files that started playing. */
export const PlayUse = Schema.Struct({
  loaded: Schema.Array(Schema.String),
  played: Schema.Array(Schema.String),
});
export type PlayUse = typeof PlayUse.Type;
/** Beside a bot run's trace: what its play loaded and played. */
export const PLAY_USE_FILE = "use.json";
const decodePlayUse = Schema.decodeUnknownOption(Schema.fromJsonString(PlayUse));
export const encodePlayUse = Schema.encodeSync(Schema.fromJsonString(PlayUse));

const MAX_FILES = 20_000;
const MAX_SOUNDS = 512;
const MAX_RECORDS = 500;
const SOUND = /\.(ogg|oga|mp3|wav|m4a|aac|flac|opus|weba)$/i;
const SHA = /^sha256:([0-9a-f]{64}):(\d+)$/;

/** Hashes each file once; a file that cannot be read has none. */
const hasher = () => {
  const known = new Map<string, Promise<string | null>>();
  return (path: string) => {
    let hash = known.get(path);
    if (hash === undefined) {
      hash = fileSha256(path).then(
        (read) => read.sha256,
        () => null,
      );
      known.set(path, hash);
    }
    return hash;
  };
};
const sizeOf = (path: string) =>
  NodeFSP.stat(path).then(
    (stat) => stat.size,
    () => null,
  );

/**
 * A play's served files and its sound reports, as game-relative paths. A Web Audio sound is
 * named by the bytes it was decoded from, so it is the served file of that length and hash; a
 * media element's by its URL on the served origin. A report that matches no served file (a
 * sound made in code, a blob) names nothing.
 */
export const resolvePlayUse = async (input: {
  /** The served folder on disk. */
  readonly webRoot: string;
  /** The same folder, game-relative ("" for the game root). */
  readonly project: string;
  readonly origin: string;
  readonly served: ReadonlySet<string>;
  readonly sounds: ReadonlySet<string>;
}): Promise<PlayUse> => {
  const served = [...input.served].slice(0, MAX_FILES);
  const hash = hasher();
  const sizes = new Map<string, Promise<number | null>>();
  const size = (path: string) => {
    let known = sizes.get(path);
    if (known === undefined) {
      known = sizeOf(NodePath.join(input.webRoot, path));
      sizes.set(path, known);
    }
    return known;
  };
  const played = new Set<string>();
  for (const sound of [...input.sounds].slice(0, MAX_SOUNDS)) {
    const bytes = SHA.exec(sound);
    if (bytes !== null) {
      for (const path of served)
        if (
          (await size(path)) === Number(bytes[2]) &&
          (await hash(NodePath.join(input.webRoot, path))) === bytes[1]
        ) {
          played.add(path);
          break;
        }
      continue;
    }
    try {
      const url = new URL(sound);
      if (url.origin !== input.origin) continue;
      const path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (input.served.has(path)) played.add(path);
    } catch {
      // Not a URL on the served origin: nothing shipped.
    }
  }
  const relative = (path: string) => (input.project === "" ? path : `${input.project}/${path}`);
  return {
    loaded: served.map(relative).toSorted(),
    played: [...played].map(relative).toSorted(),
  };
};

/** A bot run's use record in its evidence folder; null when it has none or it does not read. */
export const readPlayUse = (root: string, evidence: string) =>
  NodeFSP.readFile(NodePath.join(root, evidence, PLAY_USE_FILE), "utf8").then(
    (text) => Option.getOrNull(decodePlayUse(text)),
    () => null,
  );

/** The files a build ships: its engine's assets folder, without the library files ASSETS.md credits. */
export const shippedFiles = async (
  copyRoot: string,
  engine: GameEngineId,
  project: string,
): Promise<ReadonlyArray<string>> => {
  const paths = gamePaths(engine, project);
  const credited = await creditedLibraryFiles(copyRoot, NodePath.join(copyRoot, paths.library));
  const found = await walkFiles(NodePath.join(copyRoot, paths.assets), {
    enter: (_full, name) => !name.startsWith("."),
    match: (name) => !name.startsWith("."),
    limit: MAX_FILES,
  });
  return found
    .map((full) => NodePath.relative(copyRoot, full).split(NodePath.sep).join("/"))
    .filter((path) => !credited.has(path))
    .toSorted();
};

const GenerationRecord = Schema.Struct({ id: Schema.String, files: Schema.Array(Schema.String) });
/** The one thing a sidecar says here: which generations its export was made from. */
const SidecarGenerations = Schema.Struct({
  source: Schema.Struct({
    parts: Schema.Array(Schema.Struct({ generation: Schema.optionalKey(Schema.String) })),
  }),
});
const decodeSidecarGenerations = Schema.decodeUnknownOption(
  Schema.fromJsonString(SidecarGenerations),
);

/**
 * Shipped models by the generations their sidecars credit: an export rewrites a generated
 * model's bytes, so a character, creature, prop or motion is joined to its GLB this way.
 */
const exportsByGeneration = async (copyRoot: string, shipped: ReadonlyArray<string>) => {
  const byGeneration = new Map<string, string[]>();
  for (const path of shipped) {
    if (!/\.glb$/i.test(path)) continue;
    const text = await NodeFSP.readFile(
      NodePath.join(copyRoot, path.replace(/\.glb$/i, GAME_MODEL_SIDECAR_SUFFIX)),
      "utf8",
    ).catch(() => "");
    const decoded = decodeSidecarGenerations(text);
    if (Option.isNone(decoded)) continue;
    for (const part of decoded.value.source.parts)
      if (part.generation !== undefined)
        byGeneration.set(part.generation, [...(byGeneration.get(part.generation) ?? []), path]);
  }
  return byGeneration;
};
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(GenerationRecord));

/**
 * The build's generations (their records under art/generated/) joined to the shipped files by
 * content (a shipped file has the bytes of a file it delivered) or by an exported model's sidecar
 * crediting it, and loaded when a play loaded such a file. Only files of equal length are hashed.
 */
export const generationsShipped = async (
  copyRoot: string,
  shipped: ReadonlyArray<string>,
  loaded: ReadonlySet<string>,
): Promise<GameGenerationUse> => {
  const records = await walkFiles(NodePath.join(copyRoot, GENERATED_DIR), {
    match: (name) => name.endsWith(".generation.json"),
    maxDepth: 2,
    limit: MAX_RECORDS,
  });
  if (records.length === 0) return [];
  const bySize = new Map<number, string[]>();
  for (const path of shipped) {
    const bytes = await sizeOf(NodePath.join(copyRoot, path));
    if (bytes !== null) bySize.set(bytes, [...(bySize.get(bytes) ?? []), path]);
  }
  const exported = await exportsByGeneration(copyRoot, shipped);
  const hash = hasher();
  const joined: Array<{ id: string; loaded: boolean }> = [];
  for (const record of records) {
    const decoded = decodeRecord(await NodeFSP.readFile(record, "utf8").catch(() => ""));
    if (Option.isNone(decoded)) continue;
    const matched = new Set<string>(exported.get(decoded.value.id) ?? []);
    for (const file of decoded.value.files) {
      const normal = NodePath.posix.normalize(file);
      if (!normal.startsWith(`${GENERATED_DIR}/`)) continue;
      const full = NodePath.join(copyRoot, normal);
      const bytes = await sizeOf(full);
      const same = bytes === null ? undefined : bySize.get(bytes);
      if (same === undefined) continue;
      const mine = await hash(full);
      if (mine === null) continue;
      for (const path of same)
        if ((await hash(NodePath.join(copyRoot, path))) === mine) matched.add(path);
    }
    if (matched.size > 0)
      joined.push({ id: decoded.value.id, loaded: [...matched].some((path) => loaded.has(path)) });
  }
  return joined.slice(0, GAME_ASSET_USE_CAP);
};

/**
 * The use fact from the shipped files and every play's record. The unused list fills first,
 * since it is what the next step acts on; `more` counts used and unused files past the caps.
 */
export const assetUseOf = (
  shipped: ReadonlyArray<string>,
  plays: ReadonlyArray<PlayUse>,
  generations: GameGenerationUse,
): GameAssetUse => {
  const loaded = new Set(plays.flatMap((play) => play.loaded));
  const played = new Set(plays.flatMap((play) => play.played));
  const used = shipped.filter((path) => loaded.has(path));
  const unused = shipped.filter((path) => !loaded.has(path));
  const sounds = used.filter((path) => SOUND.test(path));
  const cap = GAME_ASSET_USE_CAP;
  return {
    used: used.slice(0, cap),
    unused: unused.slice(0, cap),
    played: sounds.filter((path) => played.has(path)).slice(0, cap),
    silent: sounds.filter((path) => !played.has(path)).slice(0, cap),
    more: Math.max(0, used.length - cap) + Math.max(0, unused.length - cap),
    generations,
  };
};
