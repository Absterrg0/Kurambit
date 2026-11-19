"""Made surfaces: a material described in a few values, baked to a tiling texture set.

  kurambit.surface("oak", "wood", "#9a6b3f", metres=1.5, wear=0.3, pattern="planks")
  kurambit.surface("wall")     a role of the game's look: its colour and its surface (kurambit.look)

builds the kind's pattern from Blender's own procedural nodes (noise and Voronoi sampled on a flat
torus, so the tile has no seam; bricks and planks on whole counts), bakes it with Cycles on the
CPU, and returns a material of that name: a colour texture holding only the pattern's light and
dark, multiplied by the colour (so Art's colour field recolours the whole surface), a normal map
and an occlusion-roughness-metal map. The files go to <folder>/<name>_color.webp, _normal.webp
and _orm.webp with <name>.surface.json beside them, which a three.js game names in ASSETS to tile
the same surface on what it builds in code (shell/assets.js). The look's finish (kurambit.look)
decides how it is drawn: "real" with its full grain and relief; "painted" soft, in broad strokes
with little relief; "flat" in two flat tones (under a hex palette, the palette's colour nearest
the colour and a darker one of the same hue when there is one).

Kinds: wood, bark, stone, metal, cloth, ground, worn (water-worn: smooth, pitted) and painted
(paint over a base, chipped by wear). pattern: "planks" (along the tile), "boards" (up it: a door,
a fence), "bricks" or "tiles" lays the kind in courses. metres: how much ground one tile covers. wear: 0 new to 1 old. size: px a side (default
STYLE.json's budget.texture, 1024)."""
import json
import math
import os

import bpy
import numpy as np

from . import helpers, look

KINDS = ("wood", "bark", "stone", "metal", "cloth", "ground", "worn", "painted")
PATTERNS = (None, "planks", "boards", "bricks", "tiles")
TAU = 2 * math.pi


