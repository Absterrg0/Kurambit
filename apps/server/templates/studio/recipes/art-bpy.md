# Blender code that runs the first time, on 4.5 and 5.x

**When.** Any `game_blender` op `code`: before a chat's first Blender call, and whenever one fails
on a name, a context or a missing attribute.

## Numbers

- The person's Blender is 4.5 LTS or 5.x; `bpy.app.version` says which. Write for both:
  - a new material has no nodes on 4.5 until `use_nodes`, and has them on 5.x: use
    `kurambit.material(...)`, or `if m.node_tree is None: m.use_nodes = True`;
  - Boolean solvers are `FAST`, `EXACT`, `MANIFOLD` on 4.5 and `FLOAT`, `EXACT`, `MANIFOLD` on
    5.x: use `EXACT` or `MANIFOLD`;
  - `action.fcurves` works on 4.5 and is gone on 5.x: key with `obj.keyframe_insert(...)`,
    `pose_bone.keyframe_insert(...)`, or op `animate`;
  - `use_auto_smooth` is gone on both (since 4.1): `me.shade_smooth()`,
    `me.set_sharp_from_angle(angle=)`, `me.shade_flat()`;
  - bones select through `bone.select` on 4.5 and `pose_bone.select` on 5.x: edit data and
    select nothing;
  - a node group's input on a modifier is `mod["Socket_2"]` before 5.2 and
    `getattr(mod.properties.inputs, "Socket_2").value` from 5.2: branch on `bpy.app.version`;
  - EEVEE is `BLENDER_EEVEE_NEXT` on 4.5 and `BLENDER_EEVEE` on 5.x: render only through ops
    `look` and `sprites`.
- Principled inputs carry their 4.0 names on both: `Emission Color`, `Specular IOR Level`,
  `Transmission Weight`, `Coat Weight`, `Subsurface Weight`.
- A review costs about 40 s; printing numbers in the same code call costs nothing.

## Steps

1. Data, not operators: `bpy.data`, `bmesh`, `obj.modifiers.new`, `foreach_get`/`foreach_set`
   with numpy need no selection, mode or view. An operator you cannot avoid runs inside
   `bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o])`;
   check it returned `{'FINISHED'}`.
2. Name what you make when you make it, and look it up again by name (`bpy.data.objects[name]`)
   after anything that frees data: applying or removing a modifier, a join, removing an object.
   Never trust a default name such as `Cube.001`.
3. Read and write meshes in object mode; in edit mode `obj.data` is stale (use
   `bmesh.from_edit_mesh` there).
4. Measure what ships: `ev = o.evaluated_get(bpy.context.evaluated_depsgraph_get())`,
   `me = ev.to_mesh()`, then `ev.to_mesh_clear()`. Call `bpy.context.view_layer.update()` before
   reading `matrix_world` after a move.
5. Leave modifiers live: the export applies all but Armature. Put rotation and scale into the
   mesh before bevel or solidify (Code).
6. Find nodes by `type` (`"BSDF_PRINCIPLED"`), never by name; read an enum's values instead of
   guessing: `[i.identifier for i in T.bl_rna.properties["x"].enum_items]`.
7. End each building call with the numbers it changed: `o.dimensions`, triangles,
   `kurambit.qa([...])`. Review when the shape or colour changed, not to find out whether code ran.

## Pitfalls

- `bpy.ops.object.mode_set`, select-then-operate chains and `bpy.context.active_object` depend
  on what an earlier call left selected and active: use data, or an override.
- A mesh used by several objects: `o.data.transform(...)` moves every copy; `o.data = o.data.copy()`
  first.
- Applying a modifier on a mesh with shape keys fails.
- A join keeps only the active object's modifiers.
- Geometry Nodes output loses smooth shading and UVs unless the tree sets them.
- Printing whole objects or long lists floods the result: print rounded numbers.

## Checks

```yaml
- agent: "every building call prints what it changed (dimensions, triangles, kurambit.qa problems)"
- agent: "no call failed on a name the table lists"
```

## Code

```python
import bpy
from mathutils import Matrix
o = bpy.data.objects["Crate"]
if o.data.users > 1:
    o.data = o.data.copy()
loc, rot, scale = o.matrix_basis.decompose()        # rotation and scale into the mesh, no operator
o.data.transform(Matrix.LocRotScale(None, rot, scale))
o.matrix_basis = Matrix.Translation(loc)
print([round(d, 3) for d in o.dimensions], kurambit.qa([o])["problems"])
```

## Sources

EL4CTEO's blender-skills (MIT): `blender-core` and its 5.x migration table and bpy patterns
(verified there on 5.2-5.3), `blender-geometry-nodes`, `blender-character-rigging` and
`blender-animation` notes; Kurambit's kit (`helpers.use_nodes`, the export pass). The 4.5
columns from Blender's 4.1-5.0 release notes.
