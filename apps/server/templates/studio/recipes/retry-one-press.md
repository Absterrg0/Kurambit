# Fail fast, retry in one press

**When.** Every game that can be lost; and its pause.

## Numbers

- From the end screen back to play in **at most 1 press and 3 s** (judgement, after
  Celeste-style instant respawn).
- The end screen holds the result, a stat or two, and Retry (judgement).
- Pause on **Esc** (and P, and the pad's Start): play's clock stops; Resume, Restart, volumes
  and controls (Game Accessibility Guidelines; Steam Deck).
- A first loss is reachable early; a demo errs on the easier side (Mark Brown).

## Steps

1. On `GameState.lose`, show the end screen over the frozen scene with Retry focused.
2. Enter, Space, R, a click on Retry, or the pad's A calls `GameState.play()`: a fresh run.
3. Keep load out of retry: models and sounds are already loaded.
4. Read the shell's `pause` action: `GameState.pause()` on Esc, `resume()` to go on. Release
   pointer lock on pause; never pause by releasing it alone.
5. Keep nothing from the lost run except what `KEEP_ACROSS_RUNS` names.

## Pitfalls

- A retry that reloads the page or replays the intro.
- Retry leaking listeners, intervals or objects (the QA play counts them).
- A pause that keeps the simulation running.
- An ending with no end screen.

## Checks

```yaml
- probe: player.retry.inputs
  label: inputs to retry
  want: "<= 1"
- probe: player.retry.seconds
  label: seconds to retry
  want: "<= 3"
- probe: player.pause
  label: Esc pauses
  want: "== true"
- probe: player.lost
  label: can be lost early
  want: "== true"
```

## Code

`GameState.play()`, `pause()`, `resume()` (TEMPLATE.md item 3).

## Sources

Game Accessibility Guidelines, basic (read). Steam Deck compatibility (read). Mark Brown on
demos (read). Celeste-style respawn (read second-hand).
