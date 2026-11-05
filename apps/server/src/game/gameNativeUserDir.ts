// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the native filesystem boundary for user:// isolation.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { HOST_OS } from "./processHost.ts";

/**
 * Per-run user:// isolation shared by scenario runs, native captures and
 * runtime calibrations: the environment that points Godot's data, config and
 * cache roots into a per-run (or kept) directory, without touching the game
 * sources or any installed userdata. Callers pass the returned env to exactly
 * one child via GameProcesses; nothing is set globally and no real saved
 * game is ever deleted.
 *
 * Where Godot reads those roots, from its sources (`get_data_path`,
 * `get_config_path`, `get_cache_path` in platform/linuxbsd/os_linuxbsd.cpp,
 * platform/windows/os_windows.cpp and platform/macos/os_macos.mm, 4.5 to
 * master): Linux and the BSDs honour XDG_DATA_HOME, XDG_CONFIG_HOME and
 * XDG_CACHE_HOME; Windows reads %APPDATA% for data and config and
 * %LOCALAPPDATA% for cache; macOS reads $HOME/Library/Application Support and
 * $HOME/Library/Caches and no XDG variable, so there the child gets its own
 * HOME. user:// is `<data>/Godot/app_userdata/<project>` everywhere.
 */

export interface NativeUserIsolation {
  /** Parent-owned isolation root, e.g. <evidence>/user. Removed with its evidence. */
  readonly dir: string;
  readonly dataDir: string;
  readonly configDir: string;
  readonly cacheDir: string;
  /** Scoped overrides for exactly one child process. */
  readonly env: NodeJS.ProcessEnv;
}

/** True when child stays inside parent (equal counts as inside). */
export const isPathInside = (child: string, parent: string): boolean => {
  const relative = NodePath.relative(NodePath.resolve(parent), NodePath.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/**
 * Best-effort preflight over project.godot's user-dir config. A custom user
 * directory that names an absolute path or climbs with `..` would escape the
 * per-run isolation, so the caller refuses instead of claiming a clean state.
 * A plain custom name still lives under the isolated XDG data home and is
 * allowed; the runner's reported OS.get_user_data_dir containment is the
 * authoritative check.
 */
export const userDirConfigIssues = (projectText: string): string[] => {
  const issues: string[] = [];
  const useCustom = /^\s*config\/use_custom_user_dir\s*=\s*true\s*$/m.test(projectText);
  if (!useCustom) return issues;
  const match = projectText.match(/^\s*config\/custom_user_dir_name\s*=\s*"([^"]*)"\s*$/m);
  const name = match?.[1] ?? "";
  if (name.trim() === "") {
    issues.push(
      "The project enables a custom user directory without naming one; user:// would not be isolated by the per-run XDG dirs, so this run is refused instead of claiming a clean state.",
    );
    return issues;
  }
  if (
    NodePath.isAbsolute(name) ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith("~")
  )
    issues.push(
      `The project's custom user directory "${name.slice(0, 80)}" escapes the per-run isolation; user:// would not be contained, so this run is refused instead of claiming a clean state.`,
    );
  return issues;
};

/** Scoped XDG overrides for exactly one child; never touches process.env. */
export const nativeUserEnv = (
  dataDir: string,
  configDir: string,
  cacheDir: string,
): NodeJS.ProcessEnv => ({
  XDG_DATA_HOME: dataDir,
  XDG_CONFIG_HOME: configDir,
  XDG_CACHE_HOME: cacheDir,
});

/** Where an OS's Godot puts its data, config and cache roots under `dir`, and the env that says so. */
export const nativeUserLayout = (
  dir: string,
  os: NodeJS.Platform,
): Omit<NativeUserIsolation, "dir"> => {
  const join = os === "win32" ? NodePath.win32.join : NodePath.posix.join;
  if (os === "win32") {
    const dataDir = join(dir, "data");
    const cacheDir = join(dir, "cache");
    return {
      dataDir,
      configDir: dataDir,
      cacheDir,
      env: { APPDATA: dataDir, LOCALAPPDATA: cacheDir },
    };
  }
  if (os === "darwin") {
    const home = join(dir, "home");
    const dataDir = join(home, "Library", "Application Support");
    return {
      dataDir,
      configDir: dataDir,
      cacheDir: join(home, "Library", "Caches"),
      env: { HOME: home },
    };
  }
  const dataDir = join(dir, "data");
  const configDir = join(dir, "config");
  const cacheDir = join(dir, "cache");
  return { dataDir, configDir, cacheDir, env: nativeUserEnv(dataDir, configDir, cacheDir) };
};

/** This OS's isolation under dir, created when missing; nothing is removed. */
export const nativeUserIsolationAt = async (dir: string): Promise<NativeUserIsolation> => {
  const layout = nativeUserLayout(dir, HOST_OS);
  await NodeFSP.mkdir(dir, { recursive: true });
  const root = await NodeFSP.realpath(dir).catch(() => null);
  for (const path of new Set([layout.dataDir, layout.configDir, layout.cacheDir])) {
    await NodeFSP.mkdir(path, { recursive: true });
    // A link planted inside the folder must not point the game at real user data.
    const real = await NodeFSP.realpath(path);
    if (root === null || !isPathInside(real, root))
      throw new Error(`The save folder ${path} resolves to ${real}, outside ${dir}; refused.`);
  }
  return { dir, ...layout };
};

/**
 * Creates a fresh per-run isolation trio under parentDir. Each call mints a
 * unique user-<uuid> root, so two runs sharing one evidence parent still get
 * separate userdata. The caller owns parentDir (an evidence or run directory)
 * and removes it with that evidence; this helper never touches HOME or
 * installed userdata.
 */
export const prepareNativeUserIsolation = (parentDir: string): Promise<NativeUserIsolation> =>
  nativeUserIsolationAt(NodePath.join(parentDir, `user-${NodeCrypto.randomUUID()}`));
