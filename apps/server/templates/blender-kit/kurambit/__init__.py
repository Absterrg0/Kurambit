"""Kurambit's Blender kit: the helpers and entry points the live scene imports as kurambit.

Entry points (each prints one KURAMBIT_RESULT line, or KURAMBIT_REFUSED): animate, character, digest,
review and rig (a static model rigged on a Mesh2Motion template or on chains, with its clips); paint.paint runs in the one-shot pass, and
paint.adopt takes its result into the live scene. resolve returns names.

Models are dense surfaces matched to a reference (studio-skills/art-pipeline.md): ref_planes stands
the reference behind the model, sweep makes one continuous surface along a centreline, one_skin
fuses regions into one, hard_surface cuts and bevels rigid parts, bake_down puts a dense model's
detail onto a light one. A model is built static, then rigged by rig (a Mesh2Motion template or
chains); skin_rigid adds a part to a rig on one bone, joints prints a skeleton's joints, decal paints
a face or emblem onto the model, hold, pivot, place_on_surface and grid place things, material
colours them; loft is a coarse sweep. blender holds Rigify's meta-rigs (an animal's skeleton), bake_ik_walk and
Blender's bundled node groups; look is the game's lock as made things read it; surface bakes a tiling material and wrap maps it in metres; scan lays a
photo-scanned texture under a material's own colour (op asset_import does it); qa counts the
faults the game shows that a review's pictures hide (inward faces, flicker).

The earlier craft kits (hero, world, carve) are gone. A model made with them still exports and plays
from its .blend, but its script no longer rebuilds: kurambit.hero or kurambit.world says so."""
from . import blender, look
from .animate import animate
from .bake import bake_down
from .character import character
from .digest import digest, resolve
from .hardsurface import hard_surface
from .helpers import (aim, decal, eye_lid, eye_squash, grid, hold, joints, key_pose, loft, material, mirror_pose, palette_of, pivot, place_on_surface, skin_rigid,
                      surface_hit, turn)
from .protocol import Refused
from .qa import qa
from .refplanes import ref_planes
from .rig import run as rig
from .review import review
from .scan import scan
from .skin import one_skin
from .surfaces import surface, wrap
from .sweep import sweep

__all__ = ["aim", "animate", "bake_down", "blender", "character", "decal", "digest", "eye_lid", "eye_squash", "grid", "hard_surface", "hold", "joints", "key_pose", "look", "loft", "material", "mirror_pose", "one_skin", "palette_of", "pivot",
           "place_on_surface", "qa", "ref_planes", "Refused", "resolve", "review", "rig", "scan", "skin_rigid", "surface", "surface_hit", "sweep", "turn", "wrap"]

GONE = ("hero", "world", "carve", "face", "hair", "garment", "cloth", "footwear", "trim", "zones", "anatomy", "creature", "gait")


# Parts-on-bones weighting, replaced by rigging the whole model.
RIGGED = ("weights_along", "ring_around", "tube_along_bones", "place_chain")


def __getattr__(name):
    if name in RIGGED:
        raise ImportError(
            f"kurambit.{name} was removed: build the model static and rig it with game_blender op character's rig "
            "(a template such as \"human\", or \"chains\"); props and plates go in its rigid.")
    if name in GONE:
        # ImportError, not AttributeError: `from kurambit import hero` turns an AttributeError into a
        # bare "cannot import name", and that is how the old scripts imported these.
        raise ImportError(
            f"kurambit.{name} was removed: the craft helpers it held are gone. A model made with it still exports from its "
            ".blend; to make it again, build it static with sweep, one_skin and hard_surface (studio-skills/art-pipeline.md) "
            "and rig it with game_blender op character's rig.")
    raise AttributeError(f"module 'kurambit' has no attribute {name!r}")
