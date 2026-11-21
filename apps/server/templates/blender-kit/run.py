"""The one-shot entry: blender -b <copy of live.blend> --python run.py -- pass <params.json>.
Also `paint <params.json>` (kurambit.paint): work that outlasts a live call, done on a copy so the
live scene changes only when its result is adopted.

params: {objects (resolved names), expectedDigest: {name: sha1}, style: STYLE.json | null,
         budgets: {character, prop, texture}, standardJoints: [...] | null, out: abs dir,
         standard?: abs path of the standard armature's GLB, rig?: the lock's rig id,
         glb?: abs path to write the GLB to (default <out>/candidate.glb)}
Writes the GLB and prints KURAMBIT_RESULT {kind, objects, measured, refusals, parts,
usedPalette, armatures, creatures, ownClips, notes}: armatures are those the
lock's rig governs; creatures (name to its own rig id) those marked kurambit_rig, which keep their
own skeleton, with each one's clips
(ownClips: its own, and those from the clip library), from which the server decides whether the
mark stands. It works on its own copy of the scene: the live scene and the game folder
are never touched, and what it measures is the GLB it wrote, so the review, the export and
the sidecar all describe the same bytes."""
import json
import os
import sys

sys.dont_write_bytecode = True  # in dev the kit folder is the repository: no .pyc may land there
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Matrix  # noqa: E402

from kurambit import contact, deform, measure, skeleton, stylepass  # noqa: E402
from kurambit import gates as gates_rules  # noqa: E402
from kurambit.digest import digests, exported_actions  # noqa: E402
from kurambit.protocol import Refused, entry  # noqa: E402
from kurambit.voxels import aim_limbs  # noqa: E402

MADE = {"from": "made", "licence": "made in this game", "ai": False, "credits": None}
MAX_REST_DEVIATION = 2.0


def _stamp(idb, key="kurambit_source"):
    try:
        return json.loads(idb.get(key, ""))
    except (TypeError, ValueError):
        return None


def parts_of(objects):
    """The ledger: every distinct stamp (what, from, licence, ai and credits all count), body first;
    an unstamped mesh, or a clip with no source, was made here. Nothing is dropped: the server
    merges parts past the sidecar's limit, or refuses."""
    parts = []

    def add(p):
        part = {"what": p["what"], "from": p["from"], "licence": p.get("licence", ""),
                "ai": bool(p.get("ai", False)), "credits": p.get("credits")}
        if isinstance(p.get("generation"), str):  # the generation that delivered it (GameAssetPart)
            part["generation"] = p["generation"][:64]
        if part not in parts:
            parts.append(part)

    meshes = [o for o in objects if o.type in stylepass.helpers.GEOMETRY]
    for o in meshes:
        s = _stamp(o)
        if s is not None and s.get("what") == "body":
            add(s)
            for p in _stamp(o, "kurambit_parts") or []:  # an earlier export reused as a body brings its ledger
                add(p)
    for arm in (o for o in objects if o.type == "ARMATURE"):
        clips = json.loads(arm.get("kurambit_clips", "[]"))
        for c in clips:
            add({"what": "clips", **c})
        for a in exported_actions(arm):
            s = _stamp(a)  # a clip an import brought carries the import's stamp
            if s is not None:
                add({**s, "what": "clips"})
            elif "kurambit_from" not in a:
                add({"what": "clips", **MADE})
    for o in meshes:
        s = _stamp(o)
        if s is None:
            add({"what": "parts", **MADE})
        elif s.get("what") != "body":
            add(s)
    for o in meshes:
        s = _stamp(o, "kurambit_paint")  # a texture painted from a sheet credits the sheet's source
        if s is not None:
            add(s)
    return parts


