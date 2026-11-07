"""Kurambit's Blender kit: the helpers and entry points the live scene imports as kurambit.

Entry points (each prints one KURAMBIT_RESULT line, or KURAMBIT_REFUSED): animate, character, digest,
generated, model_views, motion_strip and review; paint.paint and carve.carve run in the one-shot pass, and
paint.adopt and carve.adopt take their results into the live scene. resolve returns names. The helpers model parts and key clips on a conformed character."""
from .animate import animate
from .character import character
from .digest import digest, resolve
from .generated import generated
from .helpers import (aim, eye_lid, eye_squash, key_pose, material, mirror_pose, palette_of, place_chain, place_on_surface, ring_around, skin_rigid,
                      surface_hit, tube_along_bones, turn)
from .protocol import Refused
from .review import model_views, motion_strip, review

__all__ = ["aim", "animate", "character", "digest", "eye_lid", "eye_squash", "generated", "key_pose", "material", "mirror_pose", "model_views", "motion_strip", "palette_of", "place_chain", "place_on_surface",
           "Refused", "resolve", "review", "ring_around", "skin_rigid", "surface_hit", "tube_along_bones", "turn"]
