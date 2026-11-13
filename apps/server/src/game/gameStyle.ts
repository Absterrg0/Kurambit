// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- STYLE.json is a file in the game folder, read and decoded like ASSETS.md.
// The style lock's one reader: STYLE.json at the game root, decoded and checked
// against the library, for the art tools that fill defaults from it and refuse
// what drifts from it.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  GAME_STYLE_DEFAULT_BUDGET,
  GAME_STYLE_DEFAULT_CHARACTERS,
  GAME_STYLE_DEFAULT_MUSIC_LUFS,
  GAME_STYLE_DEFAULT_SFX_PEAK_DBTP,
  GAME_STYLE_FILE,
  type GameBlenderRenderSpritesInput,
  type GameCharacterRoute,
  type GameManifest,
  GameOperationError,
  GameStyle,
  type GameStyleLock,
} from "@kurambit/contracts";
import { awaitsMirror, type LibraryFile, type LibraryPack } from "./assetLibraryFiles.ts";
import { stableStringify } from "@kurambit/shared/stableJson";
import { LIBRARY_SOURCES } from "./assetLibrarySources.ts";
import {
  CURATED_PACKS,
  LIBRARY_CATALOG,
  LIBRARY_FAMILIES,
  LIBRARY_RIG_ALIASES,
  LIBRARY_RIG_JOINTS,
  RETIRED_RIGS,
  STANDARD_RIG,
} from "./assetLibraryCatalog.ts";

/** A lock is a few hundred bytes; anything this large is not one. */
const MAX_STYLE_BYTES = 64 * 1024;

const decodeStyle = Schema.decodeUnknownResult(Schema.fromJsonString(GameStyle), {
  errors: "all",
});
const checkStyle = Schema.decodeUnknownResult(GameStyle, { errors: "all" });

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

const PACK_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** The rig id a lock's rig names, through the aliases older locks may use. */
export const resolveRig = (rig: string) => LIBRARY_RIG_ALIASES[rig] ?? rig;

/** What in a decoded lock names nothing in the library, or null. */
const PACK_IDS: ReadonlyArray<string> = [
  ...LIBRARY_CATALOG.map((pack) => pack.id),
  ...LIBRARY_SOURCES.map((source) => source.id),
];
const PACK_ID_SET: ReadonlySet<string> = new Set(PACK_IDS);
/** The packs a lock may be derived from or a refusal may point to: none waiting for a mirror. */
const OFFERED = LIBRARY_CATALOG.filter((pack) => !awaitsMirror(pack));

