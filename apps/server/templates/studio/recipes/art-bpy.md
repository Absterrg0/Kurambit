# Blender code that runs the first time, on Blender 5.x

**When.** Any `game_blender` op `code`: before a chat's first Blender call, and whenever one fails
on a name, a context or a missing attribute.

## Numbers

- Kurambit runs Blender 5.x (5.3 by default; `bpy.app.version` says which). What older
  tutorials and memory get wrong:
  - a new material and world already have their nodes (`use_nodes` is deprecated): find the
    Principled node by type;
  - Boolean solvers are `EXACT`, `FLOAT` (was `FAST`) and `MANIFOLD`;
  - actions are layered: `action.fcurves` is gone. Key with `obj.keyframe_insert(...)`,
    `pose_bone.keyframe_insert(...)`, or op `animate`;
  - no `use_auto_smooth` (since 4.1): `me.shade_smooth()`, `me.set_sharp_from_angle(angle=)`,
    `me.shade_flat()`;
  - bones select through `pose_bone.select`, not `bone.select`: edit data and select nothing;
  - a node group's input on a modifier is `getattr(mod.properties.inputs, sock.identifier).value`
    (5.2), not `mod["Socket_2"]`;
  - EEVEE is `BLENDER_EEVEE`; `blend_method` is `surface_render_method` (`BLENDED` for glass);
  - the compositor is `scene.compositing_node_group`, not `scene.node_tree`; a mix node's
    sockets share names (`A`, `B`): index them.
- Principled inputs: `Emission Color`, `Specular IOR Level`, `Transmission Weight`, `Coat Weight`,
  `Subsurface Weight`. They ship in the GLB with UVs, image textures and normal maps unless a
  palette is locked; procedural nodes never do: bake them to textures.
- Sculpt Mode operators crash in background Blender: shape with modifiers (Remesh, Smooth,
  Displace, Shrinkwrap), bmesh or numpy.
- A review renders for tens of seconds; printing numbers in the same code call costs nothing.

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
   `kurambit.qa([...])`. Look when the shape or colour changed, not to find out whether code ran.

## Pitfalls

- `bpy.ops.object.mode_set`, select-then-operate chains and `bpy.context.active_object` depend
  on what an earlier call left selected and active: use data, or an override.
- A mesh used by several objects: `o.data.transform(...)` moves every copy; `o.data = o.data.copy()`
  first.
- Applying a modifier on a mesh with shape keys fails.
- A join keeps only the active object's modifiers.
- Geometry Nodes output loses smooth shading and UVs unless the tree sets them.
- Printing whole objects or long lists floods the result: print rounded numbers.

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
`blender-animation` notes; Kurambit's kit (`helpers.use_nodes`, the export pass); Blender's
5.0-5.3 Python API release notes.
