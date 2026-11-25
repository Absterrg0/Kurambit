// What the game layer asks of an engine that is plain data: directories, how its games
// play, which harness duties apply and the engine's own prompt lines. No I/O, so the run's
// pure policy reads it too. A new engine adds its profile here, keyed by its GameEngineId.
// Engine behaviour (processes, editors, exports) is the backend's, in GameEngine.ts; each
// backend carries its engine's profile.
import {
  type GameEngineId,
  type GameExportTarget,
  type GameStageKind,
  type GameViewport,
} from "@kurambit/contracts";
import { THREE_PROFILE } from "./threeProfile.ts";

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

export interface GameEngineProfile {
  readonly id: GameEngineId;
  /** The live editors its games are made in, beyond the code: each one's agent tools need it. */
  readonly editors: ReadonlyArray<"blender">;
  /**
   * When a chat turn changes the game, play and measure its build at once. Off
   * for an engine whose build is too slow to follow every turn.
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
  /** Short human name for honest operation messages ("three.js"). */
  readonly displayName: string;
  /** The engine project directory a new game gets; the run calls it the lane. */
  readonly projectDirectory: string;
  /** Which export targets this engine can release (the targets of `releases`). Anything else is refused plainly. */
  readonly exportTargets: ReadonlyArray<GameExportTarget>;
  /** Every release it makes, by target. */
  readonly releases: ReadonlyArray<GameProfileRelease>;
  /** A new game: the engine version the manifest records, the folders made beside the template's, and the opening of its AGENTS.md. */
  readonly scaffold: {
    readonly version: string;
    readonly directories: ReadonlyArray<string>;
    readonly agents: string;
    /** .gitignore patterns for what the engine generates in its own games. */
    readonly ignores: ReadonlyArray<string>;
  };
  /** The path a game's code loads a project-relative file by (./x). */
  readonly resourcePath: (projectRelative: string) => string;
  /** Whether the engine imports a file before the game can load it; false when the project's files are the game as they are. */
  readonly importStep: boolean;
  /**
   * Whether a Blender export ships compressed (WebP images, meshopt geometry and clips): true where
   * the player downloads the GLB itself. An engine that imports models re-encodes them its own way.
   */
  readonly compressedModels: boolean;
  /** How a sprite's ground line `ground` rows from the top becomes the node origin. */
  readonly groundHint: (width: number, height: number, ground: number) => string;
  /** How the game loads an exported model's sidecar; null when the engine imports the GLB itself. */
  readonly sidecarLoad: ((key: string, sidecar: string) => string) | null;
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
  /** The resolution its games boot, explore and bot-play at. */
  readonly viewport: GameViewport;
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
  };
  /** This engine's skill in the studio pack; a game keeps it and drops the other engines'. */
  readonly skill: string;
}

// Keyed by every engine id, so a new engine in the contracts does not compile without its profile.
const BY_ID: Readonly<Record<GameEngineId, GameEngineProfile>> = {
  three: THREE_PROFILE,
};
export const PROFILES: ReadonlyArray<GameEngineProfile> = Object.values(BY_ID);

export const engineProfile = (id: GameEngineId): GameEngineProfile => BY_ID[id];

/** What an agent runs after it brought a file into the engine project. */
export const afterAddingArt = (profile: GameEngineProfile) =>
  profile.importStep ? "Run the engine's import, then game_check." : "Run game_check.";

/** What a game tool can need of its game's engine. `play` is every engine's. */
export type GameEngineCapability = "play" | "tune" | "turnLoop" | "packageWeb" | "blender";
const packageable = (profile: GameEngineProfile, target: GameExportTarget) =>
  profile.releases.some((release) => release.target === target && release.packageable);
const capabilitiesOf = (profile: GameEngineProfile): ReadonlySet<GameEngineCapability> =>
  new Set<GameEngineCapability>([
    "play",
    ...(profile.tuneFile === null ? [] : (["tune"] as const)),
    ...(profile.turnLoop ? (["turnLoop"] as const) : []),
    ...(packageable(profile, "Web") ? (["packageWeb"] as const) : []),
    ...profile.editors,
  ]);
const CAPABILITIES: Readonly<Record<GameEngineId, ReadonlySet<GameEngineCapability>>> = {
  three: capabilitiesOf(THREE_PROFILE),
};
export const engineCapabilities = (engine: GameEngineId): ReadonlySet<GameEngineCapability> =>
  CAPABILITIES[engine];

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
