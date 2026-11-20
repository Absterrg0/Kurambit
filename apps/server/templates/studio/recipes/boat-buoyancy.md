# Boat buoyancy and wake

**When.** Any hull on water the player steers or watches.

## Numbers

- Jacques Kerner's model: hydrostatic force summed over the submerged hull triangles, each cut
  against the water height (0 to 3 vertices under), plus viscous and pressure drag and
  slamming to damp it. Budget **under 1 ms per boat**. Hydrostatics alone oscillate.
- Hull proxy of **50 to 200 triangles**, separate from the drawn mesh (judgement).
- A simpler game version: **4 to 8 probe points** on the hull, each a damped spring to the
  sea's `height()` (judgement). Pitch and roll lag the swell.
- Kelvin wake half-angle **19.47°** (`asin(1/3)`), whatever the speed.
- The waterline stays within **±10% of hull height** of the surface; pitch and roll settle
  within **3 s** in calm water (judgement).

## Steps

1. Put the waterline at z = 0 in the model; keep the hull proxy closed.
2. Each step, sample `height()` at the probes, push each up by how far it is under, damp by
   its vertical speed, and integrate heave, pitch and roll.
3. Drive with thrust along the hull and a turn that needs speed; damp sideways slip.
4. Draw a wake: a V of foam at 19.47° behind the stern, longer with speed, plus a bow wave.
5. Tune damping until a dropped boat settles in about 3 s.

## Pitfalls

- A height query that differs from the drawn sea (`stylised-sea`).
- Probe spacing large next to the shortest wave: the boat ignores small waves.
- No damping: endless bobbing. Too much: the boat ignores the swell.
- A wake drawn as a static texture that does not follow speed.

## Checks

```yaml
- agent: "waterline within 10% of hull height of height() at 4 points (game_play eval)"
- agent: "pitch and roll settle within 3 s in calm water"
- fact: scene.report.player.heightPx
  label: boat px high
  want: ">= 50"
- fact: perf.drawCalls
  label: draw calls
  want: "<= 300"
```

## Code

None maintained in JS for the hydrostatics. `@dimforge/rapier3d-compat` (Apache-2.0) only if
the game needs rigid bodies anyway.

## Sources

Jacques Kerner, "Water interaction model for boats in video games", parts 1 and 2 (Game
Developer, read). Kelvin wake angle: standard physics, computed.
