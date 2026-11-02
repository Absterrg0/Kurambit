"""Render every Kurambit icon from the fox artwork in assets/brand.

Usage: python3 scripts/export-brand-icons.py [--check]

Needs Pillow. The artwork is ink and vermilion on washi paper; the paper is
separated out so each channel can place the fox on its own ground.
"""

import io
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "assets" / "brand"
ARTWORK = BRAND / "kurambit-artwork.png"

INK = (21, 18, 15)
PAPER = (236, 225, 206)
CREAM = (240, 230, 213)
VERMILION = (200, 70, 30)
NIGHT = (24, 28, 44)

# Face and ears; the full sitting fox is too thin to read at icon sizes.
HEAD_BOX = (225, 45, 825, 645)

CHANNELS = {
    "prod": {"name": "kurambit", "ground": PAPER, "fox": "ink", "grain": True},
    "dev": {"name": "kurambit-dev", "ground": INK, "fox": "light", "grain": False},
    "nightly": {"name": "kurambit-nightly", "ground": NIGHT, "fox": "light", "grain": False},
}


def smooth(lo, hi, v):
    if v <= lo:
        return 0.0
    if v >= hi:
        return 1.0
    t = (v - lo) / (hi - lo)
    return t * t * (3 - 2 * t)


def separate(src):
    """Un-mix pigment from paper into an ink mark and a cream mark for dark grounds."""
    w, h = src.size
    # Low-frequency paper estimate so uneven lighting does not read as ink.
    paper = (
        src.resize((32, 48), Image.BILINEAR)
        .filter(ImageFilter.MaxFilter(5))
        .resize((w, h), Image.BILINEAR)
    )
    ink = Image.new("RGBA", (w, h))
    light = Image.new("RGBA", (w, h))
    sp, pp, ip, lp = src.load(), paper.load(), ink.load(), light.load()
    for y in range(h):
        for x in range(w):
            r, g, b = sp[x, y]
            pr, pg, pb = pp[x, y]
            a = smooth(0.14, 0.62, max(1 - r / max(pr, 1), 1 - g / max(pg, 1), 1 - b / max(pb, 1)))
            if a <= 0:
                continue
            inv = 1 / max(a, 1e-3)
            fr, fg, fb = (max(0.0, min(255.0, (c - (1 - a) * p) * inv)) for c, p in ((r, pr), (g, pg), (b, pb)))
            alpha = int(a * 255)
            if max(fr, fg, fb) - min(fr, fg, fb) > 90 and fr > fb:
                ip[x, y] = (int(fr), int(fg), int(fb), alpha)
                lp[x, y] = (min(255, int(fr * 1.12)), int(fg * 1.1), int(fb), alpha)
            else:
                ip[x, y] = (*INK, alpha)
                lp[x, y] = (*CREAM, alpha)
    solid = ink.split()[3].point(lambda v: 255 if v > 90 else 0).getbbox()
    pad = 24
    box = (max(0, solid[0] - pad), max(0, solid[1] - pad), min(w, solid[2] + pad), min(h, solid[3] + pad))
    return ink, light, box


def grain(size, seed_image):
    """Paper fibre taken from the artwork's own blank corner, tiled."""
    sample = seed_image.crop((0, 1300, 236, 1536)).convert("L")
    sample = ImageChops.subtract(sample, sample.filter(ImageFilter.GaussianBlur(12)), scale=1, offset=128)
    tiled = Image.new("L", (size, size))
    for y in range(0, size, sample.height):
        for x in range(0, size, sample.width):
            tiled.paste(sample, (x, y))
    return tiled


def tile(size, ground, with_grain, artwork):
    radius = round(size * 0.225)
    body = Image.new("RGBA", (size, size), (*ground, 255))
    if with_grain:
        g = grain(size, artwork).point(lambda v: max(0, min(255, 128 + (v - 128) * 2)))
        body = Image.composite(
            Image.new("RGBA", (size, size), tuple(max(0, c - 14) for c in ground) + (255,)),
            body,
            g.point(lambda v: max(0, 128 - v) * 2),
        )
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(body, (0, 0), mask)
    return out