class _Graph:
    """A few node shorthands over one material tree; every value is a socket or a number."""

    def __init__(self, tree, turned=False):
        self.n, self.l = tree.nodes, tree.links
        uv = self.n.new("ShaderNodeTexCoord")
        sep = self.n.new("ShaderNodeSeparateXYZ")
        self.l.new(uv.outputs["UV"], sep.inputs[0])
        # turned: the pattern drawn a quarter turn round, so what ran along the tile runs up it.
        self.u, self.v = (sep.outputs["Y"], sep.outputs["X"]) if turned else (sep.outputs["X"], sep.outputs["Y"])

    def _set(self, socket, value):
        if isinstance(value, bpy.types.NodeSocket):
            self.l.new(value, socket)
        else:
            socket.default_value = value

    def math(self, op, a, b=0.0, c=0.0):
        node = self.n.new("ShaderNodeMath")
        node.operation = op
        for socket, value in zip(node.inputs, (a, b, c)):
            self._set(socket, value)
        return node.outputs[0]

    def torus(self, stretch_u=1.0, stretch_v=1.0, shift=0.0):
        """The tile wrapped on a flat torus in four dimensions: (vector, w) for a 4D texture. A
        stretch below 1 draws features that much longer along that side."""
        ru, rv = stretch_u / TAU, stretch_v / TAU
        au, av = self.math("MULTIPLY", self.u, TAU), self.math("MULTIPLY", self.v, TAU)
        vec = self.n.new("ShaderNodeCombineXYZ")
        self._set(vec.inputs[0], self.math("MULTIPLY", self.math("COSINE", au), ru))
        self._set(vec.inputs[1], self.math("MULTIPLY", self.math("SINE", au), ru))
        self._set(vec.inputs[2], self.math("MULTIPLY", self.math("COSINE", av), rv))
        w = self.math("MULTIPLY", self.math("SINE", av), rv)
        return vec.outputs[0], (self.math("ADD", w, shift) if shift else w)

    def noise(self, scale, detail=4.0, rough=0.55, stretch=(1.0, 1.0), shift=0.0, distort=0.0):
        node = self.n.new("ShaderNodeTexNoise")
        node.noise_dimensions = "4D"
        vec, w = self.torus(*stretch, shift=shift)
        self.l.new(vec, node.inputs["Vector"])
        self._set(node.inputs["W"], w)
        for key, value in (("Scale", scale), ("Detail", detail), ("Roughness", rough), ("Distortion", distort)):
            self._set(node.inputs[key], value)
        return node.outputs["Fac"]

    def cells(self, scale, feature="F1", stretch=(1.0, 1.0), shift=0.0, random=1.0):
        node = self.n.new("ShaderNodeTexVoronoi")
        node.voronoi_dimensions = "4D"
        node.feature = feature
        vec, w = self.torus(*stretch, shift=shift)
        self.l.new(vec, node.inputs["Vector"])
        self._set(node.inputs["W"], w)
        node.inputs["Scale"].default_value = scale
        node.inputs["Randomness"].default_value = random
        return node.outputs["Distance"]

    def ramp(self, value, stops):
        """value through a ramp of [(position, level)], 0..1."""
        node = self.n.new("ShaderNodeValToRGB")
        ramp = node.color_ramp
        while len(ramp.elements) < len(stops):
            ramp.elements.new(0.5)
        for element, (position, level) in zip(ramp.elements, stops):
            element.position = position
            element.color = (level, level, level, 1.0)
        self._set(node.inputs[0], value)
        return node.outputs[0]

    def mix(self, t, a, b):
        return self.math("ADD", self.math("MULTIPLY", a, self.math("SUBTRACT", 1.0, t)), self.math("MULTIPLY", b, t))

    def courses(self, across, along, stagger=0.5, gap=0.04, jitter=True):
        """Courses laid on whole counts: `across` rows up the tile, `along` pieces in each, every
        other row shifted. Returns (gap mask 0 in the joint to 1 on the piece, a random 0..1 per piece)."""
        row = self.math("FLOOR", self.math("MULTIPLY", self.v, across))
        fv = self.math("FRACT", self.math("MULTIPLY", self.v, across))
        shift = self.math("MULTIPLY", self.math("MODULO", row, 2.0), stagger)
        if jitter:
            white = self.n.new("ShaderNodeTexWhiteNoise")
            white.noise_dimensions = "1D"
            self._set(white.inputs["W"], self.math("ADD", row, 0.5))
            shift = self.math("ADD", shift, white.outputs["Value"]) if stagger == 0 else shift
        x = self.math("ADD", self.math("MULTIPLY", self.u, along), shift)
        col = self.math("FLOOR", x)
        fu = self.math("FRACT", x)
        # A piece's own number wraps with the tile, so the last piece of a row is the first again.
        ident = self.n.new("ShaderNodeTexWhiteNoise")
        ident.noise_dimensions = "2D"
        pair = self.n.new("ShaderNodeCombineXYZ")
        self._set(pair.inputs[0], self.math("MODULO", col, along))
        self._set(pair.inputs[1], row)
        self.l.new(pair.outputs[0], ident.inputs["Vector"])
        edge_v = self.math("MINIMUM", fv, self.math("SUBTRACT", 1.0, fv))
        edge_u = self.math("MULTIPLY", self.math("MINIMUM", fu, self.math("SUBTRACT", 1.0, fu)), across / along)
        edge = self.math("MINIMUM", edge_v, edge_u)
        mask = self.math("SMOOTHSTEP", edge, gap * 0.5, gap * 1.5) if False else self.ramp(edge, [(gap * 0.4, 0.0), (gap * 1.6, 1.0)])
        return mask, ident.outputs["Value"]


