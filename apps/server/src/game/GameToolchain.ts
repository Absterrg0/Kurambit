import * as HostProcess from "@kurambit/shared/HostProcess";
// @effect-diagnostics globalFetch:off -- Stream large checked artifacts directly to disk with an AbortSignal.
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
import {
  GameOperationError,
  UNITY_PINNED_VERSION,
  type GameToolchainStatus,
} from "@kurambit/contracts";
import * as ServerSettings from "../serverSettings.ts";
import { commandDetail } from "./commandDetail.ts";
import * as GameProcesses from "./GameProcesses.ts";
import {
  UNITY_CLI_SHA256,
  UNITY_CLI_URL,
  UNITY_CLI_VERSION,
  UNITY_EXTRA_MODULES,
  parseUnityLicense,
  unityCliEnv,
  unityLicenseFile,
  unityLicenseMessage,
  unityPaths,
  type UnityLicense,
} from "./unityToolchain.ts";

export const GODOT_VERSION = "4.7.2";
export const BLENDER_VERSION = "4.5.14";
/** Pinned uv ( astral-sh/uv ): no checksum file is published, so the install
 * verifies by running the extracted binary and matching this version. */
export const UV_VERSION = "0.9.8";
export const toolsDirectory = () =>
  NodePath.join(
    process.env.XDG_DATA_HOME || NodePath.join(NodeOS.homedir(), ".local/share"),
    "kurambit/tools",
  );
export const validToolVersion = (tool: "blender" | "godot" | "uv", version: string) => {
  const match = version.match(/(?:Blender\s+)?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]),
    minor = Number(match[2]);
  if (tool === "uv") return major === 0 && minor >= 7;
  return tool === "godot" ? major === 4 && minor === 7 : major > 4 || (major === 4 && minor >= 2);
};
export const toolCandidates = (
  tool: "blender" | "godot" | "uv",
  explicit: string,
  environment: string | undefined,
  directory: string,
  searchPath: string,
) => {
  if (explicit.trim()) return [NodePath.resolve(explicit.trim())];
  if (environment?.trim()) return [NodePath.resolve(environment.trim())];
  const managed =
    tool === "blender"
      ? NodePath.join(directory, `blender-${BLENDER_VERSION}/blender`)
      : tool === "godot"
        ? NodePath.join(
            directory,
            `godot-${GODOT_VERSION}/Godot_v${GODOT_VERSION}-stable_linux.x86_64`,
          )
        : NodePath.join(directory, `uv-${UV_VERSION}/uv`);
  return [
    managed,
    ...searchPath
      .split(NodePath.delimiter)
      .filter(Boolean)
      .flatMap((entry) =>
        (tool === "godot" ? ["godot", "godot4"] : tool === "uv" ? ["uv"] : ["blender"]).map(
          (name) => NodePath.join(entry, name),
        ),
      ),
  ];
};
export class GameToolchain extends Context.Service<
  GameToolchain,
  {
    readonly executable: (
      tool: "blender" | "godot" | "uv",
    ) => Effect.Effect<
      { path: string; version: string; templates: string | null },
      GameOperationError
    >;
    /**
     * The pinned Unity CLI and editor plus the licence they will run under.
     * Fails with an actionable reason when either is missing or no licence
     * is active, before any editor starts.
     */
    readonly unity: Effect.Effect<UnityTools, GameOperationError>;
    /**
     * Where the pinned Unity CLI and editor live, installed or not and with
     * or without a licence: the only executables a Unity pid record may name.
     */
    readonly unityInstall: UnityInstall;
    readonly status: Effect.Effect<GameToolchainStatus>;
    readonly verify: Effect.Effect<GameToolchainStatus, GameOperationError>;
    /** Blender, Godot and uv by default; `unity` installs the Unity CLI and editor instead. */
    readonly install: (input: {
      readonly unity?: boolean | undefined;
    }) => Effect.Effect<GameToolchainStatus, GameOperationError>;
  }
