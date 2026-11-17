"""The hero kit, as one namespace for game_blender op code: `from kurambit import hero`.

Body:    hero.creature_body(name, sketch), hero.sculpt(obj, kind, ...), hero.decimate(obj, tris)
         (a human body is game_blender op character's: body mpfb or library, style, height)
Clothes: hero.dress(garment, armature, hang=..., chains=6), hero.dangle(part, armature, start, end),
         hero.follow_hem(armature)
Rig:     hero.creature_rig(body, height=(lo, hi)), hero.bind(mesh, armature)
Motion:  hero.creature_clips(armature, ["walk", "trot", "run", "idle", "look", "sit"])
Gates:   hero.gates(armature): the review's gate numbers now, in the live scene
"""
from .cloth import dangle, dress, follow_hem
from .creature import bind, creature_body, creature_clips, creature_rig, decimate, sculpt


def gates(armature, budgets=None):
    """The hero gates of armature in the live scene, as the review measures them (before the style
    pass's scaling): a quick reading between reviews."""
    import bpy

    from . import deform, helpers

    arm = bpy.data.objects[armature] if isinstance(armature, str) else armature
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and (arm in helpers._deforming(o) or o.parent == arm)]
    return deform.hero_gates(arm, meshes, budgets or {"character": 30000, "texture": 2048})


__all__ = ["bind", "creature_body", "creature_clips", "creature_rig", "dangle", "decimate", "dress", "follow_hem", "gates", "sculpt"]
