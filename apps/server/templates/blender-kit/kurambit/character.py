"""character(): a body conformed to the standard skeleton, skinned, with its clips and chains.

params (the server resolves every path):
    name      the collection, the armature's name and the export's default stem
    body      {"library": abs, "pack"?: id, "licence"?: str} | {"mpfb": {age, gender, weight, ...}}
              | {"game": abs}
    standard  abs path of the standard armature's GLB (STANDARD_ARMATURE)
    clips     [{pack, name, path, licence?}]
    chains    [{name, parent, bones, direction, length, mirror?}]
    replace   rebuild the body and armature of an existing <name>, re-binding its other objects
"""
import importlib
import json
import os
import re

import bpy
from mathutils import Vector

from . import helpers, skeleton
from .protocol import Refused, entry

MPFB_LICENCE = "CC0 1.0 (bodies made by MPFB2; its GPL-3.0 code is not in the game)"
LIBRARY_HELP = "Library bodies (quaternius-universal-base-characters, as game_assets_search lists them) need no install."


MADE_BODY = {"what": "body", "from": "made", "licence": "made in this game", "ai": False, "credits": None}
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
    mod = _mpfb_module()
    human = importlib.import_module(mod + ".services.humanservice").HumanService
    targets = importlib.import_module(mod + ".services.targetservice").TargetService
    macro = targets.get_default_macro_info_dict()
    for k in ("age", "gender", "weight", "muscle", "height", "proportions"):
        if k in spec:
            macro[k] = float(spec[k])
    body = human.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=False,
                              feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
    # MPFB fits its rig to the vertex coordinates: bake the targets first, or an adult skeleton
    # ends up inside a child's mesh.
    _bake_shape_keys(body)
    rig = human.add_builtin_rig(body, "game_engine", import_weights=True)
    skeleton.baked_mesh(body, keep=lambda m: m.type == "ARMATURE")
    for vg in list(body.vertex_groups):
        if vg.name.startswith(("joint-", "helper-")) or vg.name == "body":
            body.vertex_groups.remove(vg)
    return rig, [body], skeleton.NAME_MAPS["mpfb_game_engine"]


def _file_body(path):
    if not os.path.isfile(path):
        raise Refused("invalid-input", f"no body file at {path}")
    new, actions = skeleton.import_gltf(path)
    for a in actions:
        bpy.data.actions.remove(a)
    rigs = [o for o in new if o.type == "ARMATURE"]
    if len(rigs) != 1:
        skeleton.remove_objects(new)
        raise Refused("invalid-input", f"{os.path.basename(path)} holds {len(rigs)} armatures: a body is one rigged humanoid on the standard skeleton")
    rig = rigs[0]
    meshes = [o for o in new if o.type == "MESH" and (o.parent == rig or rig in helpers._deforming(o))]
    for o in [rig] + meshes:
        if o.parent is not None and o.parent not in (rig,):
            mw = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = mw
    skeleton.remove_objects([o for o in new if o is not rig and o not in meshes])
    return rig, meshes, skeleton.NAME_MAPS["identity"]


def _part(p):
    """A sidecar part as the ledger holds it, or None when it is not one (GameAssetPart)."""
    if not isinstance(p, dict) or p.get("what") not in WHATS:
        return None
    src, licence, ai, credits = p.get("from"), p.get("licence"), p.get("ai"), p.get("credits")
    if not (isinstance(src, str) and 0 < len(src) <= 64 and isinstance(licence, str) and len(licence) <= 200
            and isinstance(ai, bool) and (credits is None or (isinstance(credits, (int, float)) and not isinstance(credits, bool)))):
        return None
    return {"what": p["what"], "from": src, "licence": licence, "ai": ai, "credits": credits}


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
        raise Refused("invalid-input", f"{os.path.basename(sidecar)} has no ledger that reads as one (source.parts), so the body's credits are unknown: export that model again with game_blender_export, or use a library body")
    body = next((p for p in parts if p["what"] == "body"), None)
    rest = [p for p in parts if p is not body]
    return (body if body is not None else dict(MADE_BODY)), rest


