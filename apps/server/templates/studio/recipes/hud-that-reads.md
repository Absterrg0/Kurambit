# A HUD that reads

**When.** Any text, bar or icon over the game: HUD, prompts, menus, end screens.

## Numbers

- Xbox Accessibility Guideline 101: minimum default text height (ascender to descender)
  **18 px at 1080p on PC**, 26 px for console; text scalable to 200%; letter spacing at least
  0.12× and word spacing 0.16× the font size for blocks over two lines.
- Steam Deck: the smallest character **never under 9 px at 1280×800**; aim for 12 px. Glyphs
  match the device in use.
- Contrast against what is behind at least **4.5:1** (WCAG AA; the studies' judgement for
  games).
- Subtitles at most 38 characters per line (IGDA, read second-hand).
- Health: the bar drops at once and a lighter "ghost" chunk drains after **0.3 to 0.6 s**;
  under 25% health, pulse it (judgement).
- No block over **30 words** before 10 s of play.

## Steps

1. Lay the HUD out from the edges in CSS (percentages and `clamp()` sizes), never for one
   window shape.
2. Size text at least 18 px at 1080p; scale with the window's height.
3. Back text over the 3D scene with an outline, shadow or panel.
4. Use the reference's own instruments when the brief has a picture (a yacht's speed,
   heading and camera bar).
5. A pause screen on Esc: Resume, Restart, volumes, controls.

## Pitfalls

- Text over bright sky with no backing.
- A HUD laid out for 16:9 only (off screen on a phone or 4:3).
- State shown by colour alone.
- Keyboard glyphs while a pad is in use.
- Text drawn into the canvas: the harness cannot measure it.

## Checks

```yaml
- probe: player.text1080
  label: smallest text at 1080p px
  want: ">= 18"
- probe: player.text800
  label: smallest text at 1280x800 px
  want: ">= 9"
- probe: player.textWall.words
  label: longest text block before 10 s
  want: "<= 30"
- probe: player.pause
  label: Esc pauses
  want: "== true"
```

## Code

DOM text. `troika-three-text` (MIT) for text in the world.

## Sources

Microsoft Xbox Accessibility Guideline 101 (read). Steam Deck compatibility review (read).
Game Accessibility Guidelines, basic (read). IGDA subtitle guidance (read second-hand).
