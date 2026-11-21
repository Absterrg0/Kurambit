# Characters and creatures: one skin, matched to a reference

**When.** A person, monster or animal made in Blender: the player, an enemy, an NPC, a pet.

## Technique

- Reference first: the person's picture or a front and side sheet drawn for this subject,
  behind the model with `kurambit.ref_planes(front=, side=, height=)`. Render its front and
  side cameras after every big change; proportions before detail.
- Pose: an A-pose (arms 30-45° down, clear of the torso; legs a little apart) or the T-pose
  op `character` stands in, facing -Y, feet on z 0. Every prop is its own object. A four-legged
  animal keeps its legs separate down to the feet: a rig is fitted to the joints, and limbs
  fused together cannot be told apart.
- A human starts from a base body: `game_blender` op `character`, `body` `{studio: {gender}}`
  (Blender Studio's drawn stylised body, ships with the kit), `{mpfb: {...}}` (MPFB2's realistic
  human; the person agrees to the add-on first), a library body, or `{game: path}`, at a
  `height`. To restyle it (a bigger head, shorter legs), edit the static body mesh yourself
  before it is rigged (`recipes/art-rigging.md`).
- From scratch, each region is a `kurambit.sweep`: a centreline through the joints and 4-8
  stations of width, height and superellipse exponent (2 round, 3-4 a rounded box) that blend
  smoothly. 48-96 sides for a hero, 24-32 for a background part. Sink each region a few cm into
  the next, then fuse: `kurambit.one_skin([torso, neck, head, arm_l, arm_r, leg_l, leg_r],
voxel=height/200, smooth=10, target_faces=)`, then Subdivision 1.
- Faces and hands want edge loops: three loops round an eye, the mouth and every finger joint.
  A head from one parametric mesh (an ellipsoid with loops round the mouth and eyes) beats a
  head of spheres.
- Clothes: duplicate the body's faces under the garment, Shrinkwrap 1-3 cm out, Solidify 0.5-2
  cm, so it takes the body's weights. Armour plates, belts and weapons are rigid pieces made with
  `kurambit.hard_surface`, overlapping like real lamellae; hair is a sweep, or cards.
- Surface layers (scales, feathers, fur) are cards scattered along a flow over the skin
  (`kurambit.blender.scatter`), each card one feather or tuft, with size and colour jitter.
- An animal: build it static with its legs apart, then rig it on a template (`fox`, `horse`,
  `dragon`…) or chains (`recipes/art-rigging.md`).
- Materials: skin with subsurface and roughness 0.4-0.6; cloth matte with a weave or noise;
  metal metallic 1 with worn, lighter edges; eyes glossy. Variation everywhere: no part one
  flat colour.

## Pitfalls

- Separate low-sided tubes per limb: a toy robot, however well they are posed.
- A voxel smaller than the detail you need melts it; a voxel too big turns fingers to mitts.
- Smoothing cannot add form the blockout does not have: fix proportions first.
- Clothes modelled as rigid parts tear at the hips and shoulders in a walk.
- A body whose arms touch its sides: their weights blend, and the arms drag the ribs.

## Sources

MODEL-METHODS (2026-11-21): Fable 5.2's pelican (superellipse sweeps on Hermite tables) and
eagle (one subdivision-ready body, cards on a flow field, an orthographic reference camera),
the higgsfield hand (loops at every joint), Patch's facial-shapekeys head; Kurambit's AQ
bake-off (the sculpted cat won).
