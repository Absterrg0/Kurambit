import * as Schema from "effect/Schema";

/** The play-session protocol the browser host speaks; 2 streams the engine's own frames. */
export const PLAY_SESSION_PROTOCOL = 2;

/**
 * What a play session can do beyond acts of the shared playtest steps (the harness plays a running
 * game through one session, apps/server/src/game/playSession.ts). A session without `realtime`
 * cannot carry a bot; without `ui` its acts take no ui steps and its bots' id-clicks are skipped;
 * without `inspect` no inspect steps; without `setState` a bot's state writes are refused; without
 * `frames` a bot run has no video and no end picture. A native engine's process runner once spoke
 * a line protocol for this; git history keeps it.
 */
export const PlaySessionCapability = Schema.Literals([
  "realtime",
  "ui",
  "inspect",
  "setState",
  "frames",
]);
export type PlaySessionCapability = typeof PlaySessionCapability.Type;
