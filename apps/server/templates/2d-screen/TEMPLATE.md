# {{GAME_NAME}} — 2D Screen starter template

This game started from the **2D Screen** template: a fixed-screen dialogue and
management game in Godot 4.7 (Compatibility renderer, GDScript only) that runs in
the editor, on Linux and in the single-threaded Web export. It is a real game —
title screen, five callers, trust and cold-reply rules, a hold-to-listen action,
pause, restart, win and loss screens, pointer and keyboard parity, and a safe
anchored layout. Every system below is a reference implementation: reuse what fits
the design, adapt or cut the rest.

Play it with `game_preview` / `game_run_native`, test it with
`game_godot_test { script: "tests/smoke_test.gd" }`.

## What the starter is

You are on a night help desk. Five callers come through; each has one line, an
optional detail and three replies. Warm replies raise trust, steady replies hold
it, and cold replies lower it. The shift is won by finishing all five calls with
trust at three or more. Three cold replies, or ending the shift below three
trust, loses it. The shipped story is a placeholder for your brief: the screen,
input handling and run rules are the reusable part.

```
MENU → PLAYING → (PAUSED) → WON | LOST
```

`GameState` owns that lifecycle and every run value. `ShiftScreen` owns the
current call and the presentation. `CallBook` owns the five story entries.

## The 60-second tour

```
godot/
  project.godot              autoloads, InputMap, 960x540 design frame, window-pixel layout
  default_bus_layout.tres    Master / Music / SFX buses
  ui/theme.tres              buttons, panels, labels and the listen meter
  scenes/
    main_menu.tscn           title, Start the shift, Quit (hidden on Web)
    game.tscn                the desk: status bar, caller, choices, reply, pause, end screen
    ui/pause_menu.tscn       Resume / Restart shift / Main menu
    ui/end_screen.tscn       Shift held or Shift over, stats and the two ways out
  scripts/
    game_state.gd            run rules and the values StudioProbe reads
    game_screen.gd           the screen controller, input and reply flow
    call_book.gd             the five calls, their details and replies
    ui/main_menu.gd, ui/pause_menu.gd, ui/end_screen.gd
    audio.gd                 synthesised UI sounds and music; no .wav files
    studio_probe.gd          the web playtest probe and visibility bridge
  tests/
    smoke_test.gd            entry point,  smoke_harness.gd  the real checks
    scenarios/full-run.json  five warm calls, normal input
    scenarios/lose-run.json  three cold calls, normal input
```

## Controls

The project defines these actions in `project.godot`:

- `choose_1`, `choose_2`, `choose_3` — keys `1`, `2`, `3`; the same choice
  buttons are real Godot `Button`s, so a pointer click runs the same handler.
- `listen` — hold `L` for 0.7 s to hear the current caller out. The on-screen
  **Hear them out** button calls the same reveal immediately, so pointer users
  are not locked out of the mechanic. That timing and the instant-pointer
  alternative are this starter's tuning, not a universal rule: adapt them to the
  design and keep pointer/keyboard parity for whatever remains.
- `pause` — `Escape` or gamepad Start; the Pause button does the same.
- `restart` — `R` or gamepad Back while playing or paused.

Every menu, pause and end-screen control is a real focusable `Button`. `Enter`
activates the focused button, arrows/Tab move focus, and the pointer clicks it.
The title screen focuses **Start the shift** on entry; each call focuses the first
choice; a reply focuses **Next caller**; a result focuses **Work another shift**.
There is no mouse-only or keyboard-only path through the game.

## GameState

`scripts/game_state.gd` is autoloaded as `GameState`. It is the single source of
truth, so a restart reloads the scene and calls `start_run()`; the screen keeps
no duplicate counters.

Signals: `state_changed(state)`, `run_started(call_total)`,
`call_started(index, call_total)`, `answered(index, trust_delta, cold_delta)`,
`listened_changed(listened)`, `run_won(trust, cold, listened)`,
`run_lost(reason, trust, cold)`.

Methods: `start_run(count)`, `answer(trust_delta, cold_delta)`, `mark_listened()`,
`finish_call()`, `pause_game()`, `resume_game()`, `to_menu()`, `is_playing()`,
`is_finished()`.

Public values: `state` (`0 MENU`, `1 PLAYING`, `2 PAUSED`, `3 WON`, `4 LOST`),
`call_index`, `call_count`, `calls`, `choices`, `trust`, `cold`, `listened`,
`won`, `loss_reason`. Constants: `CALL_COUNT`, `START_TRUST` (2), `WIN_TRUST`
(3), `MAX_COLD` (3).

