"""character(): a human body made or imported as a static mesh, then rigged on the human template
with its clips (rig.py), the agent's own parts rigged with it.

params (the server resolves every path):
    name      the armature's name and the export's default stem
    body      {"library": abs, "pack"?: id, "licence"?: str} | {"mpfb": {age, gender, weight, ...}}
              | {"studio": {gender}}: Blender Studio's drawn stylised body (studio.py) | {"game": abs}:
              an earlier export, its ledger the sidecar beside it
    height    metres: the body scaled to it, standing on the floor
    objects   more of the scene's meshes rigged with the body (clothes, hair)
    rigid     {object: bone}: parts that ride one bone (a sword in hand_r)
    joints, clips, pack: as rig() takes them

A body's own skeleton and clips are dropped: it is rigged as any static model is. A made body (mpfb or
studio) comes with no material of its own: it gets one, "<name> skin", in SKIN, so it never ships the
export's default white.
"""
import importlib
import json
import os

import bpy

from . import helpers, skeleton, studio
from .rig import rig as rig_model
from .protocol import Refused, entry

SKIN = "#e0a882"

MPFB_LICENCE = "CC0 1.0 (bodies made by MPFB2; its GPL-3.0 code is not in the game)"
LIBRARY_HELP = "Library bodies (quaternius-universal-base-characters, as game_assets op search lists them) need no install."

MADE_BODY = {"what": "body", "from": "made", "licence": "made in this game", "ai": False, "credits": None}

# Where a drawn body's eyes and lips are (studio.py marks them).
EYES = {"l": "face_eye_l", "r": "face_eye_r"}
LIPS = "face_lips"

WHATS = {"body", "clips", "mesh", "parts", "texture"}


def stamp(obj, what, source, licence):
    obj["kurambit_source"] = json.dumps({"what": what, "from": source, "licence": licence, "ai": False, "credits": None})


def _mpfb_module():
    import addon_utils

    names = [m.__name__ for m in addon_utils.modules() if m.__name__ == "mpfb" or m.__name__.endswith(".mpfb")]
    if not names:
        raise Refused("tool-missing", f"MPFB2 is not installed: the person installs it in Settings → Game tools (MPFB2). {LIBRARY_HELP}")
    addon_utils.enable(names[0], default_set=True)
    return names[0]


def _bake_shape_keys(obj):
    """The mix of every shape key becomes the mesh (MPFB's macro targets are shape keys)."""
    if obj.data.shape_keys is None:
        return
    obj.shape_key_add(name="mix", from_mix=True)
    for k in list(obj.data.shape_keys.key_blocks)[:-1]:
        obj.shape_key_remove(k)
    obj.shape_key_remove(obj.data.shape_keys.key_blocks[0])


def _mpfb_body(spec):
    """An MPFB2 human as one static mesh: its macro targets baked, its helper geometry gone but the
    eyeballs."""
    mod = _mpfb_module()
    human = importlib.import_module(mod + ".services.humanservice").HumanService
    targets = importlib.import_module(mod + ".services.targetservice").TargetService
    macro = targets.get_default_macro_info_dict()
    for k in ("age", "gender", "weight", "muscle", "height", "proportions"):
        if k in spec:
            macro[k] = float(spec[k])
    body = human.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True,
                              feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
    shown = body.vertex_groups.new(name="kurambit_shown")
    keep = {g.index for g in body.vertex_groups if g.name in ("body", "helper-l-eye", "helper-r-eye")}
    shown.add([v.index for v in body.data.vertices if any(e.group in keep for e in v.groups)], 1.0, "REPLACE")
    for m in body.modifiers:
        if m.type == "MASK":
            m.vertex_group = shown.name
    _bake_shape_keys(body)
    skeleton.baked_mesh(body)
    body.vertex_groups.clear()
    return [body]


def _file_body(path):
    """The meshes of a rigged or static model file, at rest, with its skeleton and clips gone."""
    if not os.path.isfile(path):
        raise Refused("invalid-input", f"no body file at {path}")
    new, actions = skeleton.import_model(path)
    bpy.data.batch_remove(set(actions))
    meshes = [o for o in new if o.type == "MESH"]
    if not meshes:
        skeleton.remove_objects(new)
        raise Refused("invalid-input", f"{os.path.basename(path)} holds no mesh")
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    skeleton.remove_objects([o for o in new if o not in meshes])
    return meshes


