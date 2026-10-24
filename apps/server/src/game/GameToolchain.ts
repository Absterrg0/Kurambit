import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics globalFetch:off -- Stream large checked artifacts directly to disk with an AbortSignal.
// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeStream from "node:stream";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GameOperationError, type GameToolchainStatus } from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import { commandDetail } from "./commandDetail.ts";
import * as GameProcesses from "./GameProcesses.ts";

export const GODOT_VERSION = "4.7.2";
export const BLENDER_VERSION = "4.5.14";
export const toolsDirectory = () =>
  NodePath.join(
    process.env.XDG_DATA_HOME || NodePath.join(NodeOS.homedir(), ".local/share"),
    "game-studio/tools",
  );
export const validToolVersion = (tool: "blender" | "godot", version: string) => {
  const match = version.match(/(?:Blender\s+)?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]),
    minor = Number(match[2]);
  return tool === "godot" ? major === 4 && minor === 7 : major > 4 || (major === 4 && minor >= 2);
};
export const toolCandidates = (
  tool: "blender" | "godot",
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
      : NodePath.join(
          directory,
          `godot-${GODOT_VERSION}/Godot_v${GODOT_VERSION}-stable_linux.x86_64`,
        );
  return [
    managed,
    ...searchPath
      .split(NodePath.delimiter)
      .filter(Boolean)
      .flatMap((entry) =>
        (tool === "godot" ? ["godot", "godot4"] : ["blender"]).map((name) =>
          NodePath.join(entry, name),
        ),
      ),
  ];
};
export class GameToolchain extends Context.Service<
  GameToolchain,
  {
    readonly executable: (
      tool: "blender" | "godot",
    ) => Effect.Effect<
      { path: string; version: string; templates: string | null },
      GameOperationError
    >;
    readonly status: Effect.Effect<GameToolchainStatus>;
    readonly verify: Effect.Effect<GameToolchainStatus, GameOperationError>;
    readonly install: Effect.Effect<GameToolchainStatus, GameOperationError>;
  }
>()("t3/game/GameToolchain") {}
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
        tool === "blender" ? config.gameBlenderPath : config.gameGodotPath,
        process.env[tool === "blender" ? "GAME_STUDIO_BLENDER" : "GAME_STUDIO_GODOT"],
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
          (result.stdout + result.stderr).match(
            tool === "godot" ? /4\.\d+\.\d+\.[^\s]+/ : /Blender\s+\d+\.\d+\.\d+/,
          )?.[0] ?? "unknown";
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
  const status = Effect.gen(function* () {
    const tools = yield* Effect.forEach(["blender", "godot"] as const, (tool) =>
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
    return { toolsDirectory: directory, installing, tools };
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
      return yield* status;
    }).pipe(
      Effect.ensuring(Effect.promise(() => NodeFSP.rm(scratch, { recursive: true, force: true }))),
    );
  });
  const install = Effect.gen(function* () {
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
  return GameToolchain.of({ executable, status, verify, install });
});
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