A restart resets the run in `start_run()`; it must not mutate a screen's private
copy. Add a new run value here as a public variable and the probe will report it.

## The screen and its safe layout

`scenes/game.tscn` is one `Control` tree:

- `Safe` is a full-rect `MarginContainer` with the screen's safe margin. All
  visible content sits inside it, so nothing hugs the window edge.
- `Layout` is a `VBoxContainer`: a wrapping `HFlowContainer` status bar, a
  `ScrollContainer` for the caller and choices, and a pinned footer hint.
- The caller panel and choice panel are ordinary `PanelContainer`s with
  `VBoxContainer`s inside. Long caller lines and details use
  `autowrap_mode = 3`. Choice buttons have a real minimum height, and the scroll
  container can scroll the middle if a narrow window or a long translation needs
  the room. The status bar and footer stay put.
- `project.godot` disables stretch so containers reflow in window pixels. A 480px
  window keeps the theme's text sizes and button heights instead of shrinking
  a 960px canvas to half size. The app's stage can still letterbox the game.

If you add a panel, keep it inside `Content` below the pinned footer, and give
labels `autowrap_mode = 3` and `size_flags_horizontal = 3`. If you add a button,
give it a height of at least 44 px and a focus style; the theme supplies the
focus ring. Do not switch the root to fixed offsets for a single window size.
Colors, buttons, panels and the listen meter come from `ui/theme.tres`; edit the
theme for a global restyle instead of hard-coding colours on every node.

## Adding or changing calls

`scripts/call_book.gd` is a plain constant array of dictionaries named `CALLS`. Each entry
has `caller`, `role`, `line`, `detail` and three choices. Each choice has `text`,
`tone`, `trust` (`+1`, `0` or `-1`), `cold` (`1` for the cold reply, otherwise
`0`) and `reply`. Keep one of each tone per call so the trust budget stays
readable.

Add an entry with the same shape. `game_screen.gd` passes `CallBook.CALLS.size()`
to `start_run`, so a sixth entry is enough; any other caller passes the same size.
The top bar and win/loss checks read `GameState.call_count`; no other scene needs a
number changed. The smoke test's five-call loop and the two scenario routes must be
extended when the shift gets longer.

To change the rules, edit the constants in `game_state.gd` (`START_TRUST`,
`WIN_TRUST`, `MAX_COLD`) and keep the design's acceptance observations in step.
The screen reads those constants and does not hard-code a second win rule.

## Web playtest probe

`scripts/studio_probe.gd` is autoloaded as `StudioProbe`. In web builds only, it
registers `window.__studioProbe()`, which returns JSON with GameState's public
primitive members, the first `player`-group position (this game has none) and
visible screen text. `game_web_playtest` reads it after boot, between steps and at
the end, and qualifies an approved game only when a criterion that was false at
the gameplay baseline becomes true later. A no-player screen game establishes
that baseline from the typed `state` marker (`1` while playing), not from an
avatar.

The same probe carries the stage's visibility bridge: `studio-visibility`
postMessages pause the SceneTree and mute the master bus while the stage tab is
closed, then restore what they found and answer with `studio-visibility-ack`. Keep
the probe and its autoload line. The playtest obligation is server-owned: a game
made with the probe owes it for good, so deleting the script or autoload makes the
playtest fail instead of weakening the exam. Add observable values to GameState,
not to the probe.

## Recipes

Start from these shipped recipe ids with `game_recipe_get`, then adapt the
mechanism rather than pasting it:

- `read.layout` — keep the card, choices, status and primary action inside a
  changing viewport; long text wraps, the middle scrolls, the footer stays pinned.
  This template already follows its shape; fetch it when a new panel or a longer
  translation breaks the frame.
- `loop.dialogue` — gate choices on state the scene keeps, show locked options and
  make a locked choice a no-op. Use it when a caller's reply should depend on an
  earlier one.
- `loop.card` — drag a card to its target, pay its cost once and refill on a new
  turn. Use it when the desk becomes a hand-management or card game.

`game_recipe_search` is still useful for a defect or a genre word the ids above do
not cover.

## Design and build plan

Before building, write a **3–5 step build plan** in DESIGN.md's `## Milestones`
section. Each step names the acceptance ids it proves and the proof you will run
(a scenario id, a `game_verify` route, or a visible frame). Make step 1 the
playable core and get a first playable checkpoint early; add content in the middle
steps and presentation last. A step that only restates a design section is not a
step.

For this starter the shortest credible plan is:

1. **Desk core** — one caller, three replies, trust and the next-caller beat;
   prove the choice and trust observations.
2. **Full shift** — five callers and the win/loss endings; prove the content, win
   and lose observations through both routes.