def refusals_of(measured, info, params, creatures=()):
    """creatures: armatures on their own rig (kurambit_rig), which the lock's rig, made so library
    clips fit every character, does not govern."""
    out = []
    kind = measured["kind"]
    joints = params.get("standardJoints")
    if kind == "character" and joints:
        for name, bones in info["armatures"].items():
            if name in creatures:
                continue
            missing = [j for j in joints if j not in bones]
            if missing:
                out.append({"code": "off-rig", "text": f"{name} lacks {len(missing)} joints of STYLE.json's rig ({', '.join(missing[:4])}), so library clips would not fit it. For those, build it with game_blender op character. If it carries its own clips, mark it on its own rig: armature['kurambit_rig'] = '<rig name>'."})
    dev = measured["restDeviation"]
    if dev is not None and dev > MAX_REST_DEVIATION:
        out.append({"code": "rest-frames", "text": f"{info['worstJoint']}'s rest frame is {dev:.1f}° off the standard skeleton (at most {MAX_REST_DEVIATION:.0f}°): library clips would play twisted. Build the body with game_blender op character, which conforms it."})
    budget = params["budgets"][kind]
    if measured["triangles"] > budget:
        out.append({"code": "triangles", "text": f"{measured['triangles']} triangles, over STYLE.json's budget.{kind} of {budget}: raise that budget if the model needs them (the game's Performance row counts the scene), or thin a dense part (a decimate modifier on it)."})
    side = params["budgets"]["texture"]
    big = [t for t in measured["textures"] if max(t["width"], t["height"]) > side]
    if big:
        out.append({"code": "texture", "text": f"a {big[0]['width']}x{big[0]['height']} texture is over STYLE.json's budget.texture of {side} px a side and the pass could not scale it: replace it, or use the palette."})
    # A creature with no clips ships posed as it came; one with clips needs one to stand in.
    if kind == "character" and not any("idle" in c["name"].lower() for c in measured["clips"]) and (measured["clips"] or not creatures):
        out.append({"code": "no-idle", "text": "a character needs an idle clip to stand: add Idle_Loop through game_blender op character's clips, or key one."})
    clips = measured["clips"]
    if kind == "character" and clips and len(info["frozen"]) == len(clips):
        out.append({"code": "frozen-clips", "text": "no clip moves a bone in the exported model, so the character would slide around in one pose. If the armature was left in rest position (Armature > Pose Position: Rest), the pass already exports it posed; otherwise check that each action keys this armature's bones."})
    if kind == "character" and info["unweighted"]:
        out.append({"code": "unweighted", "text": f"{info['unweighted']} vertices are weighted to no bone (no vertex group, or groups naming no bone): they stay where they are while the character moves. Weight them to its bones with helpers.skin_rigid, or parent the part to a bone."})
    return out


def max_influences(objects):
    """The most bones any skinned vertex follows, before the export keeps its four strongest; None
    with nothing skinned."""
    most = None
    for o in objects:
        if o.type != "MESH":
            continue
        arm = next((m.object for m in o.modifiers if m.type == "ARMATURE" and m.object is not None), None)
        if arm is None:
            continue
        bones = {g.index for g in o.vertex_groups if g.name in arm.data.bones}
        for v in o.data.vertices:
            n = sum(1 for g in v.groups if g.group in bones and g.weight > 0)
            most = n if most is None else max(most, n)
    return most


def _keep_only(objects):
    """Removes everything that is not the candidate (keeping where its objects are), and every
    clip another character owns."""
    keep = set(objects)
    for o in objects:
        if o.parent is not None and o.parent not in keep:
            mw = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = mw
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o)
    owned = set()
    for arm in (o for o in objects if o.type == "ARMATURE"):
        owned |= set(exported_actions(arm))
        skeleton.assign_action(arm, None)
        for pb in arm.pose.bones:
            pb.matrix_basis = Matrix()
    for a in list(bpy.data.actions):
        if a not in owned:
            bpy.data.actions.remove(a)
    for a in owned:
        if a.get("kurambit_clip"):
            a.name = a["kurambit_clip"]


