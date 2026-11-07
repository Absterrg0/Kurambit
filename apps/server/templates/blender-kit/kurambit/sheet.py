"""read_sheet(): a turnaround sheet measured from its own pixels, for paint and carve.

A sheet is two to four orthographic views of one subject side by side (front, side, back) on a
plain background. Everything is measured, never typed in by hand:
  mask      the background flood-filled from the border, plus unmistakable background the figure
            encloses (between the legs) as extra seeds, so a cream collar close to the background
            stays foreground; then closed (specks of background inside the figure) and eroded, so
            no background halo is projected onto silhouettes and a thin ground line drops out;
  views     split at the mask's empty columns; specks are dropped;
  each view its crown and baseline rows and its centre column;
  labels    left to right front, side, back by convention, but the pair of views with the most
            similar widths is front and back (a statue's side can be its widest view), and a side
            view's facing is read from where the feet or base reach; `labels` overrides.
A sheet that cannot be read this way is refused with the reason, before anything is baked.

Images are (H, W, C) float arrays, row 0 at the top, values as the file stores them (sRGB)."""
import bpy
import numpy as np

from .protocol import Refused

LABELS = ("front", "back", "left", "right")
ERODE = 2  # px the mask is eroded, so no background halo is projected
# The subject faces -Y, +X is its left. right_axis: the world direction that runs left to right in
# the view's image; look: the direction its camera looks.
AXES = {
    "front": ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
    "back": ((-1.0, 0.0, 0.0), (0.0, -1.0, 0.0)),
    "left": ((0.0, 1.0, 0.0), (-1.0, 0.0, 0.0)),  # shows its left side: it faces image-left
    "right": ((0.0, -1.0, 0.0), (1.0, 0.0, 0.0)),  # shows its right side: it faces image-right
}


def load_image(path):
    """(H, W, 4) float32, row 0 at the top, the file's own values (no colour transform)."""
    img = bpy.data.images.load(path, check_existing=False)
    try:
        img.colorspace_settings.name = "Non-Color"
        w, h = img.size
        if w == 0 or h == 0:
            raise Refused("invalid-input", f"{path} could not be read as an image")
        a = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(a)
    finally:
        bpy.data.images.remove(img)
    return a.reshape(h, w, 4)[::-1].copy()


# ----------------------------------------------------------------------------- 2D filters (numpy)

def box_blur(a, r):
    """Mean over a (2r+1)² box, edges clamped; a is (H, W) or (H, W, C)."""
    if r < 1:
        return a
    for axis in (0, 1):
        n = a.shape[axis]
        pad = [(0, 0)] * a.ndim
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis, dtype=np.float64)
        hi = np.take(c, np.arange(2 * r + 1, n + 2 * r + 1), axis=axis)
        lo = np.take(c, np.arange(0, n), axis=axis)
        a = ((hi - lo) / (2 * r + 1)).astype(np.float32)
    return a


def blur(a, sigma):
    """A Gaussian of sigma px, as three box blurs."""
    w = np.sqrt(12 * sigma * sigma / 3 + 1)
    r = max(1, int(round((w - 1) / 2)))
    for _ in range(3):
        a = box_blur(a, r)
    return a


def _shift(m, d, axis, fill):
    out = np.full_like(m, fill)
    n = m.shape[axis]
    if d > 0:
        src, dst = slice(0, n - d), slice(d, n)
    else:
        src, dst = slice(-d, n), slice(0, n + d)
    idx_s = [slice(None)] * m.ndim
    idx_d = [slice(None)] * m.ndim
    idx_s[axis], idx_d[axis] = src, dst
    out[tuple(idx_d)] = m[tuple(idx_s)]
    return out


def dilate(m, r):
    for axis in (0, 1):
        out = m.copy()
        for d in range(1, r + 1):
            out |= _shift(m, d, axis, False) | _shift(m, -d, axis, False)
        m = out
    return m


def erode(m, r):
    for axis in (0, 1):
        out = m.copy()
        for d in range(1, r + 1):
            out &= _shift(m, d, axis, True) & _shift(m, -d, axis, True)
        m = out
    return m


