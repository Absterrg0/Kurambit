import * as HostProcess from "@kurambit/shared/HostProcess";
// @effect-diagnostics globalFetch:off -- Stream checked helper binaries directly to disk with an AbortSignal.
// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeStream from "node:stream";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  GameOperationError,
  UNITY_MIN_VERSION,
  type GameToolSource,
  type GameToolStatus,
  type GameToolchainStatus,
} from "@kurambit/contracts";
import * as ServerSettings from "../serverSettings.ts";
import { commandDetail } from "./commandDetail.ts";
import * as GameProcesses from "./GameProcesses.ts";
import {
  UNITY_CLI_SHA256,
  UNITY_CLI_URL,
  UNITY_CLI_VERSION,
  UNITY_DOWNLOAD_URL,
  legacyUnityEditorRoot,
  parseSecondaryInstallPath,
  parseUnityLicense,
  pickUnityEditor,
  projectEditorVersion,
  unityCliEnv,
  unityCliPaths,
  unityEditorDir,
  unityEditorExecutable,
  unityHubLocations,
  unityLicenseFile,
  unityLicenseMessage,
  unityVersionFromPath,
  unityWindowsSupport,
  type UnityEditorCandidate,
  type UnityLicense,
} from "./unityToolchain.ts";

/** Pinned uv ( astral-sh/uv ), fetched on first use: no checksum file is
 * published, so the fetch verifies by running the extracted binary and
 * matching this version. */
export const UV_VERSION = "0.9.8";
const DOWNLOADS = {
  blender: "https://www.blender.org/download/",
  godot: "https://godotengine.org/download",
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
  unity: UNITY_DOWNLOAD_URL,
} as const;
const NAMES = { blender: "Blender", godot: "Godot", uv: "uv", unity: "Unity" } as const;
const REQUIRED = {
  blender: "Blender 4.2 or later",
  godot: "Godot 4.7.x",
  uv: "uv 0.7 or later",
} as const;
/** Kurambit's own data folder for helpers it fetches, and where earlier versions installed engines. */
export const toolsDirectory = () =>
  NodePath.join(
    process.env.XDG_DATA_HOME || NodePath.join(NodeOS.homedir(), ".local/share"),
    "kurambit/tools",
  );
type BinaryTool = "blender" | "godot" | "uv";
type Platform = "linux" | "darwin" | "win32";
const hostPlatform = (platform: NodeJS.Platform): Platform =>
  platform === "darwin" || platform === "win32" ? platform : "linux";
export const validToolVersion = (tool: BinaryTool, version: string) => {
  const match = version.match(/(?:Blender\s+)?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]),
    minor = Number(match[2]);
  if (tool === "uv") return major === 0 && minor >= 7;
  return tool === "godot" ? major === 4 && minor === 7 : major > 4 || (major === 4 && minor >= 2);
};
/** The copies earlier Kurambit versions installed, before it stopped installing engines. */
const LEGACY_INSTALLS = {
  blender: "blender-4.5.14/blender",
  godot: "godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64",
  uv: `uv-${UV_VERSION}/uv`,
} as const;
const ENV_OVERRIDES = {
  blender: "KURAMBIT_BLENDER",
  godot: "KURAMBIT_GODOT",
  uv: "KURAMBIT_UV",
} as const;
export interface ToolCandidate {
  readonly path: string;
  readonly source: GameToolSource;
}
/**
 * Detection order, as for providers: the Settings path, the env override,
 * a copy an earlier Kurambit installed, then PATH. An explicit path is the
 * only candidate, so a wrong override is reported instead of skipped.
 */
