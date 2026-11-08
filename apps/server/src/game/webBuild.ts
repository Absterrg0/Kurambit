// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the game build path on the native filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { GAME_SOURCE_FILE_LIMIT, sourceLimitDetail } from "@kurambit/contracts";
import { hashFile } from "./sourceSnapshot.ts";

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

/**
 * A three.js build is a copy of its sources, so a Web build may hold as many
 * files as a game's sources may (and a Godot one a handful more).
 */
const MAX_WEB_ARTIFACT_FILES = GAME_SOURCE_FILE_LIMIT + 100;

type WalkedFile = {
  readonly path: string;
  readonly absolute: string;
  readonly size: number;
  /** Device, inode, size and times: moves whenever the bytes could have. */
  readonly identity: string;
};

/** Why a build folder could not be read as one: too many files, a link, or the filesystem. */
export type WebBuildProblem = "entry-limit" | "symlink" | "io";

const walkBuild = async (
  directory: string,
): Promise<{ readonly files: readonly WalkedFile[] } | { readonly problem: WebBuildProblem }> => {
  const files: WalkedFile[] = [];
  const stack = [directory];
  try {
    while (stack.length > 0) {
      const current = stack.pop()!;
      for await (const entry of await NodeFSP.opendir(current)) {
        const absolute = NodePath.join(current, entry.name);
        // A linked build file can be replaced without changing what the record
        // names, so it is not an artifact this server can vouch for.
        if (entry.isSymbolicLink()) return { problem: "symlink" };
        if (entry.isDirectory()) {
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        if (files.length >= MAX_WEB_ARTIFACT_FILES) return { problem: "entry-limit" };
        const stat = await NodeFSP.stat(absolute, { bigint: true });
        files.push({
          path: NodePath.relative(directory, absolute).split(NodePath.sep).join("/"),
          absolute,
          size: Number(stat.size),
          identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
        });
      }
    }
  } catch {
    return { problem: "io" };
  }
  return {
    files: files.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  };
};

/** SHA-256 over the artifact's sorted path/content lines. */
const webBuildId = (files: readonly WebBuildFile[]): string => {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  return hash.digest("hex");
};

/**
 * Hashes every file in an absolute build directory. This is the identity a
 * round decides on: a same-size edit in the same mtime tick changes it, and an
 * unchanged copy of the same export always hashes the same.
 */
export const readWebBuild = async (
  directory: string,
): Promise<HashedWebBuild | { readonly problem: WebBuildProblem | "empty" }> => {
  const walked = await walkBuild(directory);
  if ("problem" in walked) return walked;
  if (walked.files.length === 0) return { problem: "empty" };
  const files: WebBuildFile[] = [];
  try {
    for (const file of walked.files) {
      const { sha256, bytes } = await hashFile(file.absolute);
      files.push({ path: file.path, size: bytes, sha256 });
    }
  } catch {
    return { problem: "io" };
  }
  return { buildId: webBuildId(files), directory, files };
};

/** Why a Web build folder is not one build, in the words the export's refusal uses. */
export const webBuildProblemText = (problem: WebBuildProblem | "empty", project: string): string =>
  problem === "entry-limit"
    ? sourceLimitDetail(project)
    : problem === "symlink"
      ? "The exported web build contains a symbolic link, which Play never serves."
      : problem === "empty"
        ? "The export wrote no web build files."
        : "The exported web build directory could not be read back from disk.";

/**
 * The stat identity of every file in a build folder, without reading a byte:
 * equal identities mean the bytes hashed earlier are still the ones there (the
 * way git's index skips unchanged files). Null when the folder is not one
 * build (a link, too many files, unreadable).
 */
export const webBuildStatIdentity = async (directory: string): Promise<string | null> => {
  const walked = await walkBuild(directory);
  return "problem" in walked
    ? null
    : walked.files.map((file) => `${file.path}\0${file.identity}`).join("\n");
};

const hashWebBuildDirectory = async (directory: string): Promise<HashedWebBuild | null> => {
  const read = await readWebBuild(directory);
  return "problem" in read ? null : read;
};

/** The same identity, for a game-relative build directory. */
export const hashWebBuild = async (
  root: string,
  directory: string,
): Promise<HashedWebBuild | null> => {
  const hashed = await hashWebBuildDirectory(NodePath.join(root, directory));
  return hashed === null ? null : { ...hashed, directory };
};
