"""Kept so models made with it still rebuild; new models are parts on a structure
(studio-skills/recipes).

The hero kit, as one namespace for game_blender op code: `from kurambit import hero`.

Body:    hero.creature_body(name, sketch, style="cartoon"|...), hero.sculpt(obj, kind, ...), hero.decimate(obj, tris)
         (a human body is game_blender op character's: body mpfb or library, style, height)
Face:    hero.face(armature, iris="#4f7396", brows="#3a2a20"): eyes that blink, brows and a mouth in
         the body's style
Head:    hero.hair(armature, "short"|"long"|"tied"|"curly", colour=): a cap and chunky locks on the
         head it finds; hero.beard(armature, colour=), hero.glasses(armature, shape=), and
         hero.wear(hat, armature): a hat or helmet you modelled, sized to the head and its hair
Clothes: hero.garment(armature, "top"|"trousers"|"gloves"|"skirt", colour=, ...): a whole
         garment made from the body's own surface between clean cuts, fitted and bound;
         hero.footwear(armature, "boots"|"shoes", colour=, sole=, toe="round"|"pointed"|"square"):
         footwear with a sole and one toe, made for the feet it is on; by hand,
         hero.dress(garment, armature, hang=..., chains=6), hero.dangle(part, armature, start, end),
         hero.follow_hem(armature)
Gear:    hero.trim(armature, "belt"|"strap"|"pouch"|"bag"|"collar"|"cuffs"|"buttons"|"pauldrons"|
         "cape"|"scabbard", colour=, metal=): gear made round what the character wears now
Colour:  hero.zone(mesh, kind, colour): a second colour by what the part is. A creature's "belly",
         "socks", "muzzle", "ears", "blaze", "stripes", "spots", "saddle", "tip", "mask"; a
         garment's "hems", "stripe", "panel", "patch". Each is one more colour in Art
Animal:  hero.creature_face(armature, eyes=, set="side"|"front"|"top"): eyes that blink, nostrils,
         a mouth; hero.feet(armature, "hoof"|"paw"|"claw"); hero.fur(armature, "neck"|"tail"|chain,
         side="top"|"under"|"end"): a mane, a ruff, a tail's tuft; hero.feathers(armature, "wing",
         depth=) or hero.wing(armature, "wing", depth=): a wing's feathers, or its ribbed skin;
         hero.horns(armature, "swept"|"straight"|"curled", pairs=)
Rig:     hero.creature_rig(body, height=(lo, hi)), hero.bind(mesh, armature),
         hero.membrane(armature, "fin_top", depth, shape="sail"|"fan"|"round"): a fin on its chain
Motion:  hero.creature_clips(armature, ["walk", "trot", "run", "idle", "look", "sit"]), and "swim",
         "slither", "flap", "fly", "hop", "hover"; by hand,
         hero.controls(armature) (a Rigify control rig: IK paws, a torso), pose and key it, then
         hero.bake_controls(armature, "Pounce", start, end) and hero.controls(armature, on=False)
Machine: hero.hinge_rig(name, parts, base=[...], height=(lo, hi)), hero.hinge_clips(armature,
         {"Open": {"lid": [(0, 0), (0.5, -100)]}}): parts on hinges with their own clips
Gates:   hero.gates(armature): the review's gate numbers now, in the live scene
"""
from .anatomy import creature_face, feathers, feet, fur, horns, wing
from .cloth import dangle, dress, follow_hem
from .face import face
from .footwear import footwear
from .trim import trim
from .zones import zone
from .garment import garment
from .hair import beard, glasses, hair, wear
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
