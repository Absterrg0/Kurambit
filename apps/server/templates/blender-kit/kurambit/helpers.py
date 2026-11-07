"""Helpers for modelling parts and keying clips on a conformed character: skin_rigid, ring_around,
tube_along_bones, place_on_surface, aim and key_pose, plus material and place_chain, and the
eyes that blink by bones: eye_lid and eye_squash.

Every helper works in world space on the character's rest pose (what the export binds to), even
while a clip poses it in the viewport. The Blender traps live here, not in the agent's code:
bone references are fetched again after every edit-mode switch, and geometry is measured at rest."""
import json
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

from . import skeleton

GEOMETRY = {"MESH", "CURVE", "SURFACE", "FONT", "META"}


def _armature(armature):
    return bpy.data.objects[armature] if isinstance(armature, str) else armature


def armature_of(bone):
    """The one armature in the scene with a bone of this name."""
    rigs = [o for o in bpy.context.scene.objects if o.type == "ARMATURE" and bone in o.data.bones]
    if len(rigs) != 1:
        where = ", ".join(o.name for o in rigs) or "no armature"
        raise ValueError(f"bone {bone!r} is on {where}: pass armature=")
    return rigs[0]


def _deforming(obj):
    return [m.object for m in getattr(obj, "modifiers", []) if m.type == "ARMATURE" and m.object is not None]


def rest_coords(obj):
    """World vertex positions of obj's evaluated mesh (its modifiers applied) at the rest pose,
    and its polygons, so a clip playing in the viewport does not move what is measured."""
    rigs = _deforming(obj)
    saved = [(a, a.data.pose_position) for a in rigs]
    for a, _ in saved:
        a.data.pose_position = "REST"
    try:
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        ev = obj.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            m = np.array(ev.matrix_world)
            co = co @ m[:3, :3].T + m[:3, 3]
            polys = [tuple(p.vertices) for p in me.polygons]
        finally:
            ev.to_mesh_clear()
    finally:
        for a, p in saved:
            a.data.pose_position = p
    return co, polys


def surface_hit(targets, origin, direction, distance=10.0):
    """The nearest surface point of targets (objects) on a ray at rest: (point, normal, object) or None."""
    targets = [targets] if not isinstance(targets, (list, tuple)) else targets
    best = None
    d = Vector(direction).normalized()
    for t in targets:
        co, polys = rest_coords(t)
        if not polys:
            continue
        tree = BVHTree.FromPolygons([tuple(v) for v in co], polys)
        loc, normal, _, dist = tree.ray_cast(Vector(origin), d, distance)
        if loc is not None and (best is None or dist < best[3]):
            best = (loc, normal, t, dist)
    return None if best is None else best[:3]


def use_nodes(idb):
    """Gives a material or world its node tree. Blender before 5.0 creates them without one;
    5.0 always has one and 6.0 removes the use_nodes flag, so it is set only when missing."""
    if idb.node_tree is None:
        idb.use_nodes = True
    return idb.node_tree


def material(hex_colour, glow=0.0, name=None, roughness=0.55):
    """A material of one sRGB colour ("#RRGGBB"); glow > 0 makes it emissive (the style pass turns
    emissive materials into the Glow material and snaps every colour to STYLE.json's palette)."""
    name = name or f"pal:{hex_colour.lower()}"
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    use_nodes(m)
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    rgb = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92 for c in rgb] + [1.0]
    bsdf.inputs["Base Color"].default_value = lin
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Emission Color"].default_value = lin
    bsdf.inputs["Emission Strength"].default_value = glow
    return m


