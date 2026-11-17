"""A hero's gates as numbers: height in its declared range, the worst edge stretch and squash
against rest, clothing inside the body, feet on the ground and not skating, and the budget.

Pure numpy (no bpy): deform.py samples the clips in Blender and hands the arrays here, so every
threshold and measure is testable on its own. Each gate returns {"name", "pass", "value", "limit",
"text"}; a failing text names the clip, the frame and the part.
"""
import numpy as np

# A human body's height when its brief names none; any other subject declares its own range.
HUMAN_HEIGHT = (1.5, 2.0)
# Linear blend skinning stretches a shoulder and squashes the inside of a bent knee even on a good
# body: Quaternius' base body on the library's own walk, jog, sprint and jump reaches 2.9x at its
# 99.9th percentile edge, 6.6x at its single worst, and squashes to 0.27x at its 0.1st percentile
# (edges of 1% of its height and up; smaller ones are fingers and eyelids); an MPFB2 body's jump
# squashes to 0.13x. So the gate takes the
# spread (a percentile, where a cone of a coat or a torn armpit shows) and the single worst edge
# (where one vertex weighted to the wrong bone shows), each past what that body does.
STRETCH_SPREAD_MAX = 3.2
STRETCH_WORST_MAX = 8.0
SQUASH_SPREAD_MIN = 0.08
EDGE_SHARE = 0.01
# Clothing sunk into the body deeper than this shows skin through it.
CLOTH_DEPTH_MAX = 0.015
# A share of a garment's outside that may sit that deep before it fails: a knee-length coat on
# hem chains that follow the legs keeps under it in a walk and a jog; a sprint's kick passes 4%.
CLOTH_SHARE_MAX = 0.02
# A planted foot comes down within this share of the hero's height of the ground it stood on at
# rest, and strays no further than SLIDE_SHARE from the path of a foot planted at ground speed:
# 6.3 cm and 7.2 cm on a 1.8 m human, 1 cm at least. The library's own walk, jog and sprint on its
# base body reach 3.0 cm and 5.0 cm, on an MPFB2 cartoon body 2.3 and 5.9, on a 1 m chibi 4.2 and
# 2.0; a gait keyed by hand skates several times that.
CONTACT_SHARE, CONTACT_FLOOR = 0.035, 0.01
SLIDE_SHARE, SLIDE_FLOOR = 0.04, 0.01


def feet_limits(hero_height):
    return max(CONTACT_FLOOR, CONTACT_SHARE * hero_height), max(SLIDE_FLOOR, SLIDE_SHARE * hero_height)


def gate(name, ok, value, limit, text):
    return {"name": name, "pass": bool(ok), "value": value, "limit": limit, "text": text}


def height(measured, lo, hi):
    ok = lo <= measured <= hi
    return gate("height", ok, round(float(measured), 3), [lo, hi],
                f"{measured:.2f} m tall, in its {lo:g}-{hi:g} m range" if ok else
                f"{measured:.2f} m tall, outside its {lo:g}-{hi:g} m range: scale it, or declare the range the brief means (op character's height or heightRange, hero.creature_rig's height)")


def edge_lengths(coords, edges):
    coords = np.asarray(coords, float)
    edges = np.asarray(edges, int)
    if len(edges) == 0:
        return np.zeros(0)
    return np.linalg.norm(coords[edges[:, 0]] - coords[edges[:, 1]], axis=1)


def strain(rest, posed, min_edge):
    """{"spread": 99.9th percentile stretch, "worst": max stretch, "squash": 0.1st percentile ratio,
    "edge": the worst edge, "spread_edge": the edge at the spread} of posed over rest edge lengths,
    edges of min_edge and up."""
    rest = np.asarray(rest, float)
    posed = np.asarray(posed, float)
    idx = np.nonzero(rest >= min_edge)[0]
    if len(idx) == 0:
        return None
    r = posed[idx] / rest[idx]
    hi = float(np.percentile(r, 99.9))
    lo = float(np.percentile(r, 0.1))
    return {"spread": hi, "worst": float(r.max()), "squash": lo, "edge": int(idx[int(np.argmax(r))]),
            "spread_edge": int(idx[int(np.argmin(np.abs(r - hi)))])}


