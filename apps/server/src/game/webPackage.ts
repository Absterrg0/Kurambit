// @effect-diagnostics nodeBuiltinImport:off -- Web packaging streams the selected build files from the native filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
/** The immutable web build Play serves. Written at each Web export. */
export interface GameSelectedBuild {
  readonly buildId: string;
  /** Game-relative directory, e.g. builds/candidates/<hash>. */
  readonly directory: string;
  /** Game-relative entry file inside `directory`. */
  readonly entry: string;
  /** Response headers the artifact needs served, when it needs any. */
  readonly headers?: Record<string, string> | undefined;
}
import { ArchivePublishError, publishArchive } from "./archivePublication.ts";
import {
  StoredZipError,
  throwIfAborted,
  writeStoredZip,
  type StoredZipEntry,
} from "./storedZip.ts";
import { candidateBuildId, hashWebBuild, type WebBuildFile } from "./webBuild.ts";

export const WEB_PACKAGES_DIRECTORY = "builds/web-packages";
export const WEB_PACKAGE_FILE = "game-web.zip";
const BUILD_ID = /^[0-9a-f]{64}$/;

/** A packaged build is addressed by its build id, so an old URL can never name another build. */
export const webPackageArchivePath = (root: string, buildId: string) =>
  NodePath.join(root, WEB_PACKAGES_DIRECTORY, `${buildId}.zip`);

export class WebPackageError extends Error {
  readonly path: string;
  readonly kind: "missing" | "invalid" | "changed" | "io";
  constructor(
    path: string,
    kind: "missing" | "invalid" | "changed" | "io",
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "WebPackageError";
    this.path = path;
    this.kind = kind;
  }
}

export interface WebPackageFile {
  /** Path inside the ZIP, with forward slashes. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface WebPackageResult {
  readonly archivePath: string;
  readonly fileName: string;
  readonly buildId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly files: readonly WebPackageFile[];
  /** The ZIP-root HTML entry a static host serves. */
  readonly entry: string;
  /** The selected artifact's entry, before any root mapping. */
  readonly sourceEntry: string;
  readonly notes: readonly string[];
}

const isNotFound = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const short = (buildId: string) => buildId.slice(0, 12);

const notPackaged = (path: string, detail: string) =>
  new WebPackageError(
    path,
    "changed",
    `${detail} No package was written, and any earlier package was left alone.`,
  );

/**
 * Opens one selected build file for one pass of the archive writer: a
 * regular file, the size the build's hash recorded. Both passes compare its
 * bytes with the recorded SHA-256, so a swap or an edit between them fails.
 */
const openBuildFile = (root: string, directory: string, file: WebBuildFile) => async () => {
  const absolute = NodePath.join(root, directory, file.path);
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      absolute,
      NodeFSP.constants.O_RDONLY | (NodeFSP.constants.O_NOFOLLOW ?? 0),
    );
  } catch (cause) {
    throw notPackaged(
      absolute,
      isNotFound(cause)
        ? `The selected Web build file ${file.path} disappeared while packaging.`
        : `The selected Web build file ${file.path} could not be opened: ${describe(cause)}.`,
    );
  }
  const stat = await handle.stat().catch(async (cause: unknown) => {
    await handle.close().catch(() => undefined);
    throw cause;
  });
  if (!stat.isFile() || stat.size !== file.size) {
    await handle.close().catch(() => undefined);
    throw notPackaged(
      absolute,
      `The selected Web build file ${file.path} changed while packaging.`,
    );
  }
  return {
    read: async (offset: number, length: number) => {
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(buffer, read, length - read, offset + read);
        if (result.bytesRead === 0)
          throw notPackaged(
            file.path,
            `The selected Web build file ${file.path} changed while packaging.`,
          );
        read += result.bytesRead;
      }
      return buffer;
    },
    close: () => handle.close(),
  };
};

