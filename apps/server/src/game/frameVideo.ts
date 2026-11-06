// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off -- A bot run's video: engine frames piped into one ffmpeg child, timed by the wall clock.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import { engineChildEnv } from "./GameProcesses.ts";
import type { PlayFrame } from "./playSession.ts";
import { spawnOwned, type OwnedProcess, type ProcessHostState } from "./processHost.ts";

/** The run video's rate: what x11grab recorded before, enough to read motion. */
export const VIDEO_FPS = 12;
/** Frames are downscaled in the engine to at most this width before they cross the socket. */
export const VIDEO_WIDTH = 960;
/** The video's fixed height; frames of another shape are letterboxed. */
const VIDEO_HEIGHT = 540;
/** An encoder this far behind gets no more frames until it catches up; the drops are counted. */
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

/** What the video's sidecar says about its frames, so a stalled renderer reads as stalled. */
export interface FrameVideoFacts {
  /** Where the pictures came from: the engine's back buffer, captured by harness code. */
  readonly route: "engine-frames";
  readonly fps: number;
  readonly received: number;
  /** Video frames written, including repeats that keep wall-clock timing. */
  readonly written: number;
  /** Frames skipped because the encoder fell behind. */
  readonly dropped: number;
  /** Distinct engine frame counters among the received frames. */
  readonly distinctFrames: number;
  /** The longest wall time, in ms, the engine's frame counter did not advance. */
  readonly longestStallMs: number;
  /** Game seconds at the start of that stall. */
  readonly longestStallAt: number;
}

/**
 * One run video from the engine's own frames. The video runs on the wall
 * clock: a slot with no new picture repeats the last one, so a game that
 * draws slowly or stops shows exactly that, and the sidecar keeps each
 * picture's engine frame counter and game time. ffmpeg reads JPEGs on stdin;
 * when the server dies its stdin closes and it finalizes and exits on its own.
 */
export const openFrameVideo = (input: {
  readonly host: ProcessHostState;
  readonly ffmpeg: string;
  readonly videoPath: string;
  readonly sidecarPath: string;
  readonly logPath: string;
}) => {
  const interval = 1000 / VIDEO_FPS;
  let ffmpeg: OwnedProcess | null = null;
  let started = 0;
  let written = 0;
  let dropped = 0;
  let last: PlayFrame | null = null;
  let finished = false;
  const received: Array<readonly [frame: number, t: number, wallMs: number]> = [];
  let lastAdvance = 0;
  let lastCounter = -1;
  let longestStallMs = 0;
  let longestStallAt = 0;
  let lastAdvanceT = 0;
  const stalled = (now: number) => {
    if (now - lastAdvance <= longestStallMs) return;
    longestStallMs = now - lastAdvance;
    longestStallAt = lastAdvanceT;
  };
  const open = (): OwnedProcess => {
    const log = NodeFS.openSync(input.logPath, "w");
    const owned = spawnOwned(
      input.host,
      input.ffmpeg,
      [
        "-y",
        "-f",
        "image2pipe",
        "-framerate",
        String(VIDEO_FPS),
        "-c:v",
        "mjpeg",
        "-i",
        "-",
        // One output size for the whole run: a game that resizes its window
        // mid-run changes the frames' size, which libx264 cannot follow.
        "-vf",
        `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        input.videoPath,
      ],
      { env: engineChildEnv(), stdio: ["pipe", log, log], tree: false },
    );
    NodeFS.closeSync(log);
    owned.child.stdin?.on("error", () => undefined);
    return owned;
  };
  const write = (frame: PlayFrame): void => {
    const stdin = ffmpeg?.child.stdin;
    // The slot still counts, so wall-clock timing holds; only the picture is skipped.
    if (stdin !== undefined && stdin !== null && stdin.writableLength > MAX_PENDING_BYTES)
      dropped += 1;
    else stdin?.write(frame.jpeg);
    written += 1;
  };
  /** Fills every slot up to `slot` with the last picture. */
  const fillTo = (slot: number): void => {
    if (last === null) return;
    for (let missing = slot - written; missing > 0; missing--) write(last);
  };
  return {
    push: (frame: PlayFrame): void => {
      if (finished) return;
      const now = Date.now();
      if (ffmpeg === null) {
        ffmpeg = open();
        started = now;
        lastAdvance = now;
      }
      received.push([frame.frame, Number(frame.t.toFixed(3)), now - started]);
      if (frame.frame !== lastCounter) {
        stalled(now);
        lastAdvance = now;
        lastAdvanceT = frame.t;
        lastCounter = frame.frame;
      }
      const slot = Math.floor((now - started) / interval);
      fillTo(slot);
      // A picture newer than its slot's is kept for the next slot.
      if (written === slot) write(frame);
      last = frame;
    },
    /** The latest picture, as received. */
    last: (): PlayFrame | null => last,
    /** Pads the video to now, closes ffmpeg's input and waits for the file; returns the sidecar facts. */
    finish: async (): Promise<FrameVideoFacts | null> => {
      if (finished) return null;
      finished = true;
      const owned = ffmpeg;
      if (owned === null) return null;
      const now = Date.now();
      fillTo(Math.floor((now - started) / interval) + 1);
      stalled(now);
      let timedOut = false;
      await new Promise<void>((resolve) => {
        if (!owned.running()) return resolve();
        // An encoder that never finishes would hold the run; its partial file still plays.
        const timer = setTimeout(() => {
          timedOut = true;
          void owned.stop().then(resolve);
        }, 60_000);
        owned.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        owned.child.stdin?.end();
      });
      // A failed encoder leaves no video to claim (a stopped slow one leaves a playable partial).
      if (!timedOut && owned.child.exitCode !== 0) return null;
      const facts: FrameVideoFacts = {
        route: "engine-frames",
        fps: VIDEO_FPS,
        received: received.length,
        written,
        dropped,
        distinctFrames: new Set(received.map(([frame]) => frame)).size,
        longestStallMs,
        longestStallAt: Number(longestStallAt.toFixed(2)),
      };
      await NodeFSP.writeFile(
        input.sidecarPath,
        JSON.stringify({ ...facts, frames: received }),
      ).catch(() => undefined);
      return facts;
    },
    /** Ends ffmpeg without waiting for a finished file (a run that failed). */
    stop: async (): Promise<void> => {
      finished = true;
      await ffmpeg?.stop({ graceMs: 3_000 });
    },
  };
};

export type FrameVideo = ReturnType<typeof openFrameVideo>;
