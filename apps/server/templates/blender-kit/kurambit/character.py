"""character(): a body conformed to the standard skeleton, skinned, with its clips and chains.

params (the server resolves every path):
    name      the collection, the armature's name and the export's default stem
    body      {"library": abs, "pack"?: id, "licence"?: str} | {"mpfb": {age, gender, weight, ...}}
              | {"game": abs, "source"?: {from, licence, ai, credits}} (source: a generated file's
              record, read by the server; without it the sidecar beside the file is the ledger).
              A game body keeps its own clips, and every body its own skinned bone chains (cloth,
              hair) as spring chains.
    standard  abs path of the standard armature's GLB (STANDARD_ARMATURE)
    clips     [{pack, name, path, licence?}] | {pack, name, path, licence, source, motion: true}: a GLB
              the motion lane delivered (one clip retargeted onto the body it holds), its source
              the generation's stamp {from, licence, ai, credits}
    chains    [{name, parent, bones, direction, length, mirror?}]
    replace   rebuild the body and armature of an existing <name>, re-binding its other objects
    fit       {arms?, calm?} | None: fit.fit() on every library clip, after the conform
"""
import importlib
import json
import math
import os
import re

import bpy
from mathutils import Vector

from . import fit, helpers, skeleton
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


def _file_body(path, keep_clips=False):
    """(armature, meshes, name map, the body's own clips when keep_clips, else none)."""
    if not os.path.isfile(path):
        raise Refused("invalid-input", f"no body file at {path}")
    new, actions = skeleton.import_model(path)
    if not keep_clips:
        bpy.data.batch_remove(set(actions))
        actions = []
    rigs = [o for o in new if o.type == "ARMATURE"]
    if len(rigs) != 1:
        bpy.data.batch_remove(set(actions))
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
    return rig, meshes, skeleton.humanoid_map({b.name: b.parent.name if b.parent else None for b in rig.data.bones}), actions


def _body_clips(actions, rig, name_map, reference, bones, notes):
    """The clips a body came with (a hand-keyed cut, a dodge), on the standard names: [(action,
    label)]. glTF keys absolute joint rotations, so they play as made only when the body's rest
    frames are the standard's; off them they are dropped with a note. Keys on bones that do not
    stay (merged into a joint) go."""
    if not actions:
        return []
    frames = {name_map.get(n, n): q for n, q in skeleton.local_frames(rig).items()}
    worst = max(((math.degrees(frames[n].rotation_difference(q).angle), n) for n, q in reference.items() if n in frames), default=(0.0, None))
    if worst[0] > MAX_REST_DEVIATION:
        notes.append(f"the body's own clips ({', '.join(sorted(a.name for a in actions))[:200]}) were left out: its {worst[1]} rest frame is {worst[0]:.1f}° off the standard skeleton (at most {MAX_REST_DEVIATION:.0f}°), so they would play twisted on it")
        bpy.data.batch_remove(set(actions))
        return []
    out = []
    for act in actions:
        fcs = skeleton.action_fcurves(act)
        for fc in list(fcs):
            m = re.match(r'^pose\.bones\["(.+?)"\](.*)$', fc.data_path)
            joint = name_map.get(m.group(1), m.group(1)) if m else None
            if joint not in bones:
                fcs.remove(fc)
            elif joint != m.group(1):
                fc.data_path = f'pose.bones["{joint}"]{m.group(2)}'
        if len(fcs) == 0:
            bpy.data.actions.remove(act)
            continue
        out.append((act, re.sub(r"\.\d{3}$", "", act.name)))
    return out


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
        raise Refused("invalid-input", f"{os.path.basename(sidecar)} has no ledger that reads as one (source.parts), so the body's credits are unknown: export that model again with game_blender_export, or use a library body")
    body = next((p for p in parts if p["what"] == "body"), None)
    rest = [p for p in parts if p is not body]
    return (body if body is not None else dict(MADE_BODY)), rest


# The most a clip's skeleton may differ from the standard's rest frames, as the export allows.
MAX_REST_DEVIATION = 2.0
# The most spring chains a model's sidecar holds (GameModelSpring).
MAX_SPRINGS = 8


def _height(arm, name_map):
    """Head over foot_l at rest, in metres: what a clip's pelvis travel is scaled by."""
    by_std = {name_map.get(b.name, b.name): b for b in arm.data.bones}
    head, foot = by_std.get("Head"), by_std.get("foot_l")
    if head is None or foot is None:
        return None
    return ((arm.matrix_world @ head.head_local).z - (arm.matrix_world @ foot.head_local).z) or None


