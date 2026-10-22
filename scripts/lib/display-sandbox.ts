// @effect-diagnostics nodeBuiltinImport:off -- The sandbox owns a directory and hands an env to spawned children.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Everything a child process needs to reach a display server. The raw lane
 * proved why they all go: its agent ran `godot --write-movie` with the
 * operator's `DISPLAY=:0` and opened windows on the screen the user was using.
 */
export const DISPLAY_VARIABLES = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"] as const;

export interface DisplaySandbox {
  /** Absolute, empty and private: the compositor's default `wayland-0` is not here. */
  readonly runtimeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * A copy of `environment` with every route to the user's display removed.
 * `XDG_RUNTIME_DIR` stays set but points at an empty directory, because some
 * tools create sockets there and refuse to run when it is missing entirely.
 */
export function sandboxDisplayEnvironment(
  environment: NodeJS.ProcessEnv,
  runtimeDirectory: string,
): NodeJS.ProcessEnv {
  const sandboxed: NodeJS.ProcessEnv = { ...environment, XDG_RUNTIME_DIR: runtimeDirectory };
  for (const name of DISPLAY_VARIABLES) delete sandboxed[name];
  return sandboxed;
}

/**
 * Creates the private runtime directory under the run folder. The XDG spec
 * wants 0700, and an empty directory is the point: no `wayland-0` socket means
 * no compositor to open a window on. Headless Chrome and `godot --headless`
 * do not need one.
 */
export async function prepareDisplaySandbox(runDirectory: string): Promise<DisplaySandbox> {
  const runtimeDirectory = NodePath.join(runDirectory, "display-sandbox");
  await NodeFSP.rm(runtimeDirectory, { recursive: true, force: true });
  await NodeFSP.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  return {
    runtimeDirectory,
    environment: sandboxDisplayEnvironment(process.env, runtimeDirectory),
  };
}
