import * as HostProcess from "@kurambit/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeStreamPromises from "node:stream/promises";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  GameOperationError,
  type GameToolSource,
  type GameAddon,
  type GameToolStatus,
  type GameToolchainStatus,
} from "@kurambit/contracts";
import * as ServerSettings from "../serverSettings.ts";
import { commandDetail } from "./commandDetail.ts";
import * as GameProcesses from "./GameProcesses.ts";
import { UV_BUILDS, UV_VERSION, plumbingHost, type PlumbingBuild } from "./plumbingBuilds.ts";
import { downloadPinned } from "./assetLibraryFiles.ts";
import { fileSha256 } from "./fileHash.ts";
import { openZipArchive } from "../zipArchive.ts";

const DOWNLOADS = {
  blender: "https://www.blender.org/download/",
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
} as const;
const FFMPEG_DOWNLOAD = "https://ffmpeg.org/download.html";
const NAMES = { blender: "Blender", uv: "uv" } as const;
const REQUIRED = {
  blender: "Blender 4.2 or later",
  uv: "uv 0.7 or later",
} as const;
/** One entry of the add-ons list, as Kurambit fetches and installs it. */
export interface BlenderAddon extends Omit<GameAddon, "asksFirst"> {
  /** The extension's own id on its platform: `user_default.<extension>` once installed. */
  readonly extension: string;
  readonly download: string;
  readonly sha256: string;
  /** An environment variable naming a copy of the same pinned zip placed by hand. */
  readonly env: string;
}
/**
 * The add-ons list: tools that make something, each fetched from its source at a pinned version,
 * verified against its SHA-256, kept in Kurambit's own folder and installed by each live Blender
 * into its isolated user folder, never the person's own Blender config. GPL code is fetched,
 * never bundled. A pack of finished assets does not belong here: those are the asset library's.
 */
export const BLENDER_ADDONS: ReadonlyArray<BlenderAddon> = [
  {
    id: "mpfb",
    extension: "mpfb",
    name: "MPFB2",
    makes: "Human bodies",
    purpose: "Makes human bodies for characters.",
    source: "extensions.blender.org",
    official: true,
    licence: "GPL-3.0 code; the bodies it makes are CC0",
    version: "2.0.18",
    download:
      "https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip",
    sha256: "c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad",
    bytes: 45_956_992,
    without: "Characters can still use library bodies.",
    env: "KURAMBIT_MPFB",
  },
];
/**
 * Past this an add-on is a download worth a yes: the official extensions a route could need are
 * under 4 MB (Sapling 36 KB, Extra Mesh Objects 133 KB, Archimesh 323 KB, Modular Tree 3.8 MB),
 * MPFB2 is 46 MB.
 */
const ADDON_ASK_BYTES = 8_000_000;
/** The person is asked first for a large download, or for anything not from Blender's own platform. */
export const addonAsksFirst = (addon: Pick<BlenderAddon, "official" | "bytes">): boolean =>
  !addon.official || addon.bytes > ADDON_ASK_BYTES;
const megabytes = (bytes: number): string =>
  bytes >= 1_000_000
    ? `${Math.round(bytes / 1_000_000)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;
/** An add-on as a sentence: what it is, its licence, where it comes from and how big it is. */
export const addonAbout = (addon: BlenderAddon): string =>
  `${addon.name} ${addon.version}: ${addon.purpose.replace(/\.$/, "").toLowerCase()}. ${addon.licence}; downloaded from ${addon.source} into Kurambit's own Blender folder (${megabytes(addon.bytes)}).`;
/** The list's entry as clients and agents read it. */
const addonEntry = (addon: BlenderAddon): GameAddon => ({
  id: addon.id,
  name: addon.name,
  makes: addon.makes,
  purpose: addon.purpose,
  source: addon.source,
  official: addon.official,
  licence: addon.licence,
  version: addon.version,
  bytes: addon.bytes,
  asksFirst: addonAsksFirst(addon),
  without: addon.without,
});
/**
 * Whether `path` is a regular file with exactly the pinned bytes. Kept per file identity, so a
 * status poll never rehashes 46 MB; a file changed or replaced on disk is hashed again.
 */
