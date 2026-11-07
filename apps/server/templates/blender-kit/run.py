"""The one-shot entry: blender -b <copy of live.blend> --python run.py -- pass <params.json>.

params: {objects (resolved names), expectedDigest: {name: sha1}, style: STYLE.json | null,
         budgets: {character, prop, texture}, standardJoints: [...] | null, out: abs dir,
         standard?: abs path of the standard armature's GLB, rig?: the lock's rig id,
         glb?: abs path to write the GLB to (default <out>/candidate.glb)}
Writes the GLB and prints KURAMBIT_RESULT {kind, objects, measured, refusals, parts,
usedPalette, armatures, notes}. It works on its own copy of the scene: the live scene and the game folder
are never touched (D7), and what it measures is the GLB it wrote, so the review, the export and
the sidecar all describe the same bytes."""
import json
import os
import sys

sys.dont_write_bytecode = True  # in dev the kit folder is the repository: no .pyc may land there
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Matrix  # noqa: E402

from kurambit import contact, measure, skeleton, stylepass  # noqa: E402
from kurambit.digest import digests, exported_actions  # noqa: E402
from kurambit.protocol import Refused, entry  # noqa: E402

MADE = {"from": "made", "licence": "made in this game", "ai": False, "credits": None}
MAX_REST_DEVIATION = 2.0


def _stamp(idb, key="kurambit_source"):
    try:
        return json.loads(idb.get(key, ""))
    except ValueError:
        return None


def parts_of(objects):
    """The ledger: every distinct stamp (what, from, licence, ai and credits all count), body first;
    an unstamped mesh, or a clip with no source, was made here. Nothing is dropped: the server
    merges parts past the sidecar's limit, or refuses."""
    parts = []

    def add(p):
        part = {"what": p["what"], "from": p["from"], "licence": p.get("licence", ""),
                "ai": bool(p.get("ai", False)), "credits": p.get("credits")}
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
    return parts


def refusals_of(measured, info, params):
    out = []
    kind = measured["kind"]
    joints = params.get("standardJoints")
    if kind == "character" and joints:
        for name, bones in info["armatures"].items():
            missing = [j for j in joints if j not in bones]
            if missing:
                out.append({"code": "off-rig", "text": f"{name} lacks {len(missing)} joints of STYLE.json's rig ({', '.join(missing[:6])}): its clips would not fit the game's other characters. Build it with game_blender_character, which puts it on the rig."})
    dev = measured["restDeviation"]
    if dev is not None and dev > MAX_REST_DEVIATION:
        out.append({"code": "rest-frames", "text": f"{info['worstJoint']}'s rest frame is {dev:.1f}° off the standard skeleton (at most {MAX_REST_DEVIATION:.0f}°): library clips would play twisted. Build the body with game_blender_character, which conforms it."})
    budget = params["budgets"][kind]
    if measured["triangles"] > budget:
        out.append({"code": "triangles", "text": f"{measured['triangles']} triangles, over STYLE.json's budget.{kind} of {budget}: use fewer segments, decimate a dense part, or raise the budget."})
    side = params["budgets"]["texture"]
    big = [t for t in measured["textures"] if max(t["width"], t["height"]) > side]
    if big:
        out.append({"code": "texture", "text": f"a {big[0]['width']}x{big[0]['height']} texture is over STYLE.json's budget.texture of {side} px a side and the pass could not scale it: replace it, or use the palette."})
    if kind == "character" and not any("idle" in c["name"].lower() for c in measured["clips"]):
        out.append({"code": "no-idle", "text": "a character needs an idle clip to stand: add Idle_Loop through game_blender_character's clips, or key one."})
    if kind == "character" and info["unweighted"]:
        out.append({"code": "unweighted", "text": f"{info['unweighted']} vertices are weighted to no bone (no vertex group, or groups naming no bone): they stay where they are while the character moves. Weight them to its bones with helpers.skin_rigid, or parent the part to a bone."})
    return out


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

    _keep_only(objects)
    out = params["out"]
    os.makedirs(out, exist_ok=True)
    # Before the style pass, which joins a character's meshes into one.
    gaps = contact.floating(objects)
    styled = stylepass.style_pass(objects, params.get("style"), out, params["budgets"]["texture"])
    # The server names the file (a temporary one it renames into place), so nothing reads half of it.
    candidate = params.get("glb") or os.path.join(out, "candidate.glb")
    bpy.ops.export_scene.gltf(
        filepath=candidate, export_format="GLB", export_yup=True, export_apply=True,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True,
        export_anim_single_armature=True, export_reset_pose_bones=True, export_skins=True,
        export_def_bones=False, export_optimize_animation_size=True, export_morph=False,
        export_image_format="AUTO", export_materials="EXPORT", export_texcoords=True, export_normals=True,
        export_cameras=False, export_lights=False,
    )
    measured, info = measure.measure(candidate, styled["kind"], standard_rest, params.get("standardJoints"), chains, rig)
    if gaps is not None:
        k = styled["scaled"] or 1.0  # in the shipped size
        measured["floating"] = [{"part": n[:128], "gap": round(g * k, 4)} for n, g in gaps[:32]]
    return {
        "kind": styled["kind"],
        "objects": names,
        "measured": measured,
        "refusals": refusals_of(measured, info, params),
        "parts": parts,
        "usedPalette": styled["usedPalette"],
        "armatures": info["armatures"],
        "notes": [n[:400] for n in styled["notes"]],
    }


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:]
    if len(argv) != 2 or argv[0] != "pass":
        raise SystemExit("usage: blender -b <scene.blend> --python run.py -- pass <params.json>")
    with open(argv[1]) as f:
        run_pass(json.load(f))