>()("kurambit/game/GameToolchain") {}
export interface UnityInstall {
  readonly cli: string;
  readonly editor: string;
  /** The editor's install root; its asset workers, shader compilers and Bee run from inside it. */
  readonly editorDir: string;
  /** The HOME every CLI call runs under. */
  readonly cliHome: string;
}
export interface UnityTools extends UnityInstall {
  readonly version: string;
  readonly license: Extract<UnityLicense, { kind: "active" }>;
}
const pythonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const isGameOperationError = Schema.is(GameOperationError);
const make = Effect.gen(function* () {
  const processes = yield* GameProcesses.GameProcesses;
  const settings = yield* ServerSettings.ServerSettingsService;
  const directory = toolsDirectory();
  const logRoot = NodePath.join(directory, ".operations");
  let installing = false;
  const verified = new Map<string, string>();
  const probes = new Map<string, { mtime: number; size: number; version: string }>();
  const executable: GameToolchain["Service"]["executable"] = Effect.fn("GameToolchain.executable")(
    function* (tool) {
      const config = yield* settings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new GameOperationError({ operation: "settings", path: directory, reason: "io", cause }),
        ),
      );
      const candidates = toolCandidates(
        tool,
        tool === "blender" ? config.gameBlenderPath : tool === "godot" ? config.gameGodotPath : "",
        process.env[
          tool === "blender"
            ? "KURAMBIT_BLENDER"
            : tool === "godot"
              ? "KURAMBIT_GODOT"
              : "KURAMBIT_UV"
        ],
        directory,
        process.env.PATH ?? "",
      );
      const selected = yield* Effect.promise(async () => {
        for (const candidate of candidates) {
          try {
            await NodeFSP.access(candidate, NodeFSP.constants.X_OK);
            if ((await NodeFSP.stat(candidate)).isFile()) return candidate;
          } catch {
            /* Try the next permitted resolution source. */
          }
        }
        return undefined;
      });
      if (!selected)
        return yield* new GameOperationError({
          operation: tool,
          path: candidates[0] ?? tool,
          reason: "tool-missing",
        });
      const stat = yield* Effect.tryPromise({
        try: () => NodeFSP.stat(selected),
        catch: (cause) =>
          new GameOperationError({
            operation: tool,
            path: selected,
            reason: "tool-missing",
            cause,
          }),
      });
      const cached = probes.get(selected);
      let version: string;
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size)
        version = cached.version;
      else {
        const result = yield* processes
          .run({
            root: logRoot,
            executable: selected,
            args: ["--version"],
            operation: `${tool}-version`,
            timeoutMs: 20_000,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new GameOperationError({
                  operation: tool,
                  path: selected,
                  reason: "tool-missing",
                  cause,
                }),
            ),
          );
        version =
          tool === "uv"
            ? ((result.stdout + result.stderr).match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown")
            : ((result.stdout + result.stderr).match(
                tool === "godot" ? /4\.\d+\.\d+\.[^\s]+/ : /Blender\s+\d+\.\d+\.\d+/,
              )?.[0] ?? "unknown");
        if (result.exitCode !== 0 || !validToolVersion(tool, version))
          return yield* new GameOperationError({
            operation: tool,
            path: selected,
            reason: result.exitCode !== 0 ? "command-failed" : "wrong-version",
            detail:
              `${tool} reported ${version}. ${result.exitCode !== 0 ? "The version check failed. Fix its path in Settings > General > Game tools, or clear the override and click Install tools in Settings > General > Game tools.\n" : ""}${commandDetail(result)}`.slice(
                0,
                4096,
              ),
          });
        probes.set(selected, { mtime: stat.mtimeMs, size: stat.size, version });
      }
      let templates: string | null = null;
      if (tool === "godot") {
        const templateVersion = version.split(".").slice(0, 4).join(".");
        const selfContained = awaitExists(NodePath.join(NodePath.dirname(selected), "._sc_"));
        const base = (yield* Effect.promise(() => selfContained))
          ? NodePath.join(NodePath.dirname(selected), "editor_data/export_templates")
          : NodePath.join(
              process.env.XDG_DATA_HOME || NodePath.join(NodeOS.homedir(), ".local/share"),
              "godot/export_templates",
            );
        templates = NodePath.join(base, templateVersion);
      }
      return { path: selected, version, templates };
    },
  );
  const unityFiles = unityPaths(directory);
  const unityMissing = (path: string, detail: string) =>
    new GameOperationError({ operation: "unity", path, reason: "tool-missing", detail });
  const readLicense = Effect.gen(function* () {
    const xml = yield* Effect.promise(() =>
      NodeFSP.readFile(unityLicenseFile(), "utf8").catch(() => null),
    );
    return parseUnityLicense(xml, yield* Clock.currentTimeMillis);
  });
  const unityInstall: UnityInstall = (() => {
    const editor = process.env.KURAMBIT_UNITY_EDITOR?.trim() || unityFiles.editor;
    return {
      cli: process.env.KURAMBIT_UNITY_CLI?.trim() || unityFiles.cli,
      editor,
      // <editorDir>/Editor/Unity
      editorDir: NodePath.dirname(NodePath.dirname(editor)),
      cliHome: unityFiles.installHome,
    };
  })();
  const unity: GameToolchain["Service"]["unity"] = Effect.gen(function* () {
    const { cli, editor } = unityInstall;
    const installHint =
      "Click Install Unity in Settings > General > Game tools (about 4.5 GB), or set KURAMBIT_UNITY_CLI / KURAMBIT_UNITY_EDITOR.";
    if (!(yield* Effect.promise(() => isExecutable(cli))))
      return yield* unityMissing(
        cli,
        `The Unity CLI ${UNITY_CLI_VERSION} is not installed. ${installHint}`,
      );
    if (!(yield* Effect.promise(() => isExecutable(editor))))
      return yield* unityMissing(
        editor,
        `The Unity ${UNITY_PINNED_VERSION} editor is not installed. ${installHint}`,
      );
    const license = yield* readLicense;
    if (license.kind !== "active")
      return yield* new GameOperationError({
        operation: "unity",
        path: unityLicenseFile(),
        reason: "license-missing",
        detail: unityLicenseMessage(license),
      });
    return { ...unityInstall, version: UNITY_PINNED_VERSION, license };
  });
  const unityStatus = Effect.gen(function* () {
    const resolved = yield* unity.pipe(
      Effect.map((tools) => ({ ok: true as const, tools })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );
    if (!resolved.ok)
      return {
        tool: "unity" as const,
        path: resolved.error.path,
        version: null,
        ready: false,
        verified: false,
        message: resolved.error.detail ?? resolved.error.message,
      };
    const windows = yield* Effect.promise(() => awaitExists(unityFiles.windowsPlayer));
    return {
      tool: "unity" as const,
      path: resolved.tools.editor,
      version: resolved.tools.version,
      ready: true,
      verified: verified.get(resolved.tools.editor) === resolved.tools.version,
      message:
        `Unity ${resolved.tools.version} with CLI ${UNITY_CLI_VERSION}. ${unityLicenseMessage(resolved.tools.license)}` +
        (windows
          ? ""
          : " Windows build support is missing from this editor: Windows exports are refused until it is reinstalled with the windows-mono module."),
    };
  });
  const status = Effect.gen(function* () {
    const tools = yield* Effect.forEach(["blender", "godot", "uv"] as const, (tool) =>
      executable(tool).pipe(
        Effect.flatMap((resolved) =>
          Effect.promise(async () => {
            const hasTemplates =
              resolved.templates === null || (await hasBaseExportTemplates(resolved.templates));
            // Windows is additive: a toolchain with working Web/Linux templates
            // stays ready, but Settings must say Windows needs one extra install.
            const hasWindows =
              tool === "godot" &&
              resolved.templates !== null &&
              (await hasWindowsExportTemplates(resolved.templates));
            const windowsNotice =
              tool === "godot" && hasTemplates && !hasWindows
                ? " Windows export templates are missing; Install tools adds them without replacing the Godot binary."
                : "";
            return {
              tool,
              path: resolved.path,
              version: resolved.version,
              ready: hasTemplates,
              verified: verified.get(resolved.path) === resolved.version && hasTemplates,
              message: hasTemplates
                ? (verified.get(resolved.path) === resolved.version
                    ? "Ready. Real headless verification passed."
                    : "Found. Verify to run a real headless smoke check.") + windowsNotice
                : new GameOperationError({
                    operation: "Godot export templates",
                    path: resolved.templates!,
                    reason: "templates-missing",
                    detail: `Godot executable: ${resolved.path} (${resolved.version}).`,
                  }).message,
            };
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed({
            tool,
            path: error.path,
            version: null,
            ready: false,
            verified: false,
            message: error.message,
          }),
        ),
      ),
    );
    return { toolsDirectory: directory, installing, tools: [...tools, yield* unityStatus] };
  });
  const verify = Effect.gen(function* () {
    const scratch = yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(directory, { recursive: true });
        return NodeFSP.mkdtemp(NodePath.join(directory, ".verify-"));
      },
      catch: (cause) =>
        new GameOperationError({ operation: "verify", path: directory, reason: "io", cause }),
    });
    return yield* Effect.gen(function* () {
      const blender = yield* executable("blender");
      yield* Effect.tryPromise({
        try: () =>
          NodeFSP.writeFile(
            NodePath.join(scratch, "verify.py"),
            `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()\nbpy.ops.export_scene.gltf(filepath=${pythonString(NodePath.join(scratch, "cube.glb"))},export_format='GLB')\n`,
          ),
        catch: (cause) =>
          new GameOperationError({ operation: "verify", path: scratch, reason: "io", cause }),
      });
      const blend = yield* processes.run({
        root: logRoot,
        executable: blender.path,
        args: [
          "--background",
          "--factory-startup",
          "--python-exit-code",
          "1",
          "--python",
          NodePath.join(scratch, "verify.py"),
        ],
        operation: "verify-blender",
      });
      if (
        blend.exitCode !== 0 ||
        !(yield* Effect.promise(() => awaitExists(NodePath.join(scratch, "cube.glb"))))
      )
        return yield* new GameOperationError({
          operation: "verify-blender",
          path: blend.logPath,
          reason: "command-failed",
          detail: commandDetail(blend),
        });
      verified.set(blender.path, blender.version);
      const godot = yield* executable("godot");
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.writeFile(
            NodePath.join(scratch, "project.godot"),
            '[application]\nconfig/name="Toolchain verification"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
          );
        },
        catch: (cause) =>
          new GameOperationError({ operation: "verify", path: scratch, reason: "io", cause }),
      });
      const imported = yield* processes.run({
        root: logRoot,
        executable: godot.path,
        args: ["--headless", "--path", scratch, "--editor", "--import"],
        operation: "verify-godot",
      });
      if (
        imported.exitCode !== 0 ||
        /(?:SCRIPT ERROR|ERROR:)/.test(imported.stdout + imported.stderr)
      )
        return yield* new GameOperationError({
          operation: "verify-godot",
          path: imported.logPath,
          reason: "command-failed",
          detail: commandDetail(imported),
        });
      verified.set(godot.path, godot.version);
      const uv = yield* executable("uv");
      const uvCheck = yield* processes.run({
        root: logRoot,
        executable: uv.path,
        args: ["--version"],
        operation: "verify-uv",
        timeoutMs: 20_000,
      });
      if (uvCheck.exitCode !== 0 || !(uvCheck.stdout + uvCheck.stderr).includes(UV_VERSION))
        return yield* new GameOperationError({
          operation: "verify-uv",
          path: uvCheck.logPath,
          reason: "wrong-version",
          detail: `uv reported ${(uvCheck.stdout + uvCheck.stderr).slice(0, 200)}; expected ${UV_VERSION}.`,
        });
      verified.set(uv.path, uv.version);
      return yield* status;
    }).pipe(
      Effect.ensuring(Effect.promise(() => NodeFSP.rm(scratch, { recursive: true, force: true }))),
    );
  });
  const installCore = Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "linux" || (yield* HostProcess.Architecture) !== "x64")
      return yield* new GameOperationError({
        operation: "install",
        path: directory,
        reason: "unsupported-platform",
      });
    if (installing)
      return yield* new GameOperationError({
        operation: "install",
        path: directory,
        reason: "busy",
      });
    installing = true;
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(directory, { recursive: true }),
        catch: (cause) =>
          new GameOperationError({ operation: "install", path: directory, reason: "io", cause }),
      });
      const stage = yield* Effect.tryPromise({
        try: () => NodeFSP.mkdtemp(NodePath.join(directory, ".install-")),
        catch: (cause) =>
          new GameOperationError({ operation: "install", path: directory, reason: "io", cause }),
      });
      const run = Effect.fnUntraced(function* (executablePath: string, args: string[]) {
        const result = yield* processes.run({
          root: logRoot,
          executable: executablePath,
          args,
          operation: "install-extract",
          timeoutMs: 600_000,
        });
        if (result.exitCode !== 0)
          return yield* new GameOperationError({
            operation: "install-extract",
            path: result.logPath,
            reason: "command-failed",
            detail: commandDetail(result),
          });
      });
      return yield* Effect.gen(function* () {
        const blenderName = `blender-${BLENDER_VERSION}-linux-x64.tar.xz`;
        const blenderBase = "https://download.blender.org/release/Blender4.5";
        const godotBase = `https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}-stable`;
        const godotName = `Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip`;
        const templatesName = `Godot_v${GODOT_VERSION}-stable_export_templates.tpz`;
        const download = (
          base: string,
          name: string,
          checksumName: string,
          algorithm: "sha256" | "sha512",
        ) =>
          Effect.tryPromise({
            try: (signal) => downloadVerified(base, name, checksumName, algorithm, stage, signal),
            catch: (cause) =>
              isGameOperationError(cause)
                ? cause
                : new GameOperationError({
                    operation: "download",
                    path: name,
                    reason: "download",
                    cause,
                  }),
          });
        // uv publishes no checksum file, so the plain download below is
        // verified afterwards by running the extracted binary and matching
        // UV_VERSION (wrong-version fails the install).
        if (
          !(yield* Effect.promise(() =>
            awaitExists(NodePath.join(directory, `uv-${UV_VERSION}/uv`)),
          ))
        ) {
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
                    operation: "download",
                    path: `uv-${UV_VERSION}.tar.gz`,
                    reason: "download",
                    cause,
                  }),
          });
          yield* run("tar", ["-xzf", archive, "-C", stage]);
          const extracted = NodePath.join(stage, "uv-x86_64-unknown-linux-gnu");
          const check = yield* processes.run({
            root: logRoot,
            executable: NodePath.join(extracted, "uv"),
            args: ["--version"],
            operation: "install-uv-check",
            timeoutMs: 20_000,
          });
          if (check.exitCode !== 0 || !(check.stdout + check.stderr).includes(UV_VERSION))
            return yield* new GameOperationError({
              operation: "install-uv",
              path: archive,
              reason: "wrong-version",
              detail: `uv reported ${(check.stdout + check.stderr).slice(0, 200)}; expected ${UV_VERSION}.`,
            });
          yield* Effect.tryPromise({
            try: () => NodeFSP.rename(extracted, NodePath.join(directory, `uv-${UV_VERSION}`)),
            catch: (cause) =>
              new GameOperationError({
                operation: "install-uv",
                path: directory,
                reason: "io",
                cause,
              }),
          });
        }
        if (
          !(yield* Effect.promise(() =>
            awaitExists(NodePath.join(directory, `blender-${BLENDER_VERSION}/blender`)),
          ))
        ) {
          const archive = yield* download(
            blenderBase,
            blenderName,
            `blender-${BLENDER_VERSION}.sha256`,
            "sha256",
          );
          yield* run("tar", ["-xJf", archive, "-C", stage]);
          yield* Effect.tryPromise({
            try: () =>
              NodeFSP.rename(
                NodePath.join(stage, `blender-${BLENDER_VERSION}-linux-x64`),
                NodePath.join(directory, `blender-${BLENDER_VERSION}`),
              ),
            catch: (cause) =>
              new GameOperationError({
                operation: "install-blender",
                path: directory,
                reason: "io",
                cause,
              }),
          });
        }
        const godotInstall = NodePath.join(directory, `godot-${GODOT_VERSION}`);
        const templatesTarget = NodePath.join(
          godotInstall,
          "editor_data/export_templates",
          `${GODOT_VERSION}.stable`,
        );
        const godotBinary = NodePath.join(godotInstall, godotName.slice(0, -4));
        const godotPresent = yield* Effect.promise(
          async () =>
            (await awaitExists(godotBinary)) && (await hasBaseExportTemplates(templatesTarget)),
        );
        if (!godotPresent) {
          const archive = yield* download(godotBase, godotName, "SHA512-SUMS.txt", "sha512");
          const target = NodePath.join(stage, "godot");
          yield* Effect.promise(() => NodeFSP.mkdir(target));
          yield* run("unzip", ["-q", archive, "-d", target]);
          const templatesArchive = yield* download(
            godotBase,
            templatesName,
            "SHA512-SUMS.txt",
            "sha512",
          );
          const extractTemplates = NodePath.join(stage, "templates-extract");
          yield* run("unzip", [
            "-q",
            templatesArchive,
            ...BASE_EXPORT_TEMPLATE_FILES.map((file) => `templates/${file}`),
            ...WINDOWS_EXPORT_TEMPLATE_FILES.map((file) => `templates/${file}`),
            "-d",
            extractTemplates,
          ]);
          const installedTemplates = NodePath.join(target, "editor_data/export_templates");
          yield* Effect.tryPromise({
            try: async () => {
              const templateVersion = await readTemplateVersion(extractTemplates);
              if (templateVersion !== `${GODOT_VERSION}.stable`)
                throw new GameOperationError({
                  operation: "install-templates",
                  path: templatesArchive,
                  reason: "wrong-version",
                });
              await NodeFSP.mkdir(installedTemplates, { recursive: true });
              await NodeFSP.rename(
                NodePath.join(extractTemplates, "templates"),
                NodePath.join(installedTemplates, templateVersion),
              );
              await NodeFSP.writeFile(NodePath.join(target, "._sc_"), "");
              await NodeFSP.chmod(NodePath.join(target, godotName.slice(0, -4)), 0o755);
              // A previous interrupted install is replaced only after all artifacts verify and extract.
              const old = `${godotInstall}.old`;
              if (await awaitExists(godotInstall)) await NodeFSP.rename(godotInstall, old);
              await NodeFSP.rename(target, godotInstall);
              await NodeFSP.rm(old, { recursive: true, force: true });
            },
            catch: (cause) =>
              isGameOperationError(cause)
                ? cause
                : new GameOperationError({
                    operation: "install-godot",
                    path: godotInstall,
                    reason: "io",
                    cause,
                  }),
          });
        } else if (!(yield* Effect.promise(() => hasWindowsExportTemplates(templatesTarget)))) {
          // A working Godot binary and its Web/Linux templates stay in place;
          // only the missing Windows x86_64 templates are added.
          const templatesArchive = yield* download(
            godotBase,
            templatesName,
            "SHA512-SUMS.txt",
            "sha512",
          );
          const extractTemplates = NodePath.join(stage, "templates-extract");
          yield* run("unzip", [
            "-q",
            templatesArchive,
            ...WINDOWS_EXPORT_TEMPLATE_FILES.map((file) => `templates/${file}`),
            "templates/version.txt",
            "-d",
            extractTemplates,
          ]);
          yield* Effect.tryPromise({
            try: async () => {
              const templateVersion = await readTemplateVersion(extractTemplates);
              if (templateVersion !== `${GODOT_VERSION}.stable`)
                throw new GameOperationError({
                  operation: "install-templates",
                  path: templatesArchive,
                  reason: "wrong-version",
                });
              await NodeFSP.mkdir(templatesTarget, { recursive: true });
              for (const file of WINDOWS_EXPORT_TEMPLATE_FILES)
                await NodeFSP.rename(
                  NodePath.join(extractTemplates, "templates", file),
                  NodePath.join(templatesTarget, file),
                );
            },
            catch: (cause) =>
              isGameOperationError(cause)
                ? cause
                : new GameOperationError({
                    operation: "install-windows-templates",
                    path: templatesTarget,
                    reason: "io",
                    cause,
                  }),
          });
        }
        return yield* verify;
      }).pipe(
        Effect.ensuring(Effect.promise(() => NodeFSP.rm(stage, { recursive: true, force: true }))),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          installing = false;
        }),
      ),
    );
  });
  /**
   * The pinned Unity CLI (sha256 against the published manifest value), then
   * the pinned editor through that CLI's own installer, which md5-checks the
   * archive. The CLI installs with its state in the tools directory so the
   * 4.5 GB download never lands in the user's Hub cache.
   */
  const installUnity = Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "linux" || (yield* HostProcess.Architecture) !== "x64")
      return yield* new GameOperationError({
        operation: "install-unity",
        path: directory,
        reason: "unsupported-platform",
      });
    if (installing)
      return yield* new GameOperationError({
        operation: "install-unity",
        path: directory,
        reason: "busy",
      });
    installing = true;
    return yield* Effect.gen(function* () {
      if (!(yield* Effect.promise(() => isExecutable(unityFiles.cli)))) {
        const stage = yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(directory, { recursive: true });
            return NodeFSP.mkdtemp(NodePath.join(directory, ".install-"));
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "install-unity",
              path: directory,
              reason: "io",
              cause,
            }),
        });
        yield* Effect.tryPromise({
          try: async (signal) => {
            const file = await downloadPlainFile(UNITY_CLI_URL, "unity", stage, signal);
            const hash = NodeCrypto.createHash("sha256");
            for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
            if (hash.digest("hex") !== UNITY_CLI_SHA256)
              throw new GameOperationError({
                operation: "install-unity-cli",
                path: UNITY_CLI_URL,
                reason: "checksum",
              });
            await NodeFSP.chmod(file, 0o755);
            await NodeFSP.mkdir(unityFiles.cliDir, { recursive: true });
            await NodeFSP.rename(file, unityFiles.cli);
          },
          catch: (cause) =>
            isGameOperationError(cause)
              ? cause
              : new GameOperationError({
                  operation: "install-unity-cli",
                  path: UNITY_CLI_URL,
                  reason: "download",
                  cause,
                }),
        }).pipe(
          Effect.ensuring(
            Effect.promise(() => NodeFSP.rm(stage, { recursive: true, force: true })),
          ),
        );
      }
      const version = yield* processes.run({
        root: logRoot,
        executable: unityFiles.cli,
        args: ["--version"],
        operation: "unity-cli-version",
        timeoutMs: 30_000,
        env: unityCliEnv(unityFiles.installHome),
        envMode: "replace",
      });
      if (version.exitCode !== 0 || !version.stdout.includes(UNITY_CLI_VERSION))
        return yield* new GameOperationError({
          operation: "install-unity-cli",
          path: unityFiles.cli,
          reason: "wrong-version",
          detail: `The Unity CLI reported ${(version.stdout + version.stderr).slice(0, 200)}; expected ${UNITY_CLI_VERSION}.`,
        });
      if (!(yield* Effect.promise(() => isExecutable(unityFiles.editor)))) {
        const home = unityFiles.installHome;
        yield* Effect.promise(() => NodeFSP.mkdir(home, { recursive: true }));
        const installed = yield* processes.run({
          root: logRoot,
          executable: unityFiles.cli,
          args: [
            "install",
            UNITY_PINNED_VERSION,
            "-d",
            unityFiles.editorRoot,
            ...UNITY_EXTRA_MODULES.flatMap((module) => ["-m", module]),
            "--accept-eula",
            "--format",
            "json",
          ],
          operation: "install-unity",
          timeoutMs: 3 * 60 * 60_000,
          env: unityCliEnv(home, networkEnv()),
          envMode: "replace",
        });
        if (
          installed.exitCode !== 0 ||
          !(yield* Effect.promise(() => isExecutable(unityFiles.editor)))
        )
          return yield* new GameOperationError({
            operation: "install-unity",
            path: installed.logPath,
            reason: "command-failed",
            detail: commandDetail(installed),
          });
        // The download cache only serves a retry; a finished install drops it.
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(home, ".config/unityhub/downloads"), {
            recursive: true,
            force: true,
          }),
        );
      }
      const resolved = yield* unity;
      verified.set(resolved.editor, resolved.version);
      return yield* status;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          installing = false;
        }),
      ),
    );
  });
  const install: GameToolchain["Service"]["install"] = (input) =>
    input.unity === true ? installUnity : installCore;
  return GameToolchain.of({ executable, unity, unityInstall, status, verify, install });
});
const isExecutable = async (file: string) => {
  try {
    await NodeFSP.access(file, NodeFSP.constants.X_OK);
    return (await NodeFSP.stat(file)).isFile();
  } catch {
    return false;
  }
};
/** Proxy and CA variables the Unity installer may need to reach Unity's CDN. */
const networkEnv = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const name of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
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
const WINDOWS_EXPORT_TEMPLATE_FILES = [
  "windows_release_x86_64.exe",
  "windows_debug_x86_64.exe",
  "windows_release_x86_64_console.exe",
  "windows_debug_x86_64_console.exe",
] as const;
const REQUIRED_WINDOWS_EXPORT_TEMPLATE_FILES = [
  "windows_release_x86_64.exe",
  "windows_debug_x86_64.exe",
] as const;
export const hasBaseExportTemplates = async (directory: string) =>
  (
    await Promise.all(
      BASE_EXPORT_TEMPLATE_FILES.map((file) => awaitExists(NodePath.join(directory, file))),
    )
  ).every(Boolean);