const styleProblem = (style: GameStyle): string | null => {
  const packIds = PACK_IDS;
  for (const [field, ids] of [
    ["packs", style.packs],
    ["audio.packs", style.audio?.packs ?? []],
  ] as const)
    for (const [index, id] of ids.entries())
      if (!PACK_ID_SET.has(id))
        return `${field}[${index}]: no library pack or source "${id}"${near(id, packIds)}`;
  const familyIds = LIBRARY_FAMILIES.map((family) => family.id);
  if (style.family !== undefined && !familyIds.includes(style.family))
    return `family: no library family "${style.family}"; the families are ${familyIds.join(", ")}`;
  if (style.mode === "pixel" && Array.isArray(style.palette))
    return "palette: pixel mode reads its palette from a pack id or a PNG";
  // A palette named like a pack is a pack id, not a path (a path has a slash or a .png).
  if (
    typeof style.palette === "string" &&
    PACK_ID.test(style.palette) &&
    !PACK_ID_SET.has(style.palette)
  )
    return `palette: no library pack "${style.palette}"${near(style.palette, packIds)}; a palette is a pack id or a PNG or folder in the game`;
  if (style.rig === undefined) return null;
  const retired = RETIRED_RIGS[style.rig];
  if (retired !== undefined) return `rig: ${retired}`;
  const rigs = [...new Set(LIBRARY_CATALOG.flatMap((pack) => (pack.rig ? [pack.rig] : [])))];
  if (!rigs.includes(resolveRig(style.rig)))
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
    // The lock's filter refuses a hex list in pixel mode, so only a pack id or a path reaches sprites.
    const palette = typeof style.palette === "string" ? style.palette : undefined;
    const asked = input.pixelArt?.palette;
    if (asked !== undefined && asked !== palette)
      return {
        refusal: `${GAME_STYLE_FILE} locks this game's palette to ${palette}; leave out pixelArt.palette (the lock fills it) or pass that one. To change every sprite's palette, change ${GAME_STYLE_FILE}'s palette first and render the strips again.`,
      };
    const outline = input.pixelArt?.outline ?? style.outline;
    locked = {
      ...locked,
      pixelArt: {
        ...input.pixelArt,
        ...(palette === undefined ? {} : { palette }),
        ...(outline === undefined ? {} : { outline }),
      },
    };
    if (input.pixelArt === undefined)
      notes.push(
        `${GAME_STYLE_FILE}: pixel art, palette ${palette}${outline === undefined || outline === false ? "" : ", outlined"}.`,
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

/**
 * Why the lock refuses a pack before anything is fetched, or null. The lock's family is one
 * look, so every pack of it may come in; beyond it, the packs it lists, and every asset of a
 * source it lists (polyhaven). A pixel lock's palette pack is part of the look; sound is
 * locked only once the lock lists audio.packs, as characters are only once it names a rig.
 */
export const lockPackRefusal = (pack: LibraryPack, style: GameStyle | null): string | null => {
  if (style === null) return null;
  if (style.packs.includes(pack.id) || style.palette === pack.id) return null;
  if (!soundOnly(pack) && style.family !== undefined && pack.family === style.family) return null;
  if (pack.group !== undefined && style.packs.includes(pack.group)) return null;
  if (soundOnly(pack) && style.audio?.packs === undefined) return null;
  const audio = style.audio?.packs ?? [];
  if (audio.includes(pack.id)) return null;
  const list = soundOnly(pack) ? "audio.packs" : "packs";
  const holds = soundOnly(pack) ? audio : style.packs;
  const allow = pack.group ?? pack.id;
  return `${GAME_STYLE_FILE} locks this game's ${soundOnly(pack) ? "sound" : "look"} to ${soundOnly(pack) || style.family === undefined ? "" : `the ${style.family} family and `}${holds.length === 0 ? "no sound packs yet" : holds.join(", ")}; ${pack.id} (${pack.family}: ${pack.style}) is outside it. If it fits the game, add "${allow}" to ${GAME_STYLE_FILE}'s ${list}${pack.group === undefined ? "" : ` (every ${pack.group} asset then fits)`} and add again; to change the game's ${soundOnly(pack) ? "sound" : "look"}, change ${GAME_STYLE_FILE} first.`;
};

/**
 * Whether a model may be an animated character: it has clips, or its clips
 * could not be read (an FBX, .blend or .dae, or a glTF too large to read).
 * Only a model known to have no clips is a prop.
 */
export const mayBeCharacter = (file: LibraryFile) =>
  file.media === "model" &&
  ((file.clipCount ?? 0) > 0 ||
    file.clipsUnread === true ||
    file.format === "fbx" ||
    file.format === "blend" ||
    file.format === "dae");

/**
 * Why the lock refuses a pack's characters on another rig, or null. The rig names the
 * skeleton made characters are conformed to; a pack the lock lists brings its characters
 * on its own rig with its own clips (KayKit foes beside a standard-skeleton hero).
 */
export const lockRigRefusal = (pack: LibraryPack, style: GameStyle | null): string | null => {
  if (style?.rig === undefined || pack.rig === undefined || style.packs.includes(pack.id))
    return null;
  const rig = resolveRig(style.rig);
  if (pack.rig === rig) return null;
  const same = OFFERED.filter((other) => other.rig === rig).map((other) => other.id);
  const from = same.length > 1 ? `${same.slice(0, -1).join(", ")} or ${same.at(-1)}` : same[0];
  return `${pack.id}'s characters are on the ${pack.rig} rig and ${GAME_STYLE_FILE}'s rig is ${style.rig}, so their clips would not fit the game's other characters. Take characters from ${from}; from this pack add only props known to have no clips (glTF without animations: an FBX's clips cannot be read, so it counts as a character); or, if its characters belong in the game on their own rig, add "${pack.id}" to ${GAME_STYLE_FILE}'s packs.`;
};

/** UI, icons, fonts and particles that sit with every look: every derived lock lists them. */
const INTERFACE_FAMILY = "kenney-interface";

/**
 * STYLE.json for a chosen family, as game_assets_add writes it before adding `adding`:
 * the family's visual packs (those on another rig left out), its rig (the added pack's,
 * else the one its packs share), its pixel mode, tile and palette, and the interface packs.
 * What else a lock already there holds (anchor, a key-art palette, audio, imports, budgets)
 * is kept, so choosing the look again never drops the person's own settings.
 */
export const styleFromLock = (
  lock: GameStyleLock,
  adding: LibraryPack,
  existing: GameStyle | null,
): { readonly style: GameStyle } | { readonly refusal: string } => {
  const family = LIBRARY_FAMILIES.find((candidate) => candidate.id === lock.family);
  // The family admits all its packs; the lock lists its curated ones (a short, readable list,
  // well under the lock's limit) and the per-asset sources that share its look.
  const members = CURATED_PACKS.filter((pack) => pack.family === lock.family && !soundOnly(pack));
  const sources = LIBRARY_SOURCES.filter((source) => source.family === lock.family).map(
    (source) => source.id,
  );
  const hasLook = (id: string) =>
    OFFERED.some((pack) => pack.family === id && !soundOnly(pack)) ||
    LIBRARY_SOURCES.some((source) => source.family === id);
  if (family === undefined || family.id === INTERFACE_FAMILY || !hasLook(family.id)) {
    const looks = LIBRARY_FAMILIES.filter(
      (candidate) => candidate.id !== INTERFACE_FAMILY && hasLook(candidate.id),
    ).map((candidate) => candidate.id);
    return {
      refusal: `lock.family "${lock.family}" is not a look to lock; the families are ${looks.join(", ")} (game_assets_search with no words describes each).`,
    };
  }
  const rigs = [
    ...new Set(
      OFFERED.filter((pack) => pack.family === family.id).flatMap((pack) =>
        pack.rig === undefined ? [] : [pack.rig],
      ),
    ),
  ];
  const lockedRig = existing?.rig === undefined ? undefined : resolveRig(existing.rig);
  const rig =
    adding.family === family.id && adding.rig !== undefined
      ? adding.rig
      : rigs.length === 1
        ? rigs[0]
        : lockedRig !== undefined && rigs.includes(lockedRig)
          ? lockedRig
          : undefined;
  const packs = [
    ...new Set([
      ...members
        .filter((pack) => pack.rig === undefined || pack.rig === rig)
        .map((pack) => pack.id),
      // A generated pack added with the lock is listed, so its characters on their own rig come in.
      ...(adding.family === family.id && adding.group === undefined ? [adding.id] : []),
      ...sources,
      ...LIBRARY_CATALOG.filter((pack) => pack.family === INTERFACE_FAMILY && !soundOnly(pack)).map(
        (pack) => pack.id,
      ),
    ]),
  ];
  const pixel = family.palette !== undefined;
  // A pack palette and a rig belong to the family; what else a lock holds is the person's.
  const kept = existing === null ? {} : Struct.omit(existing, ["tile", "palette", "rig"]);
  const palette = existing?.palette;
  const candidate = {
    ...kept,
    version: 1,
    family: family.id,
    mode: pixel ? "pixel" : "smooth",
    ...(pixel ? { tile: family.tile ?? 16, palette: family.palette } : {}),
    // A hex palette read from the key art outlives a change of family; a pack palette does not.
    ...(!pixel && Array.isArray(palette) ? { palette } : {}),
    view: lock.view,
    ...(rig === undefined ? {} : { rig }),
    packs,
  };
  const checked = checkStyle(candidate);
  if (Result.isFailure(checked))
    return { refusal: `The lock for ${family.id} is not valid: ${checked.failure.message}` };
  const problem = styleProblem(checked.success);
  return problem === null
    ? { style: checked.success }
    : { refusal: `The lock for ${family.id} is not valid: ${problem}` };
};

/** The loudness targets a lock sets, or the defaults without one. */
export const loudnessTargets = (style: GameStyle | null) => ({
  musicLufs: style?.audio?.musicLufs ?? GAME_STYLE_DEFAULT_MUSIC_LUFS,
  sfxPeakDbtp: style?.audio?.sfxPeakDbtp ?? GAME_STYLE_DEFAULT_SFX_PEAK_DBTP,
  fromLock: style?.audio?.musicLufs !== undefined || style?.audio?.sfxPeakDbtp !== undefined,
});

/** Why the lock refuses an import from an outside source, or null. */
export const lockImportRefusal = (
  source: "polyhaven" | "sketchfab" | "polypizza",
  style: GameStyle | null,
): string | null =>
  style === null || (style.imports ?? []).includes(source)
    ? null
    : `${GAME_STYLE_FILE} locks this game's look to its library packs (${style.packs.join(", ")}) and allows no imports from ${source}. If ${source} models fit that look, add "${source}" to ${GAME_STYLE_FILE}'s imports and import again; otherwise take the piece from the lock's packs or build it in Blender in their style.`;

/** How an armature says it is on its own rig; the name becomes its sidecar's skeleton. */
const OWN_RIG_MARK = `armature["kurambit_rig"] = "<rig name>"`;

/**
 * Why the lock refuses armatures about to enter the game (name to bone names),
 * or null: a lock with a rig takes only armatures holding every bone of that
 * rig (when its bones are known); a lock without one takes no armature. An
 * armature on its own rig (kurambit_rig) is never passed here: ownRigRefusal
 * and the generation it came from decide it.
 */
export const lockArmatureRefusal = (
  armatures: Readonly<Record<string, ReadonlyArray<string>>>,
  style: GameStyle | null,
): string | null => {
  const names = Object.keys(armatures);
  if (style === null || names.length === 0) return null;
  const ownRig = `A model you rig and animate yourself (a creature, a vehicle, a humanoid that never plays library clips) enters on its own rig: key its own clips on its armature and mark it, ${OWN_RIG_MARK}.`;
  if (style.rig === undefined)
    return `${names.join(", ")} ${names.length === 1 ? "is an armature" : "are armatures"}, and ${GAME_STYLE_FILE} names no rig, so no character shares library clips. ${ownRig} To bring characters on a shared rig, set ${GAME_STYLE_FILE}'s rig to the rig they share first.`;
  const rig = resolveRig(style.rig);
  const joints = LIBRARY_RIG_JOINTS[rig];
  if (joints === undefined) return null;
  const off = names.filter((name) => {
    const bones = new Set(armatures[name]);
    return joints.some((joint) => !bones.has(joint));
  });
  if (off.length === 0) return null;
  const packs = OFFERED.filter((pack) => pack.rig === rig).map((pack) => pack.id);
  return `${off.join(", ")} ${off.length === 1 ? "is not" : "are not"} on ${GAME_STYLE_FILE}'s rig ${rig}, so library clips would not fit ${off.length === 1 ? "it" : "them"}. ${rig === STANDARD_RIG ? `A character that plays them is built with game_blender_character, which puts it on the rig, or taken from ${packs.join(", ")}` : `Characters that play them come from ${packs.join(", ")}`}. ${ownRig} Or change ${GAME_STYLE_FILE}'s rig to move every character.`;
};

/**
 * Why an armature may not enter on its own rig, or null. The lock's rig exists so library clips
 * fit every character; a rigged model carrying clips of its own needs none, so it enters on its
 * own rig: the rig never governs it and it plays only its own clips. One with no clips would need
 * library clips, and one carrying them is the rig's.
 */
export const ownRigRefusal = (
  name: string,
  clips: { readonly own: ReadonlyArray<string>; readonly library: ReadonlyArray<string> },
): string | null => {
  if (clips.library.length > 0)
    return `${name} is marked on its own rig (kurambit_rig) but carries library clips (${clips.library.slice(0, 6).join(", ")}), which fit only ${GAME_STYLE_FILE}'s rig. A model on its own rig plays only clips keyed on it: remove those, or leave the mark off and keep the character on the rig.`;
  if (clips.own.length === 0)
    return `${name} is marked on its own rig (kurambit_rig) but carries no clips, so it could only play library clips, which fit only ${GAME_STYLE_FILE}'s rig. Key its clips on it as named actions (an idle first: Idle, Walk, Attack, or its own moves), or build the character with game_blender_character.`;
  return null;
};

/** The export budgets a lock sets, each falling back to its default. */
export const styleBudgets = (style: GameStyle | null) => ({
  character: style?.budget?.character ?? GAME_STYLE_DEFAULT_BUDGET.character,
  prop: style?.budget?.prop ?? GAME_STYLE_DEFAULT_BUDGET.prop,
  texture: style?.budget?.texture ?? GAME_STYLE_DEFAULT_BUDGET.texture,
});

/**
 * The lock's identity for a review key: any change to STYLE.json, even one a pass would
 * not notice, makes an earlier review stale. Key order and spacing do not count.
 */
export const styleHash = (style: GameStyle | null): string =>
  style === null
    ? "none"
    : NodeCrypto.createHash("sha256").update(stableStringify(style)).digest("hex");

/** How the person chose to make this game's characters: game.json's choice, or library. */
export const characterRoute = (manifest: Pick<GameManifest, "characters">): GameCharacterRoute =>
  manifest.characters ?? GAME_STYLE_DEFAULT_CHARACTERS;

/**
 * The routes whose characters may be made in Blender. Library means the library first: a subject
 * it has no model of (a robot, a cat) is made in Blender rather than stood in by something else.
 * Generated ships only what the person's providers made, or library and stamped sources.
 */
const MAKES_CHARACTERS: Record<GameCharacterRoute, boolean> = {
  library: true,
  blender: true,
  generated: false,
};

/**
 * Why the person's character route refuses a character, or null: on the generated route, an
 * MPFB2 body or a character mesh that came from no stamped source is not theirs to ship; off
 * the generated route, neither is a generated character or creature.
 */
export const lockCharacterRouteRefusal = (
  what: "mpfb-body" | "unstamped-mesh" | "generated-body",
  route: GameCharacterRoute,
): string | null => {
  if (what === "generated-body" ? route === "generated" : MAKES_CHARACTERS[route]) return null;
  const thing =
    what === "mpfb-body"
      ? "An MPFB2 body is a Blender-made character"
      : what === "generated-body"
        ? "A generated character or creature (an AI provider made its body)"
        : "A character mesh with no library or import source is a Blender-made character";
  return `${thing}, and the person chose to make this game's characters with ${route}. Use ${route === "generated" ? "a generated character (game_generate) or a library body" : route === "library" ? "a library body, or make the character in Blender" : "a library body or the lock's packs"}, and if the request needs another kind of character, say so in your reply: only the person changes how characters are made, in the game's "Make characters with" setting.`;
};