def skin_rigid(obj, bone, armature=None):
    """Binds a mesh to the skeleton: bone is a bone name (rigid), a {bone: weight} dict, or a
    function of a vertex's world position returning such a dict. The mesh's transform is applied
    first, so it stays exactly where it was modelled. Returns obj."""
    if obj.type != "MESH":
        raise ValueError(f"{obj.name} is a {obj.type.lower()}: skin_rigid needs a mesh")
    if callable(bone):
        arm = _armature(armature) if armature is not None else None
        if arm is None:
            raise ValueError("pass armature= with a weight function")
    else:
        weights = {bone: 1.0} if isinstance(bone, str) else dict(bone)
        arm = _armature(armature) if armature is not None else armature_of(next(iter(weights)))
        missing = [b for b in weights if b not in arm.data.bones]
        if missing:
            raise ValueError(f"{arm.name} has no bone {', '.join(missing)}")
    skeleton.to_world(obj)
    for vg in list(obj.vertex_groups):
        obj.vertex_groups.remove(vg)
    groups = {}

    def group(name):
        if name not in groups:
            groups[name] = obj.vertex_groups.new(name=name)
        return groups[name]

    if callable(bone):
        for v in obj.data.vertices:
            for name, w in bone(v.co.copy()).items():
                if w > 0:
                    group(name).add([v.index], w, "REPLACE")
    else:
        everything = list(range(len(obj.data.vertices)))
        for name, w in weights.items():
            group(name).add(everything, w, "REPLACE")
    skeleton.bind(obj, arm)
    return obj


def _section(body, center, axis, slab, pick, bins):
    """The body's cross-section around an axis: its radius in each of `bins` directions (from the
    vertices within slab of the plane), gaps filled and smoothed, plus the plane's two axes."""
    axis = Vector(axis).normalized()
    a = Vector((1, 0, 0)) if abs(axis.x) < 0.9 else Vector((0, 1, 0))
    a = (a - axis * a.dot(axis)).normalized()
    b = axis.cross(a)
    co, _ = rest_coords(body)
    d = co - np.array(center)
    near = np.abs(d @ np.array(axis)) <= slab
    if pick is not None:
        near &= np.array([bool(pick(Vector(p))) for p in co])
    x, y = d[near] @ np.array(a), d[near] @ np.array(b)
    if len(x) == 0:
        raise ValueError(f"no vertex of {body.name} within {slab} m of that plane: move t or raise slab")
    k = ((np.arctan2(y, x) % (2 * math.pi)) / (2 * math.pi) * bins).astype(int) % bins
    rad = [0.0] * bins
    for i, r in zip(k, np.hypot(x, y)):
        rad[i] = max(rad[i], float(r))
    for _ in range(2):
        rad = [max(rad[i], 0.5 * (rad[i - 1] + rad[(i + 1) % bins])) for i in range(bins)]
    rad = [(rad[i - 1] + 2 * rad[i] + rad[(i + 1) % bins]) / 4 for i in range(bins)]
    return rad, a, b


def _link(obj):
    bpy.context.collection.objects.link(obj)
    return obj


def ring_around(body, bone, t=0.5, *, axis=None, center=None, thick=0.014, height=0.01, slab=0.02,
                pick=None, material=None, weights=None, name=None, armature=None, bins=24, gap=0.002):
    """A soft band hugging the body's measured cross-section (a cuff, a belt, a collar), so a colour
    seam on the body is covered by a modelled edge instead of jagged per-face colours.
    It sits at fraction t from the bone's joint to the next (or at center), around axis (default:
    along the bone), and is skinned to the bone (or weights). pick(world_co) limits which vertices count (one leg only)."""
    arm = _armature(armature) if armature is not None else armature_of(bone)
    b = arm.data.bones[bone]
    child = skeleton._child_joint(arm.data.bones, bone, lambda k: True)
    head = arm.matrix_world @ b.head_local
    tail = arm.matrix_world @ (arm.data.bones[child].head_local if child is not None else b.tail_local)
    c = Vector(center) if center is not None else head.lerp(tail, t)
    ax = Vector(axis).normalized() if axis is not None else (tail - head).normalized()
    rad, a, bb = _section(body, c, ax, slab, pick, bins)
    rows = 6
    verts, faces = [], []
    for i in range(bins):
        ang = 2 * math.pi * (i + 0.5) / bins
        out = a * math.cos(ang) + bb * math.sin(ang)
        for j in range(rows):
            u = 2 * math.pi * j / rows
            verts.append(c + out * (rad[i] + gap + thick * (1 + math.cos(u)) * 0.5) + ax * (math.sin(u) * (thick + height) * 0.5))
    for i in range(bins):
        for j in range(rows):
            n = (i + 1) % bins
            faces.append((i * rows + j, n * rows + j, n * rows + (j + 1) % rows, i * rows + (j + 1) % rows))
    me = bpy.data.meshes.new(name or f"ring_{bone}")
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.shade_smooth()
    obj = _link(bpy.data.objects.new(me.name, me))
    if material is not None:
        me.materials.append(material)
    return skin_rigid(obj, weights or bone, armature=arm)