def deformation(spread, worst, squash):
    return spread <= STRETCH_SPREAD_MAX and worst <= STRETCH_WORST_MAX and squash >= SQUASH_SPREAD_MIN


def depths(points, nearest, normals):
    """How deep each point is inside a surface, from its nearest surface point and that point's
    outward normal: positive inside, zero or less outside."""
    d = np.einsum("ij,ij->i", np.asarray(nearest, float) - np.asarray(points, float), np.asarray(normals, float))
    return d


def sunk(depth, rest_depth, limit=CLOTH_DEPTH_MAX):
    """(worst depth past what already was at rest, its vertex, the share of vertices deeper than
    limit): a garment modelled tucked under a strap at rest counts once, at rest."""
    depth = np.asarray(depth, float)
    extra = depth - np.maximum(0.0, np.asarray(rest_depth, float))
    if len(extra) == 0:
        return 0.0, None, 0.0
    i = int(np.argmax(extra))
    return float(max(0.0, extra[i])), i, float(np.mean(extra > limit))


def planted_spans(z, planted):
    spans, k, n = [], 0, len(planted)
    while k < n:
        if planted[k]:
            j = k
            while j + 1 < n and planted[j + 1]:
                j += 1
            spans.append((k, j))
            k = j + 1
        else:
            k += 1
    return spans


def plants(track, band):
    """The frames a foot is planted: within band of the lowest it gets in the clip (a stance holds the
    foot at its lowest; a sprint's swing passing low over the floor never reaches it)."""
    z = np.asarray(track, float)[:, 2]
    return z - z.min() < band


def ground_speed(tracks, bands, fps, forward=(0.0, -1.0, 0.0)):
    """An in-place clip's ground speed from its feet: the median speed back of the planted feet."""
    speeds = []
    for f, tr in tracks.items():
        tr = np.asarray(tr, float)
        if len(tr) < 3:
            continue
        along = -(np.gradient(tr, axis=0) * fps) @ np.asarray(forward, float)
        speeds += list(along[plants(tr, bands[f])])
    return float(np.median(speeds)) if speeds else 0.0


def feet(track, rest_z, planted, ground_speed, fps, forward=(0.0, -1.0, 0.0)):
    """(contact error, its frame, worst slide, its frame) for one foot's in-place track: how far the
    lowest the foot gets is from the height it stood at at rest (a foot that never comes down
    floats, one that goes under sinks), and how far it strays while planted from a foot sliding back
    at the ground speed."""
    track = np.asarray(track, float)
    planted = np.asarray(planted, bool)
    low = int(np.argmin(track[:, 2]))
    contact, cat = float(abs(track[low, 2] - rest_z)), low
    slide, sat = 0.0, None
    for a, b in planted_spans(track[:, 2], planted):
        if b > a:
            steps = np.arange(b - a + 1) / fps
            ideal = track[a] - np.outer(steps, np.asarray(forward, float) * ground_speed)
            off = np.linalg.norm((track[a:b + 1] - ideal)[:, :2], axis=1)
            if off.max() > slide:
                slide, sat = float(off.max()), a + int(np.argmax(off))
    return contact, cat, slide, sat


def budget(triangles, materials, textures, limits):
    """limits: {"triangles", "materials", "texture"} (a texture's longest side, px)."""
    side = max([max(t["width"], t["height"]) for t in textures] or [0])
    over = []
    if triangles > limits["triangles"]:
        over.append(f"{triangles} triangles over {limits['triangles']}")
    if materials > limits["materials"]:
        over.append(f"{materials} materials over {limits['materials']}")
    if side > limits["texture"]:
        over.append(f"a {side} px texture over {limits['texture']} px")
    return gate("budget", not over, int(triangles), limits,
                "; ".join(over) if over else f"{triangles} triangles, {materials} materials, textures up to {side} px: within budget")
