// What the game layer asks of an engine that is plain data: directories, how its games
// play, which harness duties apply and the engine's own prompt lines. No I/O, so the run's
// pure policy reads it too. Engine behaviour (processes, editors, exports) is the
// backend's, in GameEngine.ts; each backend carries its engine's profile.
import type {
  GameEngineId,
  GameEngineStatus,
  GameExportTarget,
  GameStageKind,
  GameViewport,
} from "@kurambit/contracts";
import { GODOT_PROFILE } from "./godotProfile.ts";
import { THREE_PROFILE } from "./threeProfile.ts";
import { UNITY_PROFILE } from "./unityProfile.ts";

export type { GameExportTarget } from "@kurambit/contracts";

/** One release an engine makes: where it lands and how it ships. */
export interface GameProfileRelease {
  readonly target: GameExportTarget;
  /** Game-relative file that names the published release; null for Web, whose build is the selected candidate. */
  readonly artifact: string | null;
  /** One file, or a folder whose files ship together. */
  readonly ships: "file" | "folder";
  /** Whether Kurambit packages it as a download. */
  readonly packageable: boolean;
}

/** What of an engine project is build input; everything else is the engine's own output. */
export interface GameSourceRules {
  /** Directory names never walked, anywhere in the tree. */
  readonly skipDirs: ReadonlyArray<string>;
  /** Directory names at the project root the engine writes. */
  readonly rootOutputDirs: ReadonlyArray<string>;
  /** File suffixes the engine generates beside real sources. */
  readonly sidecarSuffixes: ReadonlyArray<string>;
  /** Files at the project root the engine or its IDE writes; null when none. */
  readonly rootOutputFiles: RegExp | null;
  /** Small `.asset` files are read through the URP settings normalisation (see sourceSnapshot). */
  readonly derivedAssets: boolean;
}

export interface GameEngineProfile {
  readonly id: GameEngineId;
  /** Active or parked (GAME_ENGINES' own answer, where the one switch lives). */
  readonly status: GameEngineStatus;
  /** The live editors its games are made in, beyond the code: each one's agent tools need it. */
  readonly editors: ReadonlyArray<"blender" | "unity">;
  /**
   * When a chat turn changes the game, play and measure its build at once. Off
   * for an engine whose build is too slow to follow every turn (parked lanes).
   */
  readonly turnLoop: boolean;
  /** How the Stage shows this engine's game (GAME_ENGINES' own answer). */
  readonly stage: GameStageKind;
  /**
   * The values file the Stage bridge's Keep as a build writes, under the
   * engine directory, which the game reads at boot; null where the engine's
   * games have no Stage bridge yet.
   */
  readonly tuneFile: string | null;
  /** Short human name for honest operation messages ("Godot", "three.js", "Unity"). */
  readonly displayName: string;
  /** The engine project directory a new game gets; the run calls it the lane. */
  readonly projectDirectory: string;
  /** Which export targets this engine can release (the targets of `releases`). Anything else is refused plainly. */
  readonly exportTargets: ReadonlyArray<GameExportTarget>;
  /** Every release it makes, by target. */
  readonly releases: ReadonlyArray<GameProfileRelease>;
  /** What of the project is build input, for the source identity. */
  readonly buildInputs: GameSourceRules;
  /** A new game: the engine version the manifest records, the folders made beside the template's, and the opening of its AGENTS.md. */
  readonly scaffold: {
    readonly version: string;
    readonly directories: ReadonlyArray<string>;
    readonly agents: string;
    /** .gitignore patterns for what the engine generates; every game ignores every engine's. */
    readonly ignores: ReadonlyArray<string>;
  };
  /** The path a game's code loads a project-relative file by (res://x, ./x, Assets/x). */
  readonly resourcePath: (projectRelative: string) => string;
  /**
   * Where art must sit for the engine to import it at all, relative to the
   * project (Unity's case-sensitive Assets/); null when anywhere under it does.
   */
  readonly importRoot: string | null;
  /** Whether game_import does work here; false when the project's files are the game as they are. */
  readonly importStep: boolean;
  /**
   * Whether a Blender export ships compressed (WebP images, meshopt geometry and clips): true where
   * the player downloads the GLB itself. An engine that imports models re-encodes them its own way.
   */
  readonly compressedModels: boolean;
  /** How a sprite's ground line `ground` rows from the top becomes the node origin. */
  readonly groundHint: (width: number, height: number, ground: number) => string;
  /** How the game loads a rendered strip's manifest; null when it reads it itself. */
  readonly stripLoad: ((key: string, resource: string, view: string) => string) | null;
  /** How the game loads an exported model's sidecar; null when the engine imports the GLB itself. */
  readonly sidecarLoad: ((key: string, sidecar: string) => string) | null;
  /** One sentence each for the game tools whose behaviour differs by engine. */
  readonly tools: {
    readonly import: string;
    readonly check: string;
    readonly export: string;
    readonly explore: string;
  };
  /** Under the engine project directory: the game's art, its icon and title art, library packs and Blender exports. */
  readonly layout: {
    readonly assets: string;
    readonly ui: string;
    readonly library: string;
    readonly blender: string;
    /** Where rendered sprite strips go, under assets. */
    readonly sprites: string;
    /** The file the game's credits screen reads, under the project directory. */
    readonly credits: string;
  };
  /**
   * How its plays on a private Linux display draw when that differs from the
   * game's own renderer: the project settings file (under the project
   * directory) and the note it gives, null when they draw alike.
   */
  readonly xvfbRenderer: {
    readonly settings: string;
    readonly note: (settings: string) => string | null;
  } | null;
  /** The fixed resolution its games boot, explore and bot-play at; null when the project settings declare it. */
  readonly viewport: GameViewport | null;
  /**
   * How explore sessions and bot runs play a game: a page in headless
   * Chromium, the engine's own runner on the sources, or a player built from
   * the sources once per source identity.
   */
  readonly play: "browser" | "native" | "player";
  /**
   * The files of a Web release, relative to its directory: `exported` must be
   * nonempty after an export, `served` must stay present for Play. Null when
   * the engine has no Web export.
   */
  readonly web: {
    readonly exported: ReadonlyArray<string>;
    readonly served: ReadonlyArray<string>;
  } | null;
  readonly check: {
    readonly timedOut: string;
    /** The warning a check without a gameplay scene carries, when it then covers less. */
    readonly withoutGameplayScene: string | null;
  };
  /** This engine's skill in the studio pack; a game keeps it and drops the other engines'. */
  readonly skill: string;
}