def _frames(path):
    """Ring frames along a path that do not twist (parallel transport)."""
    tangents = [(path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized() for i in range(len(path))]
    ref = Vector((1, 0, 0)) if abs(tangents[0].x) < 0.9 else Vector((0, 0, 1))
    side = (ref - tangents[0] * ref.dot(tangents[0])).normalized()
    out = []
    for t in tangents:
        side = (side - t * side.dot(t)).normalized()
        out.append((t, side, t.cross(side)))
    return out


def tube_along_bones(bones, radius, *, armature=None, taper=0.35, ring=10, samples=9, material=None, name=None):
    """A smooth tapered tube through a chain of bones (a tail, a cable, a tentacle), weighted by arc
    length so each bone owns its stretch and neighbours blend at the joints. radius is metres at the
    root, or a function of t (0 root .. 1 tip) returning metres."""
    arm = _armature(armature) if armature is not None else armature_of(bones[0])
    mw = arm.matrix_world
    bs = [arm.data.bones[n] for n in bones]
    pts = [mw @ bs[0].head_local] + [mw @ b.tail_local for b in bs]
    ext = [pts[0] * 2 - pts[1]] + pts + [pts[-1] * 2 - pts[-2]]

    def cr(p0, p1, p2, p3, t):
        return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)

    path = [cr(ext[i - 1], ext[i], ext[i + 1], ext[i + 2], k / samples) for i in range(1, len(ext) - 2) for k in range(samples)]
    path.append(pts[-1])
    r_of = radius if callable(radius) else (lambda t: radius * (1 - taper * t))
    verts, faces = [], []
    frames = _frames(path)
    for i, (p, (_, side, up)) in enumerate(zip(path, frames)):
        r = r_of(i / (len(path) - 1))
        verts += [p + (side * math.cos(2 * math.pi * j / ring) + up * math.sin(2 * math.pi * j / ring)) * r for j in range(ring)]
    for i in range(len(path) - 1):
        for j in range(ring):
            faces.append((i * ring + j, i * ring + (j + 1) % ring, (i + 1) * ring + (j + 1) % ring, (i + 1) * ring + j))
    tip = len(verts)
    verts.append(path[-1] + frames[-1][0] * r_of(1.0) * 0.7)
    last = (len(path) - 1) * ring
    faces += [(last + j, last + (j + 1) % ring, tip) for j in range(ring)]
    me = bpy.data.meshes.new(name or f"tube_{bones[0]}")
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.shade_smooth()
    obj = _link(bpy.data.objects.new(me.name, me))
    if material is not None:
        me.materials.append(material)
    parent = bs[0].parent.name if bs[0].parent is not None else None

    def weights(p):
        def nearest(i):
            q = p - pts[i]
            seg = pts[i + 1] - pts[i]
            f = max(0.0, min(1.0, q.dot(seg) / max(seg.length_squared, 1e-12)))
            return (pts[i].lerp(pts[i + 1], f) - p).length, f

        best = min(range(len(bones)), key=lambda i: nearest(i)[0])
        f = nearest(best)[1]
        w = {bones[best]: 1.0}
        if f < 0.25 and best > 0:
            k = (0.25 - f) / 0.5
            w = {bones[best]: 1 - k, bones[best - 1]: k}
        elif f > 0.75 and best < len(bones) - 1:
            k = (f - 0.75) / 0.5
            w = {bones[best]: 1 - k, bones[best + 1]: k}
        if best == 0 and f < 0.15 and parent is not None:
            w = {bones[0]: 0.6, parent: 0.4}
        return w

    return skin_rigid(obj, weights, armature=arm)