def _build(g, kind, pattern, wear):
    """The kind's pattern as (tone 0..1 light and dark, height 0..1, roughness 0..1, metal 0 or 1)."""
    piece, ident = (1.0, 0.5)
    if pattern in ("planks", "boards"):
        piece, ident = g.courses(6, 2, stagger=0.37, gap=0.035)
    elif pattern == "bricks":
        piece, ident = g.courses(8, 4, stagger=0.5, gap=0.07)
    elif pattern == "tiles":
        piece, ident = g.courses(4, 4, stagger=0.0, gap=0.05, jitter=False)
    shift = g.math("MULTIPLY", ident, 3.0) if pattern else 0.0
    metal = 0.0
    if kind in ("wood", "bark"):
        long = (0.12, 1.0) if kind == "wood" else (1.0, 0.16)  # grain runs along u; bark up v
        grain = g.noise(26.0 if kind == "wood" else 9.0, 5.0, 0.6, stretch=long, shift=shift, distort=0.6)
        rings = g.noise(5.0, 2.0, 0.5, stretch=(long[0] * 2.5, long[1] * 2.5) if kind == "wood" else long, shift=shift)
        fine = g.noise(90.0, 2.0, 0.5, stretch=long, shift=shift)
        if kind == "wood":
            tone = g.mix(0.35, g.ramp(grain, [(0.3, 0.55), (0.7, 1.0)]), g.ramp(rings, [(0.35, 0.6), (0.65, 1.0)]))
            height = g.math("ADD", g.math("MULTIPLY", grain, 0.25 + 0.35 * wear), g.math("MULTIPLY", fine, 0.1))
            rough = g.math("ADD", 0.55, g.math("MULTIPLY", grain, 0.25))
        else:
            ridge = g.cells(7.0, "DISTANCE_TO_EDGE", stretch=(1.0, 0.3))
            furrow = g.ramp(ridge, [(0.0, 0.0), (0.22, 1.0)])
            tone = g.math("MULTIPLY", g.ramp(grain, [(0.3, 0.6), (0.75, 1.0)]), g.math("ADD", 0.45, g.math("MULTIPLY", furrow, 0.55)))
            height = g.math("ADD", g.math("MULTIPLY", furrow, 0.75), g.math("MULTIPLY", grain, 0.25))
            rough = 0.92
    elif kind in ("stone", "worn"):
        big = g.noise(3.0, 6.0, 0.6, shift=shift)
        speck = g.noise(60.0, 2.0, 0.5, shift=shift)
        crack = g.cells(5.0 if kind == "stone" else 9.0, "DISTANCE_TO_EDGE", shift=shift)
        if kind == "stone":
            cut = g.ramp(crack, [(0.0, 0.0), (0.05 + 0.1 * wear, 1.0)])
            tone = g.math("MULTIPLY", g.math("ADD", g.ramp(big, [(0.3, 0.62), (0.72, 1.0)]), g.math("MULTIPLY", speck, 0.12)), g.math("ADD", 0.7, g.math("MULTIPLY", cut, 0.3)))
            height = g.math("ADD", g.math("MULTIPLY", big, 0.5), g.math("MULTIPLY", cut, 0.4 * (0.4 + wear)))
            rough = g.math("ADD", 0.78, g.math("MULTIPLY", speck, 0.18))
        else:
            pit = g.cells(22.0, "F1", shift=shift)
            pits = g.ramp(pit, [(0.05, 0.0), (0.22, 1.0)])
            tone = g.math("MULTIPLY", g.ramp(big, [(0.25, 0.7), (0.75, 1.0)]), g.math("ADD", 0.78, g.math("MULTIPLY", pits, 0.22)))
            height = g.math("ADD", g.math("MULTIPLY", g.ramp(crack, [(0.0, 0.3), (0.5, 1.0)]), 0.6), g.math("MULTIPLY", pits, 0.25 * (0.5 + wear)))
            rough = g.math("ADD", 0.45, g.math("MULTIPLY", big, 0.3))
    elif kind == "metal":
        brush = g.noise(70.0, 2.0, 0.5, stretch=(0.04, 1.0), shift=shift)
        blotch = g.noise(4.0, 5.0, 0.65, shift=shift)
        rust = g.ramp(blotch, [(0.62 - 0.35 * wear, 0.0), (0.74 - 0.35 * wear, 1.0)])
        tone = g.mix(rust, g.math("ADD", 0.82, g.math("MULTIPLY", brush, 0.18)), g.math("ADD", 0.35, g.math("MULTIPLY", g.noise(30.0, 3.0, 0.6), 0.3)))
        height = g.math("ADD", g.math("MULTIPLY", brush, 0.12), g.math("MULTIPLY", rust, 0.35))
        rough = g.mix(rust, g.math("ADD", 0.28, g.math("MULTIPLY", brush, 0.2)), 0.85)
        metal = g.math("SUBTRACT", 1.0, rust)
    elif kind == "cloth":
        threads = 48.0
        warp = g.math("ABSOLUTE", g.math("SINE", g.math("MULTIPLY", g.u, threads * math.pi)))
        weft = g.math("ABSOLUTE", g.math("SINE", g.math("MULTIPLY", g.v, threads * math.pi)))
        over = g.math("GREATER_THAN", g.math("SINE", g.math("MULTIPLY", g.math("ADD", g.math("FLOOR", g.math("MULTIPLY", g.u, threads)), g.math("FLOOR", g.math("MULTIPLY", g.v, threads))), math.pi)), 0.0)
        weave = g.mix(over, warp, weft)
        fuzz = g.noise(8.0, 4.0, 0.6)
        tone = g.math("MULTIPLY", g.math("ADD", 0.72, g.math("MULTIPLY", weave, 0.28)), g.math("ADD", 0.85, g.math("MULTIPLY", fuzz, 0.15 + 0.2 * wear)))
        height = g.math("ADD", g.math("MULTIPLY", weave, 0.6), g.math("MULTIPLY", fuzz, 0.2))
        rough = 0.9
    elif kind == "ground":
        big = g.noise(2.5, 6.0, 0.62)
        clod = g.noise(14.0, 4.0, 0.6)
        stone = g.cells(18.0, "F1")
        pebble = g.ramp(stone, [(0.12, 1.0), (0.2, 0.0)])
        tone = g.math("ADD", g.math("MULTIPLY", g.ramp(big, [(0.3, 0.6), (0.7, 1.0)]), g.math("ADD", 0.75, g.math("MULTIPLY", clod, 0.25))), g.math("MULTIPLY", pebble, 0.12 * wear))
        height = g.math("ADD", g.math("ADD", g.math("MULTIPLY", big, 0.35), g.math("MULTIPLY", clod, 0.35)), g.math("MULTIPLY", pebble, 0.3))
        rough = 0.95
    else:  # painted: a coat over a base, chipped where it is worn
        under = g.noise(30.0, 4.0, 0.6, stretch=(0.2, 1.0), shift=shift)
        chips = g.noise(7.0, 6.0, 0.7, shift=shift)
        edge = g.math("SUBTRACT", 1.0, piece) if pattern else 0.0
        chipped = g.ramp(g.math("ADD", chips, g.math("MULTIPLY", edge, 0.25)), [(0.68 - 0.3 * wear, 0.0), (0.72 - 0.3 * wear, 1.0)])
        brush = g.noise(40.0, 2.0, 0.5, stretch=(0.08, 1.0), shift=shift)
        tone = g.mix(chipped, g.math("ADD", 0.9, g.math("MULTIPLY", brush, 0.1)), g.math("ADD", 0.32, g.math("MULTIPLY", under, 0.2)))
        height = g.math("ADD", g.math("MULTIPLY", g.math("SUBTRACT", 1.0, chipped), 0.5), g.math("MULTIPLY", brush, 0.08))
        rough = g.mix(chipped, 0.42, 0.85)
    if pattern:
        tint = g.math("ADD", 0.82, g.math("MULTIPLY", ident, 0.18))
        tone = g.math("MULTIPLY", g.math("MULTIPLY", tone, tint), g.math("ADD", 0.45, g.math("MULTIPLY", piece, 0.55)))
        height = g.math("MULTIPLY", g.math("ADD", g.math("MULTIPLY", height, 0.5), 0.5), piece)
    return tone, height, rough, metal


