// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the game build path on the native filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { GameQualificationRead } from "@t3tools/contracts";

export const webBuildIndex = (root: string) => NodePath.join(root, "builds/web/index.html");

/** One served web build file, identified the way the source snapshot identifies sources. */
export interface WebArtifactFile {
  /** Game-relative path, with forward slashes. */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** A served build is a handful of files; a directory past this is not one we can vouch for. */
const MAX_WEB_ARTIFACT_ENTRIES = 1_000;

/** The files under builds/web, or null when the directory cannot be read. */
export const describeWebArtifacts = async (
  root: string,
): Promise<readonly WebArtifactFile[] | null> => {
  const buildRoot = NodePath.join(root, "builds/web");
  const files: WebArtifactFile[] = [];
  const stack = [buildRoot];
  let visited = 0;
  try {
    while (stack.length > 0) {
      const directory = stack.pop()!;
      for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        visited += 1;
        if (visited > MAX_WEB_ARTIFACT_ENTRIES) return null;
        const path = NodePath.join(directory, entry.name);
        // A linked build file can be replaced without changing what the record
        // names, so it is not an artifact this server can vouch for.
        if (entry.isSymbolicLink()) return null;
        if (entry.isDirectory()) {
          stack.push(path);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await NodeFSP.stat(path);
        files.push({
          path: NodePath.relative(root, path).split(NodePath.sep).join("/"),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  } catch {
    return null;
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

const sameArtifacts = (
  recorded: readonly WebArtifactFile[],
  current: readonly WebArtifactFile[],
): boolean =>
  recorded.length === current.length &&
  recorded.every((file, index) => {
    const other = current[index]!;
    return file.path === other.path && file.size === other.size && file.mtimeMs === other.mtimeMs;
  });

/**
 * Whether the artifact the export record names is still the artifact on disk.
 * A record without a descriptor, a missing file, a replaced file or an extra
 * file all read as stale: qualification must never serve files it did not see
 * exported.
 */
export const webArtifactsMatch = async (
  root: string,
  recorded: readonly WebArtifactFile[] | undefined,
): Promise<boolean> => {
  if (recorded === undefined) return false;
  const current = await describeWebArtifacts(root);
  return current !== null && sameArtifacts(recorded, current);
};

/**
 * The one identity of the exact files the preview serves, from the export
 * record's task-30a artifact descriptor. A rebuild produces fresh mtimes and
 * therefore a fresh identity; a source edit (which touches nothing under
 * builds/), a mid-flight export and a failed rebuild all keep the identity, so
 * the running game only resets when its served bytes really were replaced.
 * Derived, not stored: rewriting the same artifact keeps the same identity.
 */
export const webArtifactIdentity = (
  artifacts: readonly WebArtifactFile[] | undefined,
): string | null => {
  if (artifacts === undefined || artifacts.length === 0) return null;
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(artifacts))
    .digest("hex")
    .slice(0, 24);
};

/**
 * Whether the current web build may be served or played. The export stage is
 * only passed when its source snapshot and artifact descriptor still match, so
 * a missing, stale, failed or unknown export always forces a rebuild.
 */
export const isWebBuildFresh = (qualification: GameQualificationRead): boolean =>
  qualification.stages.some((stage) => stage.stage === "export" && stage.status === "passed");
