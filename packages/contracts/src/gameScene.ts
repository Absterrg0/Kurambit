import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

// The scene report: what a person sees at a glance, measured inside the running game by the
// three.js shell (templates/blank-three/web/shell/scene-report.js) during a measured play.
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
 * How much of the frame shows nothing: the backdrop, one flat colour, where the camera looks
 * below the horizon and no drawn thing is in the way. Sky above the horizon and a 2D game's
 * backdrop behind its plane never count; a board floating over the backdrop does.
 */
export const GameSceneEmpty = Schema.Struct({
  /** The share of the frame that empty, median over the play's looks, 0–1. */
  share: Schema.Number,
  /** The share of the play it was over the shell's limit. */
  held: Schema.Number,
  /** The flat colour, as #rrggbb. */
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

const percent = (share: number) => `${Math.round(share * 100)}%`;
const metres = (m: number) => `${m < 10 ? m.toFixed(1) : Math.round(m)} m`;
const secs = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;

/** PURE. One finding as a plain line: the one wording game_check and the facts share. */
export const sceneFindingText = (finding: GameSceneFinding): string => {
  const thing = finding.thing ?? "Something";
  const other = finding.other ?? "a solid";
  switch (finding.kind) {
    case "buried":
      return `${thing} is buried ${metres(finding.amount ?? 0)} in ${other} for ${percent(finding.share)} of play`;
    case "inside":
      return `${thing} is inside ${other} for ${percent(finding.share)} of play`;
    case "clipping":
      return `${thing} and ${other} are inside each other for ${secs(finding.seconds)}`;
    case "fell":
      return finding.amount === null
        ? `${thing} lost its position (not a number) at ${secs(finding.at)}`
        : `${thing} fell out of the world at ${secs(finding.at)} (${metres(finding.amount)} below the level)`;
    case "camera":
      return `The camera is inside ${other} for ${secs(finding.seconds)} (${percent(finding.share)} of play)`;
    case "sliding":
      return `${thing} slides over the ground at ${(finding.amount ?? 0).toFixed(1)} m/s ${finding.other === null ? "with a frozen pose" : `while playing ${finding.other}`} for ${secs(finding.seconds)}`;
  }
};

/** PURE. The player's line when a person could not follow it; null when they could. */
export const scenePlayerText = (player: GameScenePlayer): string | null => {
  if (player.kind !== "body") return null;
  if (player.notVisible)
    return player.hidden >= player.offscreen
      ? `${player.name} is hidden behind ${player.blocker ?? "solids"} for ${percent(player.hidden)} of play${player.offscreen > 0 ? ` and off screen for ${percent(player.offscreen)}` : ""}`
      : `${player.name} is off screen for ${percent(player.offscreen)} of play${player.hidden > 0 ? ` and hidden for ${percent(player.hidden)}` : ""}`;
  if (player.small && player.heightPx !== null)
    return `${player.name} is only ${Math.round(player.heightPx)} px tall${player.widthPx == null ? "" : ` and ${Math.round(player.widthPx)} px wide`} in a ${player.canvasHeight} px view, too small to read`;
  return null;
};

/** PURE. The empty frame's line when it is flagged; null when the view is filled. */
export const sceneEmptyText = (empty: GameSceneEmpty): string | null =>
  empty.flagged
    ? `${percent(empty.share)} of the view is empty: a flat ${empty.colour} backdrop under the horizon with nothing drawn on it, for ${percent(empty.held)} of play`
    : null;

/** PURE. Every problem the report shows, worded, each with its frame. */
export const sceneLines = (
  report: GameSceneReport,
): ReadonlyArray<{ readonly text: string; readonly frame: string | null }> => {
  const player = scenePlayerText(report.player);
  const empty = report.empty === undefined ? null : sceneEmptyText(report.empty);
  return [
    ...(player === null || report.player.kind !== "body"
      ? []
      : [
          {
            text: player,
            frame: report.player.notVisible ? report.player.frame : report.player.smallFrame,
          },
        ]),
    ...(empty === null ? [] : [{ text: empty, frame: report.empty?.frame ?? null }]),
    ...report.findings.map((finding) => ({
      text: sceneFindingText(finding),
      frame: finding.frame,
    })),
  ];
};