3. **Presentation** — the night-desk look, listen feedback, audio and the end
   screens; keep the layout and input parity working.

The old template games do not need this section retrofitted: a missing plan is
guidance, not a validation gate.

## Tests

`tests/smoke_test.gd` is the entry point (`SceneTree`) and
`tests/smoke_harness.gd` holds the checks. The split exists because Godot compiles
a `--script` entry point before the autoloads exist. The harness drives the real
loop:

- the title screen, its focus and the Enter/Play transition;
- a pointer click on a choice and on Next caller, and a double click on
  Next caller that must not answer the next call;
- a held `L` that reveals the detail and raises `listened`;
- a number-key choice and Enter through the reply;
- Escape pause and resume, and `R` restart;
- a five-warm-call win and a three-cold-call loss;
- the end screen's return to the main menu.

It never writes a run value or calls a game method to force an outcome. Keep that
rule when you add checks: press the same actions or click the same Controls a
player uses. Adapt the checks to the design: rewrite caller counts and trust
thresholds, drop checks for cut mechanics, and keep meaningful checks for
everything retained and promised. The shipped five-call win and three-cold loss
test the reference shift only. Never lower a threshold or skip a check to make
green: tie every change to DESIGN.md acceptance. `game_godot_check` may report "No Camera2D or Camera3D" for these
Control-only scenes; that warning is expected for a screen game and is not a
failure. Add a camera only if you add a world that actually uses one.

## Acceptance criteria

Write the DESIGN.md acceptance block against values the player changes, never
against a boot constant. A criterion passes only when it was false at the first
sample after the route's first input and became true later. For this game the
workable values are `choices`, `listened`, `trust`, `calls`, `cold`, `won` and
`state`.

Examples for this template (pick 5–12 total in the real design; numbers below are
the reference shift's, not requirements):

- control: `{ "id": "choose-a-reply", "kind": "control", "text": "Keys 1 to 3 choose a reply", "observe": { "key": "choices", "expect": ">=1" } }`
- control: `{ "id": "hear-them-out", "kind": "control", "text": "Holding L hears the caller out", "observe": { "key": "listened", "expect": ">=1" } }`
- mechanic: `{ "id": "warm-replies-raise-trust", "kind": "mechanic", "text": "A warm reply raises trust above its starting value", "observe": { "key": "trust", "expect": ">=3" } }`
- mechanic: `{ "id": "cold-replies-count", "kind": "mechanic", "text": "Cold replies accumulate", "observe": { "key": "cold", "expect": ">=1" } }`
- content: `{ "id": "answer-every-caller", "kind": "content", "text": "All five callers are answered", "observe": { "key": "calls", "expect": ">=5" } }`
- content: `{ "id": "hear-the-whole-shift", "kind": "content", "text": "Every caller is heard out", "observe": { "key": "listened", "expect": ">=5" } }`
- win: `{ "id": "hold-the-shift", "kind": "win", "text": "The shift ends with trust intact", "observe": { "key": "won", "expect": "==1" } }`
- lose: `{ "id": "three-cold-replies", "kind": "lose", "text": "Three cold replies end the shift", "observe": { "key": "state", "expect": "==4" } }`
- presentation: `{ "id": "desk-at-night", "kind": "presentation", "text": "The desk reads as a night switchboard" }`

A `win` and a real `lose` observe the value the run ends at, not `changes`; a
game with no losing state writes a `lose` criterion with `"noLoseState": true`
and no observe instead. Content counts are proven by the counter the player moves
(`calls >= 5`), not by a world total. Presentation claims carry no observe and
wait for the visual stage.

## Acceptance scenarios

`tests/scenarios/full-run.json` starts at the title screen, holds `listen`, then
chooses `choose_1` and presses `ui_accept` through all five calls; it wins.
`tests/scenarios/lose-run.json` is its adverse twin: it hears the first caller
out, then chooses `choose_3` three times and loses on the third cold reply. Both
routes use only InputMap actions — `press`, `hold` and `wait` — and never call a
game function or write GameState. Both files are game-owned route data copied from
the reference shift, not server-owned law: server-owned is the verification policy
(the canonical `res://tests/smoke_test.gd` suite path, the gameplay scene, and the
probe obligation, persisted server-side and changed only by an explicit creator
action) plus the approved DESIGN.md observations that `game_scenarios_run` grades. Adapt
the routes to this game's scope: rewrite caller counts, trust rules and timings,
and keep meaningful coverage of everything retained and promised. The reference
shift keeps both routes; a new game keeps routes for what it keeps. Never weaken a
route or lower a threshold to make green: tie every change to DESIGN.md
acceptance.
