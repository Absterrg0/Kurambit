/**
 * A downscaled RGBA sample of a rendered game frame. The playtest compares the
 * boot frame with the frame after its steps; a game that ignores input renders
 * the same pixels twice.
 */
export interface FrameSample {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

export const FRAME_SAMPLE_WIDTH = 64;
export const FRAME_SAMPLE_HEIGHT = 36;
/** Per-channel difference that still counts as the same pixel (compression, dithering). */
const CHANNEL_TOLERANCE = 12;
/** Share of sampled pixels that must change before the game is considered responsive. */
export const RESPONDED_THRESHOLD_PERCENT = 0.5;

export function compareFrameSamples(
  before: FrameSample,
  after: FrameSample,
): { readonly changedPercent: number; readonly responded: boolean } {
  const pixels = Math.min(
    Math.floor(before.data.length / 4),
    Math.floor(after.data.length / 4),
    before.width * before.height,
    after.width * after.height,
  );
  if (before.width !== after.width || before.height !== after.height || pixels === 0)
    return { changedPercent: 100, responded: true };
  let changed = 0;
  for (let index = 0; index < pixels; index++) {
    const offset = index * 4;
    const red = Math.abs((before.data[offset] ?? 0) - (after.data[offset] ?? 0));
    const green = Math.abs((before.data[offset + 1] ?? 0) - (after.data[offset + 1] ?? 0));
    const blue = Math.abs((before.data[offset + 2] ?? 0) - (after.data[offset + 2] ?? 0));
    if (Math.max(red, green, blue) > CHANNEL_TOLERANCE) changed++;
  }
  const changedPercent = Math.round((changed / pixels) * 10_000) / 100;
  return {
    changedPercent,
    responded: changedPercent >= RESPONDED_THRESHOLD_PERCENT,
  };
}
