"""What goes on a made character's head: hair(), beard(), glasses() and wear() (a hat or helmet you
modelled, fitted).

Hair by hand came out as one smooth shell (a helmet) or was left off: every hero was bald. hair()
builds what the craft notes ask for, on whatever head the body has: a thin cap that follows the
skull down to a hairline, and chunky tapered locks laid over it in two tiers, the under tier a
shade darker, with one signature lock; in a few shapes (short, long, tied, curly). Everything is
found on the head itself: rays from inside the skull out to its surface, so nothing is placed by
guessed coordinates and the hair of a chibi's head fits a chibi's head.

Directions are (azimuth, elevation) in degrees about the head's centre: azimuth 0 is the face
(-Y), + toward the character's left (+X), 180 the back; elevation 90 is the crown.
"""
import json
import math

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from . import helpers

# The hairline by azimuth (mirrored), as a height: 0 the eye line, 1 the crown. Forehead, temple,
# the dip before the ear, over the ear, behind it, the nape.
HAIRLINE = ((0, 0.6), (35, 0.58), (60, 0.4), (76, -0.05), (92, 0.22), (112, 0.12), (135, -0.45), (180, -0.55))
SHAPES = ("short", "long", "tied", "curly")
MARK = "kurambit_hair"


def _arm(armature):
    return bpy.data.objects[armature] if isinstance(armature, str) else armature


class Head:
    """A character's head at rest: its surface, its centre, and its size."""

    def __init__(self, arm, extra=()):
        from . import cloth

        self.arm = arm
        self.bodies = cloth._bodies(arm)
        verts, polys, heads = [], [], []
        for o in [*self.bodies, *extra]:
            co, faces = helpers.rest_coords(o)
            base = len(verts)
            verts += [Vector(c) for c in co]
            polys += [tuple(base + v for v in f) for f in faces]
            g = o.vertex_groups.get("Head")
            if g is not None and o in self.bodies and len(co) == len(o.data.vertices):
                heads += [co[v.index] for v in o.data.vertices if any(e.group == g.index and e.weight > 0.6 for e in v.groups)]
        if len(heads) < 20:
            raise ValueError(f"{arm.name} has no head to put this on: its body has too few vertices weighted to Head")
        self.tree = BVHTree.FromPolygons(verts, polys)
        pts = np.array(heads)
        marks = json.loads(arm.get("kurambit_face", "{}") or "{}")
        self.top = float(pts[:, 2].max())
        # The eye line, as the body marks it, else where a head keeps it: half way up.
        self.eye_z = float(marks["eye_l"][2]) if "eye_l" in marks else float(pts[:, 2].min() + 0.5 * (self.top - pts[:, 2].min()))
        self.marks = marks
        skull = pts[pts[:, 2] > self.eye_z]
        self.back, self.front = float(skull[:, 1].max()), float(skull[:, 1].min())
        self.half = float(np.abs(skull[:, 0]).max())
        self.centre = Vector((0.0, (self.back + self.front) / 2, self.eye_z + 0.3 * (self.top - self.eye_z)))
        self.r = (self.top - self.centre.z + self.half + (self.back - self.front) / 2) / 3

    def hairline(self, az, drop=0.0):
        """The elevation of the hairline at az on this head (drop degrees lower): where the skull's
        surface is at the hairline's height there."""
        want = self.eye_z + _line(az) * (self.top - self.eye_z)
        lo, hi = -70.0, 89.0
        for _ in range(14):
            mid = (lo + hi) / 2
            p = self.at(az, mid)
            if p is None or p.z < want:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2 - drop

    @staticmethod
    def dir(az, el):
        a, e = math.radians(az), math.radians(el)
        return Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))

    def at(self, az, el, lift=0.0):
        """The skull's surface in that direction, lift metres off it; None where a ray finds none."""
        d = self.dir(az, el)
        hit = self.tree.ray_cast(self.centre, d, 1.7 * self.r)  # further is the shoulders, through the neck
        if hit[0] is None:
            return None
        return hit[0] + d * lift


