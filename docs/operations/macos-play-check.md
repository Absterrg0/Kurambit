# Checking game play on macOS

Kurambit plays native games on macOS in a window placed far off every monitor, at
(-10000, -10000), because macOS gives an app no private display of its own. That window must
keep drawing, must stay invisible and must never take focus. None of this has run on a Mac yet;
these checks decide whether it works. Report each numbered result with the macOS version, the Mac
(Apple silicon or Intel) and the monitor layout.

## What to run

Use a dev build on the Mac (`vp run dev:desktop`), with Godot 4.7 and ffmpeg installed and
ffmpeg on PATH. Make a small Godot game, or open one, and have an agent run `game_explore_start`,
a few `game_explore_act` calls, then `game_bot_run` with a 30-second budget. Keep working in
another app, such as a text editor, while it runs.

## Checks

1. **Nothing appears.** No Godot window shows on any monitor, in Mission Control or on another
   Space. In Mission Control, look for a window at the far left of the desktop.
2. **Focus stays put.** The app you were typing in keeps keyboard focus when the game starts, and
   when every act and the bot run start. Note whether a Godot icon appears in the Dock, which is
   expected, and whether the menu bar switches to Godot, which is a failure.
3. **Pictures are current.** Each act's screenshot shows the game's current state, not the first
   frame repeated.
4. **The video moves.** The bot run's `run.mp4` plays motion, and its `run.frames.json` reports
   `distinctFrames` close to `received`. A `longestStallMs` of several seconds means the game
   stopped drawing.
5. **Covered and switched.** Repeat check 4 with Kurambit full screen, and again while you switch
   to another Space during the run.
6. **Quitting is clean.** After `game_explore_close`, after the bot run, and after you quit
   Kurambit mid-run with Cmd+Q, Activity Monitor shows no Godot process.
7. **Saves stay isolated.** Nothing new appears under
   `~/Library/Application Support/Godot/app_userdata/` for the game you tested. Kept saves land
   under the game's `.studio/saves/godot/`.
8. **Blender stays hidden.** The first `game_blender_*` call opens no visible Blender window and
   takes no focus.

## Why each check exists

- Godot draws a frame only while one of its windows can draw, and on macOS a window can draw only
  while `occlusionState` has `NSWindowOcclusionStateVisible` (`platform/macos/display_server_macos.mm`
  `window_can_draw`, `platform/macos/godot_window_delegate.mm` `windowDidChangeOcclusionState:`,
  and the `can_any_window_draw()` gate in `main/main.cpp`).
- Apple's AppKit release notes for OS X 10.9 say windows "are also occluded if they are ordered
  off screen, minimized to the dock, or on another space". Whether a window placed beyond every
  monitor counts as "ordered off screen" is undocumented. The play runner therefore calls
  `DisplayServer.register_additional_output`, which Godot documents as a way "to prevent Godot from
  skipping rendering when no normal windows are visible" (godotengine/godot#94412). Checks 3 to 5
  test it.
- The same release notes say windows are constrained to not intersect the menu bar
  (`constrainFrameRect:toScreen:`). That moves a window vertically, so the far-left x position
  should hold. Check 1 tests it.
- When Godot shows its main window it calls `activateIgnoringOtherApps:`
  (`platform/macos/godot_application.mm`). When it was not started by LaunchServices it also
  re-activates itself through the Dock. Kurambit passes the editor bundle's `CFBundleIdentifier` as
  `__CFBundleIdentifier`, which skips the Dock step. Since macOS 14 activation is cooperative, so
  the request alone should not take focus from the app in front. On macOS 13 and earlier it may.
  Check 2 tests both.
- Godot puts `user://` under `$HOME/Library/Application Support` on macOS and reads no XDG
  variable (`platform/macos/os_macos.mm`), so a play session gets its own `HOME`. Check 7 tests it.

## Not covered on macOS yet

Unity games do not play on macOS: Kurambit builds Linux and Windows players only, and refuses a
Unity play session on a Mac with a message saying so. The Unity editor tools (batchmode, no window)
are expected to work.
