// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- STYLE.json is a file in the game folder, read and decoded like ASSETS.md.
// The style lock's one reader: STYLE.json at the game root, decoded and checked
// against the library, for the art tools that fill defaults from it and refuse
// what drifts from it.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  GAME_STYLE_DEFAULT_MUSIC_LUFS,
  GAME_STYLE_DEFAULT_SFX_PEAK_DBTP,
  GAME_STYLE_FILE,
  type GameBlenderRenderSpritesInput,
  GameOperationError,
  GameStyle,
} from "@kurambit/contracts";
import type { LibraryPack } from "./assetLibraryFiles.ts";
import { LIBRARY_CATALOG, LIBRARY_FAMILIES } from "./assetLibraryCatalog.ts";

/** A lock is a few hundred bytes; anything this large is not one. */
const MAX_STYLE_BYTES = 64 * 1024;

const decodeStyle = Schema.decodeUnknownResult(Schema.fromJsonString(GameStyle), {
  errors: "all",
});

const fail = (reason: GameOperationError["reason"], detail: string, cause?: unknown) =>
  new GameOperationError({
    operation: "Read the style lock",
    path: GAME_STYLE_FILE,
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const near = (wanted: string, ids: ReadonlyArray<string>) => {
  const head = wanted.split("-")[0] ?? wanted;
  const close = ids.filter(
    (id) => id.includes(wanted) || wanted.includes(id) || id.startsWith(`${head}-`),
  );
  return close.length > 0 ? `; did you mean ${close.slice(0, 4).join(", ")}?` : "";
};

/** What in a decoded lock names nothing in the library, or null. */
export const styleProblem = (style: GameStyle): string | null => {
  const packIds = LIBRARY_CATALOG.map((pack) => pack.id);
  for (const [field, ids] of [
    ["packs", style.packs],
    ["audio.packs", style.audio?.packs ?? []],
  ] as const)
    for (const [index, id] of ids.entries())
      if (!packIds.includes(id))
        return `${field}[${index}]: no library pack "${id}"${near(id, packIds)}`;
  const familyIds = LIBRARY_FAMILIES.map((family) => family.id);
  if (style.family !== undefined && !familyIds.includes(style.family))
    return `family: no library family "${style.family}"; the families are ${familyIds.join(", ")}`;
  const rigs = [...new Set(LIBRARY_CATALOG.flatMap((pack) => (pack.rig ? [pack.rig] : [])))];
  if (style.rig !== undefined && !rigs.includes(style.rig))
    return `rig: no library rig "${style.rig}"; the rigs are ${rigs.join(", ")}`;
  return null;
};

/**
 * The game's lock, or null when it has none. A lock that is a link, not a
 * file, not JSON, not the schema or naming unknown library ids fails with the
 * field, so the tool reading it refuses loudly instead of ignoring it.
 */
export const readGameStyle = (
  realRoot: string,
): Effect.Effect<GameStyle | null, GameOperationError> =>
  Effect.gen(function* () {
    const path = NodePath.join(realRoot, GAME_STYLE_FILE);
    const stat = yield* Effect.tryPromise({
      try: () =>
        NodeFSP.lstat(path).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return null;
          throw cause;
        }),
      catch: (cause) => fail("io", `${GAME_STYLE_FILE} could not be read.`, cause),
    });
    if (stat === null) return null;
    if (stat.isSymbolicLink())
      return yield* fail(
        "symlink",
        `${GAME_STYLE_FILE} is a symbolic link; the style lock is read only from a real file in the game.`,
      );
    if (!stat.isFile()) return yield* fail("invalid-path", `${GAME_STYLE_FILE} is not a file.`);
    if (stat.size > MAX_STYLE_BYTES)
      return yield* fail("invalid-input", `${GAME_STYLE_FILE} is larger than a style lock can be.`);
    const text = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(path, "utf8"),
      catch: (cause) => fail("io", `${GAME_STYLE_FILE} could not be read.`, cause),
    });
    const decoded = decodeStyle(text);
    if (Result.isFailure(decoded))
      return yield* fail(
        "invalid-input",
        `${GAME_STYLE_FILE} is not a valid style lock (fix it, or delete it to lift the lock): ${decoded.failure.message.slice(0, 1200)}`,
      );
    const problem = styleProblem(decoded.success);
    if (problem !== null)
      return yield* fail(
        "invalid-input",
        `${GAME_STYLE_FILE} is not a valid style lock (fix it, or delete it to lift the lock): ${problem}`,
      );
    return decoded.success;
  });

const SPRITE_VIEWS: Record<GameStyle["view"], GameBlenderRenderSpritesInput["views"] | undefined> =
  {
    side: ["right"],
    "top-down": ["front", "back", "left", "right"],
    isometric: ["isometric"],
    perspective: undefined,
  };

/**
 * A sprite render as the lock holds it: missing pixel-art settings, size and
 * views come from the lock (each said in `notes`), and a palette or mode the
 * lock does not allow is refused with how to change the lock instead.
 */