def _take_motion(c, reference, standard_height):
    """A motion-lane GLB's clip: (action, the scale of the body it was made on). Its bones are
    renamed to the standard joints when Uthana named them otherwise, the way a body is conformed,
    and it is refused when its skeleton's rest frames are not the standard's: glTF keys absolute
    joint rotations, so on other rest frames it would play twisted."""
    path, label = c["path"], c["name"]
    if not os.path.isfile(path):
        raise Refused("invalid-input", f"no clip file at {path}")
    new, actions = skeleton.import_gltf(path)
    try:
        rigs = [o for o in new if o.type == "ARMATURE"]
        if len(rigs) != 1 or not actions:
            raise Refused("invalid-input", f"{os.path.basename(path)} holds {len(rigs)} armatures and {len(actions)} clips: a motion is one clip on one skeleton")
        rig = rigs[0]
        name_map = skeleton.humanoid_map({b.name: b.parent.name if b.parent else None for b in rig.data.bones})
        frames = {name_map.get(n, n): q for n, q in skeleton.local_frames(rig).items()}
        missing = [j for j in ("pelvis", "Head", "foot_l", "hand_l") if j not in frames]
        if missing:
            raise Refused("invalid-input", f"{label}'s skeleton has no {', '.join(missing)} under any name the kit knows: its bones are {', '.join(b.name for b in rig.data.bones)[:400]}")
        worst = max(((math.degrees(frames[n].rotation_difference(q).angle), n) for n, q in reference.items() if n in frames), default=(0.0, None))
        if worst[0] > MAX_REST_DEVIATION:
            raise Refused("invalid-input", f"{label} was made on a skeleton whose {worst[1]} rest frame is {worst[0]:.1f}° off the standard (at most {MAX_REST_DEVIATION:.0f}°): it would play twisted on the game's humanoids. Make it on a character on the standard skeleton")
        made = _height(rig, name_map)
        act = max(actions, key=lambda a: a.frame_range[1] - a.frame_range[0])
        for a in actions:
            if a is not act:
                bpy.data.actions.remove(a)
        fcs = skeleton.action_fcurves(act)
        for fc in list(fcs):
            m = re.match(r'^pose\.bones\["(.+?)"\](.*)$', fc.data_path)
            if m is None:
                fcs.remove(fc)
                continue
            joint = name_map.get(m.group(1), m.group(1))
            if joint not in reference:
                fcs.remove(fc)  # a bone the standard lacks keys nothing in the game
            elif joint != m.group(1):
                fc.data_path = f'pose.bones["{joint}"]{m.group(2)}'
        return act, (made / standard_height) if made and standard_height else 1.0
    except BaseException:
        bpy.data.batch_remove({a for a in actions if _alive(a)})
        raise
    finally:
        skeleton.remove_objects(new)