def _bake(build, size, turned=False):
    """Bakes build(graph) -> (tone, height, rough, metal) on a plane, as (tone (h, w), data (h, w, 3))."""
    scene = bpy.data.scenes.new("kurambit_surface")
    made = [scene]
    try:
        mesh = bpy.data.meshes.new("kurambit_surface")
        mesh.from_pydata([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [], [(0, 1, 2, 3)])
        mesh.uv_layers.new(name="uv").data.foreach_set("uv", [0, 0, 1, 0, 1, 1, 0, 1])
        plane = bpy.data.objects.new("kurambit_surface", mesh)
        scene.collection.objects.link(plane)
        mat = bpy.data.materials.new("kurambit_surface_bake")
        helpers.use_nodes(mat)
        tree = mat.node_tree
        for node in list(tree.nodes):
            tree.nodes.remove(node)
        g = _Graph(tree, turned)
        tone, height, rough, metal = build(g)
        emit, out = tree.nodes.new("ShaderNodeEmission"), tree.nodes.new("ShaderNodeOutputMaterial")
        tree.links.new(emit.outputs[0], out.inputs["Surface"])
        mesh.materials.append(mat)
        made += [plane, mesh, mat]
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 1
        scene.cycles.use_denoising = False
        scene.render.bake.margin = 0
        scene.view_settings.view_transform = "Standard"
        results = []
        for channels in ((tone, tone, tone), (height, rough, metal)):
            rgb = tree.nodes.new("ShaderNodeCombineXYZ")
            for socket, value in zip(rgb.inputs, channels):
                g._set(socket, value)
            for link in list(emit.inputs["Color"].links):
                tree.links.remove(link)
            tree.links.new(rgb.outputs[0], emit.inputs["Color"])
            image = bpy.data.images.new("kurambit_surface_bake", size, size, alpha=False, float_buffer=True)
            image.colorspace_settings.name = "Non-Color"
            target = tree.nodes.new("ShaderNodeTexImage")
            target.image = image
            tree.nodes.active = target
            with bpy.context.temp_override(scene=scene, view_layer=scene.view_layers[0], active_object=plane, object=plane, selected_objects=[plane]):
                bpy.ops.object.bake(type="EMIT")
            px = np.empty(size * size * 4, dtype=np.float32)
            image.pixels.foreach_get(px)
            results.append(px.reshape(size, size, 4)[:, :, :3].copy())
            tree.nodes.remove(target)
            bpy.data.images.remove(image)
        return results[0][:, :, 0], results[1]
    finally:
        for idb in made[1:]:
            (bpy.data.objects if isinstance(idb, bpy.types.Object) else bpy.data.meshes if isinstance(idb, bpy.types.Mesh) else bpy.data.materials).remove(idb)
        bpy.data.scenes.remove(scene)


def _blur(a, radius):
    """A wrapping box blur, twice: a soft falloff that still tiles."""
    for _ in range(2):
        for axis in (0, 1):
            c = np.cumsum(np.concatenate([a.take(range(-radius, 0), axis=axis), a, a.take(range(0, radius + 1), axis=axis)], axis=axis), axis=axis)
            lo, hi = [slice(None)] * 2, [slice(None)] * 2
            lo[axis], hi[axis] = slice(0, a.shape[axis]), slice(2 * radius + 1, 2 * radius + 1 + a.shape[axis])
            a = (c[tuple(hi)] - c[tuple(lo)]) / (2 * radius + 1)
    return a


def _save(name, pixels, path, srgb):
    h, w = pixels.shape[:2]
    image = bpy.data.images.new(name, w, h, alpha=False)
    image.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    rgba = np.concatenate([pixels, np.ones((h, w, 1), dtype=np.float32)], axis=2).astype(np.float32)
    image.pixels.foreach_set(rgba.ravel())
    image.filepath_raw = path
    image.file_format = "WEBP"
    image.save()
    image.pack()
    return image


def _lin(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)


def _srgb(c):
    c = np.clip(np.asarray(c, dtype=np.float64), 0, 1)
    return np.where(c > 0.0031308, 1.055 * c ** (1 / 2.4) - 0.055, 12.92 * c)


def _hex(h):
    return np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)])


