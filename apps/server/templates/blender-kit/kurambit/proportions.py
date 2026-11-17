"""A body restyled before it is conformed: head, legs, arms, hands, feet and girth scaled by a
preset (realistic, heroic, cartoon, chibi) or by hand, then the whole to a height.

Each region of the body (legs, feet, torso, arms, hands, head) has its own map, and the maps agree
at the joints between regions (a hip, a shoulder, the base of the neck), so blending them by the
skin's own weights, as skinning blends bones, keeps the surface whole. The joints move with the
same maps, so the rig the body came with still fits it. Pure numpy: the bpy side is in
character.py.

Space: Z up, the body facing -Y, feet on z = 0, metres.
"""
import numpy as np

PRESETS = {
    "realistic": {},
    "heroic": {"head": 0.9, "legs": 1.08, "hands": 1.05, "girth": 1.1, "limbs": 1.08},
    "cartoon": {"head": 1.35, "legs": 0.82, "arms": 0.9, "hands": 1.25, "feet": 1.25, "girth": 1.05, "limbs": 1.12},
    "chibi": {"head": 2.0, "legs": 0.55, "arms": 0.72, "hands": 1.35, "feet": 1.35, "girth": 1.12, "limbs": 1.3},
}
KEYS = ("head", "legs", "arms", "hands", "feet", "girth", "limbs")
REGIONS = ("torso", "legs", "feet", "arms", "hands", "neck", "head")
# Standard joints by region; a joint not named falls to its nearest named ancestor's region.
_REGION_OF = {
    "root": "torso", "pelvis": "torso", "spine_01": "torso", "spine_02": "torso", "spine_03": "torso",
    "clavicle_l": "torso", "clavicle_r": "torso",
    "neck_01": "neck", "Head": "head",
    "thigh_l": "legs", "thigh_r": "legs", "calf_l": "legs", "calf_r": "legs",
    "foot_l": "feet", "foot_r": "feet", "ball_l": "feet", "ball_r": "feet",
    "upperarm_l": "arms", "upperarm_r": "arms", "lowerarm_l": "arms", "lowerarm_r": "arms",
    "hand_l": "hands", "hand_r": "hands",
}


def resolve(style):
    """The factors for a style: {preset?, head?, legs?, arms?, hands?, feet?, girth?, limbs?}; a factor
    given beside a preset overrides the preset's."""
    style = dict(style or {})
    preset = style.pop("preset", "realistic")
    if preset not in PRESETS:
        raise ValueError(f"style preset {preset!r}: one of {', '.join(PRESETS)}")
    out = {k: 1.0 for k in KEYS}
    out.update(PRESETS[preset])
    for k, v in style.items():
        if k not in KEYS:
            raise ValueError(f"style {k!r}: one of preset, {', '.join(KEYS)}")
        out[k] = float(v)
    for k, v in out.items():
        if not 0.3 <= v <= 3.0:
            raise ValueError(f"style {k} {v:g}: between 0.3 and 3")
    return out


def region_of(std):
    return _REGION_OF.get(std)


def _ramp(z, z0, z1):
    return np.clip((z - z0) / max(1e-9, z1 - z0), 0.0, 1.0)


