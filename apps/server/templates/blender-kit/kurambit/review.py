"""review(): the composite image of a candidate, rendered in a throwaway scene.

params: {candidate: abs glb, out: abs png, gamePx, view, palette: [hex] | None, used: [hex],
         concept_png: abs | None, characterHeight?: STYLE.json scale.character (a prop's scale)}

One PNG shows exactly what the export would write: a turnaround (front, three-quarter, side,
back); the same views in clay (every material light grey, with cavity), where paint no longer hides
a part off-centre, floating or poking out; the same views as silhouettes; the model at game
distance (gamePx tall, at 1x and 3x with nearest filtering) and, for a character, a close-up of its
head (the top 45% of its height, three-quarter view); six side-view frames of each locomotion,
jump and custom clip, with six front-view frames beside each locomotion's, where hip roll and arms
through the body show; the palette with the swatches the model uses marked; and the concept image
on the left when there is one. A prop has no close-up: its turnaround already shows all of it at
one scale, and no rule picks its most detailed region honestly.

Every tile's coverage is checked: one where the subject fills under 1% of it is named in the
result's problems, never left as a silently empty picture.

The candidate is imported into its own scene and every datablock the review added is removed in
`finally`, so the live scene never changes (the spriteRenderPy precedent). The turnaround and the
game-distance view and the close-up render in EEVEE; the clay row, the strips and the labels in
Workbench, which is about fifty times faster on the live session's software GL and keeps the
review inside one tool call."""
import math
import os
import shutil
import tempfile

import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import helpers, skeleton
from .protocol import Refused, entry

BG = (0.29, 0.30, 0.33)
INK = (0.93, 0.93, 0.95)
SILHOUETTE = (0.08, 0.09, 0.11)
CLAY = (0.78, 0.76, 0.72)
PAD = 14
TURN = (300, 380)
STRIP = (130, 165)
LABEL_PX = 20
TURN_VIEWS = (("front", 0), ("three-quarter", 40), ("side", 90), ("back", 180))
CLOSE = (300, 300)
HEAD = 0.45  # the close-up: the top of a character's height
MIN_COVER = 0.01
# Where the game's camera sees a character from (azimuth, elevation) per STYLE.json view.
GAME_VIEWS = {"perspective": (35, 22), "side": (90, 0), "top-down": (20, 55), "isometric": (45, 35.26)}
STRIP_WORDS = ("walk", "jog", "run", "sprint", "jump")
LOCOMOTION = ("walk", "jog", "run", "sprint")
NOT_STRIPS = ("idle", "hit", "death", "die", "pose")
MAX_STRIPS = 8
ID_TYPES = ("objects", "meshes", "materials", "images", "actions", "armatures", "cameras", "lights",
            "worlds", "curves", "collections", "node_groups", "textures", "scenes")


def _basis(az, el):
    a, e = math.radians(az), math.radians(el)
    back = Vector((-math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))  # toward the camera
    right = Vector((math.cos(a), -math.sin(a), 0.0))
    up = back.cross(right).normalized()
    return right, up, back


def _world_coords(sc, meshes):
    dg = sc.view_layers[0].depsgraph
    dg.update()
    out = []
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get("co", co)
            m = np.array(ev.matrix_world)
            out.append(co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3])
        finally:
            ev.to_mesh_clear()
    return np.concatenate(out) if out else np.zeros((1, 3))


def _extent(points, az, el):
    """(x0, x1, y0, y1, depth0, depth1) of points seen from a view."""
    r, u, b = (np.array(v) for v in _basis(az, el))
    x, y, d = points @ r, points @ u, points @ b
    return x.min(), x.max(), y.min(), y.max(), d.min(), d.max()


def _camera(cam, az, el, ext, ortho):
    r, u, b = _basis(az, el)
    cx, cy = (ext[0] + ext[1]) / 2, (ext[2] + ext[3]) / 2
    centre = r * cx + u * cy
    m = Matrix((r, u, b)).transposed().to_4x4()
    m.translation = centre + b * (ext[5] + 10.0)
    cam.matrix_world = m
    cam.data.ortho_scale = ortho
    cam.data.clip_end = (ext[5] - ext[4]) + 30.0


def _setup(sc, engine, size):
    sc.render.engine = engine
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.use_compositing = False
    sc.render.use_sequencer = False
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    if engine == "BLENDER_WORKBENCH":
        sc.display.shading.light = "STUDIO"
        sc.display.shading.color_type = "TEXTURE"
        sc.display.shading.show_cavity = False
        sc.display.render_aa = "8"
    else:
        sc.eevee.taa_render_samples = 16


def _clay(sc):
    sc.display.shading.color_type = "SINGLE"
    sc.display.shading.single_color = CLAY
    sc.display.shading.show_cavity = True
    sc.display.shading.cavity_type = "BOTH"


def _render(sc, path):
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True, scene=sc.name)
    return _load(path)


def _cover(tile):
    return float((tile[:, :, 3] > 0.5).mean())


def _load(path):
    """A PNG as a top-down float array (h, w, 4) of its stored (sRGB) values."""
    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        if w == 0 or h == 0:  # Blender loads a file that is not an image as an empty one
            raise Refused("invalid-input", f"the concept art/concepts/{os.path.basename(path)} could not be read as an image: replace it with a PNG, or remove it")
        px = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(px)
    finally:
        bpy.data.images.remove(img)
    return np.flipud(px.reshape(h, w, 4))


def _over(canvas, tile, x, y):
    h, w = tile.shape[:2]
    h, w = min(h, canvas.shape[0] - y), min(w, canvas.shape[1] - x)
    if h <= 0 or w <= 0:
        return
    t = tile[:h, :w]
    a = t[:, :, 3:4]
    region = canvas[y:y + h, x:x + w, :3]
    canvas[y:y + h, x:x + w, :3] = t[:, :, :3] * a + region * (1 - a)


def _studio(sc, made):
    lights = []
    for name, energy, shadow in (("key", 3.2, True), ("fill", 1.0, False), ("rim", 2.4, False)):
        data = bpy.data.lights.new("kurambit_review_" + name, "SUN")
        data.energy, data.use_shadow, data.angle = energy, shadow, math.radians(8)
        ob = bpy.data.objects.new(data.name, data)
        sc.collection.objects.link(ob)
        made.append(ob)
        lights.append(ob)
    world = bpy.data.worlds.new("kurambit_review_world")
    helpers.use_nodes(world)
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.42, 0.42, 0.45, 1.0)
    bg.inputs[1].default_value = 1.0
    sc.world = world
    return lights


