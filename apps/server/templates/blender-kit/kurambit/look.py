"""The game's look, read from STYLE.json in the game root (the live scene's working directory): what
every made thing is built from, so the world helpers, surfaces and plain materials come out as one
family. game_assets op lock writes it; the game's code reads the same lock (shell/model.js).

  look.read()            {"palette", "roles", "finish", "facets", "voxel", "bevel", "chunky", "detail", "surfaces"}
  look.colour("wall")    a role's "#rrggbb" (a hex passes through)

roles: a colour per role, the lock's over ROLES. finish: "flat" (plain colours), "painted" (soft
hand-painted surfaces) or "real" (full grain and relief); flat under a hex palette, real without.
facets: flat faces and hard edges (shape.edges "faceted", the default under a hex palette, or
"voxel": facets, no bevel, and voxel is True). bevel:
metres an edge is rounded by. chunky: 0 true to life, 1 thick trunks, big crowns and roofs. detail:
0 bare forms, 1 every beam, sill and tuft. surfaces: the made surface each role wears where the
finish is not flat, the lock's over SURFACES. character: a character's height in metres, which a
doorway is cut to fit."""
import json

# Each role's own colour when the lock names none: packages/contracts GAME_STYLE_ROLES holds the same.
ROLES = {"bark": "#6b4a32", "leaf": "#4f8a3c", "leaf2": "#6fa84a", "stone": "#8a8780", "stone2": "#6f6c66", "moss": "#5f7a3a",
         "grass": "#6a9a48", "grass2": "#8aae52", "soil": "#7a5c3c", "path": "#b89a6a", "sand": "#d8c690", "water": "#4a86a8",
         "wall": "#d9cdb4", "roof": "#a2523a", "trim": "#5a4030", "floor": "#9a7650", "door": "#6a4a2e", "glass": "#9fc4d6", "metal": "#8a8f96", "cloth": "#b5483a"}
# The surface each role wears when the finish is not flat and the lock names none.
SURFACES = {"wall": {"kind": "painted", "metres": 3.0, "wear": 0.3}, "roof": {"kind": "painted", "pattern": "tiles", "metres": 1.6, "wear": 0.35},
            "floor": {"kind": "wood", "pattern": "planks", "metres": 2.0}, "door": {"kind": "wood", "pattern": "boards", "metres": 1.0, "wear": 0.4},
            "trim": {"kind": "wood", "metres": 1.2, "wear": 0.4}, "bark": {"kind": "bark", "metres": 1.5},
            "stone": {"kind": "stone", "metres": 2.5, "wear": 0.4}, "stone2": {"kind": "stone", "metres": 2.5, "wear": 0.4}, "path": {"kind": "ground", "metres": 2.0}}


def read():
    try:
        with open("STYLE.json", encoding="utf8") as f:
            style = json.load(f)
    except (OSError, ValueError):
        style = {}
    palette = style.get("palette") if isinstance(style.get("palette"), list) and style.get("palette") else None
    shape = style.get("shape") or {}
    return {"palette": palette, "roles": {**ROLES, **(style.get("roles") or {})}, "locked": set(style.get("roles") or {}),
            "finish": style.get("finish") or ("flat" if palette else "real"),
            "facets": (shape.get("edges") or ("faceted" if palette else "soft")) in ("faceted", "voxel"),
            "voxel": shape.get("edges") == "voxel",
            "bevel": 0 if shape.get("edges") == "voxel" else shape.get("bevel", 0.025), "chunky": shape.get("chunky", 0.3 if palette else 0.0), "detail": shape.get("detail", 0.6),
            "surfaces": {**SURFACES, **(style.get("surfaces") or {})}, "budget": style.get("budget") or {},
            "character": (style.get("scale") or {}).get("character") or 1.8}


def colour(role, lk=None):
    """A role's colour as "#rrggbb"; a hex passes through. A role the lock does not name takes the
    hex palette's nearest colour to its own, as the style pass will snap it."""
    if role.startswith("#"):
        return role
    lk = lk or read()
    if role not in lk["roles"]:
        raise ValueError(f"no role {role!r}: the roles are {', '.join(lk['roles'])}, or pass \"#rrggbb\"")
    h = lk["roles"][role]
    if lk["palette"] and role not in lk["locked"]:
        from .stylepass import _hex, _lab  # nearest as the style pass snaps: in Lab

        want = _lab(_hex(h))
        h = min(lk["palette"], key=lambda p: sum((a - b) ** 2 for a, b in zip(_lab(_hex(p)), want)))
    return h
