"""The review's reference compare: a model's silhouettes against a reference's, as numbers.

Masks are (H, W) booleans, row 0 at the top. Two framings are compared:
  same camera   both rendered by one orthographic camera (a library model as yardstick): size
                and placement count, so a building half the yardstick's height overlaps little;
  same height   each figure cropped to itself and scaled to one height, feet on one row,
                centred: shape alone, which is all an image reference can say.
The width profile is each figure's width in tenths of its height, feet first, at the same height:
where a model is too thin or too broad shows band by band. Nothing here judges; the review
prints the numbers and the agent decides."""
import numpy as np

from . import sheet
from .protocol import Refused

FIT_H, FIT_W = 256, 384
BANDS = 10


def mask_of(tile):
    return tile[:, :, 3] > 0.5


def iou(a, b):
    union = int((a | b).sum())
    return float((a & b).sum()) / union if union else 0.0


def fit(mask, h=FIT_H, w=FIT_W):
    """mask's figure scaled to h px tall (aspect kept), bottom row its lowest point, centred."""
    ys, xs = np.nonzero(mask)
    out = np.zeros((h, w), bool)
    if len(ys) == 0:
        return out
    crop = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    ch, cw = crop.shape
    k = h / ch
    nw = max(1, int(round(cw * k)))
    scaled = crop[np.minimum((np.arange(h) / k).astype(int), ch - 1)][:, np.minimum((np.arange(nw) / k).astype(int), cw - 1)]
    x0 = (w - nw) // 2
    a, b = max(0, x0), min(w, x0 + nw)
    out[:, a:b] = scaled[:, a - x0:b - x0]
    return out


def widths(fitted):
    """The figure's width in each tenth of its height, feet first, as a share of its height."""
    h = fitted.shape[0]
    out = []
    for i in range(BANDS):
        rows = fitted[h - (i + 1) * h // BANDS:h - i * h // BANDS]
        cols = np.flatnonzero(rows.any(0))
        out.append(round(float(cols[-1] - cols[0] + 1) / h, 2) if len(cols) else 0.0)
    return out


def thin_share(mask, r=1):
    """Share of a silhouette in parts under 2r + 1 px across: what an opening by r removes."""
    total = int(mask.sum())
    if total == 0:
        return 0.0
    kept = sheet.dilate(sheet.erode(mask, r), r) & mask
    return float(total - kept.sum()) / total


def image_mask(path):
    """The figure in a reference picture: its alpha where it has transparency, else everything
    not its plain background (sheet.py's flood from the border). A picture with several figures
    side by side (a turnaround sheet) gives its leftmost, a sheet's front. Returns (mask, rgba,
    note or None)."""
    px = sheet.load_image(path)
    alpha = px[:, :, 3]
    border = np.concatenate([alpha[0], alpha[-1], alpha[:, 0], alpha[:, -1]])
    if float((border < 0.5).mean()) > 0.9:
        mask = alpha > 0.5
    else:
        try:
            mask = sheet._mask(px[:, :, :3], sheet._background(px[:, :, :3], 0.05), 0.05)
        except Refused as e:
            raise Refused("invalid-input", f"the reference {path} has no transparent or plain background, so its figure cannot be told from it ({e.args[-1] if e.args else e}). Pass the subject alone on a plain background, or a library model.")
    note = None
    segs = sheet._segments(mask)
    if len(segs) > 1:
        a, b = segs[0]
        keep = np.zeros_like(mask)
        keep[:, a:b] = mask[:, a:b]
        mask = keep
        note = f"the reference shows {len(segs)} figures side by side: compared with its leftmost (a sheet's front)"
    if mask.mean() < 0.005:
        raise Refused("invalid-input", f"the reference {path} shows no figure on its background")
    return mask, px, note


def describe(name, model, reference):
    """{view, sameHeight, widths: {model, reference}} for one view's fitted masks."""
    fm, fr = fit(model), fit(reference)
    return {"view": name, "sameHeight": round(iou(fm, fr), 3), "widths": {"model": widths(fm), "reference": widths(fr)}}


def overlay(model, reference):
    """A picture of two same-framed masks: both dark, only the model's orange, only the
    reference's blue."""
    h, w = model.shape
    out = np.zeros((h, w, 4), np.float32)
    both, mo, ro = model & reference, model & ~reference, reference & ~model
    out[both] = (0.08, 0.09, 0.11, 1.0)
    out[mo] = (0.92, 0.55, 0.22, 1.0)
    out[ro] = (0.33, 0.58, 0.93, 1.0)
    return out
