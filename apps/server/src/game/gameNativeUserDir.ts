// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the native filesystem boundary for user:// isolation.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Per-run user:// isolation shared by scenario runs, native captures and
 * runtime calibrations. On Linux Godot resolves user:// under XDG data home
 * (usually ~/.local/share/godot/app_userdata/<project>), so a fresh per-run
 * XDG data/config/cache trio isolates saved games without touching the game
 * sources, HOME, or any installed userdata. Callers pass the returned env to
 * exactly one child via GameProcesses; nothing is set globally and no real
 * saved game is ever deleted.
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

/**
 * Creates a fresh per-run isolation trio under parentDir. Each call mints a
 * unique user-<uuid> root, so two runs sharing one evidence parent still get
 * separate userdata. The caller owns parentDir (an evidence or run directory)
 * and removes it with that evidence; this helper never touches HOME or
 * installed userdata.
 */
export const prepareNativeUserIsolation = async (
  parentDir: string,
): Promise<NativeUserIsolation> => {
  const unique = `user-${NodeCrypto.randomUUID()}`;
  const dir = NodePath.join(parentDir, unique);
  const dataDir = NodePath.join(dir, "data");
  const configDir = NodePath.join(dir, "config");
  const cacheDir = NodePath.join(dir, "cache");
  await NodeFSP.mkdir(dataDir, { recursive: true });
  await NodeFSP.mkdir(configDir, { recursive: true });
  await NodeFSP.mkdir(cacheDir, { recursive: true });
  return { dir, dataDir, configDir, cacheDir, env: nativeUserEnv(dataDir, configDir, cacheDir) };
};
