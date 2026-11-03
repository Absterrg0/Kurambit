// Blender-side half of game_blender_render_sprites. The service runs this in the live scene
// once to fit the camera ("fit") and then in batches to render ("render"), because the pinned
// MCP server bounds each Blender command at 180 s.
//
// Rendering happens in a throwaway scene that links the live objects, so the live scene never
// changes: the only live state touched is an assigned action and NLA mutes, restored in `finally`.

/** One view of the subject: azimuth 0 looks at its front (-Y, the way imported glTF models face), 90 shows it facing screen right; elevation 90 looks straight down. */
export interface SpriteView {
  readonly name: string;
  readonly azimuth: number;
  readonly elevation: number;
}

export interface SpriteFitParams {
  readonly phase: "fit";
  readonly objects: ReadonlyArray<string>;
  readonly action: string | null;
  readonly frames: ReadonlyArray<number> | null;
  readonly frameStart: number | null;
  readonly frameEnd: number | null;
  readonly frameCount: number | null;
  readonly loop: boolean;
  readonly views: ReadonlyArray<SpriteView>;
}

/** Orthographic camera for one view, in world units; the same scale for every view. */
export interface SpriteCamera {
  readonly view: string;
  readonly matrix: ReadonlyArray<ReadonlyArray<number>>;
  readonly clipEnd: number;
}

export interface SpriteFit {
  readonly frames: ReadonlyArray<number>;
  readonly action: string | null;
  readonly objects: ReadonlyArray<string>;
  readonly views: ReadonlyArray<{
    readonly name: string;
    /** Projected extents across every frame: right (x) and up (y) in world units, depth along the view. */
    readonly x0: number;
    readonly x1: number;
    readonly y0: number;
    readonly y1: number;
    readonly d0: number;
    readonly d1: number;
  }>;
  readonly basis: ReadonlyArray<{
    readonly right: ReadonlyArray<number>;
    readonly up: ReadonlyArray<number>;
    readonly forward: ReadonlyArray<number>;
  }>;
}

export interface SpriteRenderParams {
  readonly phase: "render";
  readonly objects: ReadonlyArray<string>;
  readonly action: string | null;
  readonly lighting: "studio" | "scene";
  readonly width: number;
  readonly height: number;
  readonly orthoScale: number;
  readonly cameras: ReadonlyArray<SpriteCamera>;
  /** Each job renders one frame of one view to an absolute PNG path. */
  readonly jobs: ReadonlyArray<{
    readonly view: number;
    readonly frame: number;
    readonly path: string;
  }>;
}