def _take_clips(clips, standard, standard_actions):
    """The requested library clips as actions owned by name; every other imported action goes."""
    by_path, taken = {}, []
    for c in clips:
        by_path.setdefault(c["path"], []).append(c)
    counts = {}
    for c in clips:
        counts[c["name"]] = counts.get(c["name"], 0) + 1
    for path, wanted in by_path.items():
        if path == standard:
            actions = standard_actions
        else:
            if not os.path.isfile(path):
                raise Refused("invalid-input", f"no clip file at {path}")
            new, actions = skeleton.import_gltf(path)
            skeleton.remove_objects(new)
        base = {re.sub(r"\.\d{3}$", "", a.name): a for a in actions}
        for c in wanted:
            act = base.pop(c["name"], None)
            if act is None:
                raise Refused("invalid-input", f"{c['pack']} has no clip {c['name']}; it has {', '.join(sorted(base))[:300]}")
            label = c["name"] if counts[c["name"]] == 1 else f"{c['pack']}:{c['name']}"
            taken.append((act, label, c))
        for a in base.values():
            bpy.data.actions.remove(a)
    return taken


def _alive(idb):
    try:
        idb.name
        return True
    except ReferenceError:
        return False


def _old_parts(old):
    """Objects bound to an existing character's armature other than its body."""
    out = []
    for o in bpy.data.objects:
        if o is old:
            continue
        bound = o.parent == old or old in helpers._deforming(o)
        src = json.loads(o.get("kurambit_source", "{}"))
        if bound and src.get("what") != "body":
            out.append(o)
    return out


