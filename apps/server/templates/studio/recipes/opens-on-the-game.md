# Opens on the game

**When.** Every game with a title, a menu or a start screen; and every game's first frame.

## Numbers

- **At most 1 input and 10 s** from opening the page to play. Poki: "players tend to move to
  another game if loading takes more than 10 seconds"; "skip splash screens, title screens,
  and level selects".
- CrazyGames: under 100 ms reads as instant, 1 s feels fine, at 10 s attention wanders. Aim
  for the first drawn frame within **1 s** (the studies' judgement).
- A title covers **at most 30%** of the first frame; the scene shows on at least 70%; no text
  over the subject (the yacht, the duellists). These are the studies' judgement, from bench 3,
  where a title card over the yacht lost every page shot.
- Title text at most **a third of the screen high**, at the top or bottom edge; the camera
  moves from the title framing to play over **0.5 to 1.5 s** instead of cutting (judgement).
- No block of more than **30 words** before 10 s of play (Poki: "walls of text intimidate").

## Steps

1. The first frame is the scene in motion: the real level, the player idle, a slow camera move.
2. `GameState.title()` in `start` holds the run on that live scene; the title is a transparent
   DOM overlay at an edge, never a full-screen card.
3. Enter, Space, a click or a pad button calls `GameState.play()`; ease the camera to play.
4. Teach the first verb in play with one short prompt near the player that fades after use;
   never a list of every control up front.
5. During load, show the scene or a progress bar, never a blank page.

## Pitfalls

- An opaque card or a separate title scene that differs from the game.
- A menu tree before play (GAG: "allow the game to be started without the need to navigate
  through multiple levels of menus").
- A start that needs the mouse only, or a key the title never names.
- Sound before the first gesture: the browser blocks it; the runtime unlocks audio on the
  first key or click.

## Checks

```yaml
- probe: player.open.inputs
  label: inputs to play
  want: "<= 1"
- probe: player.open.seconds
  label: seconds to play
  want: "<= 10"
- probe: player.cover
  label: first frame covered
  want: "<= 0.3"
- probe: player.load.frame
  label: seconds to first frame
  want: "<= 1"
- probe: player.textWall
  label: longest text block before 10 s
  want: "<= 30"
```

## Code

None: `GameState.title()` and `GameState.play()` (TEMPLATE.md item 3).

## Sources

Poki, "Easy access & onboarding" and "New requirements" (read). CrazyGames, "Getting to the
first frame" (read). Game Accessibility Guidelines, basic (read). Bench 3's judge on the yacht's
title card (Kurambit's loop report).
