// The share of a frame one colour holds, which game_check's flat-view reading uses.

/**
 * The share of pixels the most common colour holds, quantised to 4 bits a channel; `stride` 4
 * reads RGBA (a decoded PNG), its alpha ignored.
 */
export const dominantShare = (rgb: Uint8Array, stride = 3): number => {
  const counts = new Uint32Array(4096);
  let top = 0;
  const pixels = Math.floor(rgb.length / stride);
  for (let i = 0; i < pixels * stride; i += stride) {
    const bucket = ((rgb[i]! >> 4) << 8) | ((rgb[i + 1]! >> 4) << 4) | (rgb[i + 2]! >> 4);
    const count = ++counts[bucket]!;
    if (count > top) top = count;
  }
  return pixels === 0 ? 0 : top / pixels;
};