export const hasWindowsExportTemplates = async (directory: string) =>
  (
    await Promise.all(
      REQUIRED_WINDOWS_EXPORT_TEMPLATE_FILES.map((file) =>
        awaitExists(NodePath.join(directory, file)),
      ),
    )
  ).every(Boolean);
const readTemplateVersion = async (extractDirectory: string) =>
  (await NodeFSP.readFile(NodePath.join(extractDirectory, "templates/version.txt"), "utf8")).trim();
const awaitExists = async (file: string) => {
  try {
    await NodeFSP.access(file);
    return true;
  } catch {
    return false;
  }
};
/** Plain streaming download without checksum verification (uv publishes no
 * checksum file): callers must verify the artifact another way. Module-level
 * so Effect's fetch diagnostic (HTTP belongs to HttpClient in Effect code)
 * never sees it; reached only through Effect.tryPromise. */
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
async function downloadVerified(
  base: string,
  name: string,
  checksumName: string,
  algorithm: "sha256" | "sha512",
  directory: string,
  signal: AbortSignal,
) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
  const sums = await fetch(`${base}/${checksumName}`, { signal: requestSignal });
  if (!sums.ok) throw new Error(`Checksum request: ${sums.status}`);
  const expected = (await sums.text())
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+\*?/))
    .find((fields) => fields[1] === name)?.[0];
  if (
    !expected ||
    !new RegExp(`^[a-fA-F0-9]{${algorithm === "sha256" ? 64 : 128}}$`).test(expected)
  )
    throw new GameOperationError({ operation: "checksum", path: name, reason: "checksum" });
  const response = await fetch(`${base}/${name}`, { signal: requestSignal });
  if (!response.ok || !response.body) throw new Error(`Download request: ${response.status}`);
  const destination = NodePath.join(directory, name);
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body),
    NodeFS.createWriteStream(destination, { flags: "wx" }),
    {
      signal: requestSignal,
    },
  );
  const hash = NodeCrypto.createHash(algorithm);
  for await (const chunk of NodeFS.createReadStream(destination)) hash.update(chunk);
  if (hash.digest("hex").toLowerCase() !== expected.toLowerCase())
    throw new GameOperationError({ operation: "checksum", path: destination, reason: "checksum" });
  return destination;
}
export const layer = Layer.effect(GameToolchain, make);
