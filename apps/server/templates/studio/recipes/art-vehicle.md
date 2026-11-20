# Vehicle or boat: profile extrusion

**When.** Cars, carts, trucks, boats, trains: anything rigid with wheels, a hull, a rudder.

## Numbers

- Car about **1,250-1,500** triangles (KayKit cars 1,222-1,256); role `vehicle`, budget 1,500.
  A small boat about the same; a yacht 3-7k (name it `building` then, or raise the lock's budget).
- Wheels 12 sides with a 1-segment bevel, about 90 triangles each.
- Bevel about 5% of the height, 2 segments, angle limit 40°; smooth by angle at 35°.
- Arch notch radius = wheel radius + 5 cm.
- A boat's waterline is z 0; its buoyancy hull a closed proxy of 50-200 triangles.

## Steps

1. Draw the side profile as (y, z) points, front at -Y, with the wheel-arch notches as 6-segment
   half circles (a boat: the sheer line, the bow rake, the keel). Make it a face and extrude it
   across the width:
   ```python
   bm = bmesh.new()
   f = bm.faces.new([bm.verts.new((-w / 2, y, z)) for y, z in profile])
   new = bmesh.ops.extrude_face_region(bm, geom=[f])["geom"]
   bmesh.ops.translate(bm, vec=(w, 0, 0), verts=[g for g in new if isinstance(g, bmesh.types.BMVert)])
   bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
   ```
   Then a Bevel modifier (width, 2
   segments, `limit_method="ANGLE"`) and apply it.
   A hull narrows to the bow: scale the front rings in x after extruding, or loft the hull with
   `kurambit.loft` stations from stern to bow (squircle 2.6 for a chined hull).
2. Cabin profile in a glass colour, inset 8 cm from the body sides; roof slab and pillars in the
   body colour. A boat: cabin block, windows as a darker band, rails as one slab.
3. Lamps, bumpers, handles, grille, plate as bevelled primitives: detail where the camera looks.
4. Join the body into one object. Wheels (or a propeller, a rudder) are their own objects:
   `kurambit.pivot(wheel, hub, parent=body)` puts the origin at the hub.
5. `body["kurambit_role"] = "vehicle"`; review against a pack vehicle (silhouette recipe).
6. A boat for the sea: a separate closed hull proxy (a box or loft of 50-200 triangles at the
   waterline) exported as its own object for buoyancy.

## Pitfalls

- Wheels not centred in their arches.
- Smoothing without an angle limit melts the panels.
- Rails and masts under 3 px at game distance vanish: make them slabs.
- A pivot not at the hub: the wheel wobbles.

## Checks

```yaml
- triangles <= 1500 # H style.roleBudget (vehicle)
- floating == [] # H contact
- each wheel its own object, origin at the hub # A scene
- overlap with a pack vehicle >= 0.7 same height # H review
```

## Code

Plain `bpy` and `bmesh`; `kurambit.pivot`, `kurambit.loft`.

## Sources

KayKit City Builder `car_taxi` and `car_sedan` (body and wheel split, triangles measured);
Kurambit's asset study 2026-11-20 (car: 1,452 triangles, overlap 0.75-0.80 with the taxi); RECIPES
A9 on hull proxies (Kerner, read).