const verified = new Map<string, { readonly identity: string; readonly ok: boolean }>();
export const verifiedFile = async (
  path: string,
  pin: { readonly sha256: string; readonly bytes: number },
): Promise<boolean> => {
  const stat = await NodeFSP.lstat(path).catch(() => null);
  if (stat === null || !stat.isFile() || stat.size !== pin.bytes) return false;
  const identity = `${stat.ino}:${stat.mtimeMs}:${stat.size}:${pin.sha256}`;
  const known = verified.get(path);
  if (known?.identity === identity) return known.ok;
  const ok = (await fileSha256(path).catch(() => null))?.sha256 === pin.sha256;
  verified.set(path, { identity, ok });
  return ok;
};
/** Kurambit's own data folder for helpers it fetches, and where earlier versions installed tools. */
export const toolsDirectory = () =>
  NodePath.join(
    process.env.XDG_DATA_HOME || NodePath.join(NodeOS.homedir(), ".local/share"),
    "kurambit/tools",
  );
/**
 * The one uv cache and Python folder every uv child Kurambit runs shares, so a
 * pinned package downloads once per machine, never once per game, and never
 * into the person's own uv cache.
 */
export const uvCacheEnv = (): Record<string, string> => ({
  UV_CACHE_DIR: NodePath.join(toolsDirectory(), "uv-cache"),
  UV_PYTHON_INSTALL_DIR: NodePath.join(toolsDirectory(), "uv-python"),
});
type BinaryTool = "blender" | "uv";
type Platform = "linux" | "darwin" | "win32";
const hostPlatform = (platform: NodeJS.Platform): Platform =>
  platform === "darwin" || platform === "win32" ? platform : "linux";
const validToolVersion = (tool: BinaryTool, version: string) => {
  const match = version.match(/(?:Blender\s+)?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]),
    minor = Number(match[2]);
  if (tool === "uv") return major === 0 && minor >= 7;
  return major > 4 || (major === 4 && minor >= 2);
};
/**
 * Copies in Kurambit's tools folder, newest first: the Blender 5.3 the kit is made for, then the
 * 4.5 earlier Kurambit versions installed before they stopped installing tools.
 */
const KURAMBIT_INSTALLS = {
  blender: ["blender-5.3.0/blender", "blender-4.5.14/blender"],
  uv: [`uv-${UV_VERSION}/uv`],
} as const;
const kurambitInstalls = (tool: BinaryTool, platform: Platform): ReadonlyArray<string> =>
  // Only uv is still fetched; its Windows build is uv.exe.
  tool === "uv" && platform === "win32"
    ? KURAMBIT_INSTALLS.uv.map((path) => `${path}.exe`)
    : KURAMBIT_INSTALLS[tool];
const ENV_OVERRIDES = {
  blender: "KURAMBIT_BLENDER",
  uv: "KURAMBIT_UV",
} as const;
export interface ToolCandidate {
  readonly path: string;
  readonly source: GameToolSource;
}
/**
 * Detection order, as for providers: the Settings path, the env override,
 * a copy in Kurambit's tools folder (newest first), then PATH. An explicit path is the
 * only candidate, so a wrong override is reported instead of skipped.
 */
const toolCandidates = (
  tool: BinaryTool,
  explicit: string,
  environment: string | undefined,
  directory: string,
  searchPath: string,
  platform: Platform = "linux",
): ReadonlyArray<ToolCandidate> => {
  if (explicit.trim()) return [{ path: NodePath.resolve(explicit.trim()), source: "settings" }];
  if (environment?.trim()) return [{ path: NodePath.resolve(environment.trim()), source: "env" }];
  const names = [platform === "win32" ? `${tool}.exe` : tool];
  return [
    ...kurambitInstalls(tool, platform).map((path): ToolCandidate => ({
      path: NodePath.join(directory, path),
      source: "kurambit",
    })),
    ...searchPath
      .split(NodePath.delimiter)
      .filter(Boolean)
      .flatMap((entry) =>
        names.map((name): ToolCandidate => ({ path: NodePath.join(entry, name), source: "path" })),
      ),
  ];
};
const describeCandidates = (tool: BinaryTool) =>
  `the path in Settings > Game tools, ${ENV_OVERRIDES[tool]}, a copy in Kurambit's tools folder, then PATH (${tool})`;
