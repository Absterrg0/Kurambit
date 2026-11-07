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