def _fill_runs(reach, passable):
    """Every run of passable pixels along a row that holds a reached pixel becomes reached."""
    start = passable & ~_shift(passable, 1, 1, False)
    run = np.cumsum(start.ravel()).reshape(passable.shape)
    hit = np.zeros(int(run.max()) + 2, bool)
    hit[run[reach & passable]] = True
    return passable & hit[run]


def flood(seed, passable):
    """The passable pixels connected to seed (4-neighbours), by alternating row and column runs."""
    reach = seed & passable
    count = -1
    while int(reach.sum()) != count:
        count = int(reach.sum())
        reach = _fill_runs(reach, passable)
        reach = _fill_runs(reach.T, passable.T).T
    return reach


def runs(row):
    """For each pixel of a boolean row: the centre and half width (px) of the run it is in."""
    n = len(row)
    c = np.zeros(n, np.float32)
    h = np.ones(n, np.float32)
    edges = np.flatnonzero(np.diff(np.concatenate([[0], row.astype(np.int8), [0]])))
    for a, b in zip(edges[::2], edges[1::2]):
        c[a:b] = (a + b - 1) / 2
        h[a:b] = max((b - a) / 2, 1.0)
    return c, h


# ----------------------------------------------------------------------------- the sheet

def _background(rgb, thr):
    h, w = rgb.shape[:2]
    b = 4
    border = np.concatenate([rgb[:b].reshape(-1, 3), rgb[-b:].reshape(-1, 3), rgb[:, :b].reshape(-1, 3), rgb[:, -b:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    plain = float((np.abs(border - bg).max(axis=1) < thr).mean())
    if plain < 0.9:
        raise Refused("invalid-input", f"the sheet has no plain background: only {plain:.0%} of its border is one colour. A sheet needs its views on a plain, even background (no scenery, gradient or frame), so the figure can be told from it.")
    return bg


def _mask(rgb, bg, thr):
    dist = np.abs(rgb - bg).max(axis=2)
    bglike = dist < thr
    seed = np.zeros_like(bglike)
    seed[0, :] = seed[-1, :] = seed[:, 0] = seed[:, -1] = True
    seed |= dist < thr * 0.25  # unmistakable background the figure encloses
    fg = ~flood(seed, bglike)
    fg = erode(dilate(fg, 4), 4)
    return erode(fg, ERODE)


def _segments(mask):
    cols = mask.any(axis=0)
    edges = np.flatnonzero(np.diff(np.concatenate([[0], cols.astype(np.int8), [0]])))
    segs = [(int(a), int(b)) for a, b in zip(edges[::2], edges[1::2])]
    area = [int(mask[:, a:b].sum()) for a, b in segs]
    big = max(area, default=0)
    return [s for s, n in zip(segs, area) if n >= 0.03 * big]


def _facing(m):
    """+1 when a side view's subject faces image-right, -1 image-left, 0 when it cannot tell: the
    feet or base reach further forward than the shins or the body above them."""
    rows = np.flatnonzero(m.any(axis=1))
    if len(rows) < 20:
        return 0
    top, bot = rows[0], rows[-1]
    h = bot - top
    def centre(r0, r1):
        sub = m[int(r0):int(r1)]
        ys, xs = np.nonzero(sub)
        return xs.mean() if len(xs) else None
    foot = centre(bot - 0.04 * h, bot + 1)
    leg = centre(bot - 0.25 * h, bot - 0.12 * h)
    w = m.shape[1]
    if foot is None or leg is None:
        return 0
    d = (foot - leg) / max(w, 1)
    return 0 if abs(d) < 0.03 else (1 if d > 0 else -1)


class SheetView:
    """One view of the sheet: its crop (x0, x1) and rows (crown, base), its centre column, its
    label (front, back, left, right) and its own mask crop."""

    def __init__(self, label, x0, x1, crown, base, centre, fixed):
        self.label, self.x0, self.x1, self.crown, self.base, self.centre = label, x0, x1, crown, base, centre
        self.fixed = fixed  # named by the caller; otherwise a side view's facing may still be fitted

    def describe(self):
        return {"label": self.label, "columns": [self.x0, self.x1], "crown": self.crown, "base": self.base, "centre": round(float(self.centre), 1)}


def read_sheet(path, labels=None, thr=0.05):
    """The sheet's image, mask, high-pass detail and views. labels: the views left to right
    (front, back, left, right), when the measured order is not the sheet's."""
    if labels and (len(set(labels)) != len(labels) or not set(labels) <= set(LABELS)):
        raise Refused("invalid-input", f"views names each view once, from {', '.join(LABELS)}: got {', '.join(labels)}")
    px = load_image(path)
    rgb = px[:, :, :3]
    H, W = rgb.shape[:2]
    bg = _background(rgb, thr)
    mask = _mask(rgb, bg, thr)
    share = float(mask.mean())
    if share < 0.01:
        raise Refused("invalid-input", "the sheet shows no figure on its background")
    if share > 0.7:
        raise Refused("invalid-input", f"{share:.0%} of the sheet reads as figure, not background: a sheet needs its views on a plain background with space around each")
    segs = _segments(mask)
    want = len(labels) if labels else 3
    if len(segs) != want:
        why = ("its views touch or overlap, or one is missing" if len(segs) < want else "it holds more figures than views")
        raise Refused("invalid-input", f"the sheet splits into {len(segs)} figure{'s' if len(segs) != 1 else ''} at its empty columns where {want} views were expected: {why}. A sheet needs {'its views' if labels else 'front, side and back'} side by side with background between them, nothing overlapping{'' if labels else ' (name the views with views when there are two or four)'}.")
    views = []
    for x0, x1 in segs:
        m = mask[:, x0:x1]
        rows = np.flatnonzero(m.any(axis=1))
        crown, base = int(rows[0]), int(rows[-1])
        crown, base = max(crown - ERODE, 0), min(base + ERODE, H - 1)  # the figure's own rows
        edge = []
        if crown <= 1:
            edge.append("top")
        if base >= H - 2:
            edge.append("bottom")
        if x0 <= 1:
            edge.append("left")
        if x1 >= W - 1:
            edge.append("right")
        if edge:
            raise Refused("invalid-input", f"the figure in columns {x0}-{x1} is cut off at the sheet's {' and '.join(edge)} edge: every view must show the whole subject with background around it")
        ys, xs = np.nonzero(m)
        views.append({"x0": x0, "x1": x1, "crown": crown, "base": base, "centre": x0 + (xs.min() + xs.max()) / 2, "facing": _facing(m)})
    notes = []
    if labels:
        names = list(labels)
    else:
        # front and back: the most similar widths (mirror images); the side the odd one out
        wd = [v["x1"] - v["x0"] for v in views]
        pairs = sorted((abs(wd[i] - wd[j]) / max(wd[i], wd[j]), i, j) for i, j in ((0, 1), (0, 2), (1, 2)))
        (diff, i, j), second = pairs[0], pairs[1][0]
        if second - diff > 0.05:
            side = 3 - i - j
        else:  # three like widths (a pillar): the order a sheet is drawn in
            side, i, j = 1, 0, 2
        facing = views[side]["facing"]
        names = [None] * 3
        names[min(i, j)], names[max(i, j)] = "front", "back"
        names[side] = "right" if facing > 0 else "left"
        if facing == 0:
            notes.append("the side view's facing could not be read from the sheet: taken as facing left (it shows the subject's left side)")
    heights = [v["base"] - v["crown"] for v in views]
    med = float(np.median(heights))
    for v, h, name in zip(views, heights, names):
        if abs(h - med) > 0.06 * med:
            notes.append(f"the {name} view is {h} px tall where the others are about {med:.0f}: a sheet's views share one scale, so check that none is cut or posed differently")
    # A side view's facing read from the sheet is kept: a near-symmetric figure's silhouette
    # barely tells the two facings apart, so only an unreadable facing is left to the fit.
    out = [SheetView(n, v["x0"], v["x1"], v["crown"], v["base"], v["centre"], bool(labels) or v["facing"] != 0) for n, v in zip(names, views)]
    if not any(v.label == "front" for v in out):
        raise Refused("invalid-input", "the views name no front view: a sheet needs one")
    lum = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    return {"rgb": rgb, "mask": mask.astype(np.float32), "lum": lum, "views": out, "background": [round(float(c), 3) for c in bg], "notes": notes, "size": (W, H)}