export interface ResolvedTool {
  readonly path: string;
  readonly version: string;
  readonly source: GameToolSource;
}
type Probe =
  | { readonly kind: "missing" }
  | {
      readonly kind: "broken" | "wrong-version";
      readonly path: string;
      readonly source: GameToolSource;
      readonly version: string;
      readonly detail: string;
    }
  | ({ readonly kind: "ok" } & ResolvedTool);
export class GameToolchain extends Context.Service<
  GameToolchain,
  {
    /** A detected Blender or uv, or why it cannot be used, with its download link. */
    readonly executable: (tool: BinaryTool) => Effect.Effect<ResolvedTool, GameOperationError>;
    /** uv for the live Blender view: detected, else fetched once into Kurambit's tools folder. */
    readonly uv: Effect.Effect<string, GameOperationError>;
    /** Grows each time Kurambit fetches a tool, so a cached status of the toolchain knows it moved. */
    readonly revision: () => number;
    readonly status: () => Effect.Effect<GameToolchainStatus>;
    /** An add-on of the list, fetched into Kurambit's own folder or taken out of it; never the person's Blender config. */
    readonly install: (id: string) => Effect.Effect<GameToolchainStatus, GameOperationError>;
    readonly remove: (id: string) => Effect.Effect<GameToolchainStatus, GameOperationError>;
    /** The list's entry, its verified zip (null while it is not installed) and whether the person removed it, or null for an id not on the list. */
    readonly addon: (id: string) => Effect.Effect<{
      readonly entry: BlenderAddon;
      readonly zip: string | null;
      readonly removed: boolean;
    } | null>;
    /** Every entry of the list with its verified zip, for a live Blender to install or take out. */
    readonly addons: Effect.Effect<
      ReadonlyArray<{ readonly entry: BlenderAddon; readonly zip: string | null }>
    >;
  }
