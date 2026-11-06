// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off -- The window host: where native game and editor processes get a window the user never sees.
import type * as NodeChildProcess from "node:child_process";
import type { GameViewport } from "@kurambit/contracts";
import { findExecutable } from "./GameProcesses.ts";
import { HOST_OS, spawnOwned, type OwnedProcess, type ProcessHostState } from "./processHost.ts";

/**
 * What the harness needs from an OS to show a game: a window the game draws
 * into, that the user never sees and that never takes focus. Pictures, video
 * and input all come from inside the engine, so this is the whole visual
 * contract.
 *
 * - Linux gives every launch its own Xvfb display, never the user's.
 * - Windows and macOS have no private display a user app can make (a virtual
 *   monitor needs a driver; macOS's API is private), so the window opens on
 *   the user's desktop at {@link OFFSCREEN_POSITION}, never minimized: a
 *   minimized Godot window stops drawing. Placing it is the launched
 *   program's part, since every engine says it differently.
 */
export interface WindowHost {
  /**
   * "private-display": a display of its own (Xvfb); the command needs no
   * placement. "offscreen": the user's desktop; the command must place its
   * own window at OFFSCREEN_POSITION and not take focus.
   */
  readonly kind: "private-display" | "offscreen";
  /** Starts `command` with a window of `viewport`'s size, and whatever the window needs. */
  readonly launch: (command: WindowCommand, viewport: GameViewport) => Promise<HostedWindow>;
}

export interface WindowCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  /** The whole environment, with no display route: the host adds its own. */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
  readonly stdio: NodeChildProcess.StdioOptions;
  readonly token?: string | undefined;
}

export interface HostedWindow {
  /**
   * The launch, owning its tree: the command and whatever its window needed
   * (a display server). It exits when the command does.
   */
  readonly process: OwnedProcess;
  /** Where the window lives, for logs and records. */
  readonly label: string;
  /** Stops the command and what its window needed. */
  readonly stop: (options?: { readonly graceMs?: number }) => Promise<void>;
}

/** The Xvfb a window host launches, and the only Xvfb an editor record may name. */
export const findXvfb = (): Promise<string | null> =>
  findExecutable("Xvfb", { pathEnv: process.env.PATH, override: process.env.KURAMBIT_XVFB });

/**
 * The exit a hosted command reports when its private display died before it
 * did: the host's fault, which a game that then exits with an X error must not
 * be taken for.
 */
export const DISPLAY_LOST_EXIT = 71;

/**
 * Runs a command on its own Xvfb display, as xvfb-run does. Xvfb picks a free
 * display itself (`-displayfd`) and writes its number once it accepts clients,
 * so two launches at once never share one and nothing polls for it. The
 * display ends only after the command exits, so an engine never loses its
 * display mid-shutdown (Godot hangs in Xlib's exit path when it does); a game
 * that quits because its server died takes its display with it. A 24-bit
 * depth is required, or Xvfb rejects the screen and the game boots against a
 * dead display.
 */
const XVFB_WRAPPER = `size=$1 xvfb=$2
shift 2
dir=$(mktemp -d) || exit 70
mkfifo "$dir/display" || { rm -rf "$dir"; exit 70; }
"$xvfb" -displayfd 3 -screen 0 "$size" -nolisten tcp 3>"$dir/display" </dev/null >/dev/null 2>&1 &
x=$!
read -r n < "$dir/display"
rm -rf "$dir"
if [ -z "$n" ] || ! kill -0 "$x" 2>/dev/null; then
  echo "kurambit: the private display did not start" >&2
  kill "$x" 2>/dev/null
  exit 70
fi
DISPLAY=":$n" "$@"
status=$?
kill -0 "$x" 2>/dev/null || exit ${DISPLAY_LOST_EXIT}
kill "$x" 2>/dev/null
wait "$x" 2>/dev/null
exit $status`;

const xvfbHost = (host: ProcessHostState, xvfb: string): WindowHost => ({
  kind: "private-display",
  launch: async (command, viewport) => {
    const owned = spawnOwned(
      host,
      "/bin/sh",
      [
        "-c",
        XVFB_WRAPPER,
        "kurambit-window",
        `${viewport.width}x${viewport.height}x24`,
        xvfb,
        command.executable,
        ...command.args,
      ],
      {
        env: command.env,
        cwd: command.cwd,
        stdio: command.stdio,
        tree: true,
        window: true,
        token: command.token,
      },
    );
    owned.child.unref();
    return {
      process: owned,
      label: "private display",
      stop: (options) => owned.stop({ graceMs: options?.graceMs ?? 3_000 }),
    };
  },
});

/** Far outside any monitor arrangement, as Genex ships for Godot on Windows and macOS. */
export const OFFSCREEN_POSITION = { x: -10_000, y: -10_000 } as const;

/** The command itself, owning its tree; its arguments place its window. */
const offscreenHost = (host: ProcessHostState): WindowHost => ({
  kind: "offscreen",
  launch: async (command) => {
    const owned = spawnOwned(host, command.executable, command.args, {
      env: command.env,
      cwd: command.cwd,
      stdio: command.stdio,
      tree: true,
      window: true,
      token: command.token,
    });
    owned.child.unref();
    return {
      process: owned,
      label: "offscreen",
      stop: (options) => owned.stop({ graceMs: options?.graceMs ?? 3_000 }),
    };
  },
});

/**
 * The window host this machine offers, or null when it has none (Linux
 * without Xvfb): then a native game runs headless where its engine can, or
 * the caller refuses plainly. Never the user's own display on Linux.
 */
export const findWindowHost = async (host: ProcessHostState): Promise<WindowHost | null> => {
  if (HOST_OS === "win32" || HOST_OS === "darwin") return offscreenHost(host);
  const xvfb = await findXvfb();
  return xvfb === null ? null : xvfbHost(host, xvfb);
};
