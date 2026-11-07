// What the game layer asks of an engine that is plain data: directories, how its games
// play, which harness duties apply and the engine's own prompt lines. No I/O, so the run's
// pure policy reads it too. Engine behaviour (processes, editors, exports) is the
// backend's, in GameEngine.ts; each backend carries its engine's profile.
import type {
  GameEngineId,
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
  /**
   * When a chat turn changes the game, play and measure its build at once. Off
   * for an engine whose build is too slow to follow every turn (parked lanes).
   */
  readonly turnLoop: boolean;
  /** How the Stage shows this engine's game (GAME_ENGINES' own answer). */
  readonly stage: GameStageKind;
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
  /** A new game: the engine version the manifest records, and the folders made beside the template's. */
  readonly scaffold: { readonly version: string; readonly directories: ReadonlyArray<string> };
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
  };
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
  readonly run: {
    /** This engine's skill in the studio pack; a run keeps it and drops the other engines'. */
    readonly skill: string;
    /**
     * Files in the game the harness owns, under the engine directory: its
     * in-game play runner. A fresh run copies them from the engine's starter
     * template (`template`, a directory under the server templates), so games
     * made before a protocol change play by the current one.
     */
    readonly harnessFiles: {
      readonly template: string;
      readonly files: ReadonlyArray<string>;
    } | null;
    /** Whether a comparison's two samples may play at once. */
    readonly parallelSamples: boolean;
    /** Whether the project's first editor open is paid before the first root role's clock. */
    readonly warmEditor: boolean;
    /** Where reviewer code facts count source files: extensions, and the folder under the lane. */
    readonly sources: { readonly extensions: ReadonlyArray<string>; readonly under: string };
    /** Engine lines inside role prompts, written for the engine's standard directory. */
    readonly prompts: {
      /** How to build on the starter's demo shell; empty when the starter has none to follow. */
      readonly shell: string;
      /** The art stage's line on models and engine import. */
      readonly art: string;
      /** Appended to the art stage's title-art sentence. */
      readonly titleArt: string;
    };
  };
}

// Keyed by every engine id, so a new engine in the contracts does not compile without its profile.
const BY_ID: Readonly<Record<GameEngineId, GameEngineProfile>> = {
  godot: GODOT_PROFILE,
  three: THREE_PROFILE,
  unity: UNITY_PROFILE,
};
export const PROFILES: ReadonlyArray<GameEngineProfile> = Object.values(BY_ID);

export const engineProfile = (id: GameEngineId): GameEngineProfile => BY_ID[id];

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
  };
};

/**
 * The engine a project folder belongs to, for run records written before the
 * engine was kept beside it. A folder no engine names is a hand-renamed
 * project directory; it reads as Godot, the engine whose directory was
 * free-form before engines had their own.
 */
export const legacyLaneEngine = (lane: string): GameEngineId =>
  (PROFILES.find((profile) => profile.projectDirectory === lane) ?? GODOT_PROFILE).id;
/** A run's engine: the one it recorded, else the one its project folder implies. */
export const runEngine = (run: {
  readonly engine?: GameEngineId;
  readonly lane: string;
}): GameEngineId => run.engine ?? legacyLaneEngine(run.lane);
/** Every engine's skill name, for dropping the ones a lane does not use. */
export const ENGINE_SKILLS: ReadonlyArray<string> = PROFILES.map((profile) => profile.run.skill);
