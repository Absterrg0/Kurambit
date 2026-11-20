# Pictures: cards, tiles, icons, UI art, effects and 2D characters

**When.** Flat art a game needs many of in one frame (52 cards, a board's tiles, icons), 2D
effects, or a character drawn in 2D.

## Numbers

- A picture is sharp when it has at least as many pixels as it covers on screen at the
  closest the camera brings it: `pixels = width_m / (2 × distance_m × tan(fov / 2)) ×
screen_height_px`. A 0.63 m card seen from 1.2 m with a 45° camera on a 1080 px screen
  covers about 680 px: render it about 700 wide.
- Sheets no larger than STYLE.json's `budget.texture` (raise it for a big deck: fewer sheets,
  fewer draws).
- Pixel art: one base resolution (320×180 or 384×216), integer scale, nearest filtering,
  rotation by 90° only (SpriteCook). A pixel or voxel lock draws texels square.

## Steps

1. Draw the frame once as HTML and CSS or SVG; render the set with `game_assets` op `pictures`:
   ```json
   {
     "pictures": {
       "output": "cards",
       "template": "art/templates/card.html",
       "rows": [{ "name": "A_spades", "rank": "A", "ink": "#22222c" }],
       "size": [256, 358]
     }
   }
   ```
   `{{rank}}` is the row's value, escaped; `window.row` is the whole row. The page is the
   picture: `size` pixels, background clear.
2. Nothing from the network: images, fonts and styles load from paths in the game; text needs
   a font the game ships via `@font-face` (`game_assets` op `search` "font").
3. Art on a card: `game_blender` op `sprites` from the game's models, or a generated image,
   placed with `<img src>`.
4. Look at the contact sheet the answer returns, every picture, before using them.
5. In the game:
   ```js
   export const ASSETS = { cards: "assets/sheets/cards.sheet.json" };
   const cards = ctx.assets.sheet("cards");
   const card = cards.plane("A_spades", { width: 0.63, back: "back" });
   cards.sprite("coin", { width: 0.4 }); // faces the camera
   cards.texture("heart"); // one picture, for a material or the HUD
   ```
   A card flips by turning it and deals by moving it. The back is a row of the same sheet.
6. Animations: `frames` (with `fps`, `loop`) draws row `i` at `i / fps` s, CSS and SVG
   animations set to that moment and `window.frame(seconds, i)` called. Draw from a seeded
   random. Play an effect with `sheet.play("burst", { width: 3, blending: "additive", once:
true })`; `object.flipbook.restart()` plays it again.

## Pitfalls

- Smoke drawn as soft round gradients reads as blur: draw billows of round lobes, lit on top,
  soft only at the rim; a burst is many sparks or lines over time.
- A 2D character redrawn frame by frame loses its shape: cut it into rigid SVG parts turned
  about joints in `window.frame`, one row per clip, `pivot` at its feet; or render a model with
  op `sprites`.
- Fonts from the computer: refused.

## Checks

```yaml
- agent: "every picture in the contact sheet read before use"
- fact: perf.drawCalls
  label: draw calls
  want: "<= 300"
- probe: player.text1080
  label: smallest text at 1080p px
  want: ">= 18"
```

## Code

`game_assets` op `pictures`, `game_blender` op `sprites`, `ctx.assets.sheet` (the runtime's
`sheets.js`).

## Sources

Kurambit's pictures and sheets contract. SpriteCook, pixel-perfect settings (read; numbers
cited).
