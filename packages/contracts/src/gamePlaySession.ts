import * as Schema from "effect/Schema";
import { GamePlaytestProbe, GamePlaytestStateValue } from "./game.ts";
import {
  GameExploreInspection,
  GameExploreStep,
  GameExploreUiControl,
  GameExploreUiResult,
} from "./gameExplore.ts";

/**
 * How the harness plays a running game: one session protocol every engine's
 * in-game runner speaks, so exploration and bots are clients of a session and
 * an engine adds only how to launch one. A process runner (Godot's runner
 * script, Unity's StudioProbe) reads a request file, connects out to the
 * loopback port it names and exchanges one JSON object per line; the browser
 * host speaks the same messages to a three.js page through Chromium.
 *
 * A session opens held: the runner says hello, then plays discrete acts with
 * the game paused between them, until a `realtime` command lets the game run
 * at normal speed and the runner streams one tick observation every 100 ms
 * while continuous held input steers it. Quit ends either phase.
 */
export const PLAY_SESSION_PROTOCOL = 1;

/**
 * What a runner can do beyond acts of the shared playtest steps. A runner
 * without `realtime` cannot carry a bot; without `ui` its acts take no ui
 * steps and its bots' id-clicks are skipped; without `inspect` no inspect
 * steps; without `setState` a bot's state writes are refused.
 */
export const PlaySessionCapability = Schema.Literals(["realtime", "ui", "inspect", "setState"]);
export type PlaySessionCapability = typeof PlaySessionCapability.Type;

/** The file a process runner reads at start (its path is the runner's argument). */
export const PlaySessionRequest = Schema.Struct({
  protocol: Schema.Literal(PLAY_SESSION_PROTOCOL),
  port: Schema.Int,
  token: Schema.String,
  /** Godot only: the isolated user:// root the runner must find itself under. */
  expectedUserDataPrefix: Schema.optionalKey(Schema.String),
});
export type PlaySessionRequest = typeof PlaySessionRequest.Type;

export const PlaySessionError = Schema.Struct({
  message: Schema.String,
  where: Schema.String,
  /** Set by runners that know it ("page" in the browser); otherwise read from the text. */
  kind: Schema.optionalKey(Schema.Literals(["script", "engine", "page"])),
});
export type PlaySessionError = typeof PlaySessionError.Type;

/** The player body: what the bot kit's movement sensors read. */
export const PlaySessionBody = Schema.Struct({
  present: Schema.Boolean,
  dim: Schema.optionalKey(Schema.Literals(["2d", "3d"])),
  onGround: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  touching: Schema.optionalKey(Schema.Number),
  vx: Schema.optionalKey(Schema.Number),
  vy: Schema.optionalKey(Schema.Number),
  vz: Schema.optionalKey(Schema.Number),
});
export type PlaySessionBody = typeof PlaySessionBody.Type;

/** Scene counts, not timings: frame times on a software display measure the host, node counts the game. */
export const PlaySessionPerf = Schema.Struct({ nodes: Schema.Int, orphans: Schema.Int });
export type PlaySessionPerf = typeof PlaySessionPerf.Type;

const TickProbe = Schema.Struct({
  gameState: Schema.Record(Schema.String, Schema.NullOr(GamePlaytestStateValue)),
  player: Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number, z: Schema.Number })),
  hudText: Schema.optionalKey(Schema.String),
});

const helloHead = {
  op: Schema.Literal("hello"),
  protocol: Schema.Literal(PLAY_SESSION_PROTOCOL),
  token: Schema.String,
  engine: Schema.String,
  capabilities: Schema.Array(PlaySessionCapability),
};

/**
 * The handshake fields alone. The harness decodes these strictly and bounds
 * the boot observation field by field, so one odd game value never refuses a
 * session.
 */
export const PlaySessionHandshake = Schema.Struct(helloHead);

/** Runner to harness: the session handshake, sent once after boot with the game held. */
export const PlaySessionHello = Schema.Struct({
  ...helloHead,
  physicsHz: Schema.optionalKey(Schema.Number),
  probe: GamePlaytestProbe,
  screenText: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  ui: Schema.optionalKey(Schema.Array(GameExploreUiControl)),
  body: Schema.optionalKey(PlaySessionBody),
  errors: Schema.Array(PlaySessionError),
  perf: Schema.optionalKey(Schema.NullOr(PlaySessionPerf)),
});
export type PlaySessionHello = typeof PlaySessionHello.Type;