def _line(az):
    a = abs((az + 180) % 360 - 180)
    for (a0, e0), (a1, e1) in zip(HAIRLINE, HAIRLINE[1:]):
        if a <= a1:
            t = (a - a0) / (a1 - a0)
            t = t * t * (3 - 2 * t)
            return e0 + (e1 - e0) * t
    return HAIRLINE[-1][1]


class _Build:
    def __init__(self):
        self.verts, self.faces, self.mat = [], [], []

    def cap(self, head, lift, line, segs=48, rings=9, mat=0):
        """A shell over the skull from the crown down to line(az), its rim tucked into the skin."""
        base = len(self.verts)
        self.verts.append(head.at(0, 90, lift) or head.centre + Vector((0, 0, head.r)))
        for i in range(1, rings + 2):
            for j in range(segs):
                az = 360.0 * j / segs - 180
                lo = line(az)
                t = min(1.0, i / rings)
                el = 90 - (90 - lo) * t
                p = head.at(az, el, lift if i <= rings else -0.004)
                if p is None:
                    p = head.centre + head.dir(az, el) * head.r
                self.verts.append(p)
        for j in range(segs):
            self.faces.append((base, base + 1 + j, base + 1 + (j + 1) % segs))
            self.mat.append(mat)
        for i in range(rings):
            for j in range(segs):
                a, b = base + 1 + i * segs + j, base + 1 + i * segs + (j + 1) % segs
                self.faces.append((a, a + segs, b + segs, b))
                self.mat.append(mat)

    def lock(self, path, width, thick, mat=0, sides=6, root=0.6, taper=0.55):
        if len(path) < 2:
            return
        """A chunky lock along path (points on or off the skull): an oval section that swells from
        its root, holds, and tapers to a point at its tip. out per point is the way off the head."""
        n = len(path)
        base = len(self.verts)
        for i, (p, out) in enumerate(path):
            t = i / (n - 1)
            along = (path[min(n - 1, i + 1)][0] - path[max(0, i - 1)][0])
            along = along.normalized() if along.length > 1e-9 else Vector((0, 0, -1))
            side = along.cross(out)
            side = side.normalized() if side.length > 1e-9 else Vector((1, 0, 0))
            up = side.cross(along).normalized()
            k = (root + (1 - root) * math.sin(min(1.0, t / 0.3) * math.pi / 2)) * (1.0 if t < taper else max(0.0, 1 - ((t - taper) / (1 - taper)) ** 1.6))
            for s in range(sides):
                a = 2 * math.pi * s / sides
                self.verts.append(p + side * (math.cos(a) * width / 2 * k) + up * (math.sin(a) * thick / 2 * k + thick * 0.25 * k))
        for i in range(n - 1):
            for s in range(sides):
                a, b = base + i * sides + s, base + i * sides + (s + 1) % sides
                self.faces.append((a, b, b + sides, a + sides))
                self.mat.append(mat)
        self.faces.append(tuple(base + s for s in range(sides))[::-1])
        self.mat.append(mat)

    def blob(self, centre, radius, mat=0, squash=(1, 1, 1)):
        base = len(self.verts)
        rings, segs = 5, 9
        self.verts.append(centre + Vector((0, 0, radius * squash[2])))
        for i in range(1, rings):
            a = math.pi * i / rings
            for j in range(segs):
                b = 2 * math.pi * j / segs
                self.verts.append(centre + Vector((math.sin(a) * math.cos(b) * radius * squash[0], math.sin(a) * math.sin(b) * radius * squash[1], math.cos(a) * radius * squash[2])))
        self.verts.append(centre - Vector((0, 0, radius * squash[2])))
        last = len(self.verts) - 1
        for j in range(segs):
            self.faces.append((base, base + 1 + j, base + 1 + (j + 1) % segs))
            self.faces.append((last, base + 1 + (rings - 2) * segs + (j + 1) % segs, base + 1 + (rings - 2) * segs + j))
            self.mat += [mat, mat]
        for i in range(rings - 2):
            for j in range(segs):
                a, b = base + 1 + i * segs + j, base + 1 + i * segs + (j + 1) % segs
                self.faces.append((a, a + segs, b + segs, b))
                self.mat.append(mat)

    def object(self, name, materials):
        import bmesh

        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(v) for v in self.verts], [], self.faces)
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        for m in materials:
            me.materials.append(m)
        me.polygons.foreach_set("material_index", self.mat)
        me.shade_smooth()
        o = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(o)
        return o


