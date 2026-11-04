// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off -- The window host: where native game and editor processes get a window the user never sees.
import type * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import type { GameViewport } from "@kurambit/contracts";
import { findExecutable } from "./GameProcesses.ts";
import { HOST_OS, spawnOwned, type OwnedProcess } from "./processHost.ts";

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
  /** Where the window lives, for logs and records (`:251`). */
  readonly label: string;
  /** Stops the command and what its window needed. */
  readonly stop: (options?: { readonly graceMs?: number }) => Promise<void>;
}

/** The Xvfb a window host launches, and the only Xvfb an editor record may name. */
export const findXvfb = (): Promise<string | null> =>
  findExecutable("Xvfb", { pathEnv: process.env.PATH, override: process.env.KURAMBIT_XVFB });

// Displays this server picked and has not let go: two launches at once (a
// blind comparison's bots on both builds) both see a number free before
// either's Xvfb writes its lock, and the second would then share the first's.
const claimed = new Set<number>();

const displayTaken = async (n: number): Promise<boolean> => {
  try {
    await NodeFSP.access(`/tmp/.X${n}-lock`);
    return true;
  } catch {
    /* candidate */
  }
  return new Promise<boolean>((resolve) => {
    const socket = NodeNet.connect(6000 + n, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
};

/** A free private display number, well above the user's own; the caller releases it. */
const pickDisplay = async (): Promise<number | null> => {
  for (let n = 119; n < 400; n++) {
    if (claimed.has(n) || (await displayTaken(n)) || claimed.has(n)) continue;
    claimed.add(n);
    return n;
  }
  return null;
};

/**
 * Runs a command on its own Xvfb display, as xvfb-run does, but on the
 * display number the server claimed: Xvfb starts, the command runs once the
 * display's lock file names this Xvfb (not another server's that won the
 * same number), and the display ends only after the command exits, so an
 * engine never loses its display mid-shutdown (Godot hangs in Xlib's exit
 * path when it does). A game that quits because its server died takes its
 * display with it. A 24-bit depth is required, or Xvfb rejects the screen and
 * the game boots against a dead display.
 */
const XVFB_WRAPPER = `display=$1 size=$2 xvfb=$3
shift 3
"$xvfb" "$display" -screen 0 "$size" -nolisten tcp </dev/null >/dev/null 2>&1 &
x=$!
lock="/tmp/.X\${display#:}-lock"
n=0
until [ -e "$lock" ] && [ "$(tr -d ' \\n' < "$lock" 2>/dev/null)" = "$x" ]; do
  if ! kill -0 "$x" 2>/dev/null || [ "$n" -ge 150 ]; then
    echo "kurambit: the private display $display did not start" >&2
    kill "$x" 2>/dev/null
    exit 70
  fi
  n=$((n + 1))
  sleep 0.1
done
DISPLAY=$display "$@"
status=$?
kill "$x" 2>/dev/null
wait "$x" 2>/dev/null
exit $status`;

const xvfbHost = (xvfb: string): WindowHost => ({
  kind: "private-display",
  launch: async (command, viewport) => {
    const n = await pickDisplay();
    if (n === null) throw new Error("No free private X display.");
    const label = `:${n}`;
    const owned = spawnOwned(
      "/bin/sh",
      [
        "-c",
        XVFB_WRAPPER,
        "kurambit-window",
        label,
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
    owned.child.once("exit", () => claimed.delete(n));
    owned.child.once("error", () => claimed.delete(n));
    return {
      process: owned,
      label,
      stop: (options) => owned.stop({ graceMs: options?.graceMs ?? 3_000 }),
    };
  },
});

/** Far outside any monitor arrangement, as Genex ships for Godot on Windows and macOS. */
export const OFFSCREEN_POSITION = { x: -10_000, y: -10_000 } as const;

/** The command itself, owning its tree; its arguments place its window. */
const offscreenHost: WindowHost = {
  kind: "offscreen",
  launch: async (command) => {
    const owned = spawnOwned(command.executable, command.args, {
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
};

/**
 * The window host this machine offers, or null when it has none (Linux
 * without Xvfb): then a native game runs headless where its engine can, or
 * the caller refuses plainly. Never the user's own display on Linux.
 */
export const findWindowHost = async (): Promise<WindowHost | null> => {
  if (HOST_OS === "win32" || HOST_OS === "darwin") return offscreenHost;
  const xvfb = await findXvfb();
  return xvfb === null ? null : xvfbHost(xvfb);
};