/** Runner to harness: the boot failed and no session opens. */
export const PlaySessionBootFailure = Schema.Struct({
  op: Schema.Literal("error"),
  error: Schema.String,
});

/** Runner to harness: the observation after one act, or why the act failed. */
export const PlaySessionActReply = Schema.Struct({
  op: Schema.Literal("reply"),
  id: Schema.Int,
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  probe: Schema.optionalKey(GamePlaytestProbe),
  screenText: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  ui: Schema.optionalKey(Schema.Array(GameExploreUiControl)),
  errors: Schema.optionalKey(Schema.Array(PlaySessionError)),
  uiResults: Schema.optionalKey(Schema.Array(GameExploreUiResult)),
  inspections: Schema.optionalKey(Schema.Array(GameExploreInspection)),
  executedInputSteps: Schema.optionalKey(Schema.Int),
  /** Whether the runner wrote the act's picture to the requested path. */
  screenshot: Schema.optionalKey(Schema.Boolean),
});
export type PlaySessionActReply = typeof PlaySessionActReply.Type;

/** Runner to harness: the answer to a setState or quit. */
export const PlaySessionCommandReply = Schema.Struct({
  op: Schema.Literal("reply"),
  id: Schema.Int,
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  applied: Schema.optionalKey(Schema.Array(Schema.String)),
});

/**
 * Runner to harness, every 100 ms of real-time play: the bot runner's view.
 * `visible` holds on-screen controls ({kind, label}) and nearby 3D landmarks
 * ({label, dist, bearing, dy, inView}); `room` is the clearance rays of a 3D
 * body (forward = -Z) and the floor depth just ahead each way; `sweep` is the
 * body's overlap with solid geometry, sampled every fifth tick.
 */
export const PlaySessionTick = Schema.Struct({
  op: Schema.Literal("tick"),
  tick: Schema.Int,
  /** Game seconds since real-time play began. */
  t: Schema.Number,
  physicsFrames: Schema.optionalKey(Schema.Int),
  probe: TickProbe,
  body: Schema.optionalKey(PlaySessionBody),
  visible: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  room: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Number))),
  errors: Schema.Array(PlaySessionError),
  sweep: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        dim: Schema.optionalKey(Schema.String),
        overlaps: Schema.optionalKey(Schema.Number),
        overlapNames: Schema.optionalKey(Schema.String),
        error: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  perf: Schema.optionalKey(Schema.NullOr(PlaySessionPerf)),
});
export type PlaySessionTick = typeof PlaySessionTick.Type;

const ClickTarget = Schema.Union([
  Schema.Struct({ x: Schema.Number, y: Schema.Number }),
  /** A listed control's id (runners with `ui`). */
  Schema.Struct({ id: Schema.String }),
]);

/** Harness to runner. */
export const PlaySessionCommand = Schema.Union([
  /** Plays steps with the game running, then holds it again and replies with one observation. */
  Schema.Struct({
    op: Schema.Literal("act"),
    id: Schema.Int,
    steps: Schema.Array(GameExploreStep),
    screenshotPath: Schema.NullOr(Schema.String),
  }),
  /** Releases the hold for good and starts the tick stream. */
  Schema.Struct({ op: Schema.Literal("realtime") }),
  /**
   * Continuous input: exactly these keys stay down until the next input,
   * taps press and release once (about 170 ms), clicks land at once.
   */
  Schema.Struct({
    op: Schema.Literal("input"),
    held: Schema.Array(Schema.String),
    taps: Schema.Array(Schema.String),
    clicks: Schema.Array(ClickTarget),
  }),
  /** An explicit, reported state write through the game's own hook (runners with `setState`). */
  Schema.Struct({
    op: Schema.Literal("setState"),
    id: Schema.Int,
    target: Schema.String,
    values: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({ op: Schema.Literal("quit"), id: Schema.Int }),
]);
export type PlaySessionCommand = typeof PlaySessionCommand.Type;