def _shade(hex_colour, k):
    h = hex_colour.lstrip("#")
    return "#" + "".join(f"{max(0, min(255, round(int(h[i:i + 2], 16) * k))):02x}" for i in (0, 2, 4))


def _flow(head, az0, el0, az1, el1, n, lift, flick=0.0, hang=0.0, sway=0.0):
    """A lock's path over the skull from (az0, el0) to (az1, el1), lifted off it, then hanging hang
    metres straight down past its end, its tip flicked out by flick metres."""
    path = []
    for i in range(n):
        t = i / (n - 1)
        az, el = az0 + (az1 - az0) * t + sway * math.sin(t * math.pi), el0 + (el1 - el0) * t
        d = head.dir(az, el)
        p = head.at(az, el, lift * (0.5 + 0.5 * math.sin(min(1.0, t * 1.4) * math.pi / 2)))
        if p is None:
            if not path:
                continue
            p = path[-1][0] + Vector((0, 0, -0.04 * head.r))
        path.append((p, d))
    out = Vector((path[-1][1].x, path[-1][1].y, 0.0))
    out = out.normalized() if out.length > 1e-6 else Vector((0, 1, 0))
    if hang > 0:
        steps = max(2, int(round(hang / (0.35 * head.r))))
        p0 = path[-1][0]
        for k in range(1, steps + 1):
            t = k / steps
            # Down, a little off the neck, curling out at the tip.
            p = p0 + Vector((0, 0, -hang * t)) + out * (0.12 * head.r * math.sin(t * math.pi / 2) + flick * t ** 3)
            hit = head.tree.find_nearest(p)
            if hit[0] is not None and (p - hit[0]).length < lift * 1.2:
                p = hit[0] + (p - hit[0]).normalized() * lift * 1.2 if (p - hit[0]).length > 1e-6 else p + out * lift
            path.append((p, out))
    elif flick:
        p, d = path[-1]
        path[-1] = (p + d * flick, d)
    return path


