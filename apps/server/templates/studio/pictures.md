# Pictures: cards, tiles, tokens, icons, UI art

Flat art a game needs many of, sharing one frame (fifty-two cards, a board's
tiles, a set of icons), is drawn as HTML and CSS or SVG and rendered by
`game_assets` op `pictures`:

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

- **The template** is one page (inline, or a `.html` or `.svg` file in the
  game). `{{rank}}` is the row's value, escaped; `window.row` is the whole
  row for a script. The page is the picture: `size` pixels, its background
  clear, so round corners stay round.
- **Nothing comes from the network.** Images, fonts and styles load by paths
  inside the game, relative to the template. Text needs a font the game
  ships, loaded with `@font-face` (a library font pack, `game_assets` op
  `search` "font"); a computer's own fonts are refused.
- **Art on a card**: render it from the game's models with `game_blender` op
  `sprites` (`studio-skills/art-pipeline.md`, 2D sprites from 3D), or take a
  generated image on the `generated` route, and put it in the template with
  `<img src>`.
- **The answer** is a contact sheet of every picture: look at all of them
  before using them. The pictures are laid in sheets no larger than
  STYLE.json's `budget.texture` (raise it for a big deck: fewer sheets, fewer
  draws) with `<output>.sheet.json` beside them, and ASSETS.md gets their line.

## In the game

```js
export const ASSETS = { cards: "assets/sheets/cards.sheet.json" };
const cards = ctx.assets.sheet("cards");
const card = cards.plane("A_spades", { width: 0.63, back: "back" }); // a lit card, its back behind it
cards.sprite("coin", { width: 0.4 }); // faces the camera
cards.texture("heart"); // one picture, for a material or the HUD
```

A card flips by turning it (`rotation.y`), deals by moving it: they are plain
meshes. The back is a row of the same sheet.

**How big to render.** A picture is sharp when it has at least as many pixels
as it covers on screen at the closest the camera brings it:
`pixels = width_m / (2 * distance_m * tan(fov / 2)) * screen_height_px`. A
0.63 m card seen from 1.2 m with a 45° camera on a 1080-pixel screen covers
about 680 pixels, so render it about 700 wide. A pixel or voxel lock draws
the sheet's texels square; render at the art's own pixel size there.

## Animations: effects and 2D characters

`frames` (with `fps`, `loop`) draws each row as an animation: frame `i` is
drawn at `i / fps` seconds, with every CSS and SVG animation on the page set
to that moment and `window.frame(seconds, i)` called if the template defines
it, so a canvas or SVG can be drawn in code. Draw from a seeded random, so
the same call gives the same frames.

- **Effects** (smoke, a burst, a magic ring): a canvas drawing many soft
  particles, sparks or glowing lines over time reads as drawn, not as a few
  circles. Play them with
  `ctx.assets.sheet("fx").play("burst", { width: 3, blending: "additive", once: true })`
  (light: additive; smoke and dust: the default blending); `sprite: true`
  faces the camera; `object.flipbook.restart()` plays it again.
- **A character drawn in 2D** is cut out: rigid SVG parts (a body, arms,
  legs, a head) turned about their joints in `window.frame`, one row per
  clip (`walk`, `idle`) and `pivot` at its feet. Its shape holds in every
  frame because the parts do not change; a character redrawn frame by frame
  does not hold its shape, so draw it that way, or render a model with
  `game_blender` op `sprites`, which writes the same kind of sheet.

Every strip and sheet, made here or by op `sprites`, is a `.sheet.json` the
game plays with `ctx.assets.sheet`.