const SCRIPT = String.raw`
import bpy, json, math, os
import numpy as np
from mathutils import Matrix, Vector

GEOM = {"MESH", "CURVE", "SURFACE", "FONT", "META"}
scene = bpy.context.scene

def resolve(names):
    picked, missing = [], []
    if names:
        for n in names:
            ob = bpy.data.objects.get(n)
            if ob is not None:
                picked.append(ob)
                continue
            col = bpy.data.collections.get(n)
            if col is not None:
                picked.extend(col.all_objects)
                continue
            missing.append(n)
    else:
        picked = [o for o in scene.objects if o.type in GEOM and o.visible_get()]
    geo, seen = [], set()
    for ob in picked:
        for o in [ob, *ob.children_recursive]:
            if o.type in GEOM and not o.hide_render and o.name not in seen:
                seen.add(o.name)
                geo.append(o)
    return geo, missing

def drivers(geo):
    # Objects whose animation moves the geometry: ancestors and armature-modifier targets.
    out, seen = [], set()
    def add(o):
        if o is not None and o.name not in seen:
            seen.add(o.name)
            out.append(o)
    for o in geo:
        p = o
        while p is not None:
            add(p)
            p = p.parent
        for m in getattr(o, "modifiers", []):
            if m.type == "ARMATURE" and m.object is not None:
                add(m.object)
                q = m.object.parent
                while q is not None:
                    add(q)
                    q = q.parent
    return out

class Animated:
    """Plays one action on every object that moves the geometry, NLA muted, then restores both.
    Blender 4.4+ actions hold one slot per animated object (a glTF clip animating six parts is
    one action with six slots), so each object takes the slot named for it; an object the action
    does not animate holds its current pose."""
    def __init__(self, owners, action_name):
        self.saved = []
        self.action = None
        if action_name is None:
            return
        self.action = bpy.data.actions.get(action_name)
        if self.action is None:
            return
        slotted = hasattr(self.action, "slots")
        for o in owners:
            ad = o.animation_data
            created = ad is None
            if created:
                # A rig with no animation yet can still play an action imported beside it.
                if o.type != "ARMATURE":
                    continue
                ad = o.animation_data_create()
            self.saved.append((o, created, ad.action, getattr(ad, "action_slot", None), [(t, t.mute) for t in ad.nla_tracks]))
            for t in ad.nla_tracks:
                t.mute = True
            if not slotted:
                ad.action = self.action
                continue
            ad.action = self.action
            mine = [sl for sl in ad.action_suitable_slots if sl.identifier[2:] == o.name or sl.name_display == o.name]
            if ad.action_slot is not None and (not mine or ad.action_slot == mine[0]):
                continue
            if mine:
                ad.action_slot = mine[0]
            elif len(self.action.slots) == 1 and len(ad.action_suitable_slots) == 1:
                ad.action_slot = ad.action_suitable_slots[0]
            else:
                ad.action = None
    def restore(self):
        for o, created, action, slot, mutes in reversed(self.saved):
            ad = o.animation_data
            if ad is None:
                continue
            if created:
                o.animation_data_clear()
                continue
            ad.action = action
            if slot is not None:
                try:
                    ad.action_slot = slot
                except Exception:
                    pass
            for t, m in mutes:
                t.mute = m

def active_action(owners):
    for o in owners:
        ad = o.animation_data
        if ad is not None and ad.action is not None:
            return ad.action
    return None

def set_frame(sc, f):
    whole = math.floor(f)
    sub = f - whole
    scene.frame_set(whole, subframe=sub)
    if sc is not scene:
        sc.frame_set(whole, subframe=sub)

def temp_scene(geo, owners, lighting):
    sc = bpy.data.scenes.new("studio_sprite_render")
    linked = set()
    def link(o):
        if o.name not in linked:
            linked.add(o.name)
            sc.collection.objects.link(o)
    for o in geo:
        link(o)
    for o in owners:
        # Animating parents and armatures come along; another mesh would render.
        if o.type not in GEOM:
            link(o)
    if lighting == "scene":
        for o in scene.objects:
            if o.type == "LIGHT":
                link(o)
        sc.world = scene.world
    return sc

def view_basis(az, el):
    a, e = math.radians(az), math.radians(el)
    d = Vector((-math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
    r = Vector((math.cos(a), -math.sin(a), 0.0))
    f = -d
    u = r.cross(f).normalized()
    return r, u, f

def fit(P):
    geo, missing = resolve(P["objects"])
    if missing:
        return {"error": "missing", "missing": missing,
                "objects": [o.name for o in scene.objects][:60],
                "collections": [c.name for c in bpy.data.collections][:30]}
    if not geo:
        return {"error": "empty", "objects": [o.name for o in scene.objects][:60]}
    owners = drivers(geo)
    if P["action"] is not None and bpy.data.actions.get(P["action"]) is None:
        return {"error": "action", "actions": [a.name for a in bpy.data.actions][:60]}
    anim = Animated(owners, P["action"])
    sc = None
    keep = scene.frame_current, scene.frame_subframe
    try:
        sc = temp_scene(geo, owners, "studio")
        act = anim.action or active_action(owners)
        frames = P["frames"]
        # No action and no frames is a still of the current pose, whatever clip is active.
        animated = frames is not None or anim.action is not None or P["frameStart"] is not None or P["frameEnd"] is not None or P["frameCount"] is not None
        if frames is None:
            if act is not None:
                lo, hi = act.frame_range
            else:
                lo, hi = scene.frame_start, scene.frame_end
            lo = P["frameStart"] if P["frameStart"] is not None else lo
            hi = P["frameEnd"] if P["frameEnd"] is not None else hi
            n = P["frameCount"] if P["frameCount"] is not None else (8 if animated else 1)
            if n <= 1 or hi <= lo:
                frames = [float(lo if animated else scene.frame_current)]
            elif P["loop"]:
                frames = [lo + i * (hi - lo) / n for i in range(n)]
            else:
                frames = [lo + i * (hi - lo) / (n - 1) for i in range(n)]
        frames = [round(float(f), 4) for f in frames]
        bases = [view_basis(v["azimuth"], v["elevation"]) for v in P["views"]]
        R = np.array([[*b[0]] for b in bases])
        U = np.array([[*b[1]] for b in bases])
        F = np.array([[*b[2]] for b in bases])
        lo_x = np.full(len(bases), np.inf); hi_x = np.full(len(bases), -np.inf)
        lo_y = lo_x.copy(); hi_y = hi_x.copy(); lo_d = lo_x.copy(); hi_d = hi_x.copy()
        for f in frames:
            set_frame(sc, f)
            dg = sc.view_layers[0].depsgraph
            dg.update()
            for o in geo:
                ev = o.evaluated_get(dg)
                me = ev.to_mesh()
                try:
                    n = len(me.vertices)
                    if n == 0:
                        continue
                    co = np.empty(n * 3, np.float64)
                    me.vertices.foreach_get("co", co)
                    co = co.reshape(n, 3)
                    m = np.array(ev.matrix_world)
                    w = co @ m[:3, :3].T + m[:3, 3]
                finally:
                    ev.to_mesh_clear()
                px, py, pd = w @ R.T, w @ U.T, w @ F.T
                lo_x = np.minimum(lo_x, px.min(0)); hi_x = np.maximum(hi_x, px.max(0))
                lo_y = np.minimum(lo_y, py.min(0)); hi_y = np.maximum(hi_y, py.max(0))
                lo_d = np.minimum(lo_d, pd.min(0)); hi_d = np.maximum(hi_d, pd.max(0))
        if not np.isfinite(lo_x).all():
            return {"error": "empty", "objects": [o.name for o in scene.objects][:60]}
        return {
            "frames": frames,
            "action": act.name if act is not None and animated else None,
            "objects": [o.name for o in geo],
            "views": [{"name": v["name"], "x0": float(lo_x[i]), "x1": float(hi_x[i]),
                       "y0": float(lo_y[i]), "y1": float(hi_y[i]),
                       "d0": float(lo_d[i]), "d1": float(hi_d[i])} for i, v in enumerate(P["views"])],
            "basis": [{"right": list(b[0]), "up": list(b[1]), "forward": list(b[2])} for b in bases],
        }
    finally:
        anim.restore()
        if sc is not None:
            bpy.data.scenes.remove(sc)
        scene.frame_set(keep[0], subframe=keep[1])

def studio_lights(sc, made):
    # Camera-relative key, fill and rim, plus a grey world, so every view reads and no side goes black.
    lights = []
    for name, energy, shadow in (("key", 3.0, True), ("fill", 1.2, False), ("rim", 2.5, False)):
        data = bpy.data.lights.new("studio_sprite_" + name, "SUN")
        data.energy = energy
        data.use_shadow = shadow
        data.angle = math.radians(10)
        ob = bpy.data.objects.new("studio_sprite_" + name, data)
        sc.collection.objects.link(ob)
        made.append(ob)
        lights.append(ob)
    world = bpy.data.worlds.new("studio_sprite_world")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs[0].default_value = (0.42, 0.42, 0.45, 1.0)
        bg.inputs[1].default_value = 1.0
    sc.world = world
    return lights, world

def aim(ob, toward):
    ob.rotation_euler = Vector(toward).normalized().to_track_quat("Z", "Y").to_euler()

def render(P):
    geo, missing = resolve(P["objects"])
    if missing or not geo:
        return {"error": "missing", "missing": missing}
    owners = drivers(geo)
    anim = Animated(owners, P["action"])
    sc = None
    made, world = [], None
    keep = scene.frame_current, scene.frame_subframe
    written = []
    try:
        sc = temp_scene(geo, owners, P["lighting"])
        try:
            sc.render.engine = "BLENDER_EEVEE_NEXT"
        except TypeError:
            sc.render.engine = "BLENDER_EEVEE"
        sc.eevee.taa_render_samples = 16
        sc.render.resolution_x = P["width"]
        sc.render.resolution_y = P["height"]
        sc.render.resolution_percentage = 100
        sc.render.pixel_aspect_x = sc.render.pixel_aspect_y = 1
        sc.render.film_transparent = True
        sc.render.use_compositing = False
        sc.render.use_sequencer = False
        sc.view_settings.view_transform = "Standard"
        sc.view_settings.look = "None"
        sc.view_settings.exposure = 0
        sc.view_settings.gamma = 1
        sc.render.image_settings.file_format = "PNG"
        sc.render.image_settings.color_mode = "RGBA"
        sc.render.image_settings.color_depth = "8"
        cam = bpy.data.objects.new("studio_sprite_cam", bpy.data.cameras.new("studio_sprite_cam"))
        sc.collection.objects.link(cam)
        made.append(cam)
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = P["orthoScale"]
        cam.data.sensor_fit = "AUTO"
        cam.data.clip_start = 0.001
        sc.camera = cam
        lights = []
        if P["lighting"] == "studio":
            lights, world = studio_lights(sc, made)
        current = None
        for job in P["jobs"]:
            c = P["cameras"][job["view"]]
            if current != job["view"]:
                current = job["view"]
                M = Matrix(c["matrix"])
                cam.matrix_world = M
                cam.data.clip_end = c["clipEnd"]
                if lights:
                    r = M.col[0].xyz; u = M.col[1].xyz; d = M.col[2].xyz
                    aim(lights[0], d * 0.9 + u * 0.8 - r * 0.5)
                    aim(lights[1], d * 0.8 + u * 0.1 + r * 0.7)
                    aim(lights[2], -d * 1.0 + u * 0.6 + r * 0.3)
            set_frame(sc, job["frame"])
            sc.render.filepath = job["path"]
            bpy.ops.render.render(write_still=True, scene=sc.name)
            written.append(job["path"])
        return {"written": written}
    finally:
        anim.restore()
        if sc is not None:
            bpy.data.scenes.remove(sc)
        for o in made:
            data = o.data
            bpy.data.objects.remove(o)
            if isinstance(data, bpy.types.Camera):
                bpy.data.cameras.remove(data)
            elif isinstance(data, bpy.types.Light):
                bpy.data.lights.remove(data)
        if world is not None:
            bpy.data.worlds.remove(world)
        scene.frame_set(keep[0], subframe=keep[1])

result = fit(P) if P["phase"] == "fit" else render(P)
print("STUDIO_SPRITES " + json.dumps(result))
`;

/** The script with its parameters inlined as a JSON literal Python parses. */
export const spriteRenderCode = (params: SpriteFitParams | SpriteRenderParams): string =>
  `import json\nP = json.loads(${JSON.stringify(JSON.stringify(params))})\n${SCRIPT}`;

/** The JSON the script printed, or null when it printed none. */
export const spriteRenderOutput = (text: string): unknown => {
  // The pinned server prefixes the captured output ("Code executed successfully: ...").
  const line = text.split("\n").find((l) => l.includes("STUDIO_SPRITES "));
  if (line === undefined) return null;
  try {
    return JSON.parse(
      line.slice(line.indexOf("STUDIO_SPRITES ") + "STUDIO_SPRITES ".length),
    ) as unknown;
  } catch {
    return null;
  }
};