def hair(armature, shape="short", *, colour="#3a2a20", locks=22, length=None, fringe=True, thickness=1.0, seed=7, name=None):
    """Hair on armature's head, in one of SHAPES: short (a cropped mop), long (down past the nape
    to length metres, default the neck's), tied (swept back into a tail on a spring), curly (a
    round mass of curls). colour is hex; the under-locks are a shade darker on their own material.
    fringe=False keeps the forehead clear. Bound to Head. Returns {"object", "locks", "chains"}."""
    if shape not in SHAPES:
        raise ValueError(f"hair shape {shape!r}: one of {', '.join(SHAPES)}")
    arm = _arm(armature)
    old = next((o for o in bpy.data.objects if o.get(MARK) == arm.name), None)
    if old is not None:
        bpy.data.objects.remove(old)
    head = Head(arm)
    rng = np.random.default_rng(seed)
    r = head.r
    top = helpers.material(colour, name="Hair")
    under = helpers.material(_shade(colour, 0.72), name="Hair under")
    lift = 0.035 * r * thickness
    b = _Build()
    swept = shape == "tied"
    cache = {}
    hairline = lambda az, drop=0.0: cache.setdefault(round(az, 2), head.hairline(az)) - drop
    line = (lambda az: hairline(az, drop=-6 if abs((az + 180) % 360 - 180) < 60 else 0)) if swept or not fringe else hairline
    b.cap(head, lift if shape != "curly" else 0.14 * r * thickness, line, mat=1)
    made = 0
    chains = {}
    if shape == "curly":
        n = int(locks * 3.4)
        for i in range(n):
            # Even over the scalp (a golden-angle spiral), jittered.
            t = (i + 0.5) / n
            az = (i * 137.5 + rng.uniform(-8, 8)) % 360 - 180
            el = 90 - (90 - hairline(az, drop=4)) * math.sqrt(t)
            p = head.at(az, el, 0.0)
            if p is None:
                continue
            rad = r * (0.23 + 0.07 * rng.random()) * thickness
            b.blob(p + head.dir(az, el) * rad * 0.35, rad, mat=int(i % 3 == 0))
            made += 1
    else:
        tiers = ((0.5, 78.0, 0, 0.95), (0.5, 52.0, 1, 1.15))  # share of locks, root elevation, material, width
        whorl = 150.0  # the crown's swirl sits back of the top
        for share, root_el, mat, wide in tiers:
            n = max(6, int(round(locks * share)))
            for i in range(n):
                az = -180 + 360 * (i + (0.5 if mat else 0.0)) / n + rng.uniform(-6, 6)
                front = abs((az + 180) % 360 - 180) < 62
                low = hairline(az)
                if swept:
                    # Every lock runs back toward the tie at the nape of the crown.
                    end_az = az + (180 - abs(az)) * (0.55 if az >= 0 else -0.55) * (1 if mat else 0.5)
                    path = _flow(head, az * 0.9, max(low + 6, root_el - 25 * (1 - abs(az) / 180)), end_az, max(low + 4, 20.0 - 10 * mat), 6, lift * 1.6)
                    width = 0.5 * r * wide
                elif front and not fringe:
                    path = _flow(head, az, root_el, az * 1.5, low + 8, 5, lift * 1.6, flick=0.05 * r)
                    width = 0.42 * r * wide
                elif front:
                    # The fringe: over the forehead, combed a little to one side, tips flicked out.
                    path = _flow(head, az * 0.7 + 12, root_el, az + 16, low - (10 + 6 * rng.random()) * (1 if mat else 0.5), 6, lift * 1.7, flick=0.07 * r, sway=6)
                    width = 0.4 * r * wide
                else:
                    drop = (8 + 8 * rng.random()) * (1 if mat else 0.0)
                    hang = 0.0
                    if shape == "long" and mat:
                        hang = (length if length is not None else _to_shoulders(arm, head)) * (0.85 + 0.3 * rng.random())
                    path = _flow(head, az + (whorl - az) * 0.25 * (1 - mat), root_el, az, low - drop + (20 if not mat else 0), 6, lift * 1.6,
                                 flick=(0.08 if not hang else 0.12) * r, hang=hang, sway=rng.uniform(-5, 5))
                    width = (0.46 if not hang else 0.5) * r * wide
                hanging = len(path) > 6
                b.lock(path, width * thickness * (1.5 if hanging else 1.0), 0.16 * r * thickness, mat=mat, taper=0.8 if hanging else 0.55, sides=8 if hanging else 6)
                made += 1
        if fringe and not swept:
            # The signature lock: one bigger piece across the forehead.
            path = _flow(head, -24, 70, 30, hairline(30) - 14, 7, lift * 2.2, flick=0.12 * r, sway=-8)
            b.lock(path, 0.62 * r * thickness, 0.2 * r * thickness, mat=0)
            made += 1
    o = b.object(name or f"{arm.name}_hair", [top, under])
    helpers.skin_rigid(o, "Head", armature=arm)
    o[MARK] = arm.name
    if swept:
        from . import cloth

        tie = head.at(180, 18, lift) or head.centre + Vector((0, r, 0))
        drop = length if length is not None else 1.1 * _to_shoulders(arm, head)
        tb = _Build()
        tb.blob(tie + Vector((0, 0.04 * r, 0)), 0.2 * r * thickness, mat=1)
        end = tie + Vector((0, 0.45 * r, -drop))
        path = [(tie + (end - tie) * t + Vector((0, 0.3 * r * math.sin(t * math.pi), 0)), Vector((0, 1, 0))) for t in np.linspace(0, 1, 8)]
        tb.lock(path, 0.5 * r * thickness, 0.36 * r * thickness, mat=0, sides=8, root=0.5)
        tail = tb.object(f"{arm.name}_hair_tail", [top, under])
        tail[MARK] = arm.name + ":tail"
        chains = cloth.dangle(tail, arm, tuple(tie), tuple(end), bones=3, parent="Head", name="hair")
    return {"object": o.name, "locks": made, "chains": chains}


