# Hard surface: props, vehicles, buildings

**When.** Anything you could measure with a ruler: crates, weapons, armour plates, furniture,
cars, boats, houses, walls, set pieces.

## Technique

- A parts table first: each part's size in metres, read off the reference (orthographic front,
  side and top) or the real thing (door 2.1 x 0.9 m, table 0.75 m, a 1.8 m person beside it).
- Block each part to exact size, put rotation and scale into the mesh, then
  `kurambit.hard_surface(part, cutters=[...], bevel=, segments=2, angle=30)`: boolean cuts,
  bevel by angle, weighted normals. A cutter with a material paints the faces it cuts (glass in
  a window band, a dark groove).
- Bevel width about 1-3% of the part's smallest side; one width across a model reads as one
  object. Segments 2-3 catch light at game distance.
- Hulls, car bodies and fuselages are not flat side profiles pushed across the width: sweep them
  along their length with `kurambit.sweep`, stations giving the section (flare, tumblehome, a
  keel by `dz`), so the plan curves too. Cabins and fittings on top are hard-surface parts.
- Moving parts (a wheel, door, lid, turret, rudder) stay their own objects with
  `kurambit.pivot(part, hub, parent=body)`; everything that never moves apart is joined (one
  draw call a copy).
- Buildings and set pieces: a parametric generator in bpy (walls, openings, courses, roof
  slabs) at the game's own scale; each snapping piece is its own export with its origin where
  the game places it. Openings for a 1.8 m person: doors at least 1 x 2.2 m, stairs 0.18 m rise
  and 0.28 m tread. Surfaces from `kurambit.surface` (a baked tiling PBR set) or a trim sheet,
  mapped in metres with `kurambit.wrap`.
- Rocks: boxes and spheres fused with `kurambit.one_skin`, then Displace with a noise texture;
  trees: the trunk and boughs as sweeps, leaves as cards in clumps.
- Materials: metal metallic 1, roughness 0.2-0.5; paint, wood, stone metallic 0, roughness
  0.5-0.9; glass Transmission Weight 1. Wear: worn edges lighter and rougher, recesses darker;
  `kurambit.bake_down(..., maps=("normal", "ao"))` bakes contact shadow where parts meet.

## Pitfalls

- A cutter flush with a face leaves a skin and flicker: overlap every cutter through.
- A coaxial round cutter at the same phase as its cylinder leaves slivers: turn it half a
  segment.
- A feature under twice the bevel width collapses.
- A 12-sided cylinder's own edges are 30°: an angle limit of 30 bevels every one.
- Surfaces closer than 2 mm flicker in the game: keep them 5 mm apart, 2 cm if seen from far.
- Ten loose parts are ten draw calls for every copy; one unique mesh per wall kills instancing.
- A mirrored variant made by a negative scale turns faces inward: apply the scale, then
  `kurambit.qa`.

## Sources

EL4CTEO's blender-skills (MIT): `apply_stack.py` (boolean, bevel, weighted normal) and its notes
on cutters and bevel collapse; MODEL-METHODS (2026-11-21) on parts tables and swept hulls;
Kurambit's yacht proof (one sweep against a side-profile extrusion).