def _aim_lights(lights, az, el):
    r, u, b = _basis(az, el)
    for ob, toward in zip(lights, (b * 0.9 + u * 0.8 - r * 0.5, b * 0.8 + u * 0.1 + r * 0.7, -b + u * 0.6 + r * 0.3)):
        ob.rotation_euler = toward.normalized().to_track_quat("Z", "Y").to_euler()


class Labels:
    """Text rendered by Workbench in its own little scene: Blender has no text drawing in the
    background, and a text object renders anywhere a model does."""

    def __init__(self, folder):
        self.folder, self.n = folder, 0
        self.sc = bpy.data.scenes.new("kurambit_review_labels")
        _setup(self.sc, "BLENDER_WORKBENCH", (64, LABEL_PX))
        self.sc.display.shading.light = "FLAT"
        self.sc.display.shading.color_type = "SINGLE"
        self.sc.display.shading.single_color = (1.0, 1.0, 1.0)
        self.curve = bpy.data.curves.new("kurambit_review_label", "FONT")
        self.text = bpy.data.objects.new("kurambit_review_label", self.curve)
        self.sc.collection.objects.link(self.text)
        cam = bpy.data.objects.new("kurambit_review_label_cam", bpy.data.cameras.new("kurambit_review_label_cam"))
        cam.data.type = "ORTHO"
        self.sc.collection.objects.link(cam)
        self.sc.camera, self.cam = cam, cam

    def __call__(self, text):
        self.curve.body = text
        self.sc.view_layers[0].update()
        dims = self.text.dimensions
        w = max(8, int(math.ceil(LABEL_PX * (dims.x + 0.2) / 1.25)))  # 1.25 units of text height per label
        span = w / LABEL_PX * 1.25
        self.sc.render.resolution_x, self.sc.render.resolution_y = w, LABEL_PX
        self.cam.data.ortho_scale = span
        self.cam.location = (span / 2 - 0.1, 0.25, 5)
        self.n += 1
        tile = _render(self.sc, os.path.join(self.folder, f"label_{self.n}.png"))
        tile[:, :, :3] = INK
        return tile


def _strip_clips(actions):
    named = {a: a.name.rsplit(".", 1)[0] if a.name[-4:-3] == "." and a.name[-3:].isdigit() else a.name for a in actions}
    order = lambda a: (next((i for i, w in enumerate(STRIP_WORDS) if w in named[a].lower()), len(STRIP_WORDS)), named[a])
    picked = [a for a in actions if not any(w in named[a].lower() for w in NOT_STRIPS)]
    return [(a, named[a]) for a in sorted(picked, key=order)[:MAX_STRIPS]]


def _frames(action, n=6):
    lo, hi = action.frame_range
    if "loop" in action.name.lower():
        return [lo + i * (hi - lo) / n for i in range(n)]
    return [lo + i * (hi - lo) / (n - 1) for i in range(n)]


def _set_frame(sc, f):
    sc.frame_set(int(math.floor(f)), subframe=f - math.floor(f))


def _nearest(tile, k):
    return np.repeat(np.repeat(tile, k, 0), k, 1)


def _silhouette(tile):
    small = tile[::2, ::2]
    out = np.zeros_like(small)
    out[:, :, :3] = SILHOUETTE
    out[:, :, 3] = (small[:, :, 3] > 0.5).astype(np.float32)
    return out


def _swatch(hexes, used):
    tiles = []
    for h in hexes:
        t = np.zeros((40, 34, 4), np.float32)
        rgb = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        t[2:30, 2:32, :3], t[2:30, 2:32, 3] = rgb, 1.0
        if h.lower() in used:
            t[33:38, 2:32, :3], t[33:38, 2:32, 3] = INK, 1.0
        else:
            t[2:30, 2:32, 3] = 0.45
        tiles.append(t)
    return np.concatenate(tiles, 1) if tiles else np.zeros((40, 1, 4), np.float32)


def _concept(path, height):
    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        if w == 0 or h == 0:  # Blender loads a file that is not an image as an empty one
            raise Refused("invalid-input", f"the concept art/concepts/{os.path.basename(path)} could not be read as an image: replace it with a PNG, or remove it")
        img.scale(max(1, round(w * height / h)), height)
        w, h = img.size
        px = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(px)
    finally:
        bpy.data.images.remove(img)
    return np.flipud(px.reshape(h, w, 4))