@entry
def character(params):
    name = params["name"]
    replace = bool(params.get("replace"))
    old = bpy.data.objects.get(name)
    if old is not None and not replace:
        raise Refused("invalid-input", f"{name} already exists in the live scene: pass replace: true to rebuild its body and armature and keep your parts, or pick another name")
    if old is not None and old.type != "ARMATURE":
        raise Refused("invalid-input", f"{name} is a {old.type.lower()}, not a character's armature: pick another name")
    skeleton.object_mode()
    body_spec = params["body"]
    notes = []
    carried = []

    # The clips keep their own frame rate: imported at another, a 30 fps clip lands between frames
    # and the export resamples it (a 28-frame jog became 22 frames, its last cut off the loop).
    rates = {skeleton.clip_rate(skeleton.gltf_json(p)) for p in {c["path"] for c in params.get("clips", [])} if os.path.isfile(p)} - {None}
    render = bpy.context.scene.render
    if rates:
        rate = min(rates)
        if render.fps != rate or render.fps_base != 1.0:
            notes.append(f"the scene now runs at {rate} fps, the library clips' own rate (it was {render.fps / render.fps_base:g}): key your own clips at {rate} fps")
            render.fps, render.fps_base = rate, 1.0
        if len(rates) > 1:
            notes.append(f"the clips were made at {', '.join(str(r) for r in sorted(rates))} fps: those not at {rate} are resampled")

    # The standard armature first: every check below reads its joints.
    standard = params["standard"]
    std_new, std_actions = skeleton.import_gltf(standard)
    std_arm = next(o for o in std_new if o.type == "ARMATURE")
    skeleton.remove_objects([o for o in std_new if o is not std_arm])
    reference = skeleton.local_frames(std_arm)
    taken, body_arm, meshes = [], None, []
    try:
        for chain in params.get("chains", []):
            if chain["parent"] not in std_arm.data.bones:
                raise Refused("invalid-input", f"chain {chain['name']}: the standard skeleton has no joint {chain['parent']} (a tail hangs from pelvis, ears from Head)")
        taken = _take_clips(params.get("clips", []), standard, std_actions)
        if "mpfb" in body_spec:
            body_arm, meshes, name_map = _mpfb_body(body_spec["mpfb"])
            body_part = {**MADE_BODY, "from": "mpfb2", "licence": MPFB_LICENCE}
        else:
            path = body_spec.get("library") or body_spec.get("game")
            body_arm, meshes, name_map = _file_body(path)
            if "game" in body_spec:
                body_part, carried = _game_source(path)
            else:
                body_part = {**MADE_BODY, "from": body_spec.get("pack", "library"), "licence": body_spec.get("licence", "")}
        has = {name_map.get(b.name, b.name) for b in body_arm.data.bones}
        missing = [j for j in ("pelvis", "Head", "foot_l", "hand_l") if j not in has]
        if missing:
            raise Refused("invalid-input", f"the body's rig has no {', '.join(missing)}: it is not a humanoid on the standard skeleton")
        ratio = skeleton.conform(std_arm, body_arm, meshes, name_map)
    except BaseException:
        # a refused or failed build leaves the live scene as it was
        bpy.data.batch_remove({a for a in [*std_actions, *(t[0] for t in taken)] if _alive(a)})
        skeleton.remove_objects([o for o in [std_arm, body_arm, *meshes] if o is not None and _alive(o)])
        raise

    parts, old_chains = [], {}
    if old is not None:
        parts = _old_parts(old)
        old_body = [o for o in bpy.data.objects if (o.parent == old or old in helpers._deforming(o)) and o not in parts]
        for a in list(bpy.data.actions):
            if a.get("kurambit_owner") == name and "kurambit_from" in a:
                bpy.data.actions.remove(a)
        old_chains = {k: [old.matrix_world @ old.data.bones[b].head_local for b in v] + [old.matrix_world @ old.data.bones[v[-1]].tail_local]
                      for k, v in helpers.chains_of(old).items() if all(b in old.data.bones for b in v)}
        for o in [old] + old_body:
            o.name = f"{o.name}.replaced"

    arm = std_arm
    arm.name = name
    arm.data.name = name
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    for o in [arm] + meshes:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)
    for i, o in enumerate(meshes):
        o.name = f"{name}_body" if len(meshes) == 1 else f"{name}_body_{i + 1}"
        o.data.name = o.name
        o["kurambit_source"] = json.dumps(body_part)
        if carried:
            o["kurambit_parts"] = json.dumps(carried)  # the ledger's other parts this body brings

    for act, label, c in taken:
        skeleton.fit_clip(act, ratio)
        act.use_fake_user = True
        act["kurambit_from"] = c["pack"]
        act["kurambit_owner"] = name
        act["kurambit_clip"] = label
        act.name = label
    packs = []
    for _, _, c in taken:
        if all(p["from"] != c["pack"] for p in packs):
            packs.append({"from": c["pack"], "licence": c.get("licence", "")})
    if packs:
        stamp(arm, "clips", packs[0]["from"], packs[0]["licence"])
    arm["kurambit_clips"] = json.dumps(packs)
    arm["kurambit_standard_rest"] = json.dumps(skeleton.local_rest(skeleton.gltf_json(standard)))

    chains = {}
    for chain in params.get("chains", []):
        sides = [("", Vector(chain["direction"]))]
        if chain.get("mirror"):
            d = Vector(chain["direction"])
            first = "l" if d.x >= 0 else "r"
            sides = [(first, d), ("r" if first == "l" else "l", Vector((-d.x, d.y, d.z)))]
        for side, d in sides:
            d = d.normalized()
            joint = arm.matrix_world @ arm.data.bones[chain["parent"]].head_local
            hit = helpers.surface_hit(meshes, joint, d, 1.0)
            start = hit[0] if hit is not None else joint
            n = int(chain["bones"])
            points = [start + d * chain["length"] * i / n for i in range(n + 1)]
            label = chain["name"] if not side else f"{chain['name']}_{side}"
            if label in old_chains and len(old_chains[label]) == n + 1:
                points = old_chains[label]  # where place_chain put it before, so the parts on it fit
            chains[label] = helpers.add_chain(arm, label, chain["parent"], points)

    if old is not None:
        gone = set()
        for o in parts:
            if o.parent == old:
                mw = o.matrix_world.copy()
                o.parent = arm
                if o.parent_type == "BONE" and o.parent_bone not in arm.data.bones:
                    gone.add(o.parent_bone)
                o.matrix_world = mw
            for m in o.modifiers:
                if m.type == "ARMATURE" and m.object == old:
                    m.object = arm
            gone |= {vg.name for vg in o.vertex_groups if vg.name in old.data.bones and vg.name not in arm.data.bones}
        skeleton.remove_objects(old_body + [old])
        notes.append(f"re-bound {len(parts)} parts to the new armature")
        if gone:
            notes.append(f"bones the parts use are gone: {', '.join(sorted(gone))} (add them again, or make them chains)")

    idle = next((a for a, _, _ in taken if "idle" in a.name.lower()), None)
    skeleton.assign_action(arm, idle)
    deviation = skeleton.frame_deviation(arm, reference)
    zs = [z for o in meshes for z in helpers.rest_coords(o)[0][:, 2]]
    height = max(zs) - min(zs) if zs else 0.0
    notes.append(f"body {height:.2f} m; clips play with the pelvis translation scaled by {ratio:.3f} and no other bone translation")
    return {
        "armature": arm.name,
        "meshes": [o.name for o in meshes],
        "clips": [a.name for a, _, _ in taken],
        "chains": chains,
        "restDeviation": round(deviation or 0.0, 2),
        "height": round(height, 3),
        "notes": notes,
    }
