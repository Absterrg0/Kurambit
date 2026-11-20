"""Kurambit's Blender kit: the helpers and entry points the live scene imports as kurambit.

Entry points (each prints one KURAMBIT_RESULT line, or KURAMBIT_REFUSED): animate, character, digest,
generated, model_views, motion_strip and review; paint.paint and carve.carve run in the one-shot pass, and
paint.adopt and carve.adopt take their results into the live scene. resolve returns names.

Models are parts on a structure (studio-skills/recipes): loft makes a part as rings on its joints,
weights_along keeps it on its own bones through skin_rigid, joints prints a skeleton's joints, decal
paints a face or emblem into the model's atlas, hold, pivot, place_on_surface and grid place things,
material colours them. blender holds Rigify's meta-rigs (an animal's skeleton), bake_ik_walk and
Blender's bundled node groups; look is the game's lock as made things read it; voxels makes a voxel
model from a grid or a .vox; surface bakes a tiling material and wrap maps it in metres. hero and world
are the earlier craft kits, kept so models made with them still rebuild: new models do not use them."""
from . import blender, hero, look, world
from .animate import animate
from .character import character
from .digest import digest, resolve
from .generated import generated
from .helpers import (aim, decal, eye_lid, eye_squash, grid, hold, key_pose, material, mirror_pose, joints, loft, palette_of, pivot, place_chain, place_on_surface,
                      ring_around, skin_rigid, surface_hit, tube_along_bones, turn, weights_along)
from .protocol import Refused
from .review import model_views, motion_strip, review
from .surfaces import surface, wrap
from .voxels import voxels

__all__ = ["aim", "animate", "blender", "hero", "character", "decal", "digest", "eye_lid", "eye_squash", "generated", "grid", "hold", "joints", "key_pose", "look", "loft", "material", "mirror_pose", "model_views", "motion_strip", "palette_of", "pivot",
           "place_chain", "place_on_surface", "Refused", "resolve", "review", "ring_around", "skin_rigid", "surface", "surface_hit", "tube_along_bones", "turn", "voxels", "weights_along", "world", "wrap"]