>()("kurambit/game/GameToolchain") {}
const isGameOperationError = Schema.is(GameOperationError);
const make = Effect.gen(function* () {
  const processes = yield* GameProcesses.GameProcesses;
  const settings = yield* ServerSettings.ServerSettingsService;
  const platform = hostPlatform(yield* HostProcess.Platform);
  const plumbing = plumbingHost(platform, yield* HostProcess.Architecture);
  const directory = toolsDirectory();
  const logRoot = NodePath.join(directory, ".operations");
  const fetchLock = Semaphore.makeUnsafe(1);
  let revision = 0;
  // A probe that answered is kept while the binary is the same file; one that
  // failed or timed out (a cold start under memory pressure) only briefly, so
  // a passing hiccup never reads as a broken tool for the server's life.
  const probes = new Map<
    string,
    { mtime: number; size: number; exitCode: number; output: string; until: number }
  >();
  const readSettings = settings.getSettings.pipe(
    Effect.mapError(
      (cause) =>
        new GameOperationError({ operation: "settings", path: directory, reason: "io", cause }),
    ),
  );
  const versionOf = (tool: BinaryTool, output: string) =>
    output.match(tool === "uv" ? /\d+\.\d+\.\d+/ : /Blender\s+\d+\.\d+\.\d+/)?.[0] ?? "unknown";
  /** `--version`, cached per file identity so a status poll never re-runs a large binary. */
  const probeVersion = (tool: BinaryTool, path: string) =>
    Effect.gen(function* () {
      const stat = yield* Effect.promise(() => NodeFSP.stat(path));
      const now = yield* Clock.currentTimeMillis;
      const cached = probes.get(path);
      if (
        cached &&
        cached.mtime === stat.mtimeMs &&
        cached.size === stat.size &&
        now < cached.until
      )
        return cached;
      const result = yield* processes
        .run({
          root: logRoot,
          executable: path,
          args: ["--version"],
          operation: `${tool}-version`,
          timeoutMs: 20_000,
          log: false,
        })
        .pipe(
          Effect.map((run) => ({
            exitCode: run.timedOut ? -1 : run.exitCode,
            output: `${run.stdout}${run.stderr}`,
            detail: commandDetail(run),
          })),
          Effect.orElseSucceed(() => ({ exitCode: -1, output: "", detail: "" })),
        );
      const entry = {
        mtime: stat.mtimeMs,
        size: stat.size,
        exitCode: result.exitCode,
        output: result.exitCode === 0 ? result.output : result.detail || result.output,
        until: result.exitCode === 0 ? Number.POSITIVE_INFINITY : now + 60_000,
      };
      probes.set(path, entry);
      return entry;
    });
  /** The first usable candidate; else the first one found, with what is wrong with it. */
  const probe = (tool: BinaryTool): Effect.Effect<Probe, GameOperationError> =>
    Effect.gen(function* () {
      const config = yield* readSettings;
      const candidates = toolCandidates(
        tool,
        tool === "blender" ? config.gameBlenderPath : "",
        process.env[ENV_OVERRIDES[tool]],
        directory,
        process.env.PATH ?? "",
        platform,
      );
      let firstProblem: Probe | null = null;
      for (const candidate of candidates) {
        if (!(yield* Effect.promise(() => isExecutable(candidate.path)))) continue;
        const result = yield* probeVersion(tool, candidate.path);
        const version = versionOf(tool, result.output);
        if (result.exitCode === 0 && validToolVersion(tool, version))
          return {
            kind: "ok",
            path: candidate.path,
            source: candidate.source,
            version,
          } satisfies Probe;
        firstProblem ??= {
          kind: result.exitCode === 0 ? "wrong-version" : "broken",
          path: candidate.path,
          source: candidate.source,
          version,
          detail: result.output.slice(0, 2000),
        };
      }
      if (firstProblem !== null) return firstProblem;
      // A missing explicit path is its own problem: the user pointed somewhere wrong.
      const explicit = candidates[0];
      return explicit !== undefined && (explicit.source === "settings" || explicit.source === "env")
        ? {
            kind: "broken",
            path: explicit.path,
            source: explicit.source,
            version: "unknown",
            detail: `${explicit.path} is not an executable file.`,
          }
        : { kind: "missing" };
    });
  const probeMessage = (tool: BinaryTool, found: Exclude<Probe, { kind: "ok" }>) =>
    found.kind === "missing"
      ? `${NAMES[tool]} was not found. Kurambit looks at ${describeCandidates(tool)}. Get ${REQUIRED[tool]} from ${DOWNLOADS[tool]}.`
      : found.kind === "wrong-version"
        ? `${found.path} is ${NAMES[tool]} ${found.version}; Kurambit needs ${REQUIRED[tool]}. Get it from ${DOWNLOADS[tool]}, or point Settings > Game tools at a supported copy.`
        : `${found.path} did not run as ${NAMES[tool]} (\`--version\` failed). Fix or reinstall it from ${DOWNLOADS[tool]}, or point Settings > Game tools at a working copy.${found.detail ? `\n${found.detail}` : ""}`;
  const executable: GameToolchain["Service"]["executable"] = Effect.fn("GameToolchain.executable")(
    function* (tool) {
      const found = yield* probe(tool);
      if (found.kind === "ok") return found;
      return yield* new GameOperationError({
        operation: NAMES[tool],
        path: found.kind === "missing" ? tool : found.path,
        reason:
          found.kind === "missing"
            ? "tool-missing"
            : found.kind === "wrong-version"
              ? "wrong-version"
              : "command-failed",
        detail: probeMessage(tool, found).slice(0, 4096),
      });
    },
  );
  // uv is plumbing: unless the user named one, a missing, old or broken uv
  // on PATH is replaced by the pinned fetch, which the probe then finds first.
  const fetchesUv = (found: Probe) =>
    plumbing !== null &&
    found.kind !== "ok" &&
    (found.kind === "missing" || (found.source !== "settings" && found.source !== "env"));
  const binaryStatus = (tool: BinaryTool) =>
    Effect.gen(function* () {
      const found = yield* probe(tool);
      if (found.kind !== "ok")
        return {
          tool,
          installed: found.kind !== "missing",
          path: found.kind === "missing" ? null : found.path,
          version: found.kind === "missing" || found.version === "unknown" ? null : found.version,
          source: found.kind === "missing" ? null : found.source,
          ...(tool === "uv" && fetchesUv(found)
            ? {
                status: "ready" as const,
                message: `Kurambit fetches uv ${UV_VERSION} the first time the live Blender view needs it.`,
                downloadUrl: null,
              }
            : {
                status: "error" as const,
                message: probeMessage(tool, found),
                downloadUrl: DOWNLOADS[tool],
              }),
        } satisfies GameToolStatus;
      return {
        tool,
        installed: true,
        path: found.path,
        version: found.version,
        source: found.source,
        status: "ready",
        message: "Ready.",
        downloadUrl: null,
      } satisfies GameToolStatus;
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          tool,
          installed: false,
          path: null,
          version: null,
          source: null,
          status: "error",
          message: error.message,
          downloadUrl: DOWNLOADS[tool],
        } satisfies GameToolStatus),
      ),
    );
  /**
   * The one fetch path for plumbing: download the vendor's build for this
   * OS and CPU, refuse it unless its SHA-256 is the one the vendor
   * published, then unpack it. Returns where its executables are.
   */
  const fetchPlumbing = (operation: string, build: PlumbingBuild, stage: string) =>
    Effect.gen(function* () {
      const name = NodePath.basename(new URL(build.url).pathname);
      const file = yield* Effect.tryPromise({
        try: async (signal) => {
          const downloaded = NodePath.join(stage, name);
          await downloadPinned({ download: build.url, bytes: build.bytes }, downloaded, signal);
          if ((await fileSha256(downloaded)).sha256 !== build.sha256)
            throw new GameOperationError({ operation, path: build.url, reason: "checksum" });
          return downloaded;
        },
        catch: (cause) =>
          isGameOperationError(cause)
            ? cause
            : new GameOperationError({ operation, path: build.url, reason: "download", cause }),
      });
      if (build.archive === null) return file;
      const unpacked = NodePath.join(stage, "unpacked");
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(unpacked, { recursive: true }),
        catch: (cause) =>
          new GameOperationError({ operation, path: unpacked, reason: "io", cause }),
      });
      // A zip (uv's Windows builds) is read by yauzl: the tar on PATH may be
      // Git for Windows' GNU tar, which refuses zips and reads C:\ as a host.
      if (file.endsWith(".zip")) {
        yield* unzipFlat(operation, file, unpacked);
        return NodePath.join(unpacked, build.dir);
      }
      const extract = yield* processes.run({
        root: logRoot,
        executable: "tar",
        args: ["-xf", file, "-C", unpacked],
        operation: `${operation}-extract`,
        timeoutMs: 120_000,
        log: false,
      });
      if (extract.exitCode !== 0)
        return yield* new GameOperationError({
          operation,
          path: file,
          reason: "tool-failed",
          detail: commandDetail(extract),
        });
      return NodePath.join(unpacked, build.dir);
    });
  /**
   * Unpacks a verified zip whose files sit at its root (uv's Windows builds):
   * plain file names only, each written exclusively. Anything else in it is
   * refused, since the archive's bytes were pinned and should hold nothing else.
   */
  const unzipFlat = (operation: string, file: string, unpacked: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const unsafe = (detail: string, cause?: unknown) =>
          new GameOperationError({
            operation,
            path: file,
            reason: "unsafe-archive",
            detail,
            cause,
          });
        const archive = yield* openZipArchive(file, unsafe);
        for (;;) {
          const entry = yield* archive.next;
          if (entry === null) return;
          const name = entry.fileName;
          if (!/^[\w.-]+$/.test(name) || name === "." || name === "..")
            return yield* unsafe(`The archive holds an unexpected entry (${name.slice(0, 120)}).`);
          const readable = yield* archive.streamEntry(entry);
          yield* Effect.tryPromise({
            try: () =>
              NodeStreamPromises.pipeline(
                readable,
                NodeFS.createWriteStream(NodePath.join(unpacked, name), {
                  flags: "wx",
                  mode: 0o755,
                }),
              ),
            catch: (cause) =>
              new GameOperationError({ operation, path: unpacked, reason: "io", cause }),
          });
        }
      }),
    );
  const exe = (name: string) => (platform === "win32" ? `${name}.exe` : name);
  /**
   * Puts a verified uv folder at `target`. A broken earlier one there is moved
   * aside first (a rename onto a non-empty folder always fails), and a good
   * one another server placed meanwhile is accepted: every server on the
   * machine shares the tools folder, and no lock spans them.
   */
  const placeUv = (extracted: string, target: string) =>
    Effect.gen(function* () {
      const placedGood = Effect.flatMap(
        Effect.promise(() => isExecutable(NodePath.join(target, exe("uv")))),
        (present) =>
          present
            ? probeVersion("uv", NodePath.join(target, exe("uv"))).pipe(
                Effect.map((probed) => probed.exitCode === 0 && probed.output.includes(UV_VERSION)),
                Effect.orElseSucceed(() => false),
              )
            : Effect.succeed(false),
      );
      if (yield* placedGood) return;
      const aside = `${target}.old-${NodeCrypto.randomUUID()}`;
      yield* Effect.promise(() => NodeFSP.rename(target, aside).catch(() => undefined));
      const placed = yield* Effect.tryPromise({
        try: () => NodeFSP.rename(extracted, target),
        catch: (cause) =>
          new GameOperationError({ operation: "fetch-uv", path: target, reason: "io", cause }),
      }).pipe(
        Effect.catchTags({
          // Another server placed it between the move and the rename.
          GameOperationError: (error) =>
            Effect.flatMap(placedGood, (good) => (good ? Effect.void : Effect.fail(error))),
        }),
        Effect.exit,
      );
      yield* Effect.promise(() => NodeFSP.rm(aside, { recursive: true, force: true }));
      if (placed._tag === "Failure") return yield* Effect.failCause(placed.cause);
    });
  const fetchUv = Effect.gen(function* () {
    const target = NodePath.join(directory, `uv-${UV_VERSION}`);
    if (plumbing === null)
      return yield* new GameOperationError({
        operation: "fetch-uv",
        path: target,
        reason: "unsupported-platform",
        detail: "Kurambit has no uv build to fetch for this OS and CPU; install uv yourself.",
      });
    const stage = yield* makeStage("fetch-uv");
    return yield* Effect.gen(function* () {
      const extracted = yield* fetchPlumbing("fetch-uv", UV_BUILDS[plumbing], stage);
      const check = yield* processes.run({
        root: logRoot,
        executable: NodePath.join(extracted, exe("uv")),
        args: ["--version"],
        operation: "fetch-uv-check",
        timeoutMs: 20_000,
        log: false,
      });
      if (check.exitCode !== 0 || !(check.stdout + check.stderr).includes(UV_VERSION))
        return yield* new GameOperationError({
          operation: "fetch-uv",
          path: extracted,
          reason: "wrong-version",
          detail: `uv reported ${(check.stdout + check.stderr).slice(0, 200)}; expected ${UV_VERSION}.`,
        });
      yield* placeUv(extracted, target);
    }).pipe(Effect.ensuring(dropStage(stage)));
  });
  const uv: GameToolchain["Service"]["uv"] = fetchLock.withPermits(1)(
    Effect.gen(function* () {
      const found = yield* probe("uv");
      if (found.kind === "ok") return found.path;
      if (!fetchesUv(found)) return (yield* executable("uv")).path;
      yield* fetchUv;
      revision += 1;
      return (yield* executable("uv")).path;
    }),
  );
  const addonFile = (addon: BlenderAddon) =>
    NodePath.join(directory, "blender-extensions", `${addon.id}-${addon.version}.zip`);
  // The person's Remove is remembered (any version), so an agent asks before adding it back.
  const removedMark = (addon: BlenderAddon) =>
    NodePath.join(directory, "blender-extensions", `${addon.id}.removed`);
  const removedByPerson = (addon: BlenderAddon) =>
    Effect.promise(() =>
      NodeFSP.access(removedMark(addon)).then(
        () => true,
        () => false,
      ),
    );
  // The entry's env variable names a copy of the same pinned zip placed by hand (a shared tools
  // folder, a machine with no network), as KURAMBIT_BLENDER names a Blender; only the pin's bytes count.
  const addonFound = (addon: BlenderAddon) =>
    Effect.promise(async () => {
      const override = process.env[addon.env]?.trim();
      if (override && (await verifiedFile(override, addon)))
        return { path: override, source: "env" as const };
      return (await verifiedFile(addonFile(addon), addon))
        ? { path: addonFile(addon), source: "kurambit" as const }
        : null;
    });
  const addonStatus = (addon: BlenderAddon) =>
    Effect.gen(function* () {
      const about = addonAbout(addon);
      const base = {
        tool: "addon" as const,
        addon: addonEntry(addon),
        path: null,
        version: null,
        source: null,
        // Install is the way in: a link would invite installing it into the person's own Blender, which Kurambit never reads.
        downloadUrl: null,
      };
      // A Blender extension needs a usable Blender with the extension platform (4.2+).
      const blender = yield* probe("blender").pipe(Effect.orElseSucceed(() => null));
      if (blender?.kind !== "ok")
        return {
          ...base,
          installed: false,
          status: "error",
          message: `${about} It needs Blender 4.2 or later, which Kurambit cannot use yet: see the Blender row.`,
        } satisfies GameToolStatus;
      const found = yield* addonFound(addon);
      if (found === null)
        return {
          ...base,
          installed: false,
          status: "warning",
          message: `Not installed. ${about} ${addon.without}`,
        } satisfies GameToolStatus;
      return {
        ...base,
        installed: true,
        path: found.path,
        version: addon.version,
        source: found.source,
        status: "ready",
        message: `${about} A live Blender already open picks a change up when it reopens.`,
        downloadUrl: null,
      } satisfies GameToolStatus;
    });
  // Found exactly as a bot run finds it (GameBot): KURAMBIT_FFMPEG, then PATH. Only the
  // person installs it; without it no play is measured, so the row says what is lost.
  const ffmpegStatus = Effect.promise(async (): Promise<GameToolStatus> => {
    const override = process.env.KURAMBIT_FFMPEG;
    const path = await GameProcesses.findExecutable("ffmpeg", {
      pathEnv: process.env.PATH ?? "",
      override,
    });
    const base = { tool: "ffmpeg" as const, version: null };
    return path !== null
      ? {
          ...base,
          installed: true,
          path,
          source: path === override?.trim() ? "env" : "path",
          status: "ready",
          message: "Records each bot play, which a build's play facts are read from.",
          downloadUrl: null,
        }
      : {
          ...base,
          installed: false,
          path: null,
          source: null,
          status: "error",
          message: `ffmpeg was not found (Kurambit looks at KURAMBIT_FFMPEG, then PATH). Without it a build is only checked for booting: its plays are not measured, and Keep going cannot set up a play bot. Install it with your package manager (apt install ffmpeg, dnf install ffmpeg, brew install ffmpeg, winget install ffmpeg), or get it from ${FFMPEG_DOWNLOAD}, then press Check again.`,
          downloadUrl: FFMPEG_DOWNLOAD,
        };
  });
  // An engine that needs a tool of its own adds its detection here and to GameToolName.
  const status: GameToolchain["Service"]["status"] = () =>
    Effect.all([
      binaryStatus("blender"),
      binaryStatus("uv"),
      ...BLENDER_ADDONS.map(addonStatus),
      ffmpegStatus,
    ]).pipe(Effect.map((tools) => ({ tools })));
  const listed = (id: string, operation: string) => {
    const addon = BLENDER_ADDONS.find((entry) => entry.id === id);
    return addon === undefined
      ? Effect.fail(
          new GameOperationError({
            operation,
            path: id,
            reason: "invalid-input",
            detail: `${id} is not on the add-ons list (${BLENDER_ADDONS.map((entry) => entry.id).join(", ")}).`,
          }),
        )
      : Effect.succeed(addon);
  };
  /** Fetched into a private stage and verified against its pin before it is moved into place. */
  const installAddon = (addon: BlenderAddon) =>
    fetchLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* addonFound(addon)) !== null) return;
        const operation = `install-${addon.id}`;
        const file = addonFile(addon);
        const stage = yield* makeStage(operation);
        yield* Effect.gen(function* () {
          const staged = NodePath.join(stage, NodePath.basename(file));
          yield* Effect.tryPromise({
            try: (signal) => downloadPinned(addon, staged, signal),
            catch: (cause) =>
              new GameOperationError({
                operation,
                path: addon.download,
                reason: "download",
                detail: `Could not download ${addon.name} ${addon.version} from ${addon.source}.`,
                cause,
              }),
          });
          if (!(yield* Effect.promise(() => verifiedFile(staged, addon))))
            return yield* new GameOperationError({
              operation,
              path: addon.download,
              reason: "checksum",
              detail: `The ${addon.name} ${addon.version} download does not match its pinned SHA-256, so it was not installed.`,
            });
          yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
              await NodeFSP.rename(staged, file);
              await NodeFSP.rm(removedMark(addon), { force: true });
            },
            catch: (cause) =>
              new GameOperationError({ operation, path: file, reason: "io", cause }),
          });
        }).pipe(Effect.ensuring(dropStage(stage)));
      }),
    );
  const removeAddon = (addon: BlenderAddon) =>
    fetchLock.withPermits(1)(
      Effect.tryPromise({
        try: async () => {
          await NodeFSP.rm(addonFile(addon), { force: true });
          await NodeFSP.mkdir(NodePath.dirname(removedMark(addon)), { recursive: true });
          await NodeFSP.writeFile(removedMark(addon), "");
        },
        catch: (cause) =>
          new GameOperationError({
            operation: `remove-${addon.id}`,
            path: addonFile(addon),
            reason: "io",
            cause,
          }),
      }),
    );
  const makeStage = (operation: string) =>
    Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(directory, { recursive: true });
        return NodeFSP.mkdtemp(NodePath.join(directory, ".fetch-"));
      },
      catch: (cause) => new GameOperationError({ operation, path: directory, reason: "io", cause }),
    });
  const dropStage = (stage: string) =>
    Effect.promise(() => NodeFSP.rm(stage, { recursive: true, force: true }));
  return GameToolchain.of({
    executable,
    uv,
    status,
    revision: () => revision,
    // A change moves the revision, so the cached status the Settings row reads is fresh at once.
    install: (id) =>
      listed(id, "install-addon").pipe(
        Effect.flatMap(installAddon),
        Effect.ensuring(Effect.sync(() => (revision += 1))),
        Effect.andThen(status()),
      ),
    remove: (id) =>
      listed(id, "remove-addon").pipe(
        Effect.flatMap(removeAddon),
        Effect.ensuring(Effect.sync(() => (revision += 1))),
        Effect.andThen(status()),
      ),
    addon: (id) => {
      const entry = BLENDER_ADDONS.find((each) => each.id === id);
      return entry === undefined
        ? Effect.succeed(null)
        : Effect.all({ found: addonFound(entry), removed: removedByPerson(entry) }).pipe(
            Effect.map(({ found, removed }) => ({ entry, zip: found?.path ?? null, removed })),
          );
    },
    addons: Effect.forEach(BLENDER_ADDONS, (entry) =>
      Effect.map(addonFound(entry), (found) => ({ entry, zip: found?.path ?? null })),
    ),
  });
});
const isExecutable = async (file: string) => {
  try {
    await NodeFSP.access(file, NodeFSP.constants.X_OK);
    return (await NodeFSP.stat(file)).isFile();
  } catch {
    return false;
  }
};
export const layer = Layer.effect(GameToolchain, make);
