# Block out first: a moving scene on the Stage within minutes

**When.** The first turn of every game, before any final model, title or menu.

## Numbers

- Something moving on the Stage within **5 to 6 minutes** of the brief (the owner's bar for
  Kurambit; the Stage shows the game from its first drawn frame and follows every save).
- Boxes at **final scale**: a humanoid 1.8 m, a car 4.5 m, a KayKit wall piece 4 m (three.md
  rule 5). Art later replaces each box one for one at that size (the studies' judgement).
- The first loop needs a goal and a way to fail inside about 2 minutes of play (the studies'
  judgement, after Griesemer's "30 seconds of fun").

## Steps

1. Write `main.js` so it starts a run at once: a ground, the player as a box or capsule at its
   real height, the camera the game will ship with, light, and one thing that moves by itself
   (the sea, a patrol, a spinning pickup). Save. The Stage now moves.
2. Wire the real controls through `ctx.input` and play the box. Fix speed and camera here,
   with boxes, where a change costs a line.
3. Add the loop: the goal, the threat, `GameState.win` and `GameState.lose`.
4. Name what a person would tune and select (`ctx.thing`, `ctx.tune`).
5. Now replace boxes with models, one at a time, each at the box's size, saving after each so
   the Stage never stops. Start Blender models early and keep the box until they
   arrive.
6. Title, HUD and end screen come last, over the live game (`opens-on-the-game`).

## Pitfalls

- A title card, a menu or a model as the first thing built: the Stage shows nothing for many
  minutes.
- Waiting on a Blender model before anything moves.
- Rewriting the scene from scratch late: grow it in place, so every save still boots.
- Guessing a scale per model: size each one to the box it replaces.
- Dressing a level before walking it with the real controller and camera.

## Checks

```yaml
- probe: stageMinutes
  label: minutes to the Stage moving
  want: "<= 6"
- probe: player.moves
  label: opening frame moves
  want: "== true"
- probe: player.lost
  label: can be lost early
  want: "== true"
- agent: "each model replaces its box at the box's size"
```

## Code

None: the runtime's `start`, `update`, `ctx.thing` and `ctx.tune` (TEMPLATE.md).

## Sources

Kurambit's plan (2026-11-20 owner's decision: 5-6 minutes to a moving Stage). Grey-box first:
"Level design for combat" (Game Developer) and GMTK on Spelunky's critical path, both read
second-hand in DESIGN-RECIPES §3.1. Griesemer, "30 seconds of fun" (read second-hand).
