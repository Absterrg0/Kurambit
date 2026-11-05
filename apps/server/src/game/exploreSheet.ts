// @effect-diagnostics nodeBuiltinImport:off -- Frame sizes are read from the PNG headers the explore sessions wrote.
// One contact sheet of the frames a blind player's explore sessions kept, so a
// comparator judges looks from pixels in the same format for both builds.
import * as NodeFSP from "node:fs/promises";
import { readImageDimensions } from "@kurambit/shared/imageDimensions";

/** A frame an explore session kept, in play order across the thread's sessions. */
export interface ExploreFrame {
  readonly session: number;
  readonly step: number;
  readonly path: string;
}

/** 4 x 3 cells of 400 px: about 1600 px wide, readable at a glance. */
export const SHEET_FRAMES = 12;
const COLUMNS = 4;
const CELL_W = 400;
// Labels sit in a band above each frame, so they never cover the game's own HUD.
const BAND = 24;
const GAP = 4;

/** An even selection across the whole sample, always holding its first and last frame. */
export const pickFrames = <T>(frames: ReadonlyArray<T>, max = SHEET_FRAMES): T[] =>
  frames.length <= max
    ? [...frames]
    : Array.from(
        { length: max },
        (_, i) => frames[Math.round((i * (frames.length - 1)) / (max - 1))]!,
      );

/** Width and height from a PNG's IHDR chunk; null when the file is not a PNG. */
export const pngSize = async (path: string): Promise<{ w: number; h: number } | null> => {
  const handle = await NodeFSP.open(path, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const head = Buffer.alloc(24);
    const { bytesRead } = await handle.read(head, 0, 24, 0);
    const dimensions = readImageDimensions(head.subarray(0, bytesRead));
    if (dimensions === null) return null;
    // A truncated frame (a capture cut off mid-write) has no IEND trailer, and
    // one undecodable input fails the whole ffmpeg tile.
    const { size } = await handle.stat();
    const tail = Buffer.alloc(12);
    const { bytesRead: tailRead } = await handle.read(tail, 0, 12, Math.max(0, size - 12));
    if (tailRead < 12 || tail.toString("latin1", 4, 8) !== "IEND") return null;
    return { w: dimensions.width, h: dimensions.height };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/**
 * ffmpeg arguments that tile the frames into one JPEG at `output`. Cells keep
 * the first frame's aspect; `font` is a file name in ffmpeg's working directory,
 * or null to draw no labels. Frame paths are separate argv entries, never part
 * of the filtergraph, so they need no escaping.
 */
export const sheetArgs = (
  frames: ReadonlyArray<ExploreFrame>,
  aspect: number,
  font: string | null,
  output: string,
): string[] => {
  const frameH = 2 * Math.round((CELL_W * aspect) / 2);
  const cellH = frameH + BAND;
  const columns = Math.min(COLUMNS, frames.length);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  const graph: string[] = [];
  frames.forEach((frame, i) => {
    args.push("-i", frame.path);
    const label =
      font === null
        ? ""
        : `,drawtext=fontfile=${font}:text='session ${frame.session}  act ${frame.step}':fontsize=16:fontcolor=white:x=6:y=5`;
    graph.push(
      `[${i}:v]scale=${CELL_W}:${frameH}:force_original_aspect_ratio=decrease,pad=${CELL_W}:${cellH}:(ow-iw)/2:${BAND}+(${frameH}-ih)/2:color=0x1b1b20,setsar=1${label}[c${i}]`,
    );
  });
  graph.push(
    frames.length === 1
      ? "[c0]null[out]"
      : `${frames.map((_, i) => `[c${i}]`).join("")}xstack=inputs=${frames.length}:layout=${frames
          .map(
            (_, i) =>
              `${(i % columns) * (CELL_W + GAP)}_${Math.floor(i / columns) * (cellH + GAP)}`,
          )
          .join("|")}:fill=0x6a6a74[out]`,
  );
  return [
    ...args,
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[out]",
    "-frames:v",
    "1",
    "-q:v",
    "4",
    output,
  ];
};
