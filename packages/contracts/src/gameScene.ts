import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

// The scene report: what a person sees at a glance, measured inside the running game by the
// three.js shell (templates/runtime/three/1/shell/scene-report.js) during a measured play.
// Its own module, so game.ts (game_check) and gameBuilds.ts (the build's facts) share it
// without importing each other.

/** What a finding says is wrong; the shell keeps only what lasts longer than a moment. */
export const GameSceneFindingKind = Schema.Literals([
  /** Feet sunk well below the surface under them. */
  "buried",
  /** The body's middle inside a closed solid. */
  "inside",
  /** Two bodies inside each other. */
  "clipping",
  /** Far below the level, or no position at all. */
  "fell",
  /** The camera inside a closed solid. */
  "camera",
  /** A skinned body moving over the ground in its idle clip or a frozen pose. */
  "sliding",
]);
export type GameSceneFindingKind = typeof GameSceneFindingKind.Type;

export const GameSceneFinding = Schema.Struct({
  kind: GameSceneFindingKind,
  /** The thing's name as the game registers it; null for the camera. */
  thing: Schema.NullOr(Schema.String),
  /** The solid it is in, the other body, or the clip it slides in; null when there is none. */
  other: Schema.NullOr(Schema.String),
  /** Game seconds into the measured play when it was first seen. */
  at: Schema.Number,
  /** Seconds it held, in all. */
  seconds: Schema.Number,
  /** The share of the time the thing was measured that it held, 0–1. */
  share: Schema.Number,
  /** Metres buried or fallen below the level, the overlap share, metres a second sliding; null: no position at all. */
  amount: Schema.NullOr(Schema.Number),
  /** Game-relative PNG with the problem outlined; null when none was kept. */
  frame: Schema.NullOr(Schema.String),
});
export type GameSceneFinding = typeof GameSceneFinding.Type;

export const GameScenePlayer = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("body"),
    name: Schema.String,
    /** Shares of the measured play the player was behind solids and off screen. */
    hidden: Schema.Number,
    offscreen: Schema.Number,
    /** The solid that hid it most. */
    blocker: Schema.NullOr(Schema.String),
    /** Its median height on screen, in CSS pixels of a canvas `canvasHeight` tall. */
    heightPx: Schema.NullOr(Schema.Number),
    /** Its median width on screen; absent from a shell that predates it. */
    widthPx: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    canvasHeight: Schema.Number,
    notVisible: Schema.Boolean,
    small: Schema.Boolean,
    frame: Schema.NullOr(Schema.String),
    smallFrame: Schema.NullOr(Schema.String),
    /**
     * How much it stands out from what is behind it: the colour difference (CIE ΔE) across its
     * outline, median of the play's readings; null when it was never read. Absent from a shell
     * that predates it.
     */
    contrast: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    /** Lost against what is behind it in most readings: the shell's verdict, by its own limit. */
    faint: Schema.optionalKey(Schema.Boolean),
    faintFrame: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    /**
     * none: the game set no ctx.player. point: it is a position, not a body. no-body: an
     * object with nothing drawn. first-person: the camera sits inside it. hidden-by-game:
     * the game kept it hidden or out of the scene the whole play.
     */
    kind: Schema.Literals(["none", "point", "no-body", "first-person", "hidden-by-game"]),
  }),
]);
export type GameScenePlayer = typeof GameScenePlayer.Type;

/**
 * How much of the frame shows nothing: a flat backdrop where the camera looks below the horizon
 * and no drawn thing is in the way. Sky above the horizon, a 2D game's backdrop behind its plane
 * and a picture the game set as its backdrop never count; a board floating over a colour does.
 */
export const GameSceneEmpty = Schema.Struct({
  /** The share of the frame that empty, median over the play's looks, 0–1. */
  share: Schema.Number,
  /** The share of the play it was over the shell's limit. */
  held: Schema.Number,
  /** The backdrop that showed: its colour as #rrggbb, or `sky` for the look's drawn sky. */
  colour: Schema.String,
  /** Over the limit for most of the play: the shell's verdict, by its own thresholds. */
  flagged: Schema.Boolean,
  /** The frame with the empty part marked; null when it is not flagged. */
  frame: Schema.NullOr(Schema.String),
});
export type GameSceneEmpty = typeof GameSceneEmpty.Type;

export const GameSceneReport = Schema.Struct({
  /** Game seconds of play the shell looked at. */
  seconds: Schema.Number,
  findings: Schema.Array(GameSceneFinding).check(Schema.isMaxLength(24)),
  player: GameScenePlayer,
  /** Registered things that were in the scene and shown but never came into view. */
  unseen: Schema.Array(Schema.String).check(Schema.isMaxLength(16)),
  unseenMore: NonNegativeInt,
  /** Absent from a shell that predates it, or when no look was measured. */
  empty: Schema.optionalKey(GameSceneEmpty),
  /** What one look cost the page, in milliseconds. */
  cost: Schema.Struct({ meanMs: Schema.Number, worstMs: Schema.Number }),
});
export type GameSceneReport = typeof GameSceneReport.Type;