def seal(size):
    """A vermilion hanko stamp: the accent the fox's tail carries in the artwork."""
    scale = 4
    big = size * scale
    s = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(s)
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=max(1, big // 6), fill=(*VERMILION, 255))
    # A crescent claw, after the karambit blade the product is named for.
    r = big * 0.3
    cx, cy = big * 0.5, big * 0.52
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(*CREAM, 255))
    r2 = r * 0.92
    ox, oy = cx + r * 0.42, cy - r * 0.34
    d.ellipse((ox - r2, oy - r2, ox + r2, oy + r2), fill=(*VERMILION, 255))
    return s.resize((size, size), Image.LANCZOS)


def icon(size, channel, marks, artwork, inset=0.0):
    spec = CHANNELS[channel]
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    body = round(size * (1 - 2 * inset))
    t = tile(body, spec["ground"], spec["grain"], artwork)
    head = marks[spec["fox"]].crop(HEAD_BOX)
    fox_size = round(body * 0.78)
    fox = head.resize((fox_size, fox_size), Image.LANCZOS)
    t.alpha_composite(fox, ((body - fox_size) // 2, round(body * 0.12)))
    seal_size = round(body * 0.16)
    if seal_size >= 4:
        t.alpha_composite(seal(seal_size), (round(body * 0.76), round(body * 0.76)))
    if inset:
        shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        sm = Image.new("L", (size, size), 0)
        off = round(size * inset)
        ImageDraw.Draw(sm).rounded_rectangle(
            (off, off + size * 0.012, off + body, off + body + size * 0.012), radius=round(body * 0.225), fill=110
        )
        shadow.putalpha(sm.filter(ImageFilter.GaussianBlur(size * 0.014)))
        canvas.alpha_composite(shadow)
        canvas.alpha_composite(t, (off, off))
    else:
        canvas.alpha_composite(t)
    return canvas


def ico(images):
    buf = io.BytesIO()
    biggest = max(images, key=lambda im: im.size[0])
    biggest.save(buf, format="ICO", sizes=[im.size for im in images], append_images=images)
    return buf.getvalue()


def png(image):
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def outputs():
    artwork = Image.open(ARTWORK).convert("RGB")
    ink, light, box = separate(artwork)
    marks = {"ink": ink, "light": light}
    files = {
        BRAND / "kurambit-mark.png": png(ink.crop(box)),
        BRAND / "kurambit-mark-light.png": png(light.crop(box)),
        BRAND / "kurambit-head.png": png(ink.crop(HEAD_BOX).resize((512, 512), Image.LANCZOS)),
        BRAND / "kurambit-head-light.png": png(light.crop(HEAD_BOX).resize((512, 512), Image.LANCZOS)),
    }
    for channel, spec in CHANNELS.items():
        base = ROOT / "assets" / channel / spec["name"]
        render = lambda s, inset=0.0: icon(s, channel, marks, artwork, inset)
        files[Path(f"{base}-universal-1024.png")] = png(render(1024, 0.03))
        files[Path(f"{base}-macos-1024.png")] = png(render(1024, 100 / 1024))
        files[Path(f"{base}-windows.ico")] = ico([render(s) for s in (16, 24, 32, 48, 64, 128, 256)])
        files[Path(f"{base}-web-favicon.ico")] = ico([render(s) for s in (16, 32, 48)])
        files[Path(f"{base}-web-favicon-16x16.png")] = png(render(16))
        files[Path(f"{base}-web-favicon-32x32.png")] = png(render(32))
        files[Path(f"{base}-web-apple-touch-180.png")] = png(render(180))
    dev = ROOT / "assets" / "dev" / "kurambit-dev"
    public = ROOT / "apps" / "web" / "public"
    for source, target in (
        ("web-favicon.ico", "favicon.ico"),
        ("web-favicon-16x16.png", "favicon-16x16.png"),
        ("web-favicon-32x32.png", "favicon-32x32.png"),
        ("web-apple-touch-180.png", "apple-touch-icon.png"),
    ):
        files[public / target] = files[Path(f"{dev}-{source}")]
    return files


def main():
    check = "--check" in sys.argv
    stale = []
    for path, data in outputs().items():
        if check:
            if not path.exists() or path.read_bytes() != data:
                stale.append(path.relative_to(ROOT))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    if stale:
        print("Brand icons are out of date; run vp run icons:export:", *stale, sep="\n  ")
        sys.exit(1)


if __name__ == "__main__":
    main()
