# Game layer

> For maintainers. The code lives in `apps/server/src/game/`, `apps/server/src/mcp/toolkits/game/`,
> `packages/contracts/src/game.ts`, `apps/web/src/components/game/` and `scripts/studio/`.

The game layer is being rebuilt around a harness-run loop: the harness plays every build with a
separate tester session, reviews it with fresh sessions and compares builds blind, so a worse build
never lands. `scripts/studio/` is where that loop is being proven.

The design approval, critic, repair, ballot, qualification and scenario code in `apps/server/src/game`
is the previous approach. It still runs behind the current create flow until the new loop moves into
the server; do not extend it.

Two constraints hold for both:

- Agents never open a window on the user's desktop. Every game process drops `DISPLAY`,
  `WAYLAND_DISPLAY` and `XAUTHORITY`; pictures come from a private virtual display.
- Game builders do not inherit the user's provider rulesets, which can tell them to write as little
  as possible.
