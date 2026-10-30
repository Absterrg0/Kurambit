// @effect-diagnostics nodeBuiltinImport:off -- This module owns the bounded inventory walk over game files, like other game filesystem boundaries.
// Pure inventory helpers for `game_assets_inspect`. Filesystem walks and text
// scans live here as plain async functions; the service owns the Effect
// boundary, the Godot run and the operation lock. Native load semantics stay
// in the headless script — nothing here parses .tscn/.tres for dependencies.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { NodeIO } from "@gltf-transform/core";
import {
  GAME_ASSET_INVENTORY_BOUNDS,
  type GameAssetCoverage,
  type GameAssetDeclaredReference,
  type GameAssetFamily,
  type GameAssetFamilyCheck,
  type GameAssetNativeEvidence,
  type GameAssetRequirement,
  type GameAssetResourceEntry,
  type GameAssetResourceKind,
  type GameAssetSourceMention,
  type GameManifest,
} from "@t3tools/contracts";
import { sniffImagePixels } from "./gameBlenderInputs.ts";
import { templateDirectoryCandidates } from "./templates.ts";

/**
 * Structural scan bounds: the contract's literal bound object satisfies this,
 * and tests pass narrowed copies without fighting literal types.
 */
export interface InventoryBounds {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxSourceFiles: number;
  readonly maxSourceBytesPerFile: number;
  readonly maxMentions: number;
  readonly maxDeclaredRefs: number;
  readonly maxResources: number;
  readonly maxEvidencePaths: number;
}

const lower = (value: string): string => value.toLowerCase();

/** Provisional kind by extension only; the native pass refines `.tres`. */
const classifyResourceKind = (relativePosix: string): GameAssetResourceKind => {
  const ext = lower(relativePosix.slice(relativePosix.lastIndexOf(".")));
  if (ext === ".glb" || ext === ".gltf" || ext === ".fbx" || ext === ".obj") return "model";
  if (
    ext === ".png" ||
    ext === ".jpg" ||
    ext === ".jpeg" ||
    ext === ".webp" ||
    ext === ".svg" ||
    ext === ".bmp"
  )
    return "texture";
  if (ext === ".ogg" || ext === ".wav" || ext === ".mp3" || ext === ".flac") return "audio";
  if (ext === ".tscn" || ext === ".scn") return "scene";
  if (ext === ".ttf" || ext === ".otf" || ext === ".woff" || ext === ".woff2") return "font";
  if (ext === ".gd" || ext === ".gdshader" || ext === ".cfg" || ext === ".godot") return "script";
  if (
    ext === ".tres" ||
    ext === ".res" ||
    ext === ".material" ||
    ext === ".mesh" ||
    ext === ".anim"
  )
    return "resource";
  return "other";
};

/** Generated trees never enter the walk: engine output and version control. */
const isExcludedPath = (relativePosix: string): boolean => {
  const segments = relativePosix.split("/");
  if (segments.includes(".godot") || segments.includes("builds") || segments.includes(".git"))
    return true;
  if (segments.some((segment) => segment.startsWith(".staging-"))) return true;
  const base = segments.at(-1) ?? "";
  if (base.endsWith(".import") || base.endsWith(".uid") || base.endsWith(".blend1")) return true;
  if (base === ".DS_Store") return true;
  return false;
};

export interface NormalizedAuthoredPath {
  readonly resPath: string | null;
  readonly gameRelative: string | null;
  readonly invalid: string | null;
}
/**
 * One authored path to a game-relative posix path. Accepts `res://` paths
 * under the Godot project and game-relative paths inside the game. Anything
 * escaping the game, absolute, or blank is invalid rather than resolved.
 */
