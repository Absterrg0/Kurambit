# Rigging a model

**When.** A model that moves. Build it static, then rig it with `game_blender` op `character`:
one call makes the skeleton, weights and clips. Don't weight by hand.

## Technique

- Build it to be rigged: standing on z 0, facing -Y. A person in an A-pose or T-pose, arms
  clear of the torso, hands clear of the thighs; a four-legged animal with four separate feet on
  the ground.
- Props (a sword, shield, armour plate) are separate objects: list each in `rigid` with the
  bone that carries it, `{"Sword": "hand_r"}`; it never bends. Clothes, hair and capes go in
  `objects` and are weighted with the body.
- `rig` is the template whose layout matches: `human` (234 clips: Idle_A, Walk, Jog, Sprint,
  Sword_Attack, Punch_Cross, Jump_2, Death_A…), `fox` (four legs, a tail), `horse` (long legs),
  `kaiju` (a biped with a heavy tail), `dragon` (four legs, wings), `bird`, `spider`, `snake`,
  `fish`. Name clips in `clips`; none named gives an idle, a move and an attack.
- A human you don't model yourself: `body` (`mpfb`, `studio`, `library` or `game`) builds a
  body rigged as `human` with any `objects` and `rigid`. To reshape it (a big head, long legs),
  edit `<name>_body` in `code`, then rig it with `rig: "human"`, the same `name` and `objects`.
- Joints: the fit finds a person's or four-legged animal's joints from the shape; other
  templates only map a box, so pass `joints`, `{"hand_r": [x, y, z]}`. Joints between named ones
  follow. Human short names: `shoulder_l`, `elbow_l`, `wrist_l`,
  `hip_l`, `knee_l`, `ankle_l`, `chest`, `neck`. Big-headed or chibi people: always pass
  shoulders and wrists.
- No template fits (an insect, octopus, robot): `rig: "chains"` and `chains`,
  parents before children, the body first:

```
[{"name": "body", "kind": "spine", "part": ["Thorax"], "points": [[0,0.7,0.36],[0,-0.48,0.36]]},
 {"name": "leg1_l", "kind": "leg", "parent": "body", "part": "Leg1_l",
  "points": [[0.2,-0.4,0.32],[0.55,-0.56,0.58],[0.85,-0.77,0.18],[0.98,-0.85,0]]}]
```

`kind` picks the motion (`spine`, `neck`, `tail`, `tentacle`, `leg`, `arm`, `wing`, `fin`,
`jaw`, `antenna`, `rigid`); `points` are the joints root first (hip, knee, ankle, toe);
`part` lists the objects the chain moves, each weighted only from its own chain; `rigid: true`
puts each part on one bone (machines); unlisted parts ride their nearest bone. You get Idle, a
move (Walk with planted feet, Fly, Slither or Crawl) and Attack.

- Each clip reports facts: notes, never refusals. Look at each clip's extreme frame, front and
  side, with op `look`; fix what you see and rig again with the
  same `name`.

## Pitfalls

- `stretch ×N` (part, bone): up to about ×3 is normal at a bent knee, curled fingers ×3-5. Higher
  on a limb tears or folds the skin: the joint is misplaced (pass it in `joints` or `points`),
  or the joint needs edge loops. On a cape or long skirt hanging past the legs, a stride pulls
  it apart: ride it on one bone in `rigid` (`spine_03`, `pelvis`).
- `no weight and stay put`: that part can't follow; look at it, then rejoin or rebuild it.
- Without `points` a chain's joints are spaced evenly and the knee bends in the wrong place.
- `planted feet move X m/s`: for Walk or Run, move the body at that speed in the game so the feet
  don't slide; for Idle it should be about 0.
- `goes N m under the floor`: shorten the part, turn the prop, or choose another clip.
- `A and B come N m apart`: two chains pass through each other; spread them or pick another clip.

## Sources

Mesh2Motion's CC0 rigs and clips; Blender's automatic weights.
