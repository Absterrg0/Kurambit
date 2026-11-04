// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off -- The private display host: Xvfb and display locks, by pid and by number.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import type { GameViewport } from "@kurambit/contracts";
import { engineChildEnv, findExecutable } from "./GameProcesses.ts";
import { spawnOwned, type OwnedProcess } from "./processHost.ts";

/**
 * Where game processes get a screen: a private X display, never the user's.
 * Linux uses Xvfb; pictures and video come from the engine.
 */

/** PATH discovery for xvfb-run, including the user-space fallback for hosts without one. */
export const findXvfbRun = async (): Promise<string | null> => {
  const pathEnv = process.env.PATH ?? "";
  const fallback = `${process.env.HOME ?? "~"}/.gs-tmp/xvfb-local/usr/bin`;
  try {
    // The system wrapper comes first: the user-space fallback's script fails
    // to hand Godot a display (hardcoded server number, races on -a), so every
    // native boot times out with no picture when it wins. Hosts without a
    // system xvfb-run still fall back to it.
    const system = await findExecutable("xvfb-run", {
      pathEnv,
      override: process.env.KURAMBIT_XVFB_RUN,
    });
    if (system !== null) return system;
    return await findExecutable("xvfb-run", { pathEnv: fallback });
  } catch {
    return null;
  }
};

/**
 * xvfb-run arguments that run `command` on a fresh private display of the
 * viewport's size. Xvfb rejects a screen without depth ("Invalid screen
 * configuration") and xvfb-run still runs the game against the dead display,
 * so every boot would time out with no picture: the x24 depth stays.
 */
export const xvfbRunArgs = (viewport: GameViewport, command: readonly string[]): string[] => [
  "-a",
  "-s",
  `-screen 0 ${viewport.width}x${viewport.height}x24`,
  ...command,
];

// Displays this process picked and has not let go: two runs at once (a blind
// comparison's bot on both builds) both see a number free before either's Xvfb
// writes its lock, and the second would then play on the first one's display.
const claimed = new Set<number>();

/** A free private X display, preferring above the live-Blender range; the caller releases it. */
const pickDisplay = async (): Promise<number | null> => {
  const taken = async (n: number): Promise<boolean> => {
    try {
      await NodeFSP.access(`/tmp/.X${n}-lock`);
      return true;
    } catch {
      /* candidate */
    }
    return new Promise<boolean>((resolve) => {
      const s = NodeNet.connect(6000 + n, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => {
        s.destroy();
        resolve(false);
      });
    });
  };
  const ranges: number[] = [];
  for (let n = 251; n < 350; n++) ranges.push(n);
  for (let n = 119; n < 251; n++) ranges.push(n);
  for (const n of ranges) {
    if (claimed.has(n) || (await taken(n)) || claimed.has(n)) continue;
    claimed.add(n);
    return n;
  }
  return null;
};

const waitDisplay = async (n: number, timeoutMs: number): Promise<boolean> => {
  // Readiness is the server's lock file: this platform's Xvfb build never
  // listens on TCP, so a TCP probe would wait out the whole timeout.
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      await NodeFSP.access(`/tmp/.X${n}-lock`);
      return true;
    } catch {
      /* not yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

/**
 * One private display: Xvfb on a free display number, for a process that
 * plays on it. Pictures and video come from the engine, never the display.
 * `track` receives the display server so a stop can end it.
 */
export const openPrivateDisplay = async (input: {
  readonly xvfb: string;
  readonly viewport: GameViewport;
  readonly track: (owned: OwnedProcess) => void;
}) => {
  const display = await pickDisplay();
  if (display === null) throw new Error("No free private X display.");
  let xvfb: OwnedProcess | undefined;
  const release = async (): Promise<void> => {
    await xvfb?.stop({ graceMs: 3000 });
    claimed.delete(display);
  };
  try {
    const { width, height } = input.viewport;
    xvfb = spawnOwned(input.xvfb, [`:${display}`, "-screen", "0", `${width}x${height}x24`], {
      env: engineChildEnv(),
      stdio: "ignore",
      tree: false,
    });
    xvfb.child.unref();
    input.track(xvfb);
    if (!(await waitDisplay(display, 15_000)))
      throw new Error("The private display did not start.");
  } catch (error) {
    await release();
    throw error;
  }
  return {
    /** The DISPLAY value a process plays on. */
    display: `:${display}`,
    /** Ends the display. */
    release,
  };
};
