import * as Schema from "effect/Schema";
import { GameLibraryPackId } from "./gameLibrary.ts";

/** The style lock's file, at the game root beside BRIEF.md and ASSETS.md. */
export const GAME_STYLE_FILE = "STYLE.json";

/** How the game is seen: it sets the views sprites render from. */
export const GameStyleView = Schema.Literals(["side", "top-down", "isometric", "perspective"]);
export type GameStyleView = typeof GameStyleView.Type;

/**
 * STYLE.json: the look a game is held to. The agent writes it when it chooses
 * the look, the person may edit it, and the art tools read it on every call:
 * they fill their defaults from it and refuse what drifts from it.
 */
export const GameStyle = Schema.Struct({
  version: Schema.Literal(1),
  /** A style family from the library (game_assets_search lists them). */
  family: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** pixel: sprites are quantised to the palette at the tile's pixel scale; smooth: drawn at size. */
  mode: Schema.Literals(["pixel", "smooth"]),
  /** Source pixels per tile, for pixel mode. */
  tile: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: 128 }))),
  /** A library pack id added to this game, or a game-relative PNG or folder of PNGs, for pixel mode. */
  palette: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300))),
  /** A 1 px outline on rendered sprites: true for the palette's darkest colour, or #rrggbb. */
  outline: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
  view: GameStyleView,
  /** The rig every character shares, so every clip fits every character; omitted when none is rigged. */
  rig: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** The library packs the game's visuals come from. */
  packs: Schema.Array(GameLibraryPackId).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  audio: Schema.optionalKey(
    Schema.Struct({
      /** The library packs the game's sounds and music come from. */
      packs: Schema.optionalKey(Schema.Array(GameLibraryPackId).check(Schema.isMaxLength(16))),
      /** Integrated loudness of the music, in LUFS. Default -23. */
      musicLufs: Schema.optionalKey(
        Schema.Number.check(Schema.isBetween({ minimum: -40, maximum: -6 })),
      ),
      /** True-peak ceiling of the effects, in dBTP. Default -1. */
      sfxPeakDbtp: Schema.optionalKey(
        Schema.Number.check(Schema.isBetween({ minimum: -12, maximum: 0 })),
      ),
    }),
  ),
}).check(
  Schema.makeFilter((style) => {
    const issues: Array<Schema.FilterIssue> = [];
    if (style.mode === "pixel" && style.tile === undefined)
      issues.push({ path: ["tile"], issue: "pixel mode needs tile: source pixels per tile" });
    if (style.mode === "pixel" && style.palette === undefined)
      issues.push({ path: ["palette"], issue: "pixel mode needs palette: a pack id or a PNG" });
    if (typeof style.outline === "string" && !/^#[0-9a-fA-F]{6}$/.test(style.outline))
      issues.push({ path: ["outline"], issue: "outline is true, false or #rrggbb" });
    return issues;
  }),
);
export type GameStyle = typeof GameStyle.Type;

export const GAME_STYLE_DEFAULT_MUSIC_LUFS = -23;
export const GAME_STYLE_DEFAULT_SFX_PEAK_DBTP = -1;
