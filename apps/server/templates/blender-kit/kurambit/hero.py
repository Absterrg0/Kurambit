"""The hero kit, as one namespace for game_blender op code: `from kurambit import hero`.

Body:    hero.creature_body(name, sketch), hero.sculpt(obj, kind, ...), hero.decimate(obj, tris)
         (a human body is game_blender op character's: body mpfb or library, style, height)
Face:    hero.face(armature, iris="#4f7396", brows="#3a2a20"): eyes that blink, brows and a mouth in
         the body's style
Clothes: hero.dress(garment, armature, hang=..., chains=6), hero.dangle(part, armature, start, end),
         hero.follow_hem(armature)
Rig:     hero.creature_rig(body, height=(lo, hi)), hero.bind(mesh, armature),
         hero.membrane(armature, "wing", depth): a wing's or a fin's surface on its chain
Motion:  hero.creature_clips(armature, ["walk", "trot", "run", "idle", "look", "sit"]), and "swim",
         "slither", "flap", "fly", "hop", "hover"; by hand,
         hero.controls(armature) (a Rigify control rig: IK paws, a torso), pose and key it, then
         hero.bake_controls(armature, "Pounce", start, end) and hero.controls(armature, on=False)
Machine: hero.hinge_rig(name, parts, base=[...], height=(lo, hi)), hero.hinge_clips(armature,
         {"Open": {"lid": [(0, 0), (0.5, -100)]}}): parts on hinges with their own clips
Gates:   hero.gates(armature): the review's gate numbers now, in the live scene
"""
from .cloth import dangle, dress, follow_hem
from .face import face
from .creature import bake_controls, bind, controls, creature_body, creature_clips, creature_rig, decimate, hinge_clips, hinge_rig, membrane, sculpt


def gates(armature, budgets=None):
    """The hero gates of armature in the live scene, as the review measures them (before the style
    pass's scaling): a quick reading between reviews."""
    import bpy

    from . import deform, helpers

    arm = bpy.data.objects[armature] if isinstance(armature, str) else armature
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and (arm in helpers._deforming(o) or o.parent == arm)]
    return deform.hero_gates(arm, meshes, budgets or {"character": 30000, "texture": 2048})


__all__ = ["bake_controls", "bind", "controls", "creature_body", "creature_clips", "creature_rig", "dangle", "decimate", "dress", "face", "follow_hem", "gates", "hinge_clips", "hinge_rig", "membrane", "sculpt"]
