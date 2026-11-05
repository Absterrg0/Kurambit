// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the game build path on the native filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { fileSha256 } from "./fileHash.ts";

/** The legacy mutable build directory. A new export never writes here. */
export const WEB_BUILD_DIRECTORY = "builds/web";
/** Immutable, build-addressed exports. Play only serves one after selection. */
export const CANDIDATE_BUILDS_DIRECTORY = "builds/candidates";

/** The game-relative directory of a content-addressed candidate build. */
export const candidateBuildDirectory = (buildId: string) =>
  `${CANDIDATE_BUILDS_DIRECTORY}/${buildId}`;

const CANDIDATE_DIRECTORY = /^builds\/candidates\/([0-9a-f]{64})$/;

/** The build id a directory name claims, or null when it is not a candidate. */
export const candidateBuildId = (directory: string): string | null =>
  CANDIDATE_DIRECTORY.exec(directory)?.[1] ?? null;

/** One served web build file, identified the way the source snapshot identifies sources. */
export interface WebArtifactFile {
  /** Game-relative path, with forward slashes. */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** One file's exact content identity, used for round decisions. */
export interface WebBuildFile {
  /** Build-relative path, with forward slashes. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** A build-addressed artifact: its directory name is the hash of its bytes. */
export interface HashedWebBuild {
  readonly buildId: string;
  readonly directory: string;
  readonly files: readonly WebBuildFile[];
}

/** A served build is a handful of files; a directory past this is not one we can vouch for. */
const MAX_WEB_ARTIFACT_ENTRIES = 1_000;

const walkBuild = async (
  directory: string,
): Promise<
  | readonly {
      readonly path: string;
      readonly absolute: string;
      readonly size: number;
      readonly mtimeMs: number;
    }[]
  | null
> => {
  const files: { path: string; absolute: string; size: number; mtimeMs: number }[] = [];
  const stack = [directory];
  let visited = 0;
  try {
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of await NodeFSP.readdir(current, { withFileTypes: true })) {
        visited += 1;
        if (visited > MAX_WEB_ARTIFACT_ENTRIES) return null;
        const absolute = NodePath.join(current, entry.name);
        // A linked build file can be replaced without changing what the record
        // names, so it is not an artifact this server can vouch for.
        if (entry.isSymbolicLink()) return null;
        if (entry.isDirectory()) {
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await NodeFSP.stat(absolute);
        files.push({
          path: NodePath.relative(directory, absolute).split(NodePath.sep).join("/"),
          absolute,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  } catch {
    return null;
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
};

/**
 * The files under a game-relative build directory, with legacy size/mtime
 * identities and game-relative paths. A record from before build-addressed
 * exports names paths under builds/web; passing that directory keeps it
 * readable, so legacy qualification survives the change.
 */
export const describeWebArtifacts = async (
  root: string,
  directory: string = WEB_BUILD_DIRECTORY,
): Promise<readonly WebArtifactFile[] | null> => {
  const buildRoot = NodePath.join(root, directory);
  const files = await walkBuild(buildRoot);
  if (files === null) return null;
  return files.map((file) => ({
    path: `${directory}/${file.path}`,
    size: file.size,
    mtimeMs: file.mtimeMs,
  }));
};

/** SHA-256 over the artifact's sorted path/content lines. */
export const webBuildId = (files: readonly WebBuildFile[]): string => {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  return hash.digest("hex");
};

/**
 * Hashes every file in an absolute build directory. This is the identity a
 * round decides on: a same-size edit in the same mtime tick changes it, and an
 * unchanged copy of the same export always hashes the same.
 */
export const hashWebBuildDirectory = async (directory: string): Promise<HashedWebBuild | null> => {
  const walked = await walkBuild(directory);
  if (walked === null || walked.length === 0) return null;
  const files: WebBuildFile[] = [];
  for (const file of walked) {
    const { sha256, bytes } = await fileSha256(file.absolute);
    files.push({ path: file.path, size: bytes, sha256 });
  }
  return { buildId: webBuildId(files), directory, files };
};

/** The same identity, for a game-relative build directory. */
export const hashWebBuild = async (
  root: string,
  directory: string,
): Promise<HashedWebBuild | null> => {
  const hashed = await hashWebBuildDirectory(NodePath.join(root, directory));
  return hashed === null ? null : { ...hashed, directory };
};