def _to_shoulders(arm, head):
    """From the nape down to the shoulders, metres."""
    b = arm.data.bones.get("neck_01") or arm.data.bones.get("spine_03")
    if b is None:
        return 1.2 * head.r
    z = (arm.matrix_world @ b.head_local).z
    nape = head.at(180, head.hairline(180))
    return max(0.6 * head.r, (nape.z if nape is not None else head.centre.z - head.r) - z + 0.25 * head.r)


def beard(armature, *, colour="#3a2a20", length=0.5, moustache=True, name=None):
    """A beard on armature's jaw: a shell from ear to ear under the mouth, hanging length head
    radii below the chin, in chunky locks, and a moustache over the lip. Needs a body that marks
    its mouth (an MPFB2 or drawn body). Bound to Head."""
    arm = _arm(armature)
    head = Head(arm)
    if "mouth" not in head.marks:
        raise ValueError(f"{arm.name}'s body does not say where its mouth is: model the beard as a part and fit it with hero.wear")
    mx, my, mz, width = head.marks["mouth"]
    r = head.r
    mat, under = helpers.material(colour, name="Beard"), helpers.material(_shade(colour, 0.72), name="Beard under")
    look = Vector((0, -1, 0))
    b = _Build()
    # From a point inside the jaw, out through it: the jaw's own surface, ear to ear.
    inside = Vector((0.0, (head.front + head.back) / 2, mz + 0.1 * r))
    lower = mz - 0.06 * r

    def jaw(az, down, lift):
        d = Vector((math.sin(math.radians(az)), -math.cos(math.radians(az)), -down)).normalized()
        # From outside in: the jaw's outer skin, whatever a mouth holds inside.
        far = inside + d * 3 * r
        hit = head.tree.ray_cast(far, -d, 3 * r)
        return (hit[0] + d * lift, d) if hit[0] is not None else None

    n = 13
    for i in range(n):
        az = -82 + 164 * i / (n - 1)
        path = []
        for k, down in enumerate((0.05, 0.45, 0.9, 1.4)):
            p = jaw(az, down if abs(az) < 60 else down * 0.7 + 0.1, 0.02 * r)
            if p is None or (abs(az) < 28 and p[0].z > lower and k == 0):
                # Under the mouth the beard starts below the lip, never on it.
                p = jaw(az, 0.3, 0.02 * r)
            if p is not None:
                path.append(p)
        if len(path) < 2:
            continue
        tip, d = path[-1]
        hang = length * r * (1.0 - 0.85 * (abs(az) / 82) ** 1.5)
        path.append((tip + Vector((0, -0.05 * r, -hang * 0.5)), d))
        path.append((tip + Vector((0, -0.08 * r, -hang)), d))
        b.lock(path, 0.4 * r, 0.16 * r, mat=i % 2)
    if moustache:
        for sgn in (1, -1):
            pts = []
            for t in np.linspace(0.04, 1.0, 5):
                p = Vector((mx + sgn * t * width * 0.62, my, mz + 0.085 * r - 0.07 * r * t * t))
                hit = helpers.surface_hit(head.bodies, p + look * 0.3, -look, 0.6)
                pts.append(((hit[0] if hit is not None else p) + look * 0.012 * r, look))
            b.lock(pts, 0.17 * r, 0.1 * r, mat=0, root=0.9)
    o = b.object(name or f"{arm.name}_beard", [mat, under])
    helpers.skin_rigid(o, "Head", armature=arm)
    o[MARK] = arm.name + ":beard"
    return {"object": o.name}


