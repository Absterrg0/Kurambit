// What the game layer asks of an engine that is plain data: directories, how its games
// play, which harness duties apply and the engine's own prompt lines. No I/O, so the run's
// pure policy reads it too. Engine behaviour (processes, editors, exports) is the
// backend's, in GameEngine.ts; each backend carries its engine's profile.
import type { GameEngineId, GameViewport } from "@kurambit/contracts";
import { GODOT_PROFILE } from "./godotProfile.ts";
import { THREE_PROFILE } from "./threeProfile.ts";
import { UNITY_PROFILE } from "./unityProfile.ts";

export type GameExportTarget = "Web" | "Linux" | "Windows";

export interface GameEngineProfile {
  readonly id: GameEngineId;
  /** Short human name for honest operation messages ("Godot", "three.js", "Unity"). */
  readonly displayName: string;
  /** The engine project directory a new game gets; the run calls it the lane. */
  readonly projectDirectory: string;
  /** Which export targets this engine can release. Anything else is refused plainly. */
  readonly exportTargets: ReadonlyArray<GameExportTarget>;
  /** Under the engine project directory: the game's art, its icon and title art, library packs and Blender exports. */
  readonly layout: {
    readonly assets: string;
    readonly ui: string;
    readonly library: string;
    readonly blender: string;
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
      /** Where a game defines its own setState targets (a check's setup jumps there). */
      readonly stateHook: string;
    };
  };
}

// Keyed by every engine id, so a new engine in the contracts does not compile without its profile.
const BY_ID: Readonly<Record<GameEngineId, GameEngineProfile>> = {
  godot: GODOT_PROFILE,
  three: THREE_PROFILE,
  unity: UNITY_PROFILE,
};
const PROFILES = Object.values(BY_ID);

export const engineProfile = (id: GameEngineId): GameEngineProfile => BY_ID[id];

/**
 * The profile of the engine whose project directory the run's lane names. A
 * lane no engine names is a hand-renamed project directory; it reads as Godot,
 * the engine whose directory was free-form before engines had their own.
 */
export const laneProfile = (lane: string): GameEngineProfile =>
  PROFILES.find((profile) => profile.projectDirectory === lane) ?? GODOT_PROFILE;

/** Game-relative directory of the lane's art. */
export const laneAssets = (lane: string): string => `${lane}/${laneProfile(lane).layout.assets}`;

/** Game-relative directory of the lane's icon and title art. */
export const laneUi = (lane: string): string =>
  `${laneAssets(lane)}/${laneProfile(lane).layout.ui}`;

/** Game-relative directory library packs land in. */
export const laneLibrary = (lane: string): string =>
  `${laneAssets(lane)}/${laneProfile(lane).layout.library}`;

/** Every engine's skill name, for dropping the ones a lane does not use. */
export const ENGINE_SKILLS: ReadonlyArray<string> = PROFILES.map((profile) => profile.run.skill);