def _take_clips(clips, standard, standard_actions, reference=None, standard_height=None):
    """The requested library clips as actions owned by name; every other imported action goes.
    A motion-lane clip comes with the scale of the body it was made on (1 for a library clip)."""
    by_path, taken = {}, []
    motions = [c for c in clips if c.get("motion")]
    clips = [c for c in clips if not c.get("motion")]
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
            taken.append((act, label, c, 1.0))
        for a in base.values():
            bpy.data.actions.remove(a)
    names = {label for _, label, _, _ in taken}
    for c in motions:
        act, made = _take_motion(c, reference, standard_height)
        label = c["name"]
        for n in range(2, 100):
            if label not in names:
                break
            label = f"{c['name']}_{n}"
        names.add(label)
        taken.append((act, label, c, made))
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
            was = render.fps / render.fps_base
            # Every clip already in the scene keeps its seconds: its keys move to the new rate.
            for act in bpy.data.actions:
                skeleton.retime(act, rate / was)
            notes.append(f"the scene now runs at {rate} fps, the library clips' own rate (it was {was:g}; clips already here keep their timing): key your own clips at {rate} fps")
            render.fps, render.fps_base = rate, 1.0
        if len(rates) > 1:
            notes.append(f"the clips were made at {', '.join(str(r) for r in sorted(rates))} fps: those not at {rate} are resampled")

    # The standard armature first: every check below reads its joints.
    standard = params["standard"]
    std_new, std_actions = skeleton.import_gltf(standard)
    std_arm = next(o for o in std_new if o.type == "ARMATURE")
    skeleton.remove_objects([o for o in std_new if o is not std_arm])
    reference = skeleton.local_frames(std_arm)
    taken, body_arm, meshes, own_actions, own, extra, unit = [], None, [], [], [], [], 1.0
    joints = set(std_arm.data.bones.keys())
    try:
        asked_bones = set()
        for chain in params.get("chains", []):
            if chain["parent"] not in std_arm.data.bones:
                raise Refused("invalid-input", f"chain {chain['name']}: the standard skeleton has no joint {chain['parent']} (a tail hangs from pelvis, ears from Head)")
            labels = [f"{chain['name']}_l", f"{chain['name']}_r"] if chain.get("mirror") else [chain["name"]]
            asked_bones |= {f"{label}_{i + 1:02d}" for label in labels for i in range(int(chain["bones"]))}
        taken = _take_clips(params.get("clips", []), standard, std_actions, reference, _height(std_arm, {}))
        if "mpfb" in body_spec:
            body_arm, meshes, name_map = _mpfb_body(body_spec["mpfb"])
            body_part = {**MADE_BODY, "from": "mpfb2", "licence": MPFB_LICENCE}
        else:
            path = body_spec.get("library") or body_spec.get("game")
            body_arm, meshes, name_map, own_actions = _file_body(path, keep_clips="game" in body_spec)
            # The body's own cloth, hair and tails stay as spring chains, as many as a model springs.
            extra = skeleton.body_chains(meshes, body_arm, name_map, joints)
            room = MAX_SPRINGS - sum(2 if c.get("mirror") else 1 for c in params.get("chains", []))
            if len(extra) > room:
                notes.append(f"the body's own {len(extra)} bone chains ({', '.join(n for n, _, _ in extra)[:200]}) were merged into their joints: a model springs at most {MAX_SPRINGS} chains, and {MAX_SPRINGS - room} are asked for in chains")
                extra = []
            clash = sorted(asked_bones & {b for _, bones, _ in extra for b in bones})
            if clash:
                raise Refused("invalid-input", f"the body already has bones {', '.join(clash[:6])}, which it keeps as its own spring chains: leave that chain out of chains, or name it another way")
            skeleton.merge_unmapped(meshes, body_arm, name_map, joints | {b for _, bones, _ in extra for b in bones})
            if body_spec.get("source"):
                body_part = {"what": "body", **body_spec["source"]}
            elif "game" in body_spec:
                body_part, carried = _game_source(path)
            else:
                body_part = {**MADE_BODY, "from": body_spec.get("pack", "library"), "licence": body_spec.get("licence", "")}
        has = {name_map.get(b.name, b.name) for b in body_arm.data.bones}
        missing = [j for j in ("pelvis", "Head", "foot_l", "hand_l") if j not in has]
        if missing:
            raise Refused("invalid-input", f"the body's rig has no {', '.join(missing)} under any name the kit knows (UE, Mixamo, KayKit and similar): it is not a humanoid, or its bones are named another way. A creature keeps its own rig: import it with game_blender_assets_import instead. Its bones: {', '.join(b.name for b in body_arm.data.bones)[:600]}")
        own = _body_clips(own_actions, body_arm, name_map, reference, joints | {b for _, bones, _ in extra for b in bones}, notes)
        # Its clips move the pelvis in the body's own units.
        unit = body_arm.matrix_world.to_scale().z / std_arm.matrix_world.to_scale().z
        ratio = skeleton.conform(std_arm, body_arm, meshes, name_map, extra)
    except BaseException:
        # a refused or failed build leaves the live scene as it was
        bpy.data.batch_remove({a for a in [*std_actions, *(t[0] for t in taken), *own_actions] if _alive(a)})
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

    names = {label for _, label, _, _ in taken}
    for act, label in own:
        if label in names:
            notes.append(f"the body's own clip {label} was left out: a clip asked for in clips has its name")
            bpy.data.actions.remove(act)
            continue
        names.add(label)
        taken.append((act, label, {"pack": "body", "own": True}, ratio / unit))
    if own:
        notes.append(f"kept the body's own clips: {', '.join(label for _, label, c, _ in taken if c.get('own'))}")
    for act, label, c, made in taken:
        # A clip made on this body already moves its pelvis this body's distances.
        skeleton.fit_clip(act, ratio / made)
        act.use_fake_user = True
        act["kurambit_from"] = c["pack"]
        act["kurambit_owner"] = name
        act["kurambit_clip"] = label
        if c.get("motion"):
            act["kurambit_source"] = json.dumps({"what": "clips", **c["source"]})  # credited per clip: ai, cost
        elif c.get("own"):
            act["kurambit_source"] = json.dumps({**body_part, "what": "clips"})  # credited as the body is
        # Clip names are per character; in Blender every action needs its own name, so a second
        # character's Idle_Loop would read Idle_Loop.001. The export names it by kurambit_clip.
        act.name = helpers.action_name(name, label)
    packs = []
    for _, _, c, _ in taken:
        if c.get("motion") or c.get("own"):
            continue
        if all(p["from"] != c["pack"] for p in packs):
            packs.append({"from": c["pack"], "licence": c.get("licence", "")})
    if packs:
        stamp(arm, "clips", packs[0]["from"], packs[0]["licence"])
    arm["kurambit_clips"] = json.dumps(packs)
    if params.get("fit"):
        notes += fit.fit(arm, meshes, [a for a, _, c, _ in taken if not c.get("own")], params["fit"])
    arm["kurambit_standard_rest"] = json.dumps(skeleton.local_rest(skeleton.gltf_json(standard)))

    chains = {n: bones for n, bones, _ in extra}
    if extra:
        arm["kurambit_chains"] = json.dumps(chains)
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

    idle = next((a for a, _, _, _ in taken if "idle" in a.name.lower()), None)
    skeleton.assign_action(arm, idle)
    deviation = skeleton.frame_deviation(arm, reference)
    zs = [z for o in meshes for z in helpers.rest_coords(o)[0][:, 2]]
    height = max(zs) - min(zs) if zs else 0.0
    notes.append(f"body {height:.2f} m; clips play with the pelvis translation scaled by {ratio:.3f} and no other bone translation")
    return {
        "armature": arm.name,
        "meshes": [o.name for o in meshes],
        "clips": [a.name for a, _, _, _ in taken],
        "chains": chains,
        "restDeviation": round(deviation or 0.0, 2),
        "height": round(height, 3),
        "notes": notes,
    }