def glasses(armature, *, shape="round", colour="#2a2a30", lens=None, size=1.0, name=None):
    """Glasses on armature's face: two rims (round or square) about its eyes, a bridge over the
    nose and arms back to the ears, all found on the head. lens: a hex colour for see-through
    lenses, or None for empty rims. Needs a body that marks its eyes. Bound to Head."""
    arm = _arm(armature)
    head = Head(arm)
    if "eye_l" not in head.marks:
        raise ValueError(f"{arm.name}'s body does not say where its eyes are: model the glasses as a part and fit them with hero.wear")
    mat = helpers.material(colour, name="Glasses", roughness=0.3)
    look = Vector((0, -1, 0))
    b = _Build()
    wire = 0.07
    rims = {}
    for sgn, key in ((1, "l"), (-1, "r")):
        x, y, z, rad = head.marks[f"eye_{key}"]
        c = Vector((x, y, z))
        hit = helpers.surface_hit(head.bodies, c + look * 0.3, -look, 0.6)
        front = min(hit[0].y if hit is not None else y - rad, y - rad)
        # Clear of the brow and the cheek: in front of the furthest-forward skin around the eye.
        R = min(rad * 1.5, 0.46 * abs(2 * x)) * size  # the rims never cross over the nose
        for a in range(0, 360, 30):
            q = c + Vector((math.cos(math.radians(a)) * R, 0, math.sin(math.radians(a)) * R))
            h2 = helpers.surface_hit(head.bodies, q + look * 0.3, -look, 0.6)
            if h2 is not None:
                front = min(front, h2[0].y)
        c = Vector((x, front - rad * 0.22, z))
        ring = []
        for a in range(0, 360, 20):
            ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
            if shape == "square":
                k = 1.0 / max(abs(ca), abs(sa))
                ca, sa = ca * min(k, 1.25), sa * min(k, 1.25) * 0.8
            ring.append(c + Vector((ca * R, 0, sa * R)))
        rims[key] = (c, R, ring)
        t = rad * wire * 2
        for i, p in enumerate(ring):
            q = ring[(i + 1) % len(ring)]
            _bar(b, p, q, t)
        if lens:
            base = len(b.verts)
            b.verts.append(c)
            b.verts += ring
            for i in range(len(ring)):
                b.faces.append((base, base + 1 + i, base + 1 + (i + 1) % len(ring)))
                b.mat.append(1)
    (cl, R, _), (cr, _, _) = rims["l"], rims["r"]
    t = head.marks["eye_l"][3] * wire * 2
    _bar(b, cl + Vector((-R, 0, R * 0.15)), cr + Vector((R, 0, R * 0.15)), t)
    for sgn, c in ((1, cl), (-1, cr)):
        hinge = c + Vector((sgn * R, 0, R * 0.1))
        ear = head.at(sgn * 95, 5) or hinge + Vector((0, head.r, 0))
        back = Vector((max(abs(ear.x), abs(hinge.x)) * sgn + sgn * 0.002, ear.y, hinge.z))
        _bar(b, hinge, Vector((back.x, hinge.y, hinge.z)), t)
        _bar(b, Vector((back.x, hinge.y, hinge.z)), back, t)
    mats = [mat]
    if lens:
        glass = helpers.material(lens, name="Lens", roughness=0.1)
        bsdf = next(n for n in glass.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Alpha"].default_value = 0.35
        if hasattr(glass, "surface_render_method"):
            glass.surface_render_method = "BLENDED"
        mats.append(glass)
    o = b.object(name or f"{arm.name}_glasses", mats)
    o.data.polygons.foreach_set("use_smooth", [False] * len(o.data.polygons))
    helpers.skin_rigid(o, "Head", armature=arm)
    o[MARK] = arm.name + ":glasses"
    return {"object": o.name}


def _bar(b, p, q, t):
    """A square bar from p to q, t thick."""
    along = q - p
    if along.length < 1e-7:
        return
    along.normalize()
    side = along.cross(Vector((0, 1, 0)))
    side = side.normalized() if side.length > 1e-6 else Vector((1, 0, 0))
    up = along.cross(side).normalized()
    base = len(b.verts)
    for end in (p, q):
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            b.verts.append(end + side * (sx * t / 2) + up * (sy * t / 2))
    for i in range(4):
        j = (i + 1) % 4
        b.faces.append((base + i, base + j, base + 4 + j, base + 4 + i))
        b.mat.append(0)
    b.faces.append((base + 3, base + 2, base + 1, base))
    b.faces.append((base + 4, base + 5, base + 6, base + 7))
    b.mat += [0, 0]


def wear(part, armature, *, offset=0.004, sit=None, bone="Head"):
    """Fits a part you modelled (a hat, a helmet, a hood, a mask) onto armature's head and binds it
    to bone. It is sized and centred on the head where it sits: its opening (its lowest ring of
    vertices) takes the head's own outline at that height, hair included, so a crown is never cut by
    the skull behind it; then every vertex still inside the head or its hair moves out to offset
    metres above it. sit: the height (metres) its opening rests at; default where you modelled it.
    Returns {"scaled": [x, y], "moved": vertices pushed out}."""
    o = bpy.data.objects[part] if isinstance(part, str) else part
    arm = _arm(armature)
    for m in list(o.modifiers):
        if m.type != "ARMATURE":
            with bpy.context.temp_override(object=o, active_object=o):
                bpy.ops.object.modifier_apply(modifier=m.name)
    hairs = [h for h in bpy.data.objects if str(h.get(MARK, "")).split(":")[0] == arm.name and h is not o and h.type == "MESH"
             and ":" not in str(h.get(MARK))]
    head = Head(arm, extra=hairs)
    mw = o.matrix_world
    co = np.array([mw @ v.co for v in o.data.vertices])
    lo = float(co[:, 2].min())
    z = float(sit) if sit is not None else lo
    co[:, 2] += z - lo
    # The part's opening: in each direction, the nearest to its axis of the vertices in its lower
    # third (a brimmed hat's crown, not its brim's edge).
    span = max(1e-6, float(co[:, 2].max() - z))
    rim = co[co[:, 2] < z + 0.35 * span]
    axis = rim[:, :2].mean(axis=0)
    ang = np.arctan2(rim[:, 0] - axis[0], -(rim[:, 1] - axis[1]))
    rad = np.hypot(rim[:, 0] - axis[0], rim[:, 1] - axis[1])
    inner = {}
    for a, d in zip(np.round(ang / (2 * math.pi) * 24).astype(int) % 24, rad):
        inner[a] = min(inner.get(a, 1e9), d)
    # The head's outline at that height, from its own axis.
    outline = []
    for k in range(24):
        a = 2 * math.pi * k / 24
        d = Vector((math.sin(a), -math.cos(a), 0.0))
        origin = Vector((0.0, head.centre.y, z + 0.01 * span))
        hit, far = None, origin + d * 3 * head.r
        back = head.tree.ray_cast(far, -d, 3 * head.r)  # from outside in: the outermost surface, hair too
        if back[0] is not None:
            hit = back[0]
        outline.append(None if hit is None else (hit - origin))
    xs = [abs(p.x) for p in outline if p is not None]
    ys = [p.y for p in outline if p is not None]
    scaled = [1.0, 1.0]
    if xs and inner:
        want_x, want_y = max(xs) + offset, (max(ys) - min(ys)) / 2 + offset
        have_x = max(d * abs(math.sin(2 * math.pi * a / 24)) for a, d in inner.items())
        have_y = max(d * abs(math.cos(2 * math.pi * a / 24)) for a, d in inner.items())
        if have_x > 1e-6 and have_y > 1e-6:
            scaled = [want_x / have_x, want_y / have_y]
            centre_y = head.centre.y + (max(ys) + min(ys)) / 2
            co[:, 0] = (co[:, 0] - axis[0]) * scaled[0]
            co[:, 1] = (co[:, 1] - axis[1]) * scaled[1] + centre_y
    inv = mw.inverted()
    for v, c in zip(o.data.vertices, co):
        v.co = inv @ Vector(c)
    o.data.update()
    # Whatever is still inside the head or its hair comes out to just above it.
    target = [*head.bodies, *hairs]
    moved = 0
    posed = arm.data.pose_position
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    try:
        before = np.array([v.co for v in o.data.vertices])
        for t in target:
            sw = o.modifiers.new("fit", "SHRINKWRAP")
            sw.target, sw.wrap_method, sw.wrap_mode, sw.offset = t, "NEAREST_SURFACEPOINT", "OUTSIDE", float(offset)
            with bpy.context.temp_override(object=o, active_object=o):
                bpy.ops.object.modifier_apply(modifier=sw.name)
        after = np.array([v.co for v in o.data.vertices])
        moved = int((np.linalg.norm(after - before, axis=1) > 1e-5).sum())
    finally:
        arm.data.pose_position = posed
    helpers.skin_rigid(o, bone, armature=arm)
    return {"scaled": [round(scaled[0], 3), round(scaled[1], 3)], "moved": moved}