const safeRelative = (path: string) =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/**
 * Packages one already selected immutable build. It never exports, never
 * reads builds/web, and never chooses a build of its own: a missing record or
 * bytes that no longer hash to the selected id is an error, not a rebuild.
 */
export const packageWebRelease = async (input: {
  readonly root: string;
  readonly selected: GameSelectedBuild;
  readonly signal?: AbortSignal | undefined;
}): Promise<WebPackageResult> => {
  const { selected, root } = input;
  const buildDirectory = NodePath.join(root, selected.directory);
  const archive = webPackageArchivePath(root, selected.buildId);
  if (candidateBuildId(selected.directory) !== selected.buildId || !BUILD_ID.test(selected.buildId))
    throw new WebPackageError(
      selected.directory,
      "invalid",
      "The selected Web build record does not name an immutable build under builds/candidates. Export Web again (Export… in the Stage's More menu) to select a new build.",
    );
  const atPath = await NodeFSP.lstat(buildDirectory).catch((cause) => {
    throw new WebPackageError(
      buildDirectory,
      isNotFound(cause) ? "missing" : "io",
      isNotFound(cause)
        ? `The selected Web build ${short(selected.buildId)} is missing from ${selected.directory}. Export Web again.`
        : `The selected Web build directory could not be read: ${describe(cause)}.`,
      { cause },
    );
  });
  const real = await NodeFSP.realpath(buildDirectory).catch(() => null);
  const rootReal = await NodeFSP.realpath(root).catch(() => null);
  if (
    !atPath.isDirectory() ||
    real === null ||
    rootReal === null ||
    real !== NodePath.join(rootReal, selected.directory)
  )
    throw new WebPackageError(
      buildDirectory,
      "invalid",
      "The selected Web build directory is a link or not a real directory. Packaging only real files inside the game. Export Web again.",
    );
  const hashed = await hashWebBuild(root, selected.directory);
  if (hashed === null)
    throw new WebPackageError(
      buildDirectory,
      "invalid",
      `The selected Web build ${short(selected.buildId)} is empty, has too many files, or contains a symlink. It cannot be served reliably. Export Web again.`,
    );
  if (hashed.buildId !== selected.buildId)
    throw notPackaged(
      buildDirectory,
      `The files in the selected Web build changed after it was selected (recorded ${short(selected.buildId)}, now ${short(hashed.buildId)}). Play cannot serve those bytes as this build either.`,
    );

  const entry = hashed.files.find((file) => file.path === selected.entry);
  if (entry === undefined)
    throw notPackaged(buildDirectory, `The selected Web build has no entry ${selected.entry}.`);
  let archiveEntry = selected.entry;
  const notes: string[] = [];
  if (selected.entry !== "index.html") {
    const atRoot = !selected.entry.includes("/");
    const existing = hashed.files.find((file) => file.path === "index.html");
    if (!atRoot || existing !== undefined)
      throw new WebPackageError(
        buildDirectory,
        "invalid",
        existing !== undefined
          ? `The selected Web build has both the selected entry ${selected.entry} and an index.html. Packaging will not guess which page a static host should serve.`
          : `The selected Web entry ${selected.entry} is not at the build root, so it cannot be published as the static host's index.html without rewriting game content.`,
      );
    archiveEntry = "index.html";
    notes.push(
      `The selected entry ${selected.entry} is stored as index.html at the ZIP root; its bytes and the other resources are unchanged.`,
    );
  }
  if (selected.headers !== undefined && Object.keys(selected.headers).length > 0)
    notes.push(
      `The selected build declares response headers (${Object.entries(selected.headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join(", ")}). A ZIP cannot set HTTP headers, so configure them on the static host.`,
    );

  let staged: string | null = null;
  try {
    const entries: StoredZipEntry[] = [];
    for (const file of hashed.files) {
      if (!safeRelative(file.path))
        throw new WebPackageError(
          file.path,
          "invalid",
          "The selected Web build contains an unsafe relative path.",
        );
      const stat = await NodeFSP.lstat(NodePath.join(buildDirectory, file.path)).catch(() => null);
      if (stat === null || !stat.isFile())
        throw notPackaged(
          file.path,
          `The selected Web build file ${file.path} disappeared while packaging.`,
        );
      entries.push({
        name: file.path === selected.entry ? archiveEntry : file.path,
        path: file.path,
        size: file.size,
        mtimeMs: stat.mtimeMs,
        sha256: file.sha256,
        open: openBuildFile(root, selected.directory, file),
      });
    }
    await NodeFSP.mkdir(NodePath.dirname(archive), { recursive: true });
    staged = NodePath.join(
      NodePath.dirname(archive),
      `.${selected.buildId}.${NodeCrypto.randomUUID()}.partial`,
    );
    const written = await writeStoredZip({
      path: staged,
      entries,
      signal: input.signal,
    });
    throwIfAborted(input.signal);
    const stagedPath = staged;
    const stagedStat = await NodeFSP.stat(stagedPath).catch((cause) => {
      throw new WebPackageError(
        stagedPath,
        "io",
        `The Web package could not be read back before publication: ${describe(cause)}.`,
        { cause },
      );
    });
    if (stagedStat.size !== written.bytes)
      throw new WebPackageError(
        stagedPath,
        "io",
        "The Web package was not written completely. The previous package was kept; export again to retry.",
      );
    throwIfAborted(input.signal);
    let publication: { readonly notes: readonly string[] };
    try {
      publication = await publishArchive({ stagedArchive: stagedPath, archive });
    } catch (cause) {
      if (cause instanceof ArchivePublishError)
        throw new WebPackageError(cause.path, "io", cause.message, { cause });
      throw cause;
    }
    staged = null;
    const archiveStat = await NodeFSP.stat(archive).catch((cause) => {
      throw new WebPackageError(
        archive,
        "io",
        `The Web package was written but could not be read back: ${describe(cause)}.`,
        { cause },
      );
    });
    if (archiveStat.size !== written.bytes)
      throw new WebPackageError(
        archive,
        "io",
        "The published Web package size does not match the bytes written. Export Web again and package it again.",
      );
    notes.push(...publication.notes);
    notes.push(...(await retireOtherPackages(root, selected.buildId)));
    return {
      archivePath: archive,
      fileName: WEB_PACKAGE_FILE,
      buildId: selected.buildId,
      bytes: written.bytes,
      sha256: written.sha256,
      files: written.files.map((file) => ({
        path: file.name,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
      entry: archiveEntry,
      sourceEntry: selected.entry,
      notes,
    };
  } catch (cause) {
    if (cause instanceof StoredZipError)
      throw new WebPackageError(
        cause.path,
        cause.kind,
        cause.kind === "changed"
          ? "The selected Web build changed while it was being packaged. Export Web again and retry; any earlier package was left alone."
          : cause.message,
        { cause },
      );
    if (cause instanceof WebPackageError) throw cause;
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new WebPackageError(
      staged ?? archive,
      "io",
      `The Web package could not be written: ${describe(cause)}. The previous package was left alone if one existed.`,
      { cause },
    );
  } finally {
    if (staged !== null) await NodeFSP.rm(staged, { force: true }).catch(() => undefined);
  }
};

/**
 * One package per selected build. Publishing a new build's package removes the
 * older archives only after the new one is complete, so a failure keeps them.
 */
const retireOtherPackages = async (
  root: string,
  keepBuildId: string,
): Promise<readonly string[]> => {
  const directory = NodePath.join(root, WEB_PACKAGES_DIRECTORY);
  const names = await NodeFSP.readdir(directory).catch(() => [] as string[]);
  const notes: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".zip") || name === `${keepBuildId}.zip`) continue;
    try {
      await NodeFSP.rm(NodePath.join(directory, name), { force: true });
    } catch {
      notes.push(`An older Web package remains at ${NodePath.join(directory, name)}.`);
    }
  }
  return notes;
};