def place_on_surface(obj, target, direction, *, offset=0.0):
    """Moves obj's centre along direction (world) onto target's surface at rest, so a feature (an eye, a
    badge, a nose) sits on the surface instead of buried or floating: put obj roughly where it goes,
    then call this with the direction you would look along to see it (an eye on a face that looks
    toward -Y: (0, 1, 0)). offset lifts it off the surface along the normal. Returns (point, normal)."""
    d = Vector(direction).normalized()
    centre = sum((obj.matrix_world @ Vector(c) for c in obj.bound_box), Vector()) / 8  # applied transforms leave the origin anywhere
    hit = surface_hit(target, centre - d * 5.0, d, 10.0)
    if hit is None:
        names = target.name if not isinstance(target, (list, tuple)) else ", ".join(t.name for t in target)
        raise ValueError(f"no surface of {names} on the line through {obj.name} along {tuple(d)}")
    point, normal, _ = hit
    obj.matrix_world.translation += point + normal * offset - centre
    bpy.context.view_layer.update()
    return point, normal


def _pose_bone(bone, armature):
    arm = _armature(armature) if armature is not None else armature_of(bone)
    return arm, arm.pose.bones[bone]


def _rotate(arm, pb, q_world):
    """Rotates a pose bone by a world rotation about its own head."""
    mw3 = arm.matrix_world.to_3x3().normalized()
    q = (mw3.inverted() @ q_world.to_matrix() @ mw3).to_4x4()
    h = pb.head.copy()
    pb.matrix = Matrix.Translation(h) @ q @ Matrix.Translation(-h) @ pb.matrix
    bpy.context.view_layer.update()


def aim(bone, world_dir, armature=None):
    """Turns a bone so it points along a world direction (an upper arm toward (0.4, -0.9, 0.3)),
    whatever its local axes are: the bone points at its child joint (a hand at its middle finger).
    Pose it on top of a clip pose with key_pose."""
    arm, pb = _pose_bone(bone, armature)
    child = skeleton._child_joint(arm.pose.bones, bone, lambda k: True)
    tip = arm.pose.bones[child].head if child is not None else pb.tail
    mw = arm.matrix_world
    cur = (mw @ tip - mw @ pb.head).normalized()
    _rotate(arm, pb, cur.rotation_difference(Vector(world_dir).normalized()))


def turn(bone, axis, degrees, armature=None):
    """Rotates a bone about a world axis through its head (the pelvis pitching forward: (1, 0, 0))."""
    arm, pb = _pose_bone(bone, armature)
    _rotate(arm, pb, Quaternion(Vector(axis).normalized(), math.radians(degrees)))


def action_name(owner, clip):
    """A character's clip as the live scene names it: every Blender action needs its own name, and
    two characters each have an Idle_Loop. The export names it clip (kurambit_clip)."""
    return f"{owner}|{clip}"[:63]


def clip_of(arm, clip):
    """arm's own clip by its name in the game, or an action of that name no other character owns."""
    for a in bpy.data.actions:
        if a.get("kurambit_owner") == arm.name and a.get("kurambit_clip", a.name) == clip:
            return a
    a = bpy.data.actions.get(clip)
    return a if a is not None and a.get("kurambit_owner") in (None, arm.name) else None