def _part(p):
    """A sidecar part as the ledger holds it, or None when it is not one (GameAssetPart)."""
    if not isinstance(p, dict) or p.get("what") not in WHATS:
        return None
    src, licence, ai, credits = p.get("from"), p.get("licence"), p.get("ai"), p.get("credits")
    if not (isinstance(src, str) and 0 < len(src) <= 64 and isinstance(licence, str) and len(licence) <= 200
            and isinstance(ai, bool) and (credits is None or (isinstance(credits, (int, float)) and not isinstance(credits, bool)))):
        return None
    part = {"what": p["what"], "from": src, "licence": licence, "ai": ai, "credits": credits}
    if isinstance(p.get("generation"), str):
        part["generation"] = p["generation"][:64]
    return part


def _game_source(path):
    """A body that is an earlier export carries its sidecar's whole ledger: its body part (or a made
    body) and every other part, imports, ai and credits included, since its one mesh holds them all.
    A GLB with no sidecar was made here; a sidecar that does not read as one is refused, never guessed."""
    sidecar = os.path.splitext(path)[0] + ".asset.json"
    try:
        with open(sidecar) as f:
            text = f.read()
    except FileNotFoundError:
        return dict(MADE_BODY), []
    except OSError as error:
        raise Refused("invalid-input", f"could not read {os.path.basename(sidecar)}: {error}")
    try:
        raw = json.loads(text)["source"]["parts"]
    except (ValueError, KeyError, TypeError):
        raw = None
    parts = [_part(p) for p in raw] if isinstance(raw, list) and raw else [None]
    if None in parts:
        raise Refused("invalid-input", f"{os.path.basename(sidecar)} has no ledger that reads as one (source.parts), so the body's credits are unknown: export that model again with game_blender op export, or use a library body")
    body = next((p for p in parts if p["what"] == "body"), None)
    rest = [p for p in parts if p is not body]
    return (body if body is not None else dict(MADE_BODY)), rest


def _to_height(meshes, height):
    """Scales the meshes about the middle of their floor so they stand height metres tall."""
    co = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
    lo, hi = min(c.z for c in co), max(c.z for c in co)
    if hi - lo < 1e-6:
        return
    k = height / (hi - lo)
    cx, cy = (min(c.x for c in co) + max(c.x for c in co)) / 2, (min(c.y for c in co) + max(c.y for c in co)) / 2
    from mathutils import Matrix, Vector

    m = Matrix.Translation(Vector((cx, cy, lo))) @ Matrix.Scale(k, 4) @ Matrix.Translation(-Vector((cx, cy, lo)))
    for o in meshes:
        o.matrix_world = m @ o.matrix_world


@entry
def character(params):
    name = params["name"]
    spec = params["body"]
    skeleton.object_mode()
    parts = []
    if "studio" in spec:
        arm, meshes, _ = studio.body(spec["studio"].get("gender", 0.5))
        skeleton.remove_objects([arm])
        body_part = {**MADE_BODY, "from": "blender-studio-human-base-meshes", "licence": studio.LICENCE}
    elif "mpfb" in spec:
        meshes = _mpfb_body(spec["mpfb"])
        body_part = {**MADE_BODY, "from": "mpfb2", "licence": MPFB_LICENCE}
    elif "game" in spec:
        body_part, parts = _game_source(spec["game"])
        meshes = _file_body(spec["game"])
    else:
        meshes = _file_body(spec["library"])
        body_part = {**MADE_BODY, "from": spec.get("pack", "library"), "licence": spec.get("licence", "")}
    for i, o in enumerate(meshes):
        o.name = f"{name}_body" if len(meshes) == 1 else f"{name}_body_{i}"
        o.data.name = o.name
        o["kurambit_source"] = json.dumps(body_part)
        if parts:
            o["kurambit_parts"] = json.dumps(parts)
        for c in list(o.users_collection):
            c.objects.unlink(o)
        bpy.context.scene.collection.objects.link(o)
    if "mpfb" in spec or "studio" in spec:
        skin = bpy.data.materials.get(f"{name} skin") or helpers.material(SKIN, name=f"{name} skin")
        for o in meshes:
            o.data.materials.clear()
            o.data.materials.append(skin)
    if params.get("height"):
        _to_height(meshes, float(params["height"]))
    return rig_model([*meshes, *(params.get("objects") or [])], "human", None, params.get("joints"), params.get("rigid") or {},
                   params.get("clips") or (), name, params.get("pack"))