def maps(marks, f):
    """{region: points -> points} from the landmarks (standard joint name -> (x, y, z) of its head)
    and the factors. Needs pelvis, spine_03, neck_01, Head, thigh, calf, foot, upperarm and hand on
    both sides."""
    m = {k: np.asarray(v, float) for k, v in marks.items()}
    ankle = (m["foot_l"][2] + m["foot_r"][2]) / 2
    hip = (m["thigh_l"][2] + m["thigh_r"][2]) / 2
    drop = (hip - ankle) * (1 - f["legs"])
    axis = m["pelvis"][:2]
    chest = m["spine_03"][2]

    def torso(p):
        p = np.array(p, float)
        g = 1 + (f["girth"] - 1) * _ramp(p[:, 2], hip, chest)
        p[:, :2] = axis + (p[:, :2] - axis) * g[:, None]
        p[:, 2] -= drop
        return p

    def legs(p):
        p = np.array(p, float)
        z = p[:, 2]
        mid = (z >= ankle) & (z <= hip)
        # Thicker or thinner about each leg's own line, hip to ankle.
        for side in ("l", "r"):
            h, a = m[f"thigh_{side}"], m[f"foot_{side}"]
            sel = np.sign(p[:, 0] - axis[0]) == np.sign(h[0] - axis[0])
            t = _ramp(z[sel], a[2], h[2])
            centre = a[:2] + (h[:2] - a[:2]) * t[:, None]
            p[sel, :2] = centre + (p[sel, :2] - centre) * f["limbs"]
        p[:, 2] = np.where(z > hip, z - drop, np.where(mid, ankle + (z - ankle) * f["legs"], z))
        return p

    def feet(p):
        p = np.array(p, float)
        out = legs(p)
        for side in ("l", "r"):
            a = m[f"foot_{side}"]
            near = np.sign(p[:, 0] - axis[0]) == np.sign(a[0] - axis[0])
            out[near, :2] = a[:2] + (p[near, :2] - a[:2]) * f["feet"]
        return out

    def arm_side(p, side):
        # Longer or shorter along the arm, thicker or thinner across it, from the shoulder.
        s = m[f"upperarm_{side}"]
        s2 = torso(s[None])[0]
        d = m[f"hand_{side}"] - s
        d = d / max(1e-9, np.linalg.norm(d))
        v = p - s
        along = v @ d
        return s2 + np.outer(along, d) * f["arms"] + (v - np.outer(along, d)) * f["limbs"]

    def arms(p):
        p = np.array(p, float)
        left = np.sign(p[:, 0] - axis[0]) == np.sign(m["upperarm_l"][0] - axis[0])
        out = np.empty_like(p)
        out[left] = arm_side(p[left], "l")
        out[~left] = arm_side(p[~left], "r")
        return out

    def hands(p):
        p = np.array(p, float)
        left = np.sign(p[:, 0] - axis[0]) == np.sign(m["hand_l"][0] - axis[0])
        out = np.empty_like(p)
        for side, sel in (("l", left), ("r", ~left)):
            w = m[f"hand_{side}"]
            w2 = arm_side(w[None], side)[0]
            out[sel] = w2 + (p[sel] - w) * f["arms"] * f["hands"]
        return out

    def neck(p):
        # The neck keeps its length and follows the torso; it thickens toward a bigger head.
        n = m["neck_01"]
        n2 = torso(n[None])[0]
        v = p - n
        v[:, :2] *= f["head"] ** 0.5
        return n2 + v

    def head(p):
        k = m["Head"]
        k2 = neck(k[None])[0]
        return k2 + (np.array(p, float) - k) * f["head"]

    return {"torso": torso, "legs": legs, "feet": feet, "arms": arms, "hands": hands, "neck": neck, "head": head}


def blend(points, weights, regions_maps):
    """points (N, 3) moved by each region's map, blended by weights (N, len(REGIONS)) whose rows
    sum to 1 (a row of zeros keeps its point)."""
    points = np.asarray(points, float)
    weights = np.asarray(weights, float)
    out = np.zeros_like(points)
    total = weights.sum(axis=1)
    for i, r in enumerate(REGIONS):
        w = weights[:, i]
        sel = w > 1e-6
        if sel.any():
            out[sel] += regions_maps[r](points[sel]) * w[sel, None]
    keep = total < 1e-6
    out[keep] = points[keep]
    out[~keep] /= total[~keep, None]
    return out


def to_height(points, ground, height, target):
    """Points scaled about the ground under the origin so height becomes target."""
    k = target / max(1e-9, height)
    p = np.asarray(points, float).copy()
    p[:, :2] *= k
    p[:, 2] = ground + (p[:, 2] - ground) * k
    return p, k
