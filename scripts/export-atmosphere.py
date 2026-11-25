"""Render the atmosphere behind empty states: a dim warm light, ordered-dithered.

Usage: python3 scripts/export-atmosphere.py

Needs Pillow. Each pixel of the image is one dither cell; the web draws it at
2 CSS px per cell with pixelated scaling, so the cells stay crisp. A field of
light (strongest at the top, in soft vertical shafts, gone by about half the
height) is thresholded against an 8x8 Bayer matrix, like an old printed
halftone. Cells that are off stay transparent, so the panel shows through.
"""

import math
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps" / "web" / "public"

WIDTH, HEIGHT = 960, 300


def bayer(n):
    if n == 1:
        return [[0]]
    small = bayer(n // 2)
    size = n // 2
    grid = [[0] * n for _ in range(n)]
    for y in range(n):
        for x in range(n):
            base = small[y % size][x % size] * 4
            quadrant = (0, 2, 3, 1)[(y // size) * 2 + (x // size)]
            grid[y][x] = base + quadrant
    return grid


BAYER = bayer(8)


def smoothstep(edge0, edge1, x):
    t = min(max((x - edge0) / (edge1 - edge0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def gauss(x, mu, sigma):
    return math.exp(-((x - mu) ** 2) / (2 * sigma * sigma))


def light(u, v):
    """The light at (u, v) in 0..1, u across, v down."""
    shafts = 0.42 + 0.32 * gauss(u, 0.57, 0.15) + 0.28 * gauss(u, 0.03, 0.09)
    shafts += 0.16 * gauss(u, 0.86, 0.12) + 0.08 * math.sin(u * 23.0 + 1.3)
    fall = (1 - smoothstep(0.0, 1.0, v)) ** 1.1
    # Capped below 1 so even the brightest light keeps a few holes, as a print does.
    return min(max(shafts * fall, 0.0), 0.9)


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(dim, bright, strength):
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    pixels = image.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            level = light(x / (WIDTH - 1), y / (HEIGHT - 1)) * strength
            if level > (BAYER[y % 8][x % 8] + 0.5) / 64:
                # The last sparse cells ease in, so the fade has no edge where the dither ends.
                alpha = round(255 * smoothstep(0.0, 0.22, level))
                pixels[x, y] = (*mix(dim, bright, level), alpha)
    return image


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    # Dark: dim amber on the ink panel, its brightest cells about #4c2d08.
    render((36, 22, 4), (76, 45, 8), 1.0).save(OUT / "atmosphere-dark.png", optimize=True)
    # Light: a warm vermilion wash on paper, fainter so it never competes with ink text.
    render((248, 232, 220), (240, 204, 178), 0.65).save(OUT / "atmosphere-light.png", optimize=True)


if __name__ == "__main__":
    main()
