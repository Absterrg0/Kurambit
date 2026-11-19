// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- STYLE.json is a file in the game folder, read and decoded like ASSETS.md.
// STYLE.json's one reader: the game's look as recorded at the game root, decoded and
// checked against the library, for the art tools that fill defaults from it. It never
// refuses an asset for its look: the look is the agent's and the person's to choose.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  GAME_STYLE_DEFAULT_BUDGET,
  GAME_STYLE_DEFAULT_MUSIC_LUFS,
  GAME_STYLE_DEFAULT_SFX_PEAK_DBTP,
  GAME_STYLE_FILE,
  GAME_STYLE_ROLES,
  type GameBlenderRenderSpritesInput,
  type GameCharacterRoute,
  type GameManifest,
  GameOperationError,
  GameStyle,
  type GameLook,
  type GameStyleLock,
  type GameStyleLockInput,
  gameModelChoice,
} from "@kurambit/contracts";
import { awaitsMirror, type LibraryPack } from "./assetLibraryFiles.ts";
import { stableStringify } from "@kurambit/shared/stableJson";
import { LIBRARY_SOURCES } from "./assetLibrarySources.ts";
import { colourHex, hexColour, oklab } from "./spriteRender.ts";
import {
  CURATED_PACKS,
  LIBRARY_CATALOG,
  LIBRARY_FAMILIES,
  LIBRARY_RIG_ALIASES,
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
    ["packs", style.packs ?? []],
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
 * A sprite render with what it leaves out filled from STYLE.json: pixel-art settings, size and
 * views (each said in `notes`). What the input names always wins.
 */
export const lockSpriteInput = (
  input: GameBlenderRenderSpritesInput,
  style: GameStyle | null,
): { readonly input: GameBlenderRenderSpritesInput; readonly notes: ReadonlyArray<string> } => {
  if (style === null) return { input, notes: [] };
  const notes: string[] = [];
  let locked = input;
  if (style.mode === "pixel") {
    // STYLE.json's filter refuses a hex list in pixel mode, so only a pack id or a path reaches sprites.
    const palette =
      input.pixelArt?.palette ?? (typeof style.palette === "string" ? style.palette : undefined);
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
 * Whether a pack is part of the look STYLE.json records: its family's packs, the packs and
 * sources it lists, its palette pack, its sound packs. Search marks and ranks these first; it
 * never keeps a pack out.
 */
export const inLook = (pack: LibraryPack, style: GameStyle | null): boolean => {
  if (style === null) return false;
  const packs = style.packs ?? [];
  if (packs.includes(pack.id) || style.palette === pack.id) return true;
  if (!soundOnly(pack) && style.family !== undefined && pack.family === style.family) return true;
  if (pack.group !== undefined && packs.includes(pack.group)) return true;
  return (style.audio?.packs ?? []).includes(pack.id);
};

/**
 * The library animation packs on the standard skeleton a character's clips come from:
 * STYLE.json's when it lists some, else every one the library offers.
 */
export const standardClipPacks = (style: GameStyle | null): ReadonlyArray<string> => {
  const isClips = (id: string) => {
    const pack = LIBRARY_CATALOG.find((candidate) => candidate.id === id);
    return pack?.rig === STANDARD_RIG && pack.kinds.includes("animation");
  };
  const listed = (style?.packs ?? []).filter(isClips);
  return listed.length > 0 ? listed : OFFERED.map((pack) => pack.id).filter(isClips);
};

/** UI, icons, fonts and particles that sit with every look: every derived lock lists them. */
const INTERFACE_FAMILY = "kenney-interface";

/**
 * STYLE.json for a chosen family, as game_assets op add writes it before adding `adding`:
 * the family's visual packs (those on another rig left out), its rig (the added pack's,
 * else the one its packs share), its pixel mode, tile and palette, and the interface packs.
 * What else a lock already there holds (anchor, a key-art palette, audio, budgets)
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
      refusal: `lock.family "${lock.family}" is not a look to lock; the families are ${looks.join(", ")} (game_assets op search with no words describes each).`,
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

/**
 * A colour for every role from a palette: the palette colour nearest the role's own. A role
 * named `<role>2` is its role's second tone: the colour nearest the one its role took.
 */
const rolesFrom = (palette: ReadonlyArray<string>): Record<string, string> => {
  const colours = palette.flatMap((hex) => hexColour(hex) ?? []);
  const roles: Record<string, string> = {};
  if (colours.length === 0) return roles;
  // A role is its hue first (water is the blue one, however light), so lightness counts less.
  const apart = (a: number, b: number) => {
    const [l1, a1, b1] = oklab(a);
    const [l2, a2, b2] = oklab(b);
    return 0.3 * (l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2;
  };
  for (const [role, own] of Object.entries(GAME_STYLE_ROLES)) {
    const base = role.endsWith("2") ? roles[role.slice(0, -1)] : undefined;
    const pool = colours.filter((colour) => colours.length < 2 || colourHex(colour) !== base);
    // A second tone sits beside its role's colour, not beside the default it never took.
    const wanted = hexColour(base ?? own)!;
    roles[role] = colourHex(
      pool.reduce((best, c) => (apart(c, wanted) < apart(best, wanted) ? c : best)),
    );
  }
  return roles;
};

/**
 * STYLE.json for a look the game makes, as game_assets op lock writes it: the fields the input
 * names over those already there, with a colour for every role (named ones first, then the
 * palette's nearest, then what the lock held). `palette` is the hex list to derive from, already
 * read when the input named an image; a flat finish keeps it as the lock's palette (the style
 * pass's atlas), any other finish drops it so models keep their surfaces.
 */
export const styleFromLook = (
  input: GameStyleLockInput,
  palette: ReadonlyArray<string> | null,
  existing: GameStyle | null,
): { readonly style: GameStyle } | { readonly refusal: string } => {
  if (existing?.mode === "pixel")
    return {
      refusal: `${GAME_STYLE_FILE} is a pixel lock: its palette is its pack's and its sprites are drawn, not built. Delete it to lock a made 3D look instead.`,
    };
  const view = input.view ?? existing?.view;
  if (view === undefined)
    return { refusal: "lock needs view: side, top-down, isometric or perspective." };
  const held = Array.isArray(existing?.palette) ? existing.palette : null;
  const finish = input.finish ?? existing?.finish ?? (palette !== null || held ? "flat" : "real");
  const source = palette ?? held;
  const roles = {
    ...existing?.roles,
    ...(palette === null ? {} : rolesFrom(palette)),
    ...input.roles,
  };
  const kept = existing === null ? {} : Struct.omit(existing, ["palette", "anchor"]);
  const anchor = typeof input.palette === "string" ? input.palette : existing?.anchor;
  const candidate = {
    ...kept,
    version: 1,
    mode: "smooth",
    view,
    ...(finish === "flat" && source !== null ? { palette: source } : {}),
    ...(anchor === undefined ? {} : { anchor }),
    ...(Object.keys(roles).length === 0 ? {} : { roles }),
    ...(input.shape === undefined && existing?.shape === undefined
      ? {}
      : { shape: { ...existing?.shape, ...input.shape } }),
    finish,
    ...(input.surfaces === undefined && existing?.surfaces === undefined
      ? {}
      : { surfaces: { ...existing?.surfaces, ...input.surfaces } }),
  };
  const checked = checkStyle(candidate);
  if (Result.isFailure(checked))
    return { refusal: `The lock is not valid: ${checked.failure.message.slice(0, 1200)}` };
  const problem = styleProblem(checked.success);
  return problem === null
    ? { style: checked.success }
    : { refusal: `The lock is not valid: ${problem}` };
};

/** What of a lock the game's code reads (shell/model.js): its colours, shape, finish and surfaces, every role holding a colour. */
export const gameLook = (style: GameStyle | null): GameLook => ({
  ...(style === null ? {} : { view: style.view }),
  ...(Array.isArray(style?.palette) ? { palette: style.palette } : {}),
  roles: { ...GAME_STYLE_ROLES, ...style?.roles },
  ...(style?.shape === undefined ? {} : { shape: style.shape }),
  ...(style?.finish === undefined ? {} : { finish: style.finish }),
  ...(style?.surfaces === undefined ? {} : { surfaces: style.surfaces }),
});

/**
 * The character preset a lock's proportions ask for, for a character made with no style named:
 * the same `shape.chunky` the world's trunks and roofs are built by. Null when the lock names none.
 */
export const lockedCharacterStyle = (style: GameStyle | null) => {
  const chunky = style?.shape?.chunky;
  if (chunky === undefined) return null;
  const preset =
    chunky < 0.2 ? "realistic" : chunky < 0.45 ? "heroic" : chunky < 0.75 ? "cartoon" : "chibi";
  return { preset } as const;
};

/** Where a game's page finds its look, beside the runtime it loads (and inside an export). */
export const LOOK_ROUTE = "_kurambit/look.json";

/**
 * The look as the game's page reads it: JSON of gameLook. A game with no lock, or one that does
 * not read (the art tools refuse that one loudly), gets the roles' own colours and nothing else.
 */
export const gameLookJson = (root: string): Effect.Effect<string> =>
  Effect.tryPromise(() => NodeFSP.realpath(root)).pipe(
    Effect.flatMap(readGameStyle),
    Effect.orElseSucceed(() => null),
    Effect.map((style) => JSON.stringify(gameLook(style))),
  );

/** The loudness targets a lock sets, or the defaults without one. */
export const loudnessTargets = (style: GameStyle | null) => ({
  musicLufs: style?.audio?.musicLufs ?? GAME_STYLE_DEFAULT_MUSIC_LUFS,
  sfxPeakDbtp: style?.audio?.sfxPeakDbtp ?? GAME_STYLE_DEFAULT_SFX_PEAK_DBTP,
  fromLock: style?.audio?.musicLufs !== undefined || style?.audio?.sfxPeakDbtp !== undefined,
});

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
    return `${name} is marked on its own rig (kurambit_rig) but carries no clips, so it could only play library clips, which fit only ${GAME_STYLE_FILE}'s rig. Key its clips on it as named actions (an idle first: Idle, Walk, Attack, or its own moves), or build the character with game_blender op character.`;
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

/** Why a library model, texture or sprite is refused while the person has the library off. */
export const LIBRARY_OFF_REFUSAL =
  "the person turned the library off for this game, so its models, textures and sprites are not used: build what you need in code (shell/model.js) or on the game's route. Clips (quaternius-universal-animation-library, for a character in code) and sounds still come in. Say so in your reply if the request needs library models: the person turns the library on in the game's \"Make models with\" setting.";

/** Whether a pack is the standard skeleton's clips: those come in with the library off. */
export const isClipPack = (pack: Pick<LibraryPack, "rig" | "kinds">) =>
  pack.rig === STANDARD_RIG && pack.kinds.includes("animation");

/** How the person chose to make this game's models, and whether the library is on (gameModelChoice). */
export const modelChoice = (
  manifest: Pick<GameManifest, "characters" | "library">,
): GameModelChoice => gameModelChoice(manifest);
export type GameModelChoice = ReturnType<typeof gameModelChoice>;

/** How the person chose to make this game's models. */
export const characterRoute = (manifest: Pick<GameManifest, "characters" | "library">) =>
  gameModelChoice(manifest).route;

/**
 * Whether characters may be made in Blender: on the Blender route, and wherever the library is on,
 * which means the library first and Blender for a subject it has no model of (a robot, a cat), as
 * the old library route did. Code with the library off makes them in code; generated ships only
 * what the person's providers made, or library and stamped sources.
 */
const makesInBlender = (choice: GameModelChoice) =>
  choice.route === "blender" || (choice.route === "code" && choice.library);

const ROUTE_USE: Record<GameCharacterRoute, string> = {
  code: "build it in three.js code (shell/model.js)",
  blender: "make it in Blender",
  generated: "use a generated character (game_assets op generate)",
};

/**
 * Why the person's model choice refuses a character, or null: on the generated route, an MPFB2
 * body or a character mesh that came from no stamped source is not theirs to ship; off the
 * generated route, neither is a generated character or creature; on the code route with the
 * library off, neither is a Blender-made one.
 */
export const lockCharacterRouteRefusal = (
  what: "mpfb-body" | "unstamped-mesh" | "generated-body",
  choice: GameModelChoice,
): string | null => {
  if (what === "generated-body" ? choice.route === "generated" : makesInBlender(choice))
    return null;
  const thing =
    what === "mpfb-body"
      ? "An MPFB2 body is a Blender-made character"
      : what === "generated-body"
        ? "A generated character or creature (an AI provider made its body)"
        : "A character mesh with no library or import source is a Blender-made character";
  return `${thing}, and the person chose to make this game's models with ${choice.route}${choice.library ? " and the library" : ""}. Instead ${ROUTE_USE[choice.route]}${choice.library ? " or use a library model" : ""}. If the request needs another kind of model, say so in your reply: the person changes how models are made in the game's "Make models with" setting.`;
};