// Keyed by every engine id, so a new engine in the contracts does not compile without its profile.
const BY_ID: Readonly<Record<GameEngineId, GameEngineProfile>> = {
  godot: GODOT_PROFILE,
  three: THREE_PROFILE,
  unity: UNITY_PROFILE,
};
export const PROFILES: ReadonlyArray<GameEngineProfile> = Object.values(BY_ID);

export const engineProfile = (id: GameEngineId): GameEngineProfile => BY_ID[id];

/** What an agent runs after it brought a file into the engine project. */
export const afterAddingArt = (profile: GameEngineProfile) =>
  profile.importStep ? "Run game_import, then game_check." : "Run game_check.";

/**
 * What a game tool can need of its game's engine. `play` is every active
 * engine's: a parked engine has no capabilities, so its games' agents get
 * only the tools that need none (status, builds, saved media).
 */
export type GameEngineCapability =
  | "play"
  | "import"
  | "tune"
  | "turnLoop"
  | "packageWeb"
  | "packageWindows"
  | "blender"
  | "unity";
const packageable = (profile: GameEngineProfile, target: GameExportTarget) =>
  profile.releases.some((release) => release.target === target && release.packageable);
const capabilitiesOf = (profile: GameEngineProfile): ReadonlySet<GameEngineCapability> =>
  new Set<GameEngineCapability>(
    profile.status === "parked"
      ? []
      : [
          "play",
          ...(profile.importStep ? (["import"] as const) : []),
          ...(profile.tuneFile === null ? [] : (["tune"] as const)),
          ...(profile.turnLoop ? (["turnLoop"] as const) : []),
          ...(packageable(profile, "Web") ? (["packageWeb"] as const) : []),
          ...(packageable(profile, "Windows") ? (["packageWindows"] as const) : []),
          ...profile.editors,
        ],
  );
const CAPABILITIES: Readonly<Record<GameEngineId, ReadonlySet<GameEngineCapability>>> = {
  godot: capabilitiesOf(GODOT_PROFILE),
  three: capabilitiesOf(THREE_PROFILE),
  unity: capabilitiesOf(UNITY_PROFILE),
};
export const engineCapabilities = (id: GameEngineId): ReadonlySet<GameEngineCapability> =>
  CAPABILITIES[id];

/** A game's folders, game-relative with forward slashes, from its engine and its project folder. */
export const gamePaths = (engine: GameEngineId, project: string) => {
  const { layout } = BY_ID[engine];
  const assets = `${project}/${layout.assets}`;
  return {
    assets,
    ui: `${assets}/${layout.ui}`,
    library: `${assets}/${layout.library}`,
    blender: `${project}/${layout.blender}`,
    sprites: `${assets}/${layout.sprites}`,
    credits: `${project}/${layout.credits}`,
  };
};

/** Every engine's skill name, for dropping the ones a lane does not use. */
export const ENGINE_SKILLS: ReadonlyArray<string> = PROFILES.map((profile) => profile.skill);