def key_pose(action, frame, pose, armature):
    """Keys one pose of a custom clip on top of a library pose, by world directions, so the keys do
    not depend on any bone's local axes. pose:
        base       action name whose pose this starts from (default: the rest pose)
        base_frame its frame (default: its first)
        move       (dx, dy, dz) world metres for the pelvis (a crouch is negative z)
        turn       {bone: ((x, y, z), degrees)}: rotations about world axes, in order
        aim        {bone: (x, y, z)}: world directions, applied after turn, parents first
    Every bone's rotation and the pelvis location are keyed at frame. A custom clip reads well with
    an anticipation key, an overshoot and a settle. The clip stays in place: the game moves it.
    action and base name the armature's own clips (Idle_Loop, as the game names them)."""
    arm = _armature(armature)
    act = clip_of(arm, action) if isinstance(action, str) else action
    if act is None:
        act = bpy.data.actions.new(action_name(arm.name, action))
        act["kurambit_clip"] = action
    act.use_fake_user = True
    act["kurambit_owner"] = arm.name
    act["kurambit_clip"] = act.get("kurambit_clip", act.name)
    ad = arm.animation_data or arm.animation_data_create()
    previous, previous_slot = ad.action, getattr(ad, "action_slot", None)
    scene = bpy.context.scene
    keep = scene.frame_current
    try:
        base = pose.get("base")
        rest = {pb.name: Matrix() for pb in arm.pose.bones}
        if base is not None:
            found = clip_of(arm, base)
            if found is None:
                raise ValueError(f"{arm.name} has no clip {base!r}; its clips: {', '.join(sorted(a.get('kurambit_clip', a.name) for a in bpy.data.actions if a.get('kurambit_owner') == arm.name))[:300]}")
            skeleton.assign_action(arm, found)
            scene.frame_set(int(pose.get("base_frame", found.frame_range[0])))
            rest = {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones}
        ad.action = None
        for pb in arm.pose.bones:
            pb.matrix_basis = rest[pb.name]
        bpy.context.view_layer.update()
        if "move" in pose:
            pb = arm.pose.bones["pelvis"]
            pb.matrix = Matrix.Translation(arm.matrix_world.to_3x3().inverted() @ Vector(pose["move"])) @ pb.matrix
            bpy.context.view_layer.update()
        for name, (axis, deg) in pose.get("turn", {}).items():
            turn(name, axis, deg, arm)
        for name, d in pose.get("aim", {}).items():
            aim(name, d, arm)
        skeleton.assign_action(arm, act)
        for pb in arm.pose.bones:
            pb.rotation_mode = "QUATERNION"
            pb.keyframe_insert("rotation_quaternion", frame=frame)
        arm.pose.bones["pelvis"].keyframe_insert("location", frame=frame)
    finally:
        ad.action = previous
        if previous is not None and previous_slot is not None:
            ad.action_slot = previous_slot
        scene.frame_set(keep)
    return act


def chains_of(arm):
    return json.loads(arm.get("kurambit_chains", "{}"))


def add_chain(arm, name, parent, points):
    """Adds bones name_01.. through world points (root to tip) under parent; returns their names."""
    inv = arm.matrix_world.inverted()
    names = [f"{name}_{i + 1:02d}" for i in range(len(points) - 1)]
    with skeleton.edit_bones(arm) as eb:
        prev = eb[parent]
        for i, bone in enumerate(names):
            b = eb.get(bone) or eb.new(bone)
            b.head = inv @ Vector(points[i])
            b.tail = inv @ Vector(points[i + 1])
            b.roll = 0.0
            b.parent = prev
            b.use_connect = i > 0
            b.use_deform = True
            prev = b
    chains = chains_of(arm)
    chains[name] = names
    arm["kurambit_chains"] = json.dumps(chains)
    return names


def place_chain(armature, chain, points=None, *, start=None, direction=None, length=None):
    """Moves a spring chain's bones (made by game_blender_character's chains), for example ears onto
    a hood you modelled: points are world positions root to tip (one more than the bones), or give
    start (and optionally direction and length; both default to the chain's own). Do it before
    skinning parts to the chain: a skinned part keeps its shape, not its place on the bones."""
    arm = _armature(armature)
    chains = chains_of(arm)
    if chain not in chains:
        raise ValueError(f"{arm.name} has no chain {chain!r}; it has {', '.join(chains) or 'none'}")
    bones = chains[chain]
    mw = arm.matrix_world
    if points is None:
        first, last = arm.data.bones[bones[0]], arm.data.bones[bones[-1]]
        root, tip = mw @ first.head_local, mw @ last.tail_local
        d = Vector(direction).normalized() if direction is not None else (tip - root).normalized()
        n = length if length is not None else (tip - root).length
        s = Vector(start) if start is not None else root
        points = [s + d * n * i / len(bones) for i in range(len(bones) + 1)]
    if len(points) != len(bones) + 1:
        raise ValueError(f"chain {chain!r} has {len(bones)} bones: give {len(bones) + 1} points")
    parent = arm.data.bones[bones[0]].parent.name
    inv = mw.inverted()
    with skeleton.edit_bones(arm) as eb:
        for i, bone in enumerate(bones):
            eb[bone].head = inv @ Vector(points[i])
            eb[bone].tail = inv @ Vector(points[i + 1])
    return {"chain": chain, "bones": bones, "parent": parent}