export const toolCandidates = (
  tool: BinaryTool,
  explicit: string,
  environment: string | undefined,
  directory: string,
  searchPath: string,
  platform: Platform = "linux",
): ReadonlyArray<ToolCandidate> => {
  if (explicit.trim()) return [{ path: NodePath.resolve(explicit.trim()), source: "settings" }];
  if (environment?.trim()) return [{ path: NodePath.resolve(environment.trim()), source: "env" }];
  const names = (tool === "godot" ? ["godot", "godot4"] : [tool]).map((name) =>
    platform === "win32" ? `${name}.exe` : name,
  );
  return [
    { path: NodePath.join(directory, LEGACY_INSTALLS[tool]), source: "kurambit" },
    ...searchPath
      .split(NodePath.delimiter)
      .filter(Boolean)
      .flatMap((entry) =>
        names.map((name): ToolCandidate => ({ path: NodePath.join(entry, name), source: "path" })),
      ),
  ];
};
const describeCandidates = (tool: BinaryTool) =>
  `the path in Settings > General > Game tools, ${ENV_OVERRIDES[tool]}, an earlier Kurambit install, then PATH (${tool === "godot" ? "godot, godot4" : tool})`;
export interface ResolvedTool {
  readonly path: string;
  readonly version: string;
  readonly source: GameToolSource;
  /** Godot only: the export templates folder for this exact version. */
  readonly templates: string | null;
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
    /** A detected Blender, Godot or uv, or why it cannot be used, with its download link. */
    readonly executable: (tool: BinaryTool) => Effect.Effect<ResolvedTool, GameOperationError>;
    /** uv for the live Blender view: detected, else fetched once into Kurambit's tools folder. */
    readonly uv: Effect.Effect<string, GameOperationError>;
    /**
     * The Unity editor a game opens with, the Unity CLI (fetched on first
     * use) and the licence they will run under. Fails with an actionable
     * reason before any editor starts.
     */
    readonly unity: (projectDir?: string) => Effect.Effect<UnityTools, GameOperationError>;
    /**
     * Every Unity editor and the CLI this server may have launched, usable
     * or not: the only executables a Unity pid record may name.
     */
    readonly unityExecutables: Effect.Effect<UnityExecutables>;
    /** Per-tool status. With a Unity project, Unity's entry speaks for that project's editor version. */
    readonly status: (options?: {
      readonly unityProject?: string | undefined;
    }) => Effect.Effect<GameToolchainStatus>;
  }