def _style():
    try:
        with open("STYLE.json", encoding="utf8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _record(folder, name, what, files):
    """ASSETS.md's lines for a surface's files, replaced when it is baked again: the art tools write
    their own provenance. Only for a folder inside the game (the working directory)."""
    rel = os.path.relpath(os.path.abspath(folder), os.getcwd()).replace(os.sep, "/")
    if rel.startswith(".."):
        return
    paths = {f"{rel}/{file}": part for part, file in files.items()}
    try:
        with open("ASSETS.md", encoding="utf8") as f:
            lines = f.read().split("\n")
    except OSError:
        lines = ["# ASSETS"]
    kept = [line for line in lines if not any(line.lstrip().startswith(f"- `{path}`") for path in paths)]
    while kept and kept[-1] == "":
        kept.pop()
    for path, part in paths.items():
        kept.append(f"- `{path}` — made in Blender by kurambit.surface: the {part} map of {name} ({what}), baked from Blender's procedural nodes. Licence: made in this game.")
    with open("ASSETS.md", "w", encoding="utf8") as f:
        f.write("\n".join(kept) + "\n")


def surface(name, kind=None, colour=None, *, metres=None, wear=None, pattern=None, size=None, folder="web/assets/textures", relief=1.0):
    """A tiling surface as a material named name: see the module's text. With only a name, the
    surface of that role of the game's look. Returns the material; material["kurambit_surface"]
    holds {files, colour, metres}."""
    lk = look.read()
    if kind is None:
        if name not in lk["surfaces"]:
            raise ValueError(f"the look has no surface for {name!r}: pass a kind, or one of {', '.join(lk['surfaces'])}")
        own = lk["surfaces"][name]
        kind, pattern = own["kind"], pattern or own.get("pattern")
        metres, wear = metres or own.get("metres"), own.get("wear") if wear is None else wear
    colour = look.colour(colour or name, lk)
    metres, wear = metres or 1.0, 0.3 if wear is None else wear
    if kind not in KINDS:
        raise ValueError(f"surface kind is one of {', '.join(KINDS)}, not {kind!r}")
    if pattern not in PATTERNS:
        raise ValueError(f"surface pattern is planks, boards, bricks or tiles, not {pattern!r}")
    budget = lk["budget"].get("texture") or 1024
    size = int(min(size or budget, budget, 2048))
    palette, finish = lk["palette"], lk["finish"]
    tone, data = _bake(lambda g: _build(g, kind, pattern, float(wear)), size, turned=pattern == "boards")
    height, rough, metal = data[:, :, 0], np.clip(data[:, :, 1], 0.04, 1), np.clip(data[:, :, 2], 0, 1)
    tone = np.clip(tone, 0, 1)
    tone = tone / max(1e-6, float(np.percentile(tone, 99.5)))  # the lightest of the pattern is the colour itself
    # ... and the whole of it reads as that colour: a pattern that is mostly dark is lifted, so a
    # role's surface comes out the colour the look names and not a shade of it.
    tone = 1.0 - (1.0 - tone) * min(1.0, 0.2 / max(1e-6, 1.0 - float(tone.mean())))
    base = _hex(colour)
    if finish == "flat":
        # Two flat tones. Under a hex palette they are the palette's own: the colour nearest the
        # colour, and for the pattern's dark a darker one of the same hue when the palette has one.
        lum = np.array([0.2126, 0.7152, 0.0722])
        main, shade = colour, None
        if palette:
            from .stylepass import _lab  # nearest as the style pass snaps: in Lab

            goal = _lab(list(base))
            main = min(palette, key=lambda h: sum((a - b) ** 2 for a, b in zip(_lab(list(_hex(h))), goal)))
            m = _lin(_hex(main))

            def same_hue(h):
                c = _lin(_hex(h))
                cos = float(c @ m) / max(1e-9, float(np.linalg.norm(c) * np.linalg.norm(m)))
                return cos > 0.985 and 0.35 < float(c @ lum) / max(1e-9, float(m @ lum)) < 0.92

            darker = [h for h in palette if h != main and same_hue(h)]
            shade = max(darker, key=lambda h: float(_lin(_hex(h)) @ lum)) if darker else None
        dark = _hex(shade) if shade else _srgb(_lin(_hex(main)) * 0.72)
        soft = _blur(tone, max(1, size // 256))
        colour_px = np.array([dark, _hex(main)])[(soft > np.percentile(soft, 30)).astype(int)]
        factor = "#ffffff"
        height = _blur(height, max(1, size // 128))
        relief *= 0.6
    elif finish == "painted":
        # Broad soft strokes: the pattern's big shapes kept, its grain blurred away, little relief.
        soft = _blur(tone, max(2, size // 96))
        colour_px = _srgb(np.repeat(np.clip(1.0 - (1.0 - soft) * 0.7, 0, 1)[:, :, None], 3, axis=2))
        factor = colour
        height = _blur(height, max(2, size // 96))
        rough = np.clip(_blur(rough, max(2, size // 96)), 0.5, 1)
        relief *= 0.45
    else:
        colour_px = _srgb(np.repeat(np.clip(tone, 0, 1)[:, :, None], 3, axis=2) ** 1.0)
        factor = colour
    # The normal map from the height's own slope, wrapping at the tile's edge.
    strength = relief * size / 256.0 * 1.6
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * strength
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * strength
    normal = np.stack([-dx, -dy, np.ones_like(dx)], axis=2)
    normal /= np.linalg.norm(normal, axis=2, keepdims=True)
    hollow = _blur(height, max(2, size // 64)) - height
    occlusion = np.clip(1.0 - np.clip(hollow, 0, 1) * 2.2 * relief, 0.35, 1.0)
    os.makedirs(folder, exist_ok=True)
    files = {k: f"{name}_{k}.webp" for k in ("color", "normal", "orm")}
    for old in [i for i in bpy.data.images if i.name in {f"{name}_{k}" for k in files}]:
        bpy.data.images.remove(old)
    images = {
        "color": _save(f"{name}_color", colour_px.astype(np.float32), os.path.abspath(os.path.join(folder, files["color"])), True),
        "normal": _save(f"{name}_normal", (normal * 0.5 + 0.5).astype(np.float32), os.path.abspath(os.path.join(folder, files["normal"])), False),
        "orm": _save(f"{name}_orm", np.stack([occlusion, rough, metal], axis=2).astype(np.float32), os.path.abspath(os.path.join(folder, files["orm"])), False),
    }
    record = {"version": 1, "name": name, "kind": kind, "pattern": pattern, "colour": factor, "metres": metres, "size": size, "wear": wear, **files}
    with open(os.path.join(folder, f"{name}.surface.json"), "w", encoding="utf8") as f:
        json.dump(record, f, indent=1)
        f.write("\n")
    _record(folder, name, kind if pattern is None else f"{kind}, {pattern}", files)
    # The material: colour texture times the colour (glTF's base colour factor), normal, and the
    # packed occlusion-roughness-metal map the glTF exporter reads from a separated image.
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    helpers.use_nodes(mat)
    tree = mat.node_tree
    for node in list(tree.nodes):
        tree.nodes.remove(node)
    n, link = tree.nodes, tree.links
    out, bsdf = n.new("ShaderNodeOutputMaterial"), n.new("ShaderNodeBsdfPrincipled")
    link.new(bsdf.outputs[0], out.inputs["Surface"])
    coords, mapping = n.new("ShaderNodeTexCoord"), n.new("ShaderNodeMapping")
    link.new(coords.outputs["UV"], mapping.inputs["Vector"])

    def tex(key):
        node = n.new("ShaderNodeTexImage")
        node.image = images[key]
        link.new(mapping.outputs[0], node.inputs["Vector"])
        return node

    tint = n.new("ShaderNodeMix")
    tint.data_type = "RGBA"
    tint.blend_type = "MULTIPLY"
    tint.inputs["Factor"].default_value = 1.0
    link.new(tex("color").outputs["Color"], tint.inputs["A"])
    tint.inputs["B"].default_value = (*_lin(_hex(factor)), 1.0)
    link.new(tint.outputs["Result"], bsdf.inputs["Base Color"])
    bump = n.new("ShaderNodeNormalMap")
    link.new(tex("normal").outputs["Color"], bump.inputs["Color"])
    link.new(bump.outputs[0], bsdf.inputs["Normal"])
    split = n.new("ShaderNodeSeparateColor")
    link.new(tex("orm").outputs["Color"], split.inputs[0])
    link.new(split.outputs["Green"], bsdf.inputs["Roughness"])
    link.new(split.outputs["Blue"], bsdf.inputs["Metallic"])
    mat["kurambit_surface"] = json.dumps({**record, "folder": folder})
    mat["kurambit_source"] = json.dumps({"what": f"surface {name}", "from": "made", "licence": "made in this game", "ai": False, "credits": None})
    return mat


def wrap(obj, material=None, metres=None):
    """Box-maps obj's faces in metres so a surface tiles at its true size on any shape: each face is
    mapped along the axis it faces. material: assign this surface to the whole object first."""
    obj = bpy.data.objects[obj] if isinstance(obj, str) else obj
    me = obj.data
    if material is not None:
        me.materials.clear()
        me.materials.append(material)
    scales = []
    for slot in me.materials:
        info = json.loads(slot["kurambit_surface"]) if slot is not None and "kurambit_surface" in slot else None
        scales.append(metres or (info["metres"] if info else 1.0))
    uv = me.uv_layers.get("surface") or me.uv_layers.new(name="surface")
    world = np.array(obj.matrix_world)
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3) @ world[:3, :3].T + world[:3, 3]
    out = np.zeros((len(me.loops), 2), dtype=np.float32)
    for poly in me.polygons:
        nrm = world[:3, :3] @ np.array(poly.normal)
        axis = int(np.argmax(np.abs(nrm)))
        a, b = [(1, 2), (0, 2), (0, 1)][axis]
        s = scales[min(poly.material_index, len(scales) - 1)] if scales else 1.0
        for li in poly.loop_indices:
            p = co[me.loops[li].vertex_index]
            out[li] = (p[a] / s, p[b] / s)
    uv.data.foreach_set("uv", out.ravel())
    me.uv_layers.active = uv
    return obj