# ---- eyes that blink by bones (face.py reads them for the sidecar) -------------------------------

def _eye_frame(eye, look):
    """The eye's centre and radius (from its rest bounds), and (look, up, side) unit vectors."""
    co, _ = rest_coords(eye)
    if len(co) == 0:
        raise ValueError(f"{eye.name} has no vertices")
    lo, hi = co.min(axis=0), co.max(axis=0)
    centre = Vector(((lo + hi) / 2).tolist())
    d = Vector(look).normalized()
    up = Vector((0, 0, 1))
    up = (up - d * up.dot(d)).normalized()
    radius = float(max(hi - lo)) / 2
    return centre, radius, d, up, d.cross(up)


def _blink_bone(arm, name, parent, head, d, up, length):
    """A deforming bone along d (the eye's look) with its z toward up, under parent."""
    inv = arm.matrix_world.inverted()
    with skeleton.edit_bones(arm) as eb:
        b = eb.get(name) or eb.new(name)
        b.head = inv @ head
        b.tail = inv @ (head + d * length)
        b.align_roll(inv.to_3x3() @ up)
        b.parent = eb[parent]
        b.use_connect = False
        b.use_deform = True
    return name


def _side(side):
    if not (isinstance(side, str) and side.isalnum() and side.islower() and 0 < len(side) <= 8):
        raise ValueError(f"side {side!r}: one short lowercase word, such as 'l' or 'r'")
    return side


def _bound(obj, arm):
    return obj.parent == arm or arm in _deforming(obj)


def eye_lid(eye, side, *, armature=None, look=(0, -1, 0), open_deg=125.0, cover_deg=100.0, thick=None, material=None):
    """Round eyes that stand out of the head: an upper lid over eye (a sphere you modelled and
    placed) that the game shuts to blink. The lid is a shell at 1.085x the eye's radius covering
    cover_deg around the eye's look direction, turned open by open_deg toward the face's up (open
    high: low lids read grumpy), on its own bone blink_lid_<side> under Head and bound 100% to it.
    The eye is bound to Head if nothing binds it yet. Then it measures how the lid shuts, by rays over
    the eye, and returns that blink ({bone, kind, axis, amount}); a lid that never covers the eye is
    refused. The sidecar's face carries it, and the game blinks it on its own."""
    from . import face

    arm = _armature(armature) if armature is not None else armature_of("Head")
    side = _side(side)
    centre, radius, d, up, s = _eye_frame(eye, look)
    if not _bound(eye, arm):
        skin_rigid(eye, "Head", armature=arm)
    shell = 1.085 * radius
    t = thick if thick is not None else 0.07 * radius
    rings, segs = 10, 24
    verts, faces = [], []
    for layer, r in enumerate((shell, shell + t)):
        for i in range(rings + 1):
            polar = math.radians(cover_deg) * i / rings
            for j in range(segs):
                az = 2 * math.pi * j / segs
                out = d * math.cos(polar) + (s * math.cos(az) + up * math.sin(az)) * math.sin(polar)
                verts.append(centre + out * r)
    per = (rings + 1) * segs
    for layer in (0, per):
        for i in range(rings):
            for j in range(segs):
                a, b = layer + i * segs + j, layer + i * segs + (j + 1) % segs
                quad = (a, b, b + segs, a + segs)
                faces.append(quad if layer else quad[::-1])
    for j in range(segs):  # the rim joins the two layers
        a, b = rings * segs + j, rings * segs + (j + 1) % segs
        faces.append((a, b, b + per, a + per))
    opened = Matrix.Translation(centre) @ Matrix.Rotation(math.radians(open_deg), 4, s) @ Matrix.Translation(-centre)
    me = bpy.data.meshes.new(f"lid_{side}")
    me.from_pydata([tuple(opened @ v) for v in verts], [], faces)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)  # outward, or a one-sided engine shows the lid's inside
    bm.to_mesh(me)
    bm.free()
    me.shade_smooth()
    lid = _link(bpy.data.objects.new(me.name, me))
    if material is not None:
        me.materials.append(material)
    bone = _blink_bone(arm, f"blink_lid_{side}", "Head", centre, d, up, 1.5 * radius)
    skin_rigid(lid, bone, armature=arm)
    blink = face.blink_of(arm, bone)
    if blink is None:
        raise ValueError(f"the lid on {eye.name} never covers it when turned: check look (the way the eye faces) and cover_deg")
    return blink


