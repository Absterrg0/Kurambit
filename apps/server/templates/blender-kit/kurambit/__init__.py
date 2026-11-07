"""Kurambit's Blender kit: the helpers and entry points the live scene imports as kurambit.

Entry points (each prints one KURAMBIT_RESULT line, or KURAMBIT_REFUSED): character, digest and
review. resolve returns names. The helpers model parts and key clips on a conformed character."""
from .character import character
from .digest import digest, resolve
from .helpers import (aim, eye_lid, eye_squash, key_pose, material, place_chain, place_on_surface, ring_around, skin_rigid,
                      surface_hit, tube_along_bones, turn)
from .protocol import Refused
from .review import review

__all__ = ["aim", "character", "digest", "eye_lid", "eye_squash", "key_pose", "material", "place_chain", "place_on_surface",
           "Refused", "resolve", "review", "ring_around", "skin_rigid", "surface_hit", "tube_along_bones", "turn"]