@entry
def review(params):
    out = params["out"]
    folder = os.path.join(os.path.dirname(out), "review-frames")
    os.makedirs(folder, exist_ok=True)
    before = {t: set(getattr(bpy.data, t)) for t in ID_TYPES}
    made = []
    window = bpy.context.window
    shown = window.scene if window is not None else None
    try:
        sc = bpy.data.scenes.new("kurambit_review")
        # The glTF importer works only in the context's own scene (its bone shapes break under a
        # context override), so it imports into the live scene and every object moves to the
        # throwaway one at once, inside this one call; what the import changed is put back.
        live, layer = bpy.context.scene, bpy.context.view_layer
        kept = (live.frame_start, live.frame_end, live.frame_current, live.render.fps, live.render.fps_base)
        active, selected = layer.objects.active, [o for o in layer.objects if o.select_get()]
        # The clips land on frames at the rate they were sampled at, so a clip's frames and seconds
        # agree in both scenes; the live scene's own rate is put back with the rest below.
        rate = skeleton.clip_rate(skeleton.gltf_json(params["candidate"])) or live.render.fps / live.render.fps_base
        live.render.fps = sc.render.fps = round(rate)
        live.render.fps_base = sc.render.fps_base = 1.0
        try:
            new, actions = skeleton.import_gltf(params["candidate"])
        finally:
            for o in [x for t in ("objects",) for x in getattr(bpy.data, t) if x not in before[t]]:
                for c in list(o.users_collection):
                    c.objects.unlink(o)
                sc.collection.objects.link(o)
            live.frame_start, live.frame_end, _, live.render.fps, live.render.fps_base = kept
            live.frame_set(kept[2])
            for o in layer.objects:
                o.select_set(o in selected)
            layer.objects.active = active
        # A scene renders its clips' poses only while a window shows it: the live session's window
        # shows the throwaway scene for the length of this call, and the live scene again after.
        if window is not None:
            window.scene = sc
        meshes = [o for o in new if o.type == "MESH"]
        arm = next((o for o in new if o.type == "ARMATURE"), None)
        cam = bpy.data.objects.new("kurambit_review_cam", bpy.data.cameras.new("kurambit_review_cam"))
        cam.data.type = "ORTHO"
        sc.collection.objects.link(cam)
        sc.camera = cam
        made.append(cam)
        lights = _studio(sc, made)
        labels = Labels(folder)

        idle = next((a for a in actions if "idle" in a.name.lower()), None)
        if arm is not None:
            skeleton.assign_action(arm, idle)
        _set_frame(sc, idle.frame_range[0] if idle is not None else 1)
        points = _world_coords(sc, meshes)
        exts = [_extent(points, az, 8) for _, az in TURN_VIEWS]
        span = max(max(e[1] - e[0] for e in exts) * TURN[1] / TURN[0], max(e[3] - e[2] for e in exts)) * 1.1
        problems = []

        def covered(tile, what):
            if _cover(tile) < MIN_COVER:
                problems.append(f"the {what} tile shows the model over {100 * _cover(tile):.2f}% of it (under {100 * MIN_COVER:.0f}%): it is out of frame or too small to judge there")
            return tile

        _setup(sc, "BLENDER_EEVEE_NEXT", TURN)
        turns = []
        for i, (name, az) in enumerate(TURN_VIEWS):
            _camera(cam, az, 8, exts[i], span)
            _aim_lights(lights, az, 8)
            turns.append(covered(_render(sc, os.path.join(folder, f"turn_{name}.png")), f"{name} turnaround"))

        close = None
        if arm is not None:
            lo, hi = points[:, 2].min(), points[:, 2].max()
            head = points[points[:, 2] >= hi - HEAD * (hi - lo)]
            he = _extent(head, 40, 8)
            _setup(sc, "BLENDER_EEVEE_NEXT", CLOSE)
            _camera(cam, 40, 8, he, max(he[1] - he[0], he[3] - he[2]) * 1.08)
            _aim_lights(lights, 40, 8)
            close = covered(_render(sc, os.path.join(folder, "close.png")), "head close-up")

        _setup(sc, "BLENDER_WORKBENCH", TURN)
        _clay(sc)
        clays = []
        for i, (name, az) in enumerate(TURN_VIEWS):
            _camera(cam, az, 8, exts[i], span)
            clays.append(covered(_render(sc, os.path.join(folder, f"clay_{name}.png")), f"{name} clay"))

        gaz, gel = GAME_VIEWS.get(params.get("view") or "perspective", GAME_VIEWS["perspective"])
        game_px = int(params.get("gamePx") or 96)
        ge = _extent(points, gaz, gel)
        span_g = max(ge[3] - ge[2], ge[1] - ge[0])
        if arm is not None:
            per_m = game_px / max(ge[3] - ge[2], 1e-6)
            game_label = f"at game distance: {game_px} px tall"
        else:
            # a prop is drawn at the scale the game's characters are drawn at, not at their height
            height = float(params.get("characterHeight") or 2.0)
            per_m = game_px / height
            game_label = f"at game distance ({height:g} m character = {game_px} px)"
        size = max(16, int(round(span_g * per_m * 1.25)))
        _setup(sc, "BLENDER_EEVEE_NEXT", (size, size))
        _camera(cam, gaz, gel, ge, size / per_m)
        _aim_lights(lights, gaz, gel)
        game = covered(_render(sc, os.path.join(folder, "game.png")), "game-distance")

        strips = []
        if arm is not None:
            clips = _strip_clips([a for a in actions if a is not idle])
            sampled = []
            for act, _ in clips:
                skeleton.assign_action(arm, act)
                for f in _frames(act):
                    _set_frame(sc, f)
                    sampled.append(_world_coords(sc, meshes))
            if sampled:
                _setup(sc, "BLENDER_WORKBENCH", STRIP)
                frames = {}
                for view, az in (("side", 90), ("front", 0)):
                    se = _extent(np.concatenate(sampled), az, 4)
                    sspan = max((se[1] - se[0]) * STRIP[1] / STRIP[0], se[3] - se[2]) * 1.06
                    _camera(cam, az, 4, se, sspan)
                    for n, (act, label) in enumerate(clips):
                        if view == "front" and not any(w in label.lower() for w in LOCOMOTION):
                            continue
                        skeleton.assign_action(arm, act)
                        cells = []
                        for k, f in enumerate(_frames(act)):
                            _set_frame(sc, f)
                            cells.append(_render(sc, os.path.join(folder, f"strip_{view}_{n}_{k}.png")))
                        empty = [k + 1 for k, c in enumerate(cells) if _cover(c) < MIN_COVER]
                        if empty:
                            problems.append(f"the {label} {view} strip's frame{'s' if len(empty) > 1 else ''} {', '.join(map(str, empty))} show the model over under {100 * MIN_COVER:.0f}% of the tile: it leaves the frame there")
                        frames[(n, view)] = cells
                for n, (act, label) in enumerate(clips):
                    seconds = (act.frame_range[1] - act.frame_range[0]) / (sc.render.fps / sc.render.fps_base)
                    front = frames.get((n, "front"))
                    text = f"{label}  {seconds:.2f} s" + ("   side, then front" if front else "")
                    strips.append((labels(text), frames[(n, "side")] + (front or [])))

        concept = None
        if params.get("concept_png") and os.path.isfile(params["concept_png"]):
            concept = _concept(params["concept_png"], TURN[1])
        palette = [h.lower() for h in (params.get("palette") or [])]
        used = {h.lower() for h in (params.get("used") or [])}

        # ---- the layout ---------------------------------------------------------------------
        left = PAD + (concept.shape[1] + PAD if concept is not None else 0)
        zoom = max(1, min(3, TURN[1] // game.shape[0]))  # a wide prop at 3x would outgrow the page
        game3 = _nearest(game, zoom)
        turn_w = 4 * TURN[0]
        gx = left + turn_w + PAD
        strip_w = 6 * STRIP[0] + 2 * PAD
        strip_h = LABEL_PX + 4 + STRIP[1] + PAD
        width = max(gx + game3.shape[1] + PAD + game.shape[1] + PAD,
                    gx + (CLOSE[0] + PAD if close is not None else 0),
                    PAD + 2 * strip_w, PAD + 34 * len(palette) + PAD)
        row_a = PAD + LABEL_PX + 4
        row_k = row_a + max(TURN[1], game3.shape[0]) + PAD  # the clay row
        row_b = row_k + LABEL_PX + 4 + TURN[1] + PAD
        row_c = row_b + LABEL_PX + 4 + TURN[1] // 2 + PAD
        # A clip with a front strip takes a whole row; the others go two to a row.
        places, x, y = [], 0, row_c
        for _, cells in strips:
            wide = len(cells) > 6
            if x > 0 and (wide or x + strip_w > 2 * strip_w):
                x, y = 0, y + strip_h
            places.append((PAD + x, y))
            x += 2 * strip_w if wide else strip_w
        row_p = y + strip_h if strips else row_c
        height = row_p + (LABEL_PX + 4 + 40 + PAD if palette else 0)
        canvas = np.zeros((height, width, 4), np.float32)
        canvas[:, :, :3], canvas[:, :, 3] = BG, 1.0

        if concept is not None:
            _over(canvas, labels("concept"), PAD, PAD)
            _over(canvas, concept, PAD, row_a)
        _over(canvas, labels("turnaround: front, three-quarter, side, back"), left, PAD)
        for i, t in enumerate(turns):
            _over(canvas, t, left + i * TURN[0], row_a)
        _over(canvas, labels(f"{game_label}, {zoom}x and 1x" if zoom > 1 else game_label), gx, PAD)
        _over(canvas, game3, gx, row_a)
        if zoom > 1:
            _over(canvas, game, gx + game3.shape[1] + PAD, row_a)
        _over(canvas, labels("clay: no paint, so parts off-centre, floating or poking out show"), left, row_k)
        for i, t in enumerate(clays):
            _over(canvas, t, left + i * TURN[0], row_k + LABEL_PX + 4)
        if close is not None:
            _over(canvas, labels("head close-up"), gx, row_k)
            _over(canvas, close, gx, row_k + LABEL_PX + 4)
        _over(canvas, labels("silhouettes"), left, row_b)
        for i, t in enumerate(turns):
            _over(canvas, _silhouette(t), left + i * TURN[0] + TURN[0] // 4, row_b + LABEL_PX + 4)
        for (label, cells), (x, y) in zip(strips, places):
            _over(canvas, label, x, y)
            for k, cell in enumerate(cells):
                _over(canvas, cell, x + k * STRIP[0] + (2 * PAD if k >= 6 else 0), y + LABEL_PX + 4)
        if palette:
            _over(canvas, labels("palette (underlined: used by this model)"), PAD, row_p)
            _over(canvas, _swatch(palette, used), PAD, row_p + LABEL_PX + 4)

        img = bpy.data.images.new("kurambit_review_out", width, height, alpha=False)
        img.pixels.foreach_set(np.flipud(canvas).ravel())
        img.filepath_raw = out
        img.file_format = "PNG"
        img.save()
        return {"image": out, "width": width, "height": height, "problems": problems[:12]}
    finally:
        if window is not None:
            window.scene = shown
        added = [x for t in ID_TYPES for x in getattr(bpy.data, t) if x not in before[t]]
        for x in added:
            if isinstance(x, bpy.types.Scene):
                bpy.data.scenes.remove(x)
        bpy.data.batch_remove([x for x in added if not isinstance(x, bpy.types.Scene)])
        shutil.rmtree(folder, ignore_errors=True)


@entry
def motion_strip(params):
    """motion_strip(): a generated motion's card picture. Each clip plays on the body its GLB holds
    (the body it was made on): six side-view frames, and six front-view frames beside a walk or a
    run, labelled with its name and length, one row per clip. Rendered in a throwaway scene in
    Workbench like the review's strips; the live scene does not change.

    params: {clips: [{path: abs glb, label}], out: abs png}"""
    out = params["out"]
    folder = tempfile.mkdtemp(prefix="kurambit-strip-")
    before = {t: set(getattr(bpy.data, t)) for t in ID_TYPES}
    window = bpy.context.window
    shown = window.scene if window is not None else None
    live, layer = bpy.context.scene, bpy.context.view_layer
    kept = (live.frame_start, live.frame_end, live.frame_current, live.render.fps, live.render.fps_base)
    active, selected = layer.objects.active, [o for o in layer.objects if o.select_get()]
    try:
        sc = bpy.data.scenes.new("kurambit_strip")
        cam = bpy.data.objects.new("kurambit_strip_cam", bpy.data.cameras.new("kurambit_strip_cam"))
        cam.data.type = "ORTHO"
        sc.collection.objects.link(cam)
        sc.camera = cam
        labels = Labels(folder)
        if window is not None:
            window.scene = sc
        rows, problems = [], []
        for n, clip in enumerate(params["clips"]):
            rate = skeleton.clip_rate(skeleton.gltf_json(clip["path"])) or 30
            live.render.fps = sc.render.fps = round(rate)
            live.render.fps_base = sc.render.fps_base = 1.0
            objects_before = set(bpy.data.objects)
            if window is not None:
                window.scene = live  # the glTF importer works in the context's own scene only
            try:
                new, actions = skeleton.import_gltf(clip["path"])
            finally:
                for o in [x for x in bpy.data.objects if x not in objects_before]:
                    for c in list(o.users_collection):
                        c.objects.unlink(o)
                    sc.collection.objects.link(o)
                if window is not None:
                    window.scene = sc
            for o in sc.collection.objects:  # the previous clip's body leaves the frame
                if o is not cam and o not in new:
                    o.hide_render = True
            meshes = [o for o in new if o.type == "MESH"]
            arm = next((o for o in new if o.type == "ARMATURE"), None)
            if arm is None or not meshes or not actions:
                raise Refused("invalid-input", f"{os.path.basename(clip['path'])} holds no body playing a clip")
            act = max(actions, key=lambda a: a.frame_range[1] - a.frame_range[0])
            skeleton.assign_action(arm, act)
            frames = _frames(act)
            sampled = []
            for f in frames:
                _set_frame(sc, f)
                sampled.append(_world_coords(sc, meshes))
            _setup(sc, "BLENDER_WORKBENCH", STRIP)
            views = [("side", 90)] + ([("front", 0)] if any(w in clip["label"].lower() for w in ("walk", "run", "jog", "sprint")) else [])
            cells = []
            for view, az in views:
                se = _extent(np.concatenate(sampled), az, 4)
                _camera(cam, az, 4, se, max((se[1] - se[0]) * STRIP[1] / STRIP[0], se[3] - se[2]) * 1.06)
                for k, f in enumerate(frames):
                    _set_frame(sc, f)
                    cell = _render(sc, os.path.join(folder, f"strip_{n}_{view}_{k}.png"))
                    if _cover(cell) < MIN_COVER:
                        problems.append(f"{clip['label']} {view} frame {k + 1} shows almost nothing")
                    cells.append(cell)
            seconds = (act.frame_range[1] - act.frame_range[0]) / rate
            text = f"{clip['label']}  {seconds:.2f} s" + ("   side, then front" if len(views) > 1 else "")
            rows.append((labels(text), cells))

        strip_w = 6 * STRIP[0]
        width = PAD + max(len(cells) // 6 for _, cells in rows) * (strip_w + 2 * PAD)
        row_h = LABEL_PX + 4 + STRIP[1] + PAD
        canvas = np.zeros((PAD + row_h * len(rows), width, 4), np.float32)
        canvas[:, :, :3], canvas[:, :, 3] = BG, 1.0
        for i, (label, cells) in enumerate(rows):
            y = PAD + i * row_h
            _over(canvas, label, PAD, y)
            for k, cell in enumerate(cells):
                _over(canvas, cell, PAD + k * STRIP[0] + (2 * PAD if k >= 6 else 0), y + LABEL_PX + 4)
        img = bpy.data.images.new("kurambit_strip_out", width, canvas.shape[0], alpha=False)
        img.pixels.foreach_set(np.flipud(canvas).ravel())
        img.filepath_raw = out
        img.file_format = "PNG"
        img.save()
        return {"image": out, "problems": problems[:12]}
    finally:
        if window is not None:
            window.scene = shown
        live.frame_start, live.frame_end, _, live.render.fps, live.render.fps_base = kept
        live.frame_set(kept[2])
        for o in layer.objects:
            o.select_set(o in selected)
        layer.objects.active = active
        added = [x for t in ID_TYPES for x in getattr(bpy.data, t) if x not in before[t]]
        for x in added:
            if isinstance(x, bpy.types.Scene):
                bpy.data.scenes.remove(x)
        bpy.data.batch_remove([x for x in added if not isinstance(x, bpy.types.Scene)])
        shutil.rmtree(folder, ignore_errors=True)


MODEL_VIEWS = (("front", 0), ("side", 90), ("back", 180))


@entry
def model_views(params):
    """model_views(): a generated model's card picture before it is rigged, so the person sees what
    the rig would be bought for. Front, side and back with its textures, then the same views in
    clay, where paint no longer hides a part off-centre, floating or poking out. Rendered in a
    throwaway scene in Workbench like the strips; the live scene does not change.

    params: {model: abs glb, out: abs png}"""
    out = params["out"]
    folder = tempfile.mkdtemp(prefix="kurambit-views-")
    before = {t: set(getattr(bpy.data, t)) for t in ID_TYPES}
    window = bpy.context.window
    shown = window.scene if window is not None else None
    live, layer = bpy.context.scene, bpy.context.view_layer
    kept = (live.frame_start, live.frame_end, live.frame_current)
    active, selected = layer.objects.active, [o for o in layer.objects if o.select_get()]
    try:
        sc = bpy.data.scenes.new("kurambit_views")
        try:
            new, _ = skeleton.import_gltf(params["model"])  # the importer works in the context's scene only
        finally:
            for o in [x for x in bpy.data.objects if x not in before["objects"]]:
                for c in list(o.users_collection):
                    c.objects.unlink(o)
                sc.collection.objects.link(o)
        if window is not None:
            window.scene = sc
        meshes = [o for o in new if o.type == "MESH"]
        if not meshes:
            raise Refused("invalid-input", f"{os.path.basename(params['model'])} holds no mesh")
        cam = bpy.data.objects.new("kurambit_views_cam", bpy.data.cameras.new("kurambit_views_cam"))
        cam.data.type = "ORTHO"
        sc.collection.objects.link(cam)
        sc.camera = cam
        labels = Labels(folder)
        points = _world_coords(sc, meshes)
        exts = [_extent(points, az, 8) for _, az in MODEL_VIEWS]
        span = max(max(e[1] - e[0] for e in exts) * TURN[1] / TURN[0], max(e[3] - e[2] for e in exts)) * 1.1
        _setup(sc, "BLENDER_WORKBENCH", TURN)
        rows, problems = [], []
        for kind in ("textured", "clay"):
            if kind == "clay":
                _clay(sc)
            tiles = []
            for i, (name, az) in enumerate(MODEL_VIEWS):
                _camera(cam, az, 8, exts[i], span)
                tile = _render(sc, os.path.join(folder, f"{kind}_{name}.png"))
                if _cover(tile) < MIN_COVER:
                    problems.append(f"the {kind} {name} view shows almost nothing")
                tiles.append(tile)
            rows.append((labels(f"{kind}: front, side, back"), tiles))
        width = PAD * 2 + len(MODEL_VIEWS) * TURN[0]
        row_h = LABEL_PX + 4 + TURN[1] + PAD
        canvas = np.zeros((PAD + row_h * len(rows), width, 4), np.float32)
        canvas[:, :, :3], canvas[:, :, 3] = BG, 1.0
        for r, (label, tiles) in enumerate(rows):
            y = PAD + r * row_h
            _over(canvas, label, PAD, y)
            for i, tile in enumerate(tiles):
                _over(canvas, tile, PAD + i * TURN[0], y + LABEL_PX + 4)
        img = bpy.data.images.new("kurambit_views_out", width, canvas.shape[0], alpha=False)
        img.pixels.foreach_set(np.flipud(canvas).ravel())
        img.filepath_raw = out
        img.file_format = "PNG"
        img.save()
        return {"image": out, "problems": problems[:12]}
    finally:
        if window is not None:
            window.scene = shown
        live.frame_start, live.frame_end, _ = kept
        live.frame_set(kept[2])
        for o in layer.objects:
            o.select_set(o in selected)
        layer.objects.active = active
        added = [x for t in ID_TYPES for x in getattr(bpy.data, t) if x not in before[t]]
        for x in added:
            if isinstance(x, bpy.types.Scene):
                bpy.data.scenes.remove(x)
        bpy.data.batch_remove([x for x in added if not isinstance(x, bpy.types.Scene)])
        shutil.rmtree(folder, ignore_errors=True)


# ------------------------------------------------------------------------------ a move's pictures
# game_animate's pictures after every pass: the contact sheet (front, side and three-quarter of the
# beats and frames between, one fixed camera per view, so root motion shows), the onion strip
# (ghosts every few frames, blue early to orange late), the footprint plot (top down: the feet,
# stances thick with their slide, the centre of mass, the support, a held prop's tip and its
# strikes) and the curves (speeds, jerk, joint angles and balance over time, beats marked). The
# character's own objects are linked into a throwaway scene for the renders; plots are drawn with
# numpy and labelled by the Labels scene.
SHEET_TILE = (170, 215)
ONION_TILE = (230, 290)
SHEET_VIEWS = (("front", 0), ("side", 90), ("three-quarter", 40))
ONION_VIEWS = (("side", 90), ("three-quarter", 40))
BEAT = (1.0, 0.78, 0.35)
LEFT = (0.33, 0.58, 0.93)
RIGHT = (0.92, 0.42, 0.30)
GREY = (0.62, 0.63, 0.66)


def _offsets(r):
    k = int(math.ceil(r))
    return [(dy, dx) for dy in range(-k, k + 1) for dx in range(-k, k + 1) if dy * dy + dx * dx <= r * r + 0.25]


def _stroke(canvas, xy, colour, width=1.5, dash=0.0, alpha=1.0):
    """A polyline in pixel coordinates, stamped every half pixel; dash > 0 draws dashes that long."""
    xy = np.asarray(xy, float)
    if len(xy) == 0:
        return
    pts, run, total = [xy[:1]], [np.zeros(1)], 0.0
    for a, b in zip(xy[:-1], xy[1:]):
        d = float(np.linalg.norm(b - a))
        k = max(1, int(d / 0.5))
        t = np.arange(1, k + 1)[:, None] / k
        pts.append(a + (b - a) * t)
        run.append(total + d * t[:, 0])
        total += d
    pts = np.concatenate(pts)
    run = np.concatenate(run)
    if dash > 0:
        pts = pts[(run // dash) % 2 == 0]
    h, w = canvas.shape[:2]
    for dy, dx in _offsets(width / 2):
        ys = np.round(pts[:, 1]).astype(int) + dy
        xs = np.round(pts[:, 0]).astype(int) + dx
        ok = (ys >= 0) & (ys < h) & (xs >= 0) & (xs < w)
        canvas[ys[ok], xs[ok], :3] = canvas[ys[ok], xs[ok], :3] * (1 - alpha) + np.array(colour) * alpha


def _say(canvas, labels, text, x, y, colour=INK):
    tile = labels(text).copy()
    tile[:, :, :3] = colour
    _over(canvas, tile, int(x), int(y))
    return tile.shape[1]


def _blank(w, h):
    c = np.zeros((h, w, 4), np.float32)
    c[:, :, :3], c[:, :, 3] = BG, 1.0
    return c


def _save(canvas, path):
    img = bpy.data.images.new("kurambit_motion_out", canvas.shape[1], canvas.shape[0], alpha=False)
    try:
        img.pixels.foreach_set(np.flipud(canvas).ravel())
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
    finally:
        bpy.data.images.remove(img)
    return path


def _floor(sc, size, made):
    me = bpy.data.meshes.new("kurambit_motion_floor")
    h = size / 2
    me.from_pydata([(-h, -h, 0), (h, -h, 0), (h, h, 0), (-h, h, 0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new("kurambit_motion_floor", me)
    mat = bpy.data.materials.new("kurambit_motion_floor")
    mat.diffuse_color = (0.42, 0.42, 0.40, 1)
    me.materials.append(mat)
    sc.collection.objects.link(ob)
    made.append(ob)
    return ob


def _views(sc, cam, frames, folder, prefix, points, size, views, transparent, floor_ob, el=8.0, margin=0.15):
    """Renders frames from each view, one fixed camera per view framing every point of the clip."""
    _setup(sc, "BLENDER_WORKBENCH", size)
    sc.display.shading.show_shadows = not transparent
    sc.display.shading.shadow_intensity = 0.55
    sc.display.light_direction = (0.35, -0.45, 0.82)
    sc.render.film_transparent = transparent
    floor_ob.hide_render = transparent
    aspect = size[0] / size[1]
    out = {}
    for name, az in views:
        ext = _extent(points, az, el)
        w, h = (ext[1] - ext[0]) + 2 * margin, (ext[3] - ext[2]) + 2 * margin
        _camera(cam, az, el, ext, max(w, h * aspect) if aspect >= 1 else max(h, w / aspect))
        tiles = []
        for f in frames:
            sc.frame_set(f)
            tiles.append(_render(sc, os.path.join(folder, f"{prefix}_{name}_{f}.png")))
        out[name] = tiles
    return out


def _contact_sheet(sc, cam, floor_ob, folder, labels, f0, n, beats, notes, points, title):
    picks = sorted({f0 + b for b in beats if b < n} | {f0 + int(round(i * (n - 1) / 9)) for i in range(10)})
    while len(picks) > 12:  # keep the beats; drop the closest in-between frame
        mids = [p for p in picks if p - f0 not in beats]
        if not mids:
            picks = picks[:12]
            break
        gaps = [min(abs(p - q) for q in picks if q != p) for p in mids]
        picks.remove(mids[int(np.argmin(gaps))])
    tiles = _views(sc, cam, picks, folder, "sheet", points, SHEET_TILE, SHEET_VIEWS, False, floor_ob)
    tw, th = SHEET_TILE
    left, top = 96, 30 + LABEL_PX + 6
    canvas = _blank(left + tw * len(picks) + PAD, top + (th + 4) * len(SHEET_VIEWS) + PAD)
    _say(canvas, labels, title, PAD, 6)
    for c, f in enumerate(picks):
        k = f - f0
        _say(canvas, labels, f"f{k}" + (" beat" if k in beats else ""), left + c * tw + 4, 32, BEAT if k in beats else INK)
    for r, (name, _) in enumerate(SHEET_VIEWS):
        y = top + r * (th + 4)
        _say(canvas, labels, name if name != "three-quarter" else "3/4", 8, y + th // 2 - 10)
        for c, tile in enumerate(tiles[name]):
            _over(canvas, tile, left + c * tw, y)
            if picks[c] - f0 in beats:
                canvas[y:y + 3, left + c * tw:left + (c + 1) * tw - 2, :3] = BEAT
    return canvas, picks


def _onion(sc, cam, floor_ob, folder, labels, f0, n, beats, points, parts=4):
    step = 2 if n <= 60 else 3
    every = list(range(f0, f0 + n, step))
    if every[-1] != f0 + n - 1:
        every.append(f0 + n - 1)
    tiles = _views(sc, cam, every, folder, "onion", points, ONION_TILE, ONION_VIEWS, True, floor_ob)
    k = max(1, int(math.ceil(len(every) / parts)))
    chunks = [list(range(i, min(len(every), i + k + 1))) for i in range(0, len(every), k)][:parts]
    tw, th = ONION_TILE
    canvas = _blank(tw * len(chunks), 26 + th * len(ONION_VIEWS))
    _say(canvas, labels, f"onion: every {'2nd' if step == 2 else '3rd'} frame, blue early to orange late, beats and the last frame stronger", 6, 3)
    for r, (name, _) in enumerate(ONION_VIEWS):
        for c, idx in enumerate(chunks):
            panel = _blank(tw, th)
            for i, j in enumerate(idx):
                t = i / max(1, len(idx) - 1)
                tint = np.array([0.35 + 0.65 * t, 0.55 + 0.16 * (1 - abs(2 * t - 1)), 1.0 - 0.69 * t])
                tile = tiles[name][j].copy()
                strong = i == len(idx) - 1 or (every[j] - f0) in beats
                tile[:, :, :3] = tile[:, :, :3] * 0.5 + tint * 0.5
                tile[:, :, 3] *= 0.85 if strong else 0.3
                _over(panel, tile, 0, 0)
            _over(canvas, panel, c * tw, 26 + r * th)
            _say(canvas, labels, f"{'3/4' if name == 'three-quarter' else name} f{every[idx[0]] - f0}-{every[idx[-1]] - f0}", c * tw + 6, 26 + r * th + 4)
    return canvas


def _footprint(labels, res, curves, title, size=620):
    tr = {k: np.array(v) for k, v in curves["track"].items()}
    keys = [k for k in tr if k.startswith(("ball_", "heel_", "toe_"))] + (["tip"] if "tip" in tr else [])
    allp = np.concatenate([tr[k][:, :2] for k in keys] + [np.array(curves["com"])[:, :2]])
    # forward is up, the character's right is right: x = -X, y = -Y in armature space
    px, py = -allp[:, 0], -allp[:, 1]
    span = max(px.max() - px.min(), py.max() - py.min(), 0.5) * 1.12
    cx, cy = (px.max() + px.min()) / 2, (py.max() + py.min()) / 2
    top = 34
    canvas = _blank(size, size + top + 30)
    scale = size / span

    def to_px(p):
        p = np.asarray(p)
        return np.stack([size / 2 + (-p[:, 0] - cx) * scale, top + size / 2 - (-p[:, 1] - cy) * scale], 1)

    grid = 0.25 if span < 3 else 0.5
    for g in np.arange(math.floor((cx - span / 2) / grid) * grid, cx + span / 2, grid):
        x = size / 2 + (g - cx) * scale
        _stroke(canvas, [(x, top), (x, top + size)], (0.36, 0.37, 0.40), 1.0)
    for g in np.arange(math.floor((cy - span / 2) / grid) * grid, cy + span / 2, grid):
        y = top + size / 2 - (g - cy) * scale
        _stroke(canvas, [(0, y), (size, y)], (0.36, 0.37, 0.40), 1.0)
    for i, sup in enumerate(curves["support"]):
        if i % 6 == 0 and len(sup) >= 3:
            s = np.array(sup + [sup[0]])
            _stroke(canvas, to_px(np.c_[s, np.zeros(len(s))]), (0.5, 0.5, 0.52), 1.0, alpha=0.6)
    if "tip" in tr:
        _stroke(canvas, to_px(tr["tip"]), (0.8, 0.8, 0.82), 1.0, alpha=0.7)
    for s, col in (("l", LEFT), ("r", RIGHT)):
        _stroke(canvas, to_px(tr["ball_" + s]), col, 1.2, alpha=0.7)
        _stroke(canvas, to_px(tr["heel_" + s]), col, 1.0, dash=3.0, alpha=0.6)
        for st in res["stances"]:
            if st["foot"] != s:
                continue
            seg = to_px(tr["ball_" + s][st["from"]:st["to"] + 1])
            _stroke(canvas, seg, col, 6.0)
            _say(canvas, labels, f"{st['slideMm']:.0f}mm", seg[0][0] + 6, seg[0][1] - 8, col)
    _stroke(canvas, to_px(np.array(curves["com"])), (0.05, 0.05, 0.06), 2.0)
    if "tip" in tr:
        for st in res["strikes"]:
            if st["by"] != "prop":
                continue
            p = to_px(tr["tip"][st["frame"]:st["frame"] + 1])[0]
            for dy, dx in _offsets(5.5):
                y, x = int(p[1]) + dy, int(p[0]) + dx
                if 0 <= y < canvas.shape[0] and 0 <= x < size:
                    canvas[y, x, :3] = BEAT
            _say(canvas, labels, f"f{st['frame']} {st['speed']}m/s", p[0] + 8, p[1] + 2, BEAT)
    _say(canvas, labels, title + ": top down, forward up", 8, 6)
    x = 8
    for text, col in (("left foot", LEFT), ("right foot", RIGHT), ("thick: planted, its slide", INK), ("black: centre of mass", INK),
                      ("grey: support, prop tip", GREY), (f"grid {grid} m", GREY)):
        x += _say(canvas, labels, text, x, size + top + 6, col) + 14
    return canvas


def _curves(labels, res, curves, beats, title, width=920, panel=170):
    n = res["frames"]
    left, top = 64, 30
    panels = 4
    canvas = _blank(width, top + panels * (panel + 26) + 24)
    _say(canvas, labels, title + ": speeds, jerk, joint angles and balance by frame; orange: beats", 8, 4)

    def frame_x(f):
        return left + (width - left - 12) * f / max(1, n - 1)

    def plot(row, series, lo, hi, name, unit_text, guide=None):
        y0 = top + row * (panel + 26) + 22
        canvas[y0:y0 + panel, left:width - 12, :3] = (0.25, 0.26, 0.29)
        for b in beats:
            if 0 <= b < n:
                _stroke(canvas, [(frame_x(b), y0), (frame_x(b), y0 + panel)], BEAT, 1.0, alpha=0.45)

        def y_of(v):
            return y0 + panel - (np.clip(v, lo, hi) - lo) / max(1e-9, hi - lo) * panel

        if guide is not None:
            _stroke(canvas, [(left, y_of(guide)), (width - 12, y_of(guide))], (0.9, 0.3, 0.3), 1.0, dash=4.0)
        x = left
        for label, values, col in series:
            v = np.array([np.nan if q is None else q for q in values], float)
            ok = ~np.isnan(v)
            for a, b in _runs_of(ok):
                _stroke(canvas, np.stack([frame_x(np.arange(a, b + 1)), y_of(v[a:b + 1])], 1), col, 1.4)
            x += _say(canvas, labels, label, x, y0 - 21, col) + 12
        _say(canvas, labels, f"{hi:g} {unit_text}".strip() + " ", 6, y0 - 2, GREY)
        _say(canvas, labels, f"{lo:g} {unit_text}".strip() + " ", 6, y0 + panel - 18, GREY)
        _say(canvas, labels, name, width - 12 - 8 * len(name) - 10, y0 - 21, GREY)

    sp = [("hand_r", "right hand", RIGHT), ("hand_l", "left hand", LEFT), ("foot_r", "right foot", (0.75, 0.3, 0.55)),
          ("foot_l", "left foot", (0.2, 0.62, 0.5)), ("Head", "head", (0.85, 0.85, 0.88)), ("pelvis", "pelvis", (0.1, 0.1, 0.1))]
    if "tip" in curves:
        sp.append(("tip", "prop tip", BEAT))
    top_speed = max(max(curves[k]["speed"]) for k, _, _ in sp if k in curves)
    plot(0, [(lab, curves[k]["speed"], c) for k, lab, c in sp if k in curves], 0, round(max(2.0, top_speed) + 0.5), "speed", "m/s")
    lj = [(lab, np.log10(1 + np.array(curves[k]["jerk"])).tolist(), c) for k, lab, c in sp if k in curves]
    plot(1, lj, 0, 5, "jerk, log10(1 + m/s3)", "log")
    ang = curves["angles"]
    plot(2, [("knee l", ang["knee_flex_l"], (0.2, 0.62, 0.5)), ("knee r", ang["knee_flex_r"], (0.75, 0.3, 0.55)),
             ("elbow l", ang["elbow_flex_l"], LEFT), ("elbow r", ang["elbow_flex_r"], RIGHT),
             ("spine twist", ang["spine_twist"], (0.1, 0.1, 0.1)), ("neck turn", ang["neck_turn"], (0.85, 0.85, 0.88))], -90, 160, "joint angles", "deg", guide=0)
    xo = [None if d is None else d * 100 for d in curves["xcomOut"]]
    plot(3, [("XCoM outside support (cm), gaps: airborne", xo, (0.95, 0.35, 0.35))], 0, max(20, round(max([v for v in xo if v is not None] or [0]) + 5)),
         "balance", "cm", guide=5)
    return canvas


def _runs_of(flags):
    out, k, n = [], 0, len(flags)
    while k < n:
        if not flags[k]:
            k += 1
            continue
        j = k
        while j + 1 < n and flags[j + 1]:
            j += 1
        out.append((k, j))
        k = j + 1
    return out


def motion_pictures(arm, body, act, res, curves, beats, notes, out, title, motion):
    """game_animate's four pictures of a clip on its character, written under out; their paths."""
    folder = tempfile.mkdtemp(prefix="kurambit-motion-")
    before = {t: set(getattr(bpy.data, t)) for t in ID_TYPES}
    window = bpy.context.window
    shown = window.scene if window is not None else None
    live = bpy.context.scene
    made = []
    try:
        sc = bpy.data.scenes.new("kurambit_motion")
        sc.render.fps, sc.render.fps_base = live.render.fps, live.render.fps_base
        for o in [arm, *body.meshes]:
            sc.collection.objects.link(o)
        cam = bpy.data.objects.new("kurambit_motion_cam", bpy.data.cameras.new("kurambit_motion_cam"))
        cam.data.type = "ORTHO"
        sc.collection.objects.link(cam)
        sc.camera = cam
        world = bpy.data.worlds.new("kurambit_motion_world")
        world.color = (0.30, 0.31, 0.34)
        sc.world = world
        tr = curves["track"]
        points = np.concatenate([np.array(v) for v in tr.values()])
        floor_ob = _floor(sc, 4 * float(np.ptp(points[:, :2], axis=0).max() + 4), made)
        labels = Labels(folder)
        if window is not None:
            window.scene = sc
        skeleton.assign_action(arm, act)
        f0 = int(round(act.frame_range[0]))
        n = res["frames"]
        sheet, _ = _contact_sheet(sc, cam, floor_ob, folder, labels, f0, n, beats, notes, points, f"{title}: {n} frames, {res['seconds']} s")
        onion = _onion(sc, cam, floor_ob, folder, labels, f0, n, beats, points)
        os.makedirs(out, exist_ok=True)
        pictures = (("contact_sheet", sheet), ("onion", onion), ("footprint", _footprint(labels, res, curves, title)),
                    ("curves", _curves(labels, res, curves, beats, title)))
        return [(_save(c, os.path.join(out, name + ".png")), (c.shape[1], c.shape[0])) for name, c in pictures]
    finally:
        if window is not None:
            window.scene = shown
        added = [x for t in ID_TYPES for x in getattr(bpy.data, t) if x not in before[t]]
        for x in added:
            if isinstance(x, bpy.types.Scene):
                bpy.data.scenes.remove(x)
        bpy.data.batch_remove([x for x in added if not isinstance(x, bpy.types.Scene)])
        shutil.rmtree(folder, ignore_errors=True)