export const lockSpriteInput = (
  input: GameBlenderRenderSpritesInput,
  style: GameStyle | null,
):
  | { readonly input: GameBlenderRenderSpritesInput; readonly notes: ReadonlyArray<string> }
  | { readonly refusal: string } => {
  if (style === null) return { input, notes: [] };
  const notes: string[] = [];
  let locked = input;
  if (style.mode === "smooth") {
    if (input.pixelArt !== undefined)
      return {
        refusal: `${GAME_STYLE_FILE} locks this game to smooth art, so its sprites are not quantised: leave out pixelArt, or change ${GAME_STYLE_FILE}'s mode to pixel (with tile and palette) to make the whole game pixel art.`,
      };
  } else {
    const asked = input.pixelArt?.palette;
    if (asked !== undefined && asked !== style.palette)
      return {
        refusal: `${GAME_STYLE_FILE} locks this game's palette to ${style.palette}; leave out pixelArt.palette (the lock fills it) or pass that one. To change every sprite's palette, change ${GAME_STYLE_FILE}'s palette first and render the strips again.`,
      };
    const outline = input.pixelArt?.outline ?? style.outline;
    locked = {
      ...locked,
      pixelArt: {
        ...input.pixelArt,
        ...(style.palette === undefined ? {} : { palette: style.palette }),
        ...(outline === undefined ? {} : { outline }),
      },
    };
    if (input.pixelArt === undefined)
      notes.push(
        `${GAME_STYLE_FILE}: pixel art, palette ${style.palette}${outline === undefined || outline === false ? "" : ", outlined"}.`,
      );
    if (input.size === undefined && style.tile !== undefined) {
      const size = Math.min(512, Math.max(8, style.tile * 2));
      locked = { ...locked, size };
      notes.push(`${GAME_STYLE_FILE}: ${size} px canvas, twice its ${style.tile} px tile.`);
    }
  }
  const views = SPRITE_VIEWS[style.view];
  if (input.views === undefined && views !== undefined) {
    locked = {
      ...locked,
      views,
      ...(style.view === "top-down" && input.elevation === undefined ? { elevation: 35 } : {}),
    };
    notes.push(`${GAME_STYLE_FILE}: ${style.view} views (${views.join(", ")}).`);
  }
  return { input: locked, notes };
};

/** Which of a STYLE.json's pack lists a pack belongs in: sound-only packs go in audio.packs. */
const soundOnly = (pack: LibraryPack) =>
  pack.kinds.every((kind) => kind === "sfx" || kind === "music");

/** Why the lock refuses a pack before anything is fetched, or null. */
export const lockPackRefusal = (pack: LibraryPack, style: GameStyle | null): string | null => {
  if (style === null) return null;
  const audio = style.audio?.packs ?? [];
  if (style.packs.includes(pack.id) || audio.includes(pack.id)) return null;
  const list = soundOnly(pack) ? "audio.packs" : "packs";
  const holds = soundOnly(pack) ? audio : style.packs;
  return `${GAME_STYLE_FILE} locks this game's ${soundOnly(pack) ? "sound" : "look"} to ${holds.length === 0 ? "no sound packs yet" : holds.join(", ")}; ${pack.id} (${pack.style}) is outside it. If it fits the game, add "${pack.id}" to ${GAME_STYLE_FILE}'s ${list} and add again; to change the game's ${soundOnly(pack) ? "sound" : "look"}, change ${GAME_STYLE_FILE} first.`;
};

/** Why the lock refuses a pack's characters (models with clips) on another rig, or null. */
export const lockRigRefusal = (pack: LibraryPack, style: GameStyle | null): string | null => {
  if (style?.rig === undefined || pack.rig === undefined || pack.rig === style.rig) return null;
  const same = LIBRARY_CATALOG.filter((other) => other.rig === style.rig).map((other) => other.id);
  const from = same.length > 1 ? `${same.slice(0, -1).join(", ")} or ${same.at(-1)}` : same[0];
  return `${pack.id}'s characters are on the ${pack.rig} rig and ${GAME_STYLE_FILE}'s rig is ${style.rig}, so their clips would not fit the game's other characters. Take characters from ${from}, add only this pack's props, or change ${GAME_STYLE_FILE}'s rig to move every character to ${pack.rig}.`;
};

/** The loudness targets a lock sets, or the defaults without one. */
export const loudnessTargets = (style: GameStyle | null) => ({
  musicLufs: style?.audio?.musicLufs ?? GAME_STYLE_DEFAULT_MUSIC_LUFS,
  sfxPeakDbtp: style?.audio?.sfxPeakDbtp ?? GAME_STYLE_DEFAULT_SFX_PEAK_DBTP,
  fromLock: style?.audio?.musicLufs !== undefined || style?.audio?.sfxPeakDbtp !== undefined,
});
