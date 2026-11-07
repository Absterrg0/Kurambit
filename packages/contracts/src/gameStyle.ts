import * as Schema from "effect/Schema";
import { GameLibraryPackId } from "./gameLibrary.ts";

/** The style lock's file, at the game root beside BRIEF.md and ASSETS.md. */
export const GAME_STYLE_FILE = "STYLE.json";

/** How the game is seen: it sets the views sprites render from. */
/** How a game's characters are made; the person picks it in game.json, never the harness. */
export const GameCharacterRoute = Schema.Literals(["library", "blender", "tripo"]);
export type GameCharacterRoute = typeof GameCharacterRoute.Type;

const Hex = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));

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
  /** pixel: a pack id or a game-relative PNG or folder; smooth: also a hex list, the 3D style pass's colours. */
  palette: Schema.optionalKey(
    Schema.Union([
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
      Schema.Array(Hex).check(Schema.isMinLength(2), Schema.isMaxLength(64)),
    ]),
  ),
  /** The 3D style pass's shading: gradient strength of each swatch, roughness, emissive strength of glow colours. */
  shading: Schema.optionalKey(
    Schema.Struct({
      gradient: Schema.optionalKey(
        Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 0.5 })),
      ),
      roughness: Schema.optionalKey(
        Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      ),
      glow: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
    }),
  ),
  /** Metres: a made character is scaled to this standing height. */
  scale: Schema.optionalKey(
    Schema.Struct({
      character: Schema.optionalKey(
        Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 20 })),
      ),
    }),
  ),
  /** Export budgets: triangles per character and per prop, and the largest texture side in px. */
  budget: Schema.optionalKey(
    Schema.Struct({
      character: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 200_000 })),
      ),
      prop: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 100_000 })),
      ),
      texture: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 4096 })),
      ),
    }),
  ),
  /** A 1 px outline on rendered sprites: true for the palette's darkest colour, or #rrggbb. */
  outline: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
  view: GameStyleView,
  /**
   * The skeleton made characters are conformed to, so every clip fits them; a pack the lock
   * lists may still bring characters on its own rig. Omitted when none is rigged.
   */
  rig: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** The library packs the game's visuals come from; a pack-id palette is allowed without listing it. */
  packs: Schema.Array(GameLibraryPackId).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  /** Outside sources the live Blender may import from; none when omitted. */
  imports: Schema.optionalKey(
    Schema.Array(Schema.Literals(["polyhaven", "sketchfab", "polypizza"])).check(
      Schema.isMaxLength(3),
    ),
  ),
  audio: Schema.optionalKey(
    Schema.Struct({
      /** The library packs the game's sounds and music come from; omitted, sound is not locked. */
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
    if (style.mode === "pixel" && Array.isArray(style.palette))
      issues.push({
        path: ["palette"],
        issue: "pixel mode reads its palette from a pack id or a PNG",
      });
    if (typeof style.outline === "string" && !/^#[0-9a-fA-F]{6}$/.test(style.outline))
      issues.push({ path: ["outline"], issue: "outline is true, false or #rrggbb" });
    return issues;
  }),
);
export type GameStyle = typeof GameStyle.Type;

export const GAME_STYLE_DEFAULT_MUSIC_LUFS = -23;
export const GAME_STYLE_DEFAULT_SFX_PEAK_DBTP = -1;
export const GAME_STYLE_DEFAULT_SHADING = { gradient: 0.16, roughness: 0.62, glow: 2.5 } as const;
export const GAME_STYLE_DEFAULT_CHARACTERS: GameCharacterRoute = "library";
export const GAME_STYLE_DEFAULT_BUDGET = { character: 20_000, prop: 8_000, texture: 1024 } as const;
