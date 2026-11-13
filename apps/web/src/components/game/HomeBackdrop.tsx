import { useEffect, useRef } from "react";

import foxInkUrl from "../../assets/brand/fox-ink.webp";
import { observeResize } from "../../lib/observeResize";

// 8x8 Bayer thresholds, the marketing site's dither: one ordered pattern, no noise.
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((value) => (value + 0.5) / 64);
const bayer = (x: number, y: number) => BAYER[(y & 7) * 8 + (x & 7)]!;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** CSS pixels per dither cell. */
const CELL = 4;
/** The page's content column, kept clear so its words never sit on the art. */
const CONTENT_HALF_WIDTH = 420;

/**
 * Home's ground: the fox, large and dithered in vermilion, rising out of a warm glow in the
 * lower right, the way the brand's artwork is drawn on kurambit.com. Drawn once per size,
 * never animated, and behind everything, so the page stays still and cheap.
 */
export function HomeBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const fox = new Image();
    fox.src = foxInkUrl;
    let foxReady = false;
    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const cols = Math.ceil(width / CELL);
      const rows = Math.ceil(height / CELL);
      // The fox's ink, sampled onto the dither grid: tall as the page, its head in the glow.
      let ink: Uint8ClampedArray | null = null;
      if (foxReady) {
        const sample = document.createElement("canvas");
        sample.width = cols;
        sample.height = rows;
        const sampler = sample.getContext("2d", { willReadFrequently: true });
        if (sampler) {
          const foxRows = rows * 1.08;
          const foxCols = (foxRows * fox.naturalWidth) / fox.naturalHeight;
          sampler.drawImage(fox, cols - foxCols * 0.8, rows - foxRows * 0.86, foxCols, foxRows);
          ink = sampler.getImageData(0, 0, cols, rows).data;
        }
      }
      const glowX = cols * 0.96;
      const glowY = rows * 1.02;
      const glowR = Math.max(cols, rows) * 0.58;
      const middle = width / 2;
      const style = getComputedStyle(canvas);
      const hot = new Path2D();
      const mid = new Path2D();
      const warm = new Path2D();
      // A faint pixel grid over the whole ground, the screen the art is drawn on.
      const grid = new Path2D();
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          const dx = (x - glowX) / glowR;
          const dy = (y - glowY) / glowR;
          const px = x * CELL;
          const py = y * CELL;
          // Quiet under the page's content: it fades out toward the middle column.
          const clear = clamp((Math.abs(px - middle) - CONTENT_HALF_WIDTH * 0.55) / 160);
          const glow = clamp(1 - Math.sqrt(dx * dx + dy * dy)) ** 2.4 * clear;
          const strokes = ink === null ? 0 : (ink[(y * cols + x) * 4 + 3]! / 255) * clear;
          const threshold = bayer(x, y);
          // The fox's strokes burn bright where the glow reaches them and fade into the dark.
          const lit = strokes * clamp(glow * 2.6 + 0.3);
          if (lit > threshold) (glow > 0.22 ? hot : mid).rect(px, py, CELL - 1, CELL - 1);
          else if (glow * 0.6 > threshold) warm.rect(px, py, CELL - 1, CELL - 1);
          else if ((x & 1) === 0 && (y & 1) === 0) grid.rect(px, py, CELL - 2, CELL - 2);
        }
      }
      context.fillStyle = style.getPropertyValue("--home-backdrop-grid").trim() || "#141414";
      context.fill(grid, "nonzero");
      context.fillStyle = style.getPropertyValue("--home-backdrop-warm").trim() || "#5a2414";
      context.fill(warm, "nonzero");
      context.fillStyle = style.getPropertyValue("--home-backdrop-mid").trim() || "#8a3418";
      context.fill(mid, "nonzero");
      context.fillStyle = style.getPropertyValue("--home-backdrop-hot").trim() || "#e2582a";
      context.fill(hot, "nonzero");
    };
    fox.addEventListener(
      "load",
      () => {
        foxReady = true;
        draw();
      },
      { once: true },
    );
    draw();
    // Its colours are the theme's: a switch between light and dark redraws it.
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const stopResize = observeResize(canvas, draw);
    return () => {
      theme.disconnect();
      stopResize();
    };
  }, []);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* The light the dither is lit by: a soft vermilion bloom from the lower right. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_75%_at_100%_100%,rgb(226_88_42/0.22),rgb(226_88_42/0.07)_45%,transparent_75%)] dark:bg-[radial-gradient(ellipse_70%_75%_at_100%_100%,rgb(226_88_42/0.28),rgb(226_88_42/0.08)_45%,transparent_75%)]" />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 size-full [--home-backdrop-grid:#ececee] [--home-backdrop-hot:#d14b1f] [--home-backdrop-mid:#e9a184] [--home-backdrop-warm:#f3cbb9] dark:[--home-backdrop-grid:#141414] dark:[--home-backdrop-hot:#ef6a3a] dark:[--home-backdrop-mid:#9a3b1b] dark:[--home-backdrop-warm:#3a180c]"
      />
    </div>
  );
}
