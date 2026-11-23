"""Kurambit's Blender kit: the helpers and entry points the live scene imports as kurambit.

Entry points (each prints one KURAMBIT_RESULT line, or KURAMBIT_REFUSED): animate, character, digest,
review and rig (a static model rigged on a Mesh2Motion template or on chains, with its clips); paint.paint runs in the one-shot pass, and
paint.adopt takes its result into the live scene. resolve returns names.

Models are the agent's own plain bpy (studio-skills/art-pipeline.md); bake_down puts a dense
model's detail onto a light one. A model is built static, then rigged by rig (a Mesh2Motion template or
chains); skin_rigid adds a part to a rig on one bone, joints prints a skeleton's joints, decal paints
a face or emblem onto the model, hold, pivot, place_on_surface and grid place things, material
colours them. blender holds Rigify's meta-rigs (an animal's skeleton), bake_ik_walk and
Blender's bundled node groups; look is the game's lock as made things read it; scan lays a
photo-scanned texture under a material's own colour (op asset_import does it); qa counts the
faults the game shows that a review's pictures hide (inward faces, flicker).

The earlier craft kits (hero, world, carve) are gone. A model made with them still exports and plays
from its .blend, but its script no longer rebuilds: kurambit.hero or kurambit.world says so."""
from . import blender, look
from .animate import animate
from .bake import bake_down
from .character import character
from .digest import digest, resolve
from .helpers import (aim, decal, eye_lid, eye_squash, grid, hold, joints, key_pose, material, mirror_pose, palette_of, pivot, place_on_surface, skin_rigid,
                      surface_hit, turn)
from .protocol import Refused
from .qa import qa
from .rig import run as rig
from .review import review
from .scan import scan

__all__ = ["aim", "animate", "bake_down", "blender", "character", "decal", "digest", "eye_lid", "eye_squash", "grid", "hold", "joints", "key_pose", "look", "material", "mirror_pose", "palette_of", "pivot",
           "place_on_surface", "qa", "Refused", "resolve", "review", "rig", "scan", "skin_rigid", "surface_hit", "turn"]

GONE = ("hero", "world", "carve", "face", "hair", "garment", "cloth", "footwear", "trim", "zones", "anatomy", "creature", "gait")


# Modelling methods the art guide once prescribed; bare bpy made better models (model bench, 2026-11-23).
METHODS = ("sweep", "one_skin", "hard_surface", "loft", "ref_planes", "surface", "wrap")


# Parts-on-bones weighting, replaced by rigging the whole model.
RIGGED = ("weights_along", "ring_around", "tube_along_bones", "place_chain")


def __getattr__(name):
    if name in METHODS:
        raise ImportError(
            f"kurambit.{name} was removed: model in plain bpy (studio-skills/art-pipeline.md). A model made with it "
            "still exports from its .blend.")
    if name in RIGGED:
        raise ImportError(
            f"kurambit.{name} was removed: build the model static and rig it with game_blender op character's rig "
            "(a template such as \"human\", or \"chains\"); props and plates go in its rigid.")
    if name in GONE:
        # ImportError, not AttributeError: `from kurambit import hero` turns an AttributeError into a
        # bare "cannot import name", and that is how the old scripts imported these.
        raise ImportError(
            f"kurambit.{name} was removed: the craft helpers it held are gone. A model made with it still exports from its "
            ".blend; to make it again, build it static in plain bpy (studio-skills/art-pipeline.md) "
            "and rig it with game_blender op character's rig.")
    raise AttributeError(f"module 'kurambit' has no attribute {name!r}")