export const normalizeAuthoredPath = (
  authored: string,
  godotProject: string,
): NormalizedAuthoredPath => {
  const project = godotProject.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (authored.startsWith("res://")) {
    const rest = authored.slice("res://".length);
    if (rest.length === 0 || rest.includes("\\") || rest.split("/").includes(".."))
      return { resPath: null, gameRelative: null, invalid: authored };
    const gameRelative = project === "" ? rest : `${project}/${rest}`;
    if (gameRelative.split("/").includes(".."))
      return { resPath: null, gameRelative: null, invalid: authored };
    return { resPath: `res://${rest}`, gameRelative, invalid: null };
  }
  const cleaned = authored.replaceAll("\\", "/").replace(/^\.\//, "");
  if (cleaned.length === 0 || cleaned.startsWith("/") || cleaned.split("/").includes(".."))
    return { resPath: null, gameRelative: null, invalid: authored };
  const underProject = project === "" || cleaned === project || cleaned.startsWith(`${project}/`);
  const resPath = underProject
    ? `res://${project === "" ? cleaned : cleaned.slice(project.length + 1) || ""}`
    : null;
  return {
    resPath: resPath === "res://" ? null : resPath,
    gameRelative: cleaned,
    invalid: null,
  };
};

/**
 * A regular game file the inventory may read. Symlinks never count: a linked
 * script, image or GLB could change without changing the tree the engine
 * saw, and a link pointing outside the game must not leak outside content
 * into declared references, GLB measures or native dependencies.
 */
export const existsInsideGame = async (
  root: string,
  gameRelative: string,
): Promise<{ readonly exists: boolean; readonly bytes: number }> => {
  const absolute = NodePath.join(root, ...gameRelative.split("/"));
  try {
    if ((await NodeFSP.lstat(absolute)).isSymbolicLink()) return { exists: false, bytes: 0 };
  } catch {
    return { exists: false, bytes: 0 };
  }
  try {
    const stat = await NodeFSP.stat(absolute);
    if (!stat.isFile()) return { exists: false, bytes: 0 };
    const real = await NodeFSP.realpath(absolute);
    const resolvedRoot = await NodeFSP.realpath(root).catch(() => NodePath.resolve(root));
    if (real !== resolvedRoot && !real.startsWith(resolvedRoot + NodePath.sep))
      return { exists: false, bytes: 0 };
    return { exists: true, bytes: stat.size };
  } catch {
    return { exists: false, bytes: 0 };
  }
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Header dimensions without decoding pixels, so huge images fail cheaply. */
export const imagePixelCount = async (
  root: string,
  gameRelative: string,
): Promise<{ readonly width: number; readonly height: number; readonly pixels: number } | null> => {
  const lower = gameRelative.toLowerCase();
  const isPng = lower.endsWith(".png");
  const isJpg = lower.endsWith(".jpg") || lower.endsWith(".jpeg");
  if (!isPng && !isJpg) return null;
  const absolute = NodePath.join(root, ...gameRelative.split("/"));
  let handle: NodeFSP.FileHandle | null = null;
  try {
    if ((await NodeFSP.lstat(absolute)).isSymbolicLink()) return null;
    handle = await NodeFSP.open(absolute, "r");
    const head = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const bytes = head.subarray(0, bytesRead);
    if (isPng) {
      if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
        return null;
      return { width, height, pixels: width * height };
    }
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let pos = 2;
    for (let guard = 0; guard < 512 && pos + 9 < bytes.length; guard += 1) {
      if (bytes[pos] !== 0xff) break;
      const marker = bytes[pos + 1]!;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) {
        pos += 2;
        continue;
      }
      if (marker >= 0xd0 && marker <= 0xd7) {
        pos += 2;
        continue;
      }
      const length = (bytes[pos + 2]! << 8) | bytes[pos + 3]!;
      if (length < 2) break;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
        const height = (bytes[pos + 5]! << 8) | bytes[pos + 6]!;
        const width = (bytes[pos + 7]! << 8) | bytes[pos + 8]!;
        if (width <= 0 || height <= 0) return null;
        return { width, height, pixels: width * height };
      }
      pos += 2 + length;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

export interface WalkedFile {
  readonly path: string;
  readonly bytes: number;
}

export interface FilesystemScan {
  readonly files: ReadonlyArray<WalkedFile>;
  readonly scannedFiles: number;
  readonly scannedBytes: number;
  readonly truncated: boolean;
  readonly incomplete: string[];
  /** Symlink entries the walk skipped without reading; the editor may follow them. */
  readonly symlinksSkipped: number;
}

/** Bounded walk of the whole game directory, minus generated trees. Uses
 * `opendir` so an enormous directory never materializes as one huge array;
 * stops immediately when the file, directory or byte bound is reached. */
export const walkGameFiles = async (
  root: string,
  bounds: InventoryBounds = GAME_ASSET_INVENTORY_BOUNDS,
): Promise<FilesystemScan> => {
  const files: Array<WalkedFile> = [];
  const incomplete: string[] = [];
  let scannedBytes = 0;
  let scannedDirs = 0;
  let truncated = false;
  let symlinksSkipped = 0;
  const queue: string[] = [root];
  let seen = 0;
  const stop = (note: string): void => {
    if (!truncated) {
      truncated = true;
      incomplete.push(note);
    }
    queue.length = 0;
  };
  while (queue.length > 0) {
    const directory = queue.pop()!;
    scannedDirs += 1;
    if (scannedDirs > bounds.maxFiles) {
      stop(
        `directory walk stopped at ${bounds.maxFiles} directories; remaining directories are unlisted`,
      );
      break;
    }
    let dir: Awaited<ReturnType<typeof NodeFSP.opendir>>;
    try {
      dir = await NodeFSP.opendir(directory);
    } catch {
      incomplete.push(`unreadable directory: ${NodePath.relative(root, directory) || "."}`);
      continue;
    }
    try {
      for await (const entry of dir) {
        if (truncated) break;
        const absolute = NodePath.join(directory, entry.name);
        const relative = NodePath.relative(root, absolute).split(NodePath.sep).join("/");
        if (relative === "" || isExcludedPath(relative)) continue;
        if (entry.isSymbolicLink()) {
          symlinksSkipped += 1;
          continue;
        }
        if (entry.isDirectory()) {
          queue.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        seen += 1;
        if (seen > bounds.maxFiles) {
          stop(`file walk stopped at ${bounds.maxFiles} files; remaining files are unlisted`);
          break;
        }
        let size = 0;
        try {
          size = (await NodeFSP.stat(absolute)).size;
        } catch {
          incomplete.push(`unstatable file: ${relative}`);
          continue;
        }
        scannedBytes += size;
        files.push({ path: relative, bytes: size });
        if (scannedBytes > bounds.maxTotalBytes) {
          stop(
            `scanned bytes passed ${(bounds.maxTotalBytes / 1_000_000).toFixed(0)} MB; later files are unlisted`,
          );
          break;
        }
      }
    } finally {
      await dir.close().catch(() => {});
    }
    if (truncated) break;
  }
  files.sort((left, right) => (left.path < right.path ? -1 : 1));
  if (symlinksSkipped > 0)
    incomplete.push(
      `skipped ${symlinksSkipped} symlink(s); links are never read and the editor may follow them`,
    );
  return {
    files,
    scannedFiles: files.length,
    scannedBytes,
    truncated,
    incomplete,
    symlinksSkipped,
  };
};

export interface DeclaredAuthored {
  readonly from: string;
  readonly target: string;
}

/** Every path the manifest and the families author, before existence checks. */
export const collectAuthoredPaths = (manifest: GameManifest): ReadonlyArray<DeclaredAuthored> => {
  const out: Array<DeclaredAuthored> = [];
  for (const asset of manifest.assets) {
    const label = `manifest:${asset.id}`;
    for (const target of [asset.export, asset.source, asset.script])
      out.push({ from: label, target });
    if (asset.thumbnail !== undefined) out.push({ from: label, target: asset.thumbnail });
    for (const input of asset.inputs ?? [])
      out.push({ from: `${label}:input:${input.name}`, target: input.path });
  }
  for (const family of manifest.families ?? []) {
    for (const target of family.paths) out.push({ from: `family:${family.name}`, target });
  }
  return out;
};

/** Resolve authored paths against the game; invalid, missing or symlinked
 *  targets stay listed as not existing, never resolved outside the game. */
export const resolveDeclaredReferences = async (
  root: string,
  godotProject: string,
  authored: ReadonlyArray<DeclaredAuthored>,
  bounds: InventoryBounds = GAME_ASSET_INVENTORY_BOUNDS,
): Promise<{ readonly refs: GameAssetDeclaredReference[]; readonly truncated: boolean }> => {
  const refs: GameAssetDeclaredReference[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const entry of authored) {
    const key = `${entry.from}\0${entry.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (refs.length >= bounds.maxDeclaredRefs) {
      truncated = true;
      break;
    }
    const normalized = normalizeAuthoredPath(entry.target, godotProject);
    if (normalized.invalid !== null || normalized.gameRelative === null) {
      refs.push({ from: entry.from, target: entry.target, exists: false, resolvedPath: null });
      continue;
    }
    const inside = await existsInsideGame(root, normalized.gameRelative);
    const exists = inside.exists;
    refs.push({
      from: entry.from,
      target: entry.target,
      exists,
      resolvedPath: exists ? normalized.gameRelative : null,
    });
  }
  return { refs, truncated };
};

const RES_PATH_PATTERN = /res:\/\/[^\s"'`)\]]+/g;

/**
 * Bounded `res://` mention scan over project text sources. Reads at most a
 * head of each file and counts (file, target) pairs. Mentions are evidence
 * of a string, never of a load — native edges alone prove loading. Files the
 * file bound skips and heads cut short are reported through the returned
 * flags so callers never mistake an unlisted file for an unmentioned target.
 */
export const scanSourceMentions = async (
  root: string,
  files: ReadonlyArray<WalkedFile>,
  bounds: InventoryBounds = GAME_ASSET_INVENTORY_BOUNDS,
): Promise<{
  readonly mentions: GameAssetSourceMention[];
  readonly truncated: boolean;
  readonly filesTruncated: boolean;
  readonly headsCut: number;
}> => {
  const eligible = files.filter((file) =>
    [".gd", ".tscn", ".tres", ".godot", ".cfg"].some((ext) => file.path.endsWith(ext)),
  );
  const candidates = eligible.slice(0, bounds.maxSourceFiles);
  const filesTruncated = eligible.length > candidates.length;
  let headsCut = 0;
  const counts = new Map<string, number>();
  for (const file of candidates) {
    if (file.bytes > bounds.maxSourceBytesPerFile) headsCut += 1;
    let text: string;
    try {
      const absolute = NodePath.join(root, ...file.path.split("/"));
      if ((await NodeFSP.lstat(absolute)).isSymbolicLink()) continue;
      const handle = await NodeFSP.open(absolute, "r");
      try {
        const buffer = Buffer.alloc(Math.min(bounds.maxSourceBytesPerFile, file.bytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
    RES_PATH_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(RES_PATH_PATTERN)) {
      const target = match[0].replace(/[.,;:]+$/, "").slice(0, 500);
      if (target.length < "res://".length + 1) continue;
      const key = `${file.path}\0${target}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (counts.size >= bounds.maxMentions) break;
    }
    if (counts.size >= bounds.maxMentions) break;
  }
  const mentions: GameAssetSourceMention[] = [...counts.entries()].map(([key, count]) => {
    const separator = key.indexOf("\0");
    return { file: key.slice(0, separator), target: key.slice(separator + 1), count };
  });
  mentions.sort((left, right) =>
    left.file < right.file ? -1 : left.file > right.file ? 1 : left.target < right.target ? -1 : 1,
  );
  const truncated = counts.size >= bounds.maxMentions || filesTruncated || headsCut > 0;
  return { mentions, truncated, filesTruncated, headsCut };
};

const requirement = (
  status: GameAssetRequirement["status"],
  evidence: ReadonlyArray<string>,
  detail: string,
): GameAssetRequirement => ({
  status,
  evidence: evidence.slice(0, GAME_ASSET_INVENTORY_BOUNDS.maxEvidencePaths),
  detail: detail.slice(0, 500),
});

export interface FamilyMeasureInputs {
  readonly declared: ReadonlyMap<string, GameAssetDeclaredReference>;
  readonly native: GameAssetNativeEvidence;
  readonly provenanceFiles: ReadonlySet<string>;
  readonly glbHeights: ReadonlyMap<string, number>;
  /** True when the declared-reference list hit its bound, so unlisted paths were never checked. */
  readonly declaredTruncated: boolean;
}

const toResPath = (gameRelative: string, godotProject: string): string | null => {
  const project = godotProject.replaceAll("\\", "/");
  if (project === "") return `res://${gameRelative}`;
  if (gameRelative === project || gameRelative.startsWith(`${project}/`))
    return `res://${gameRelative.slice(project.length + 1)}`;
  return null;
};

/**
 * Resources the family owns plus everything the engine saw them load,
 * followed through native dependency edges. All native scoping uses this
 * exact set; basenames never match across unrelated families.
 */
const familyReachable = (
  familyRes: ReadonlySet<string>,
  native: GameAssetNativeEvidence,
): Set<string> => {
  const reachable = new Set<string>(familyRes);
  const queue = [...familyRes];
  const edgesByFrom = new Map<string, string[]>();
  for (const edge of native.edges) {
    const list = edgesByFrom.get(edge.from) ?? [];
    list.push(edge.to);
    edgesByFrom.set(edge.from, list);
  }
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const next of edgesByFrom.get(current) ?? []) {
      if (!reachable.has(next) && reachable.size < 256) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  return reachable;
};

/**
 * One family's measured verdicts. Absent expectations report unknown, never
 * pass or fail by genre. Filesystem facts decide existence and provenance;
 * only native loads decide animations, transitions and collision wiring. A
 * confirmed missing file always reports incomplete, never complete; paths
 * the bounded lists never checked report unknown, never missing.
 */
export const checkFamily = (
  family: GameAssetFamily,
  godotProject: string,
  inputs: FamilyMeasureInputs,
): GameAssetFamilyCheck => {
  const missing: string[] = [];
  const pathEvidence: string[] = [];
  const absentPaths: string[] = [];
  const unverified: string[] = [];
  for (const target of family.paths) {
    const normalized = normalizeAuthoredPath(target, godotProject);
    const key = `family:${family.name}\0${target}`;
    const ref = inputs.declared.get(key);
    if (ref === undefined && inputs.declaredTruncated) {
      unverified.push(target);
      continue;
    }
    if (ref?.exists === true && ref.resolvedPath !== null) pathEvidence.push(ref.resolvedPath);
    else absentPaths.push(normalized.invalid ?? target);
  }
  if (family.paths.length === 0) missing.push("no paths authored");
  for (const target of unverified) missing.push(`unverified ${target} (references truncated)`);

  const familyRes = new Set<string>();
  for (const evidence of pathEvidence) {
    const res = toResPath(evidence, godotProject);
    if (res !== null) familyRes.add(res);
  }
  const reachable = familyReachable(familyRes, inputs.native);
  const familyChecked =
    inputs.native.status !== "unknown" &&
    [...reachable].some((res) => inputs.native.checkedPaths.includes(res));
  // Existing files the native pass never loaded: measured subsets must not pass.
  const uncovered =
    pathEvidence.length > 0 &&
    absentPaths.length === 0 &&
    unverified.length === 0 &&
    inputs.native.status !== "unknown" &&
    (!familyChecked || [...familyRes].some((res) => !inputs.native.checkedPaths.includes(res)));
  const hasUncoveredMembers = absentPaths.length > 0 || unverified.length > 0 || uncovered;
  const downgradeYes = (check: GameAssetRequirement, reason: string): GameAssetRequirement =>
    check.status === "yes" && hasUncoveredMembers
      ? requirement("unknown", check.evidence, reason)
      : check;

  // Scale: authored targetHeight against measured GLB heights or native scales.
  let scale: GameAssetRequirement;
  if (family.targetHeight === undefined) {
    scale = requirement(
      "unknown",
      pathEvidence,
      "The family authors no targetHeight, so scale is unmeasured.",
    );
  } else {
    const heights: Array<{ path: string; height: number }> = [];
    const unmeasured: string[] = [];
    for (const evidence of pathEvidence) {
      const glb = inputs.glbHeights.get(evidence);
      if (glb !== undefined && glb > 0) {
        heights.push({ path: evidence, height: glb });
        continue;
      }
      const memberRes = toResPath(evidence, godotProject);
      const native = inputs.native.scales.find(
        (entry) =>
          memberRes !== null &&
          reachable.has(entry.resource) &&
          entry.resource === memberRes &&
          entry.heightM !== null,
      );
      const fallback =
        memberRes === null
          ? undefined
          : inputs.native.scales.find(
              (entry) => reachable.has(entry.resource) && entry.heightM !== null,
            );
      const height = native?.heightM ?? (memberRes !== null ? undefined : fallback?.heightM);
      if (typeof height === "number" && height > 0) heights.push({ path: evidence, height });
      else unmeasured.push(evidence);
    }
    if (heights.length === 0 && unmeasured.length === 0 && pathEvidence.length === 0) {
      scale = requirement(
        "unknown",
        pathEvidence,
        `Target height is ${family.targetHeight}m but the family has no existing files to measure.`,
      );
    } else {
      const bad = heights.filter(
        ({ height }) => Math.abs(height - family.targetHeight!) / family.targetHeight! > 0.2,
      );
      if (bad.length > 0) {
        scale = requirement(
          "no",
          bad.map(({ path }) => path),
          `${bad.map(({ path, height }) => `${path} stands ${height.toFixed(2)}m`).join(", ")} drifts past 20% of ${family.targetHeight}m.`,
        );
        for (const { path } of bad) missing.push(`scale of ${path}`);
      } else if (unmeasured.length > 0 || hasUncoveredMembers) {
        const names = [...unmeasured, ...absentPaths, ...unverified].slice(0, 3).join(", ");
        scale = requirement(
          "unknown",
          heights.map(({ path }) => path),
          `Target height is ${family.targetHeight}m but ${names || "some members"} were never measured; a measured subset never passes.`,
        );
        for (const entry of expectedMissing(unmeasured, absentPaths, unverified))
          missing.push(entry);
      } else {
        scale = requirement(
          "yes",
          heights.map(({ path }) => path),
          `All measured heights hold within 20% of ${family.targetHeight}m.`,
        );
      }
    }
  }

  // Pivot: authored convention against native observations only.
  let pivot: GameAssetRequirement;
  if (family.pivot === undefined) {
    pivot = requirement(
      "unknown",
      pathEvidence,
      "The family authors no pivot convention, so pivot is unmeasured.",
    );
  } else if (inputs.native.status === "unknown" || uncovered || unverified.length > 0) {
    pivot = requirement(
      "unknown",
      pathEvidence,
      `Pivot expects ${family.pivot} but no native transform was observed for these paths.`,
    );
    if (unverified.length > 0)
      for (const target of unverified) missing.push(`pivot of ${target} unverified`);
    else for (const evidence of pathEvidence) missing.push(`pivot of ${evidence} unverified`);
    if (pathEvidence.length === 0 && absentPaths.length === 0 && unverified.length === 0)
      missing.push(`pivot ${family.pivot} unobserved`);
  } else {
    const observed = inputs.native.scales.filter(
      (entry) => entry.pivot !== null && reachable.has(entry.resource),
    );
    if (observed.length === 0) {
      pivot = requirement(
        "unknown",
        pathEvidence,
        `Pivot expects ${family.pivot} but no native transform was observed for these paths.`,
      );
      if (pathEvidence.length === 0 && absentPaths.length === 0)
        missing.push(`pivot ${family.pivot} unobserved`);
    } else {
      const bad = observed.filter((entry) => entry.pivot !== family.pivot);
      if (bad.length > 0) {
        pivot = requirement(
          "no",
          bad.map((entry) => entry.resource),
          `Expected ${family.pivot} but observed ${bad.map((entry) => `${entry.resource}: ${entry.pivot}`).join(", ")}.`,
        );
        for (const entry of bad) missing.push(`pivot of ${entry.resource}`);
      } else if (hasUncoveredMembers) {
        pivot = requirement(
          "unknown",
          observed.map((entry) => entry.resource),
          `Observed pivots hold ${family.pivot} on the measured subset, but ${[...absentPaths, ...unverified].slice(0, 3).join(", ") || "some members"} were never inspected.`,
        );
      } else {
        pivot = requirement(
          "yes",
          observed.map((entry) => entry.resource),
          `Observed pivots hold the ${family.pivot} convention.`,
        );
      }
    }
  }

  // Animations: every expected name must appear in this family's native lists.
  const expectedAnimations = family.animations ?? [];
  let animations: GameAssetRequirement;
  if (expectedAnimations.length === 0) {
    animations = requirement(
      "unknown",
      pathEvidence,
      "The family authors no animation names, so animations are unmeasured.",
    );
  } else if (inputs.native.status === "unknown" || uncovered || unverified.length > 0) {
    animations = requirement(
      "unknown",
      pathEvidence,
      uncovered || unverified.length > 0
        ? "The family's files were never loaded natively, so animations are unmeasured rather than passing or failing on another family."
        : "Animations need the native pass; Godot did not report them.",
    );
    for (const entry of expectedAnimations) missing.push(`animation "${entry.name}" unverified`);
  } else {
    const scoped = inputs.native.animations.filter((entry) => reachable.has(entry.resource));
    const observedNames = new Set<string>();
    for (const entry of scoped) for (const name of entry.animations) observedNames.add(name);
    const absent = expectedAnimations.filter((entry) => !observedNames.has(entry.name));
    if (absent.length > 0) {
      animations = requirement(
        "no",
        pathEvidence,
        `Missing natively loaded animations: ${absent.map((entry) => `"${entry.name}"`).join(", ")}.`,
      );
      for (const entry of absent) missing.push(`animation "${entry.name}"`);
    } else {
      const loopKnown = scoped.some((entry) => entry.loops !== undefined);
      const looped = new Set<string>();
      for (const entry of scoped) for (const name of entry.loops ?? []) looped.add(name);
      const needsLoop = expectedAnimations.filter((entry) => entry.loop !== undefined);
      if (needsLoop.length > 0 && !loopKnown) {
        animations = requirement(
          "unknown",
          pathEvidence,
          `All ${expectedAnimations.length} expected animations are present natively, but loop flags were not reported; loop stays unmeasured rather than passing on a manual review.`,
        );
        for (const entry of needsLoop) missing.push(`animation "${entry.name}" loop unverified`);
      } else {
        const loopBad = needsLoop.filter(
          (entry) =>
            (entry.loop === true && !looped.has(entry.name)) ||
            (entry.loop === false && looped.has(entry.name)),
        );
        if (loopBad.length > 0) {
          animations = requirement(
            "no",
            pathEvidence,
            `Loop mismatch natively: ${loopBad.map((entry) => `"${entry.name}" expects loop ${String(entry.loop)}`).join(", ")}.`,
          );
          for (const entry of loopBad) missing.push(`animation "${entry.name}" loop`);
        } else {
          const candidate = requirement(
            "yes",
            pathEvidence,
            needsLoop.length === 0
              ? `All ${expectedAnimations.length} expected animations are present natively.`
              : `All ${expectedAnimations.length} expected animations are present natively with matching loop flags.`,
          );
          animations = downgradeYes(
            candidate,
            `All expected animations are present on the measured subset, but ${[...absentPaths, ...unverified].slice(0, 3).join(", ") || "some members"} were never inspected.`,
          );
          if (animations.status === "unknown")
            for (const target of [...absentPaths, ...unverified])
              missing.push(`animation member ${target} unverified`);
        }
      }
    }
  }

  // Transitions: only an observed state-machine edge counts as yes.
  const expectedTransitions = family.transitions ?? [];
  let transitions: GameAssetRequirement;
  if (expectedTransitions.length === 0) {
    transitions = requirement(
      "unknown",
      pathEvidence,
      "The family authors no transitions, so transitions are unmeasured.",
    );
  } else if (inputs.native.status === "unknown" || uncovered || unverified.length > 0) {
    transitions = requirement(
      "unknown",
      pathEvidence,
      uncovered || unverified.length > 0
        ? "The family's files were never loaded natively, so transitions are unmeasured rather than passing on another family."
        : "Transitions need the native pass; Godot did not report them.",
    );
    for (const entry of expectedTransitions)
      missing.push(`transition ${entry.from}->${entry.to} unverified`);
  } else {
    const scopedAnims = inputs.native.animations.filter((entry) => reachable.has(entry.resource));
    const observedNames = new Set<string>();
    for (const entry of scopedAnims) for (const name of entry.animations) observedNames.add(name);
    const scopedEdges = (inputs.native.transitions ?? []).filter((edge) =>
      reachable.has(edge.resource),
    );
    let sawNo = false;
    let sawUnknown = false;
    const edgeEvidence: string[] = [];
    for (const entry of expectedTransitions) {
      const match = scopedEdges.find((edge) => edge.from === entry.from && edge.to === entry.to);
      if (match !== undefined) {
        edgeEvidence.push(match.resource);
        if (entry.condition !== undefined && match.condition !== entry.condition) {
          sawUnknown = true;
          missing.push(`transition ${entry.from}->${entry.to} trigger unverified`);
        }
        continue;
      }
      if (!observedNames.has(entry.from) || !observedNames.has(entry.to)) {
        sawNo = true;
        missing.push(`transition ${entry.from}->${entry.to}`);
      } else {
        sawUnknown = true;
        missing.push(`transition ${entry.from}->${entry.to} wiring unverified`);
      }
    }
    if (sawNo) {
      transitions = requirement(
        "no",
        pathEvidence,
        `Transitions name animations that never loaded in this family: ${expectedTransitions.map((entry) => `${entry.from}->${entry.to}`).join(", ")}.`,
      );
    } else if (sawUnknown || hasUncoveredMembers) {
      transitions = requirement(
        "unknown",
        edgeEvidence.length > 0 ? edgeEvidence : pathEvidence,
        "Endpoints exist natively but state-machine wiring was not confirmed; treat as unverified, not passing.",
      );
    } else {
      transitions = requirement(
        "yes",
        edgeEvidence.length > 0 ? edgeEvidence : pathEvidence,
        `State-machine edges observed: ${expectedTransitions.map((entry) => `${entry.from}->${entry.to}`).join(", ")}.`,
      );
    }
  }

  // Collision: required needs an enabled shape, none needs no shape. A family
  // the native pass never inspected reports unknown, never yes or no.
  let collision: GameAssetRequirement;
  if (family.collision === undefined) {
    collision = requirement(
      "unknown",
      pathEvidence,
      "The family authors no collision promise, so collision is unmeasured.",
    );
  } else if (family.collision === "optional") {
    const shapes = inputs.native.collisions
      .filter((entry) => reachable.has(entry.scene))
      .reduce((sum, entry) => sum + entry.enabledWithShape, 0);
    collision = requirement(
      "yes",
      pathEvidence,
      `Collision is optional; ${shapes} enabled shapes observed on related scenes.`,
    );
  } else if (inputs.native.status === "unknown" || uncovered || unverified.length > 0) {
    collision = requirement(
      "unknown",
      pathEvidence,
      "Collision needs the native pass; Godot did not report shapes for this family.",
    );
    missing.push("collision unverified");
  } else if (family.collision === "required") {
    const related = inputs.native.collisions.filter((entry) => reachable.has(entry.scene));
    const enabled = related.reduce((sum, entry) => sum + entry.enabledWithShape, 0);
    if (enabled > 0) {
      const candidate = requirement(
        "yes",
        related.map((entry) => entry.scene),
        `${enabled} enabled collision shapes observed.`,
      );
      collision = downgradeYes(
        candidate,
        `Enabled shapes observed on the measured subset, but ${[...absentPaths, ...unverified].slice(0, 3).join(", ") || "some members"} were never inspected.`,
      );
      if (collision.status === "unknown") missing.push("collision member unverified");
    } else {
      collision = requirement(
        "no",
        pathEvidence,
        "Collision is required but no enabled CollisionShape with a shape was observed natively.",
      );
      missing.push("enabled collision shape");
    }
  } else {
    const related = inputs.native.collisions.filter((entry) => reachable.has(entry.scene));
    const enabled = related.reduce((sum, entry) => sum + entry.enabledWithShape, 0);
    if (enabled === 0) {
      const candidate = requirement(
        "yes",
        pathEvidence,
        "Collision expects none and no enabled shapes were observed.",
      );
      collision = downgradeYes(
        candidate,
        `No shapes observed on the measured subset, but ${[...absentPaths, ...unverified].slice(0, 3).join(", ") || "some members"} were never inspected.`,
      );
      if (collision.status === "unknown") missing.push("collision member unverified");
    } else {
      collision = requirement(
        "no",
        related.map((entry) => entry.scene),
        `Collision expects none but ${enabled} enabled shapes were observed.`,
      );
      missing.push("unexpected collision shapes");
    }
  }

  // Provenance: required needs a readable file beside every directory the
  // family's existing files live in. One directory's file never covers
  // unrelated directories, and missing members never pass on a subset.
  let provenance: GameAssetRequirement;
  if (family.provenance === undefined) {
    provenance = requirement(
      "unknown",
      pathEvidence,
      "The family authors no provenance promise, so provenance is unmeasured.",
    );
  } else if (family.provenance === "optional") {
    provenance = requirement("yes", pathEvidence, "Provenance is optional; no file is required.");
  } else if (pathEvidence.length === 0) {
    provenance = requirement(
      "no",
      [],
      "Provenance is required but the family has no existing files to sit beside.",
    );
    missing.push("provenance file");
  } else {
    const directories = [
      ...new Set(pathEvidence.map((path) => path.split("/").slice(0, -1).join("/"))),
    ];
    const provenanceDirs = new Set(
      [...inputs.provenanceFiles].map((file) => file.split("/").slice(0, -1).join("/")),
    );
    const uncoveredDirs = directories.filter((directory) => !provenanceDirs.has(directory));
    if (uncoveredDirs.length > 0) {
      provenance = requirement(
        "no",
        pathEvidence,
        `Provenance is required but no readable PROVENANCE.md or license sits beside: ${uncoveredDirs.slice(0, 3).join(", ")}.`,
      );
      missing.push("provenance file");
    } else if (hasUncoveredMembers) {
      provenance = requirement(
        "unknown",
        [...inputs.provenanceFiles]
          .filter((file) => directories.includes(file.split("/").slice(0, -1).join("/")))
          .slice(0, 8),
        `Provenance covers the measured directories, but ${[...absentPaths, ...unverified].slice(0, 3).join(", ") || "some members"} were never inspected.`,
      );
      for (const target of [...absentPaths, ...unverified])
        missing.push(`provenance member ${target} unverified`);
    } else {
      const found = [...inputs.provenanceFiles].filter((file) =>
        directories.includes(file.split("/").slice(0, -1).join("/")),
      );
      provenance = requirement(
        "yes",
        found.slice(0, 8),
        `Readable provenance beside every directory: ${found.slice(0, 3).join(", ")}.`,
      );
    }
  }

  for (const absent of absentPaths) missing.push(`missing file ${absent}`);

  const authoredChecks = [
    family.targetHeight !== undefined ? scale : null,
    family.pivot !== undefined ? pivot : null,
    expectedAnimations.length > 0 ? animations : null,
    expectedTransitions.length > 0 ? transitions : null,
    family.collision !== undefined && family.collision !== "optional" ? collision : null,
    family.provenance === "required" ? provenance : null,
    family.paths.length > 0 ? null : requirement("no", [], "The family names no files."),
  ].filter((entry) => entry !== null);
  // A confirmed missing file outranks every check: it is always incomplete.
  // Unlisted paths the bounds never checked are unknown, never missing.
  const status =
    absentPaths.length > 0
      ? "incomplete"
      : authoredChecks.some((entry) => entry.status === "no")
        ? "incomplete"
        : authoredChecks.every((entry) => entry.status === "yes") &&
            (family.paths.length > 0 || authoredChecks.length > 0)
          ? "complete"
          : "unknown";

  return {
    family: family.name,
    kind: family.kind,
    status: authoredChecks.length === 0 && pathEvidence.length > 0 ? "unknown" : status,
    scale,
    pivot,
    animations,
    transitions,
    collision,
    provenance,
    missing: missing.slice(0, 32),
  };
};

const expectedMissing = (
  unmeasured: ReadonlyArray<string>,
  absentPaths: ReadonlyArray<string>,
  unverified: ReadonlyArray<string>,
): string[] => {
  const out: string[] = [];
  for (const path of unmeasured.slice(0, 3)) out.push(`scale of ${path} unmeasured`);
  for (const path of absentPaths.slice(0, 3)) out.push(`missing file ${path}`);
  for (const path of unverified.slice(0, 3)) out.push(`unverified ${path} (references truncated)`);
  return out;
};

/** Aggregate kit, library, audio and provenance counts from the walk. */
export const summarizeCoverage = (
  files: ReadonlyArray<WalkedFile>,
  godotProject: string,
  native: GameAssetNativeEvidence,
  manifest: GameManifest,
): GameAssetCoverage => {
  const project = godotProject.replaceAll("\\", "/");
  const under = (prefix: string) =>
    files.filter((file) => file.path === prefix || file.path.startsWith(`${prefix}/`));
  const kitFiles = under(`${project}/assets/art/kits`).length;
  const kitDirs = new Set(
    under(`${project}/assets/art/kits`).map((file) => file.path.split("/").slice(0, -1).join("/")),
  );
  const framesBuilt = files.filter((file) => file.path.endsWith("_frames.tres")).length;
  const libraryModels = under(`${project}/assets/library/models`).filter((file) =>
    [".gltf", ".glb", ".bin"].some((ext) => file.path.toLowerCase().endsWith(ext)),
  ).length;
  const libraryMaterials = under(`${project}/assets/library/materials`).filter((file) =>
    file.path.toLowerCase().endsWith(".tres"),
  ).length;
  const audioFiles = files.filter((file) =>
    [".ogg", ".wav", ".mp3", ".flac"].some((ext) => file.path.toLowerCase().endsWith(ext)),
  ).length;
  const nativeAudio = new Set(
    native.edges
      .filter((edge) =>
        [".ogg", ".wav", ".mp3", ".flac"].some((ext) => edge.to.toLowerCase().endsWith(ext)),
      )
      .map((edge) => edge.to),
  ).size;
  const provenanceFiles = files
    .filter((file) => {
      const base = file.path.split("/").at(-1)?.toUpperCase() ?? "";
      return base === "PROVENANCE.MD" || base.startsWith("LICENSE") || base === "PROVENANCE";
    })
    .map((file) => file.path)
    .slice(0, 64);
  const supplied = manifest.assets.flatMap((asset) => asset.inputs ?? []).length;
  const message =
    `Kits: ${kitDirs.size} installed (${kitFiles} files, ${framesBuilt} frames resources). ` +
    `Library: ${libraryModels} model files, ${libraryMaterials} material resources. ` +
    `Audio: ${audioFiles} files, ${nativeAudio} referenced natively. ` +
    `Provenance: ${provenanceFiles.length} files. ` +
    `Inputs: ${supplied} supplied; source mentions never prove use.`;
  return {
    installedKits: kitDirs.size,
    kitFiles,
    framesBuilt,
    libraryModels,
    libraryMaterials,
    audioFiles,
    audioReferencedNatively: nativeAudio,
    provenanceFiles,
    unreadableProvenance: [],
    suppliedInputs: supplied,
    mentionedInputs: 0,
    message: message.slice(0, 2000),
  };
};

/** Build resource rows from the walk, marking declared files and native results. */
export const buildResourceEntries = (input: {
  readonly files: ReadonlyArray<WalkedFile>;
  readonly godotProject: string;
  readonly declaredPaths: ReadonlySet<string>;
  readonly declaredBy: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly nativeClasses: ReadonlyMap<string, string>;
  readonly skippedNative: ReadonlySet<string>;
  readonly bounds?: InventoryBounds;
}): { readonly entries: GameAssetResourceEntry[]; readonly truncated: boolean } => {
  const bounds = input.bounds ?? GAME_ASSET_INVENTORY_BOUNDS;
  const entries: GameAssetResourceEntry[] = [];
  for (const file of input.files) {
    if (entries.length >= bounds.maxResources) return { entries, truncated: true };
    const project = input.godotProject.replaceAll("\\", "/");
    const resPath =
      file.path === project || file.path.startsWith(`${project}/`)
        ? `res://${file.path.slice(project.length + 1)}`
        : null;
    const declared = input.declaredPaths.has(file.path);
    const godotClass = resPath !== null ? (input.nativeClasses.get(resPath) ?? null) : null;
    const inspect =
      godotClass !== null
        ? ("inspected" as const)
        : input.skippedNative.has(file.path)
          ? ("skipped" as const)
          : ("unknown" as const);
    entries.push({
      path: file.path,
      resPath,
      kind: classifyResourceKind(file.path),
      bytes: file.bytes,
      declared,
      declaredBy: [...(input.declaredBy.get(file.path) ?? [])].slice(0, 8),
      godotClass,
      inspect,
      ...(inspect === "unknown"
        ? { note: "No native load covered this file; treat engine facts as unknown." }
        : inspect === "skipped"
          ? { note: "Skipped for the native pass: overlarge or outside the bounded target set." }
          : {}),
    });
  }
  return { entries, truncated: false };
};

/**
 * Extensions the Godot editor would import but this preflight cannot bound
 * cheaply. A single such file under the Godot project refuses the native
 * pass with an actionable unknown — safe static unknown beats an unsafe
 * import that could OOM on a header bomb. Plain `.svg` is handled below by
 * byte-exact shipped-icon recognition: only a byte-identical copy of an
 * app-owned starter `godot/icon.svg` passes (counted at its known 128x128
 * cost); every edited, custom or overlarge SVG still refuses. Shipped
 * starters in `2d-platformer`, `3d-explorer` and `2d-screen` all carry such
 * an icon, so they pass without weakening the bound.
 */
const UNINSPECTABLE_IMPORT_EXTENSIONS = new Set([
  ".webp",
  ".bmp",
  ".svg",
  ".tga",
  ".exr",
  ".ktx",
  ".dds",
  ".hdr",
  ".avif",
  ".jxl",
  ".blend",
  ".fbx",
  ".dae",
  ".vrm",
]);

const IMPORTABLE_RISK_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".glb",
  ".gltf",
  ".obj",
  ".ogg",
  ".wav",
  ".mp3",
  ".flac",
  ".tscn",
  ".scn",
  ".tres",
  ".res",
]);

export interface ImportPreflight {
  readonly ok: boolean;
  readonly reason: string;
}

// shortcut: only the shipped 128px icons are importable SVGs; revisit their
// measured bounds when changing starter icons or adding general SVG support.
const SHIPPED_ICON_WIDTH = 128;
const SHIPPED_ICON_HEIGHT = 128;
const SHIPPED_ICON_PIXELS = SHIPPED_ICON_WIDTH * SHIPPED_ICON_HEIGHT;
const MAX_SHIPPED_SVG_BYTES = 8192;
const MAX_SHIPPED_ICON_FILES = 32;

const resolveTemplatesRootNode = async (): Promise<string | null> => {
  const [bundled, monorepo] = templateDirectoryCandidates(import.meta.dirname, NodePath.join);
  for (const candidate of [bundled, monorepo]) {
    try {
      const stat = await NodeFSP.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      await NodeFSP.realpath(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
};

const loadShippedSvgAllowlist = async (
  templatesDirectory: string | null,
  bounds: typeof GAME_ASSET_INVENTORY_BOUNDS,
): Promise<Buffer[]> => {
  if (!templatesDirectory) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await NodeFSP.readdir(templatesDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const allow: Buffer[] = [];
  let checked = 0;
  for (const entry of entries) {
    if (checked >= MAX_SHIPPED_ICON_FILES) break;
    if (!entry.isDirectory()) continue;
    checked += 1;
    const candidate = NodePath.join(templatesDirectory, entry.name, "godot", "icon.svg");
    try {
      const stat = await NodeFSP.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.size <= 0 || stat.size > MAX_SHIPPED_SVG_BYTES || stat.size > bounds.maxFileBytes)
        continue;
      const realTemplates = await NodeFSP.realpath(templatesDirectory);
      const realCandidate = await NodeFSP.realpath(candidate).catch(() => null);
      if (realCandidate === null) continue;
      if (
        realCandidate !== realTemplates &&
        !realCandidate.startsWith(realTemplates + NodePath.sep)
      )
        continue;
      const bytes = await NodeFSP.readFile(candidate);
      if (bytes.length !== stat.size || bytes.length > MAX_SHIPPED_SVG_BYTES) continue;
      if (allow.some((known) => known.equals(bytes))) continue;
      allow.push(bytes);
      if (allow.length >= MAX_SHIPPED_ICON_FILES) break;
    } catch {
      continue;
    }
  }
  return allow;
};

/**
 * Whole-project import preflight, run BEFORE any `--editor --import`.
 * Covers every file the editor may import (all files under the Godot
 * project), not just the narrowed native targets. Header dimensions fail
 * cheap without decoding pixels; embedded and data-URI glTF textures count
 * through the installed glTF SDK plus the shared PNG/JPEG header helper.
 * Truncation, symlink escapes, overlarge files and uninspectable compressed
 * formats all refuse with an actionable unknown. Filesystem facts still hold;
 * only the engine pass is skipped.
 */
export const preflightImportSafety = async (input: {
  readonly root: string;
  readonly godotProject: string;
  readonly scan: FilesystemScan;
  readonly bounds?: typeof GAME_ASSET_INVENTORY_BOUNDS;
}): Promise<ImportPreflight> => {
  const bounds = input.bounds ?? GAME_ASSET_INVENTORY_BOUNDS;
  const project = input.godotProject.replaceAll("\\", "/");
  const underProject = (path: string): boolean =>
    project === "" ? true : path === project || path.startsWith(`${project}/`);
  if (input.scan.truncated)
    return {
      ok: false,
      reason:
        "The file walk hit its bound, so unlisted files could still import; the native pass is skipped and filesystem facts below still hold. Narrow the game or raise the walk bound.",
    };
  if (input.scan.symlinksSkipped > 0)
    return {
      ok: false,
      reason: `Skipped ${input.scan.symlinksSkipped} symlink(s); links are never read and the editor may follow them, so the native pass is skipped and filesystem facts below still hold. Replace links with regular files.`,
    };
  const projectFiles = input.scan.files.filter((file) => underProject(file.path));
  let totalPixels = 0;
  const trackPixels = (
    label: string,
    dims: { readonly width: number; readonly height: number; readonly pixels: number } | null,
  ): ImportPreflight | null => {
    if (dims === null)
      return {
        ok: false,
        reason: `Image ${label} dimensions could not be bounded before import; native inspection is skipped. Re-encode it as a bounded PNG/JPEG.`,
      };
    if (dims.width > bounds.maxImageDimension || dims.height > bounds.maxImageDimension)
      return {
        ok: false,
        reason: `Image ${label} claims ${dims.width}x${dims.height}, past the ${bounds.maxImageDimension}px dimension bound; the editor import is skipped without decoding and filesystem facts below still hold. Shrink it and retry.`,
      };
    if (dims.pixels > bounds.maxImagePixels)
      return {
        ok: false,
        reason: `Image ${label} decodes to about ${(dims.pixels / 1_000_000).toFixed(1)} MP, past the ${(bounds.maxImagePixels / 1_000_000).toFixed(0)} MP per-image bound; the editor import is skipped without decoding and filesystem facts below still hold. Shrink it and retry.`,
      };
    totalPixels += dims.pixels;
    if (totalPixels > bounds.maxTotalImagePixels)
      return {
        ok: false,
        reason: `Project images decode past the ${(bounds.maxTotalImagePixels / 1_000_000).toFixed(0)} MP total bound; the editor import is skipped without decoding and filesystem facts below still hold. Use fewer or smaller textures.`,
      };
    return null;
  };
  const realRoot = await NodeFSP.realpath(input.root);
  const hasSvg = projectFiles.some(
    (file) => lower(file.path.slice(file.path.lastIndexOf("."))) === ".svg",
  );
  const svgAllowlist = hasSvg
    ? await loadShippedSvgAllowlist(await resolveTemplatesRootNode(), bounds)
    : [];
  const refuseSvg = (filePath: string, detail: string): ImportPreflight => ({
    ok: false,
    reason: `File ${filePath} uses .svg, ${detail}; the native pass is skipped and filesystem facts below still hold. Only byte-identical shipped starter icons pass — vendor any other vector as .png/.jpg or remove it.`,
  });
  // Overlarge single files the engine would still open on import.
  for (const file of projectFiles) {
    const ext = lower(file.path.slice(file.path.lastIndexOf(".")));
    if (
      file.bytes > bounds.maxFileBytes &&
      (IMPORTABLE_RISK_EXTENSIONS.has(ext) || UNINSPECTABLE_IMPORT_EXTENSIONS.has(ext))
    )
      return {
        ok: false,
        reason: `File ${file.path} holds ${(file.bytes / 1_000_000).toFixed(1)} MB, past the ${(bounds.maxFileBytes / 1_000_000).toFixed(0)} MB single-file bound; the editor import is skipped and filesystem facts below still hold. Shrink or remove it.`,
      };
    if (UNINSPECTABLE_IMPORT_EXTENSIONS.has(ext)) {
      if (ext !== ".svg")
        return {
          ok: false,
          reason: `File ${file.path} uses ${ext}, which the bounded preflight cannot prove safe before an editor import; the native pass is skipped and filesystem facts below still hold. Vendor it as .png/.jpg/.glb/.gltf or remove it.`,
        };
      if (file.bytes > MAX_SHIPPED_SVG_BYTES || file.bytes > bounds.maxFileBytes)
        return refuseSvg(
          file.path,
          `it holds ${file.bytes} bytes, past the ${MAX_SHIPPED_SVG_BYTES} byte shipped-icon bound`,
        );
      try {
        const absolute = NodePath.join(input.root, ...file.path.split("/"));
        const stat = await NodeFSP.lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink())
          return refuseSvg(file.path, "it is not a regular file");
        if (stat.size !== file.bytes || stat.size > MAX_SHIPPED_SVG_BYTES)
          return refuseSvg(file.path, "its size could not be bounded");
        const realFile = await NodeFSP.realpath(absolute).catch(() => null);
        if (
          realFile === null ||
          (realFile !== realRoot && !realFile.startsWith(realRoot + NodePath.sep))
        )
          return refuseSvg(file.path, "it escapes the game");
        const bytes = await NodeFSP.readFile(absolute);
        if (bytes.length !== stat.size)
          return refuseSvg(file.path, "it could not be read within bounds");
        if (!svgAllowlist.some((known) => known.equals(bytes)))
          return refuseSvg(file.path, "it is not a byte-identical shipped starter icon");
        const refused = trackPixels(file.path, {
          width: SHIPPED_ICON_WIDTH,
          height: SHIPPED_ICON_HEIGHT,
          pixels: SHIPPED_ICON_PIXELS,
        });
        if (refused !== null) return refused;
        continue;
      } catch {
        return refuseSvg(file.path, "it could not be bounded before import");
      }
    }
  }
  for (const file of projectFiles) {
    const ext = lower(file.path.slice(file.path.lastIndexOf(".")));
    if (ext !== ".png" && ext !== ".jpg" && ext !== ".jpeg") continue;
    if (file.bytes > bounds.maxFileBytes) continue;
    const absolute = NodePath.join(input.root, ...file.path.split("/"));
    let dims: { readonly width: number; readonly height: number; readonly pixels: number } | null =
      null;
    try {
      if ((await NodeFSP.lstat(absolute)).isSymbolicLink()) continue;
      dims = await imagePixelCount(input.root, file.path);
    } catch {
      dims = null;
    }
    const refused = trackPixels(file.path, dims);
    if (refused !== null) return refused;
  }
  const io = new NodeIO();
  let dependencyBytes = 0;
  for (const file of projectFiles) {
    const ext = NodePath.extname(file.path).toLowerCase();
    if (ext !== ".glb" && ext !== ".gltf") continue;
    const absolute = NodePath.join(input.root, ...file.path.split("/"));
    try {
      let parsed;
      if (ext === ".glb") {
        parsed = await io.readBinary(new Uint8Array(await NodeFSP.readFile(absolute)));
      } else {
        const json = JSON.parse(await NodeFSP.readFile(absolute, "utf8")) as Parameters<
          NodeIO["readJSON"]
        >[0]["json"];
        const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
        const uris = [...(json.buffers ?? []), ...(json.images ?? [])].flatMap((entry) =>
          typeof entry.uri === "string" ? [entry.uri] : [],
        );
        if (uris.length > 64) throw new Error("More than 64 model dependencies");
        for (const uri of new Set(uris)) {
          if (uri.startsWith("data:")) continue;
          if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri) || uri.startsWith("//"))
            throw new Error("Remote model dependency");
          const decoded = decodeURIComponent(uri.split(/[?#]/)[0]!);
          if (
            !decoded ||
            decoded.length > 500 ||
            decoded.includes("\\") ||
            NodePath.isAbsolute(decoded)
          )
            throw new Error("Unsafe model dependency");
          const dependency = NodePath.resolve(NodePath.dirname(absolute), decoded);
          const real = await NodeFSP.realpath(dependency);
          if (!real.startsWith(realRoot + NodePath.sep))
            throw new Error("Model dependency outside game");
          if (![".bin", ".png", ".jpg", ".jpeg"].includes(NodePath.extname(real).toLowerCase()))
            throw new Error("Unbounded model dependency format");
          const stat = await NodeFSP.lstat(dependency);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > bounds.maxFileBytes)
            throw new Error("Unbounded model dependency file");
          dependencyBytes += stat.size;
          if (dependencyBytes > bounds.maxNativeBytes)
            throw new Error("Model dependency byte budget exceeded");
          resources[uri] = new Uint8Array(await NodeFSP.readFile(dependency));
        }
        parsed = await io.readJSON({ json, resources });
      }
      for (const texture of parsed.getRoot().listTextures()) {
        const image = texture.getImage();
        const dimensions = image === null ? null : sniffImagePixels(image);
        if (dimensions === null) throw new Error("Model image dimensions could not be bounded");
        const refused = trackPixels(`${file.path} texture`, dimensions);
        if (refused !== null) return refused;
      }
    } catch {
      return {
        ok: false,
        reason: `Model ${file.path} or its dependencies could not be bounded before import; native inspection is skipped. Use a valid self-contained GLB with bounded PNG/JPEG textures.`,
      };
    }
  }
  return {
    ok: true,
    reason: "Whole-project import preflight passed within pixel and byte bounds.",
  };
};
