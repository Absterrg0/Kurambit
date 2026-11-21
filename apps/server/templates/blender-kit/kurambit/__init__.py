"""Kurambit's Blender kit: the helpers and entry points the live scene imports as kurambit.

Entry points (each prints one KURAMBIT_RESULT line, or KURAMBIT_REFUSED): animate, character, digest
and review; paint.paint runs in the one-shot pass, and
paint.adopt takes its result into the live scene. resolve returns names.

Models are parts on a structure (studio-skills/recipes): loft makes a part as rings on its joints,
weights_along keeps it on its own bones through skin_rigid, joints prints a skeleton's joints, decal
paints a face or emblem onto the model, hold, pivot, place_on_surface and grid place things,
material colours them. blender holds Rigify's meta-rigs (an animal's skeleton), bake_ik_walk and
Blender's bundled node groups; look is the game's lock as made things read it; voxels makes a voxel
model from a grid or a .vox; surface bakes a tiling material and wrap maps it in metres; qa counts the
faults the game shows that a review's pictures hide (inward faces, flicker).

The earlier craft kits (hero, world, carve) are gone. A model made with them still exports and plays
from its .blend, but its script no longer rebuilds: kurambit.hero or kurambit.world says so."""
from . import blender, look
from .animate import animate
from .character import character
from .digest import digest, resolve
from .helpers import (aim, decal, eye_lid, eye_squash, grid, hold, key_pose, material, mirror_pose, joints, loft, palette_of, pivot, place_chain, place_on_surface,
                      ring_around, skin_rigid, surface_hit, tube_along_bones, turn, weights_along)
from .protocol import Refused
from .qa import qa
from .review import review
from .surfaces import surface, wrap
from .voxels import voxels

__all__ = ["aim", "animate", "blender", "character", "decal", "digest", "eye_lid", "eye_squash", "grid", "hold", "joints", "key_pose", "look", "loft", "material", "mirror_pose", "palette_of", "pivot",
           "place_chain", "place_on_surface", "qa", "Refused", "resolve", "review", "ring_around", "skin_rigid", "surface", "surface_hit", "tube_along_bones", "turn", "voxels", "weights_along", "wrap"]

GONE = ("hero", "world", "carve", "face", "hair", "garment", "cloth", "footwear", "trim", "zones", "anatomy", "creature", "gait")


def __getattr__(name):
    if name in GONE:
        # ImportError, not AttributeError: `from kurambit import hero` turns an AttributeError into a
        # bare "cannot import name", and that is how the old scripts imported these.
        raise ImportError(
            f"kurambit.{name} was removed: the craft helpers it held are gone. A model made with it still exports from its "
            ".blend; to make it again, build it as parts with loft, skin_rigid and weights_along (studio-skills/recipes).")
    raise AttributeError(f"module 'kurambit' has no attribute {name!r}")