>()("kurambit/game/GameToolchain") {}
export interface UnityExecutables {
  readonly cli: string;
  /** The HOME every CLI call runs under. */
  readonly cliHome: string;
  readonly editors: ReadonlyArray<string>;
}
export interface UnityTools {
  readonly cli: string;
  readonly cliHome: string;
  readonly editor: string;
  /** The editor's version folder; its asset workers, shader compilers and Bee run from inside it. */
  readonly editorDir: string;
  readonly version: string;
  readonly source: GameToolSource;
  /** The project's own editor version when opening it in this newer editor upgrades it. */
  readonly upgradesProject: string | null;
  readonly license: Extract<UnityLicense, { kind: "active" }>;
}
type UnitySource = "settings" | "env" | "unity-hub" | "kurambit";
type UnityCandidate = UnityEditorCandidate<UnitySource>;
const isGameOperationError = Schema.is(GameOperationError);
const make = Effect.gen(function* () {
  const processes = yield* GameProcesses.GameProcesses;
  const settings = yield* ServerSettings.ServerSettingsService;
  const platform = hostPlatform(yield* HostProcess.Platform);
  const linuxX64 = platform === "linux" && (yield* HostProcess.Architecture) === "x64";
  const directory = toolsDirectory();
  const logRoot = NodePath.join(directory, ".operations");
  const fetchLock = Semaphore.makeUnsafe(1);
  const probes = new Map<
    string,
    { mtime: number; size: number; exitCode: number; output: string }
  >();
  const readSettings = settings.getSettings.pipe(
    Effect.mapError(
      (cause) =>
        new GameOperationError({ operation: "settings", path: directory, reason: "io", cause }),
    ),
  );
  const versionOf = (tool: BinaryTool, output: string) =>
    output.match(
      tool === "uv"
        ? /\d+\.\d+\.\d+/
        : tool === "godot"
          ? /4\.\d+\.\d+\.[^\s]+/
          : /Blender\s+\d+\.\d+\.\d+/,
    )?.[0] ?? "unknown";
  /** `--version`, cached per file identity so a status poll never re-runs a large binary. */
  const probeVersion = (tool: BinaryTool, path: string) =>
    Effect.gen(function* () {
      const stat = yield* Effect.promise(() => NodeFSP.stat(path));
      const cached = probes.get(path);
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached;
      const result = yield* processes
        .run({
          root: logRoot,
          executable: path,
          args: ["--version"],
          operation: `${tool}-version`,
          timeoutMs: 20_000,
        })
        .pipe(
          Effect.map((run) => ({
            exitCode: run.exitCode,
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
      };
      probes.set(path, entry);
      return entry;
    });
  const godotTemplates = (godot: string, version: string) =>
    Effect.promise(async () => {
      const templateVersion = version.split(".").slice(0, 4).join(".");
      const base = (await exists(NodePath.join(NodePath.dirname(godot), "._sc_")))
        ? NodePath.join(NodePath.dirname(godot), "editor_data/export_templates")
        : platform === "darwin"
          ? NodePath.join(NodeOS.homedir(), "Library/Application Support/Godot/export_templates")
          : platform === "win32"
            ? NodePath.join(
                process.env.APPDATA ?? NodePath.join(NodeOS.homedir(), "AppData/Roaming"),
                "Godot/export_templates",
              )
            : NodePath.join(
                process.env.XDG_DATA_HOME || NodePath.join(NodeOS.homedir(), ".local/share"),
                "godot/export_templates",
              );
      return NodePath.join(base, templateVersion);
    });
  /** The first usable candidate; else the first one found, with what is wrong with it. */
  const probe = (tool: BinaryTool): Effect.Effect<Probe, GameOperationError> =>
    Effect.gen(function* () {
      const config = yield* readSettings;
      const candidates = toolCandidates(
        tool,
        tool === "blender" ? config.gameBlenderPath : tool === "godot" ? config.gameGodotPath : "",
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
            templates: tool === "godot" ? yield* godotTemplates(candidate.path, version) : null,
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
        ? `${found.path} is ${NAMES[tool]} ${found.version}; Kurambit needs ${REQUIRED[tool]}. Get it from ${DOWNLOADS[tool]}, or point Settings > General > Game tools at a supported copy.`
        : `${found.path} did not run as ${NAMES[tool]} (\`--version\` failed). Fix or reinstall it from ${DOWNLOADS[tool]}, or point Settings > General > Game tools at a working copy.${found.detail ? `\n${found.detail}` : ""}`;
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
          ...(tool === "uv" && found.kind === "missing" && linuxX64
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
      const base = {
        tool,
        installed: true,
        path: found.path,
        version: found.version,
        source: found.source,
      };
      if (found.templates === null)
        return {
          ...base,
          status: "ready",
          message: "Ready.",
          downloadUrl: null,
        } satisfies GameToolStatus;
      const templates = found.templates;
      const [hasBase, hasWindows] = yield* Effect.promise(() =>
        Promise.all([hasBaseExportTemplates(templates), hasWindowsExportTemplates(templates)]),
      );
      const addTemplates = `open the Godot editor, choose Editor > Manage Export Templates and download them, or install the export templates .tpz from ${DOWNLOADS.godot}`;
      return (
        !hasBase
          ? {
              ...base,
              status: "error",
              message: `Godot ${found.version} has no export templates in ${templates}, so games cannot be built for play. To add them, ${addTemplates}.`,
              downloadUrl: DOWNLOADS.godot,
            }
          : !hasWindows
            ? {
                ...base,
                status: "warning",
                message: `Ready for Web and Linux. Windows export templates are missing from ${templates}; to export for Windows, ${addTemplates}.`,
                downloadUrl: DOWNLOADS.godot,
              }
            : { ...base, status: "ready", message: "Ready.", downloadUrl: null }
      ) satisfies GameToolStatus;
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
  const fetchUv = Effect.gen(function* () {
    const target = NodePath.join(directory, `uv-${UV_VERSION}`);
    const stage = yield* makeStage("fetch-uv");
    return yield* Effect.gen(function* () {
      const archive = yield* Effect.tryPromise({
        try: (signal) =>
          downloadPlainFile(
            `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz`,
            `uv-${UV_VERSION}.tar.gz`,
            stage,
            signal,
          ),
        catch: (cause) =>
          isGameOperationError(cause)
            ? cause
            : new GameOperationError({
                operation: "fetch-uv",
                path: `uv-${UV_VERSION}.tar.gz`,
                reason: "download",
                cause,
              }),
      });
      const extract = yield* processes.run({
        root: logRoot,
        executable: "tar",
        args: ["-xzf", archive, "-C", stage],
        operation: "fetch-uv-extract",
        timeoutMs: 120_000,
      });
      if (extract.exitCode !== 0)
        return yield* new GameOperationError({
          operation: "fetch-uv",
          path: extract.logPath,
          reason: "command-failed",
          detail: commandDetail(extract),
        });
      const extracted = NodePath.join(stage, "uv-x86_64-unknown-linux-gnu");
      const check = yield* processes.run({
        root: logRoot,
        executable: NodePath.join(extracted, "uv"),
        args: ["--version"],
        operation: "fetch-uv-check",
        timeoutMs: 20_000,
      });
      if (check.exitCode !== 0 || !(check.stdout + check.stderr).includes(UV_VERSION))
        return yield* new GameOperationError({
          operation: "fetch-uv",
          path: archive,
          reason: "wrong-version",
          detail: `uv reported ${(check.stdout + check.stderr).slice(0, 200)}; expected ${UV_VERSION}.`,
        });
      yield* Effect.tryPromise({
        try: () => NodeFSP.rename(extracted, target),
        catch: (cause) =>
          new GameOperationError({ operation: "fetch-uv", path: target, reason: "io", cause }),
      });
    }).pipe(Effect.ensuring(dropStage(stage)));
  });
  const uv: GameToolchain["Service"]["uv"] = fetchLock.withPermits(1)(
    Effect.gen(function* () {
      const found = yield* probe("uv");
      if (found.kind === "ok") return found.path;
      if (found.kind !== "missing" || !linuxX64) return (yield* executable("uv")).path;
      yield* fetchUv;
      return (yield* executable("uv")).path;
    }),
  );
  const cliFiles = unityCliPaths(directory);
  const cliPath = () => process.env.KURAMBIT_UNITY_CLI?.trim() || cliFiles.cli;
  const fetchUnityCli = Effect.gen(function* () {
    const stage = yield* makeStage("fetch-unity-cli");
    yield* Effect.tryPromise({
      try: async (signal) => {
        const file = await downloadPlainFile(UNITY_CLI_URL, "unity", stage, signal);
        const hash = NodeCrypto.createHash("sha256");
        for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
        if (hash.digest("hex") !== UNITY_CLI_SHA256)
          throw new GameOperationError({
            operation: "fetch-unity-cli",
            path: UNITY_CLI_URL,
            reason: "checksum",
          });
        await NodeFSP.chmod(file, 0o755);
        await NodeFSP.mkdir(cliFiles.cliDir, { recursive: true });
        await NodeFSP.rename(file, cliFiles.cli);
      },
      catch: (cause) =>
        isGameOperationError(cause)
          ? cause
          : new GameOperationError({
              operation: "fetch-unity-cli",
              path: UNITY_CLI_URL,
              reason: "download",
              cause,
            }),
    }).pipe(Effect.ensuring(dropStage(stage)));
    const version = yield* processes.run({
      root: logRoot,
      executable: cliFiles.cli,
      args: ["--version"],
      operation: "unity-cli-version",
      timeoutMs: 30_000,
      env: unityCliEnv(cliFiles.installHome),
      envMode: "replace",
    });
    if (version.exitCode !== 0 || !version.stdout.includes(UNITY_CLI_VERSION)) {
      yield* Effect.promise(() => NodeFSP.rm(cliFiles.cli, { force: true }));
      return yield* new GameOperationError({
        operation: "fetch-unity-cli",
        path: cliFiles.cli,
        reason: "wrong-version",
        detail: `The Unity CLI reported ${(version.stdout + version.stderr).slice(0, 200)}; expected ${UNITY_CLI_VERSION}.`,
      });
    }
  });
  const unityCli = fetchLock.withPermits(1)(
    Effect.gen(function* () {
      const cli = cliPath();
      if (yield* Effect.promise(() => isExecutable(cli))) return cli;
      if (cli !== cliFiles.cli)
        return yield* new GameOperationError({
          operation: "Unity",
          path: cli,
          reason: "tool-missing",
          detail: `KURAMBIT_UNITY_CLI names ${cli}, which is not an executable file.`,
        });
      if (!linuxX64)
        return yield* new GameOperationError({
          operation: "Unity",
          path: cli,
          reason: "unsupported-platform",
          detail: "Kurambit fetches the Unity CLI for Linux x86_64 only.",
        });
      yield* fetchUnityCli;
      return cli;
    }),
  );
  const hub = unityHubLocations(platform, NodeOS.homedir(), process.env.APPDATA);
  const editorsUnder = (root: string, source: UnitySource) =>
    Effect.promise(async () => {
      const entries = await NodeFSP.readdir(root, { withFileTypes: true }).catch(() => []);
      const found: UnityCandidate[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const editor = unityEditorExecutable(NodePath.join(root, entry.name), platform);
        if (await isExecutable(editor))
          found.push({ editor, source, version: unityVersionFromPath(editor) });
      }
      return found;
    });
  /** Explicit paths first (settings, env), then Unity Hub's folders, then an earlier Kurambit install. */
  const unityCandidates = Effect.gen(function* () {
    const config = yield* readSettings.pipe(Effect.orElseSucceed(() => null));
    const explicit: UnityCandidate[] = [];
    for (const [path, source] of [
      [config?.gameUnityPath ?? "", "settings"],
      [process.env.KURAMBIT_UNITY_EDITOR ?? "", "env"],
    ] as const)
      if (path.trim() !== "") {
        const editor = NodePath.resolve(path.trim());
        explicit.push({ editor, source, version: unityVersionFromPath(editor) });
      }
    const secondary = parseSecondaryInstallPath(
      yield* Effect.promise(() =>
        NodeFSP.readFile(hub.secondaryInstallPathFile, "utf8").catch(() => null),
      ),
    );
    const hubRoots = [...new Set([hub.editors, ...(secondary === null ? [] : [secondary])])];
    const detected: UnityCandidate[] = [];
    for (const root of hubRoots) detected.push(...(yield* editorsUnder(root, "unity-hub")));
    detected.push(...(yield* editorsUnder(legacyUnityEditorRoot(directory), "kurambit")));
    return { explicit, detected };
  });
  const unityExecutables: GameToolchain["Service"]["unityExecutables"] = unityCandidates.pipe(
    Effect.map(({ explicit, detected }) => ({
      cli: cliPath(),
      cliHome: cliFiles.installHome,
      editors: [...new Set([...explicit, ...detected].map((candidate) => candidate.editor))],
    })),
  );
  const unityMissing = (path: string, detail: string, reason: GameOperationError["reason"]) =>
    new GameOperationError({ operation: "Unity", path, reason, detail });
  const getUnity = `Install Unity Hub from ${UNITY_DOWNLOAD_URL} and add a Unity ${UNITY_MIN_VERSION} or later Unity 6 editor with Windows Build Support (Mono), or set its path in Settings > General > Game tools.`;
  /** The editor for a project, or why there is none; the licence and CLI are checked by the caller. */
  const unityEditor = (projectDir: string | undefined) =>
    Effect.gen(function* () {
      if (platform !== "linux")
        return yield* unityMissing(
          "Unity",
          "Kurambit drives the Unity editor on Linux only for now: it runs it on a private Xvfb display.",
          "unsupported-platform",
        );
      const { explicit, detected } = yield* unityCandidates;
      const override = explicit[0];
      if (override !== undefined && !(yield* Effect.promise(() => isExecutable(override.editor))))
        return yield* unityMissing(
          override.editor,
          `${override.source === "settings" ? "The Unity editor path in Settings > General > Game tools" : "KURAMBIT_UNITY_EDITOR"} names ${override.editor}, which is not an executable file. ${getUnity}`,
          "tool-missing",
        );
      const project =
        projectDir === undefined
          ? null
          : projectEditorVersion(
              yield* Effect.promise(() =>
                NodeFSP.readFile(
                  NodePath.join(projectDir, "ProjectSettings/ProjectVersion.txt"),
                  "utf8",
                ).catch(() => null),
              ),
            );
      const choice = pickUnityEditor([...explicit, ...detected], project);
      if (choice.kind === "none")
        return yield* unityMissing(
          hub.editors,
          `No Unity editor was found. Kurambit looks at the path in Settings > General > Game tools, KURAMBIT_UNITY_EDITOR, Unity Hub's editors folder (${hub.editors}) and the folder in ${hub.secondaryInstallPathFile}, and an earlier Kurambit install. ${getUnity}`,
          "tool-missing",
        );
      if (choice.kind === "unknown-version")
        return yield* unityMissing(
          choice.candidate.editor,
          `Kurambit cannot tell which Unity version ${choice.candidate.editor} is: it reads the version from the folder the editor is installed in, the way Unity Hub names it (for example .../${UNITY_MIN_VERSION}/Editor/Unity). Point at an editor Unity Hub installed.`,
          "wrong-version",
        );
      if (choice.kind === "unsupported")
        return yield* unityMissing(
          choice.candidate.editor,
          `${choice.candidate.editor} is Unity ${choice.candidate.version?.text}; Kurambit needs Unity 6 at ${UNITY_MIN_VERSION} or later. ${getUnity}`,
          "wrong-version",
        );
      return {
        editor: choice.candidate.editor,
        editorDir: unityEditorDir(choice.candidate.editor),
        version: choice.candidate.version!.text,
        source: choice.candidate.source,
        upgradesProject: choice.upgradesProject?.text ?? null,
      };
    });
  const readLicense = Effect.gen(function* () {
    const xml = yield* Effect.promise(() =>
      NodeFSP.readFile(unityLicenseFile(), "utf8").catch(() => null),
    );
    return parseUnityLicense(xml, yield* Clock.currentTimeMillis);
  });
  const unity: GameToolchain["Service"]["unity"] = (projectDir) =>
    Effect.gen(function* () {
      const editor = yield* unityEditor(projectDir);
      const license = yield* readLicense;
      if (license.kind !== "active")
        return yield* new GameOperationError({
          operation: "Unity",
          path: unityLicenseFile(),
          reason: "license-missing",
          detail: unityLicenseMessage(license),
        });
      const cli = yield* unityCli;
      return { ...editor, cli, cliHome: cliFiles.installHome, license };
    });
  const upgradeNotice = (version: string, project: string) =>
    ` This game's Unity project was made with Unity ${project}, which is not installed; opening it in ${version} upgrades the project. Add Unity ${project} in Unity Hub to keep it on its own version.`;
  const unityStatus = (projectDir: string | undefined) =>
    Effect.gen(function* () {
      const editor = yield* unityEditor(projectDir);
      const base = {
        tool: "unity" as const,
        installed: true,
        path: editor.editor,
        version: editor.version,
        source: editor.source,
      };
      const license = yield* readLicense;
      if (license.kind !== "active")
        return {
          ...base,
          status: "error",
          message: unityLicenseMessage(license),
          downloadUrl: UNITY_DOWNLOAD_URL,
        } satisfies GameToolStatus;
      const windows = yield* Effect.promise(() =>
        exists(unityWindowsSupport(editor.editorDir, platform)),
      );
      const gaps =
        (editor.upgradesProject === null
          ? ""
          : upgradeNotice(editor.version, editor.upgradesProject)) +
        (windows
          ? ""
          : " Windows Build Support (Mono) is missing from this editor, so Windows exports are refused; add the module to this editor in Unity Hub.");
      return {
        ...base,
        status: gaps === "" ? "ready" : "warning",
        message: `Unity ${editor.version}. ${unityLicenseMessage(license)}${gaps}`,
        downloadUrl: gaps === "" ? null : UNITY_DOWNLOAD_URL,
      } satisfies GameToolStatus;
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          tool: "unity",
          installed: error.reason === "wrong-version",
          path: error.reason === "wrong-version" ? error.path : null,
          version: null,
          source: null,
          status: "error",
          message: error.detail ?? error.message,
          downloadUrl: UNITY_DOWNLOAD_URL,
        } satisfies GameToolStatus),
      ),
    );
  const status: GameToolchain["Service"]["status"] = (options) =>
    Effect.all([
      binaryStatus("blender"),
      binaryStatus("godot"),
      binaryStatus("uv"),
      unityStatus(options?.unityProject),
    ]).pipe(Effect.map((tools) => ({ tools })));
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
  return GameToolchain.of({ executable, uv, unity, unityExecutables, status });
});
const isExecutable = async (file: string) => {
  try {
    await NodeFSP.access(file, NodeFSP.constants.X_OK);
    return (await NodeFSP.stat(file)).isFile();
  } catch {
    return false;
  }
};
const BASE_EXPORT_TEMPLATE_FILES = [
  "web_nothreads_release.zip",
  "web_nothreads_debug.zip",
  "linux_release.x86_64",
  "linux_debug.x86_64",
  "version.txt",
] as const;
/**
 * Windows is a separate readiness signal: games already shipping Web and
 * Linux must keep exporting when only these files are missing.
 */
const REQUIRED_WINDOWS_EXPORT_TEMPLATE_FILES = [
  "windows_release_x86_64.exe",
  "windows_debug_x86_64.exe",
] as const;
export const hasBaseExportTemplates = async (directory: string) =>
  (
    await Promise.all(
      BASE_EXPORT_TEMPLATE_FILES.map((file) => exists(NodePath.join(directory, file))),
    )
  ).every(Boolean);
export const hasWindowsExportTemplates = async (directory: string) =>
  (
    await Promise.all(
      REQUIRED_WINDOWS_EXPORT_TEMPLATE_FILES.map((file) => exists(NodePath.join(directory, file))),
    )
  ).every(Boolean);
const exists = async (file: string) => {
  try {
    await NodeFSP.access(file);
    return true;
  } catch {
    return false;
  }
};
/** Plain streaming download; callers verify the artifact (a hash, or running it).
 * Module-level so Effect's fetch diagnostic (HTTP belongs to HttpClient in
 * Effect code) never sees it; reached only through Effect.tryPromise. */
async function downloadPlainFile(
  url: string,
  name: string,
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
  const response = await fetch(url, { signal: requestSignal });
  if (!response.ok || !response.body) throw new Error(`Download request: ${response.status}`);
  const destination = NodePath.join(directory, name);
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body),
    NodeFS.createWriteStream(destination, { flags: "wx" }),
    { signal: requestSignal },
  );
  return destination;
}
export const layer = Layer.effect(GameToolchain, make);