def hero_gates(objects, params):
    """The gates of the one character among objects (deform.py), in the size the style pass will
    ship it at; none for a prop or for several armatures."""
    arms = [o for o in objects if o.type == "ARMATURE"]
    if len(arms) != 1:
        return []
    meshes = [o for o in objects if o.type == "MESH"]
    scale = stylepass.character_scale(arms, meshes, params.get("style")) or 1.0
    return deform.hero_gates(arms[0], meshes, params["budgets"], scale)


@entry
def run_pass(params):
    names = list(params["objects"])
    missing = [n for n in names if n not in bpy.data.objects]
    found = digests([n for n in names if n not in missing])
    differ = missing + [n for n, sha in found.items() if params["expectedDigest"].get(n) != sha]
    if differ:
        raise Refused("invalid-input", f"the saved scene differs from the live one ({', '.join(differ[:5])})")
    objects = [bpy.data.objects[n] for n in names]
    parts = parts_of(objects)
    arms = [o for o in objects if o.type == "ARMATURE"]
    chains = {}
    for arm in arms:
        chains.update(json.loads(arm.get("kurambit_chains", "{}")))
    standard_rest = None
    if params.get("standard"):
        standard_rest = skeleton.local_rest(skeleton.gltf_json(params["standard"]))
    else:
        stored = next((a["kurambit_standard_rest"] for a in arms if "kurambit_standard_rest" in a), None)
        standard_rest = json.loads(stored) if stored else None
    rig = params.get("rig") or ("standard-humanoid" if standard_rest else None)
    creatures = {a.name: a["kurambit_rig"] for a in arms if a.get("kurambit_rig")}
    own_clips = {}
    for a in arms:
        if not a.get("kurambit_rig"):
            continue
        # game_blender op character marks the clips it brings from the library with their pack.
        clips = [(c.get("kurambit_clip", c.name)[:120], "kurambit_from" in c) for c in exported_actions(a)]
        own_clips[a.name] = {"own": [n for n, lib in clips if not lib][:64], "library": [n for n, lib in clips if lib][:64]}

    # A made creature names the bones it stands on, and its generated gaits their speed.
    feet, speeds = None, {}
    if len(arms) == 1:
        legs = json.loads(arms[0].get("kurambit_legs", "[]") or "[]")
        feet = [leg["foot"] for leg in legs if leg.get("foot") in arms[0].data.bones] or None
        speeds = {a.get("kurambit_clip", a.name): float(a["kurambit_speed"]) for a in exported_actions(arms[0]) if a.get("kurambit_speed")}

    _keep_only(objects)
    notes = []
    # Rest position is a modelling view: exported in it, every clip samples the rest pose and ships still.
    for o in objects:
        if o.type == "ARMATURE" and o.data.pose_position != "POSE":
            o.data.pose_position = "POSE"
            notes.append(f"{o.name} was shown in rest position; its clips were exported posed (the live scene is unchanged)")
    out = params["out"]
    os.makedirs(out, exist_ok=True)
    # A clip given to a voxel character after its voxels were made gets its whole limbs aimed too.
    for o in arms:
        if o.get("kurambit_voxel_limbs"):
            aim_limbs(o)
    # The lock's faceted finish first: the gates below measure the mesh that ships.
    stylepass.facet(objects, params.get("style"))
    # Before the style pass, which joins a character's meshes into one.
    gaps = contact.floating(objects)
    # Parts held by bones need nothing under them; a building's blocks do.
    loose = contact.unsupported(objects) if not arms else None
    influences = max_influences(objects)
    gates = hero_gates(objects, params)
    # Skin a garment covers does not ship (the earlier dress helper marked it). The gates read the whole body and
    # leave that skin out of what can show.
    deform.drop_under(objects)
    role, role_named = stylepass.role_of(objects)
    styled = stylepass.style_pass(objects, params.get("style"), out, params["budgets"]["texture"])
    # The server names the file (a temporary one it renames into place), so nothing reads half of it.
    candidate = params.get("glb") or os.path.join(out, "candidate.glb")
    bpy.ops.export_scene.gltf(
        filepath=candidate, export_format="GLB", export_yup=True, export_apply=True,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True,
        export_anim_single_armature=True, export_reset_pose_bones=True, export_skins=True,
        export_def_bones=False, export_optimize_animation_size=True, export_morph=False,
        # WebP for a browser game (the server names it): a fifth of PNG's bytes, read natively by three.js.
        export_image_format=params.get("images", "AUTO"), export_image_quality=80, export_materials="EXPORT", export_texcoords=True, export_normals=True,
        export_cameras=False, export_lights=False,
    )
    own = next(iter(creatures.values())) if len(creatures) == 1 and len(arms) == 1 else None
    measured, info = measure.measure(candidate, styled["kind"], standard_rest, params.get("standardJoints"), chains, rig, own, feet)
    for clip in measured["clips"]:
        # A generated gait's speed is the one its feet were planted for (the feet gate holds it to
        # that); the measure reads bone heads, which on a two-bone leg is a knee.
        if speeds.get(clip["name"]):
            clip["groundSpeed"], clip["groundSpeedFrom"] = round(speeds[clip["name"]] * (styled["scaled"] or 1.0), 3), "stride"
    if gates:
        # The budget is the shipped model's: the style pass joins meshes, scales textures and, for the atlas, merges materials,
        # so it is read off the candidate, not the scene before the pass.
        budgets = params["budgets"]
        gates = [g for g in gates if g["name"] != "budget"] + [gates_rules.budget(
            measured["triangles"], measured["materials"], measured["textures"],
            {"triangles": budgets["character"], "texture": budgets["texture"]})]
        measured["gates"] = gates
    if styled["paints"]:
        measured["paints"] = styled["paints"]
    if styled["atlas"]:
        measured["atlas"] = {"columns": styled["atlas"]["columns"], "rows": styled["atlas"]["rows"]}
    measured["style"] = {"role": role, "roleNamed": role_named, "roleBudget": stylepass.ROLE_BUDGETS[role],
                         "hues": styled["hues"], "flat": styled["flat"]}
    k = styled["scaled"] or 1.0  # in the shipped size
    if gaps is not None:
        measured["floating"] = [{"part": n[:128], "gap": round(g * k, 4)} for n, g in gaps[:32]]
    if loose is not None:
        away = {n for n, _ in gaps or []}
        measured["unsupported"] = [{"part": n[:128], "height": round(h * k, 4)} for n, h in loose if n not in away][:32]
    if influences is not None:
        measured["influences"] = influences
    still = ["clips that move no bone: " + ", ".join(info["frozen"])[:300]] if info["frozen"] else []
    refused = refusals_of(measured, info, params, set(creatures))
    return {
        "kind": styled["kind"],
        "objects": names,
        "measured": measured,
        "refusals": refused + [{"code": f"hero-{g['name']}", "text": g["text"][:400]} for g in gates if not g["pass"]
                               # the budget's triangles and texture refusals already say it
                               and not (g["name"] == "budget" and {r["code"] for r in refused} & {"triangles", "texture"})],
        "parts": parts,
        "usedPalette": styled["usedPalette"],
        "armatures": {n: b for n, b in info["armatures"].items() if n not in creatures},
        "creatures": creatures,
        "ownClips": own_clips,
        "notes": [n[:400] for n in notes + styled["notes"] + still],
    }


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:]
    if len(argv) != 2 or argv[0] not in ("pass", "paint"):
        raise SystemExit("usage: blender -b <scene.blend> --python run.py -- pass|paint <params.json>")
    with open(argv[1]) as f:
        params = json.load(f)
    if argv[0] == "pass":
        run_pass(params)
    else:
        from kurambit import paint  # noqa: E402

        paint.paint(params)