def eye_squash(eye, side, *, shine=(), armature=None, look=(0, -1, 0)):
    """Painted-on (flat) eyes, where a lid would float in front of the face: the game blinks by
    squashing the eye along the face's up axis on its own bone blink_eye_<side> under Head, and
    hiding its highlights (shine: their objects, modelled apart from the eye) on blink_shine_<side>,
    a child of it. Each part is bound 100% to its bone. Returns the blinks ({bone, kind, axis, amount}),
    the squash axis measured off the bone."""
    from . import face

    arm = _armature(armature) if armature is not None else armature_of("Head")
    side = _side(side)
    centre, radius, d, up, _ = _eye_frame(eye, look)
    bone = _blink_bone(arm, f"blink_eye_{side}", "Head", centre, d, up, max(radius, 0.005))
    skin_rigid(eye, bone, armature=arm)
    out = [face.blink_of(arm, bone)]
    shine = list(shine)
    if shine:
        at = sum((_eye_frame(o, look)[0] for o in shine), Vector()) / len(shine)
        lit = _blink_bone(arm, f"blink_shine_{side}", bone, at, d, up, max(radius / 2, 0.003))
        for o in shine:
            skin_rigid(o, lit, armature=arm)
        out.append(face.blink_of(arm, lit))
    return out


def palette_of(path, colours=8):
    """The dominant colours of an image (the picked key art), most covered first, as "#rrggbb":
    k-means over its opaque pixels, seeded the same way every time, so one image gives one palette.
    The image is loaded for the call and removed again; it never enters the scene's data."""
    colours = max(2, min(64, int(colours)))
    image = bpy.data.images.load(path, check_existing=False)
    try:
        n = len(image.pixels) // 4
        px = np.empty(n * 4, np.float32)
        image.pixels.foreach_get(px)
        linear = image.is_float
    finally:
        bpy.data.images.remove(image)
    px = px.reshape(-1, 4)
    px = px[px[:, 3] > 0.5, :3]
    if len(px) == 0:
        raise ValueError(f"{path} has no opaque pixels")
    if linear:
        px = np.where(px > 0.0031308, 1.055 * np.power(np.clip(px, 0, 1), 1 / 2.4) - 0.055, 12.92 * px)
    rng = np.random.default_rng(0)
    px = px[rng.choice(len(px), min(len(px), 40000), replace=False)]
    centres = [px[rng.integers(len(px))]]
    for _ in range(colours - 1):  # k-means++: each next centre far from the ones chosen
        d = np.min([((px - c) ** 2).sum(1) for c in centres], axis=0)
        centres.append(px[rng.choice(len(px), p=d / d.sum())] if d.sum() > 0 else px[rng.integers(len(px))])
    centres = np.array(centres)
    for _ in range(30):
        label = np.argmin(((px[:, None, :] - centres[None]) ** 2).sum(2), 1)
        moved = np.array([px[label == k].mean(0) if np.any(label == k) else centres[k] for k in range(len(centres))])
        if np.allclose(moved, centres, atol=1e-4):
            break
        centres = moved
    share = np.bincount(label, minlength=len(centres))
    order = [k for k in np.argsort(-share) if share[k] > 0]
    return ["#%02x%02x%02x" % tuple(int(round(float(c) * 255)) for c in np.clip(centres[k], 0, 1)) for k in order]
