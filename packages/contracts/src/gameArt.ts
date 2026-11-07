import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/**
 * Generated art: each kind of asset (a lane) goes to the specialist that makes it best, and the
 * game's pipeline (conform, style pass, review, facts, ledger) makes what comes back one look.
 */
export const GameArtLane = Schema.Literals([
  /** Key art, concepts, character sheets, sprites, UI art, covers. */
  "image",
  /** A humanoid: rigged, conformed to the standard humanoid skeleton, shares the clip library. */
  "character",
  /** Any other body plan (quadruped, avian, serpentine, …): keeps its own rig and its own clips. */
  "creature",
  /** A prop, vehicle or building: unrigged. */
  "model",
  /** A tileable surface. */
  "texture",
  "sfx",
  "music",
  "voice",
]);
export type GameArtLane = typeof GameArtLane.Type;

export const GameArtProviderId = Schema.Literals([
  /** Codex's image generation on the person's ChatGPT plan: no key. */
  "codex",
  "openai",
  "google",
  "tripo",
  "meshy",
  "elevenlabs",
  /** Kurambit's own plan: one account for every lane (a later adapter; never required). */
  "kurambit",
]);
export type GameArtProviderId = typeof GameArtProviderId.Type;

/** A creature's body plan: the generator rigs it on its own skeleton of this kind. */
export const GameArtBodyPlan = Schema.Literals([
  "quadruped",
  "avian",
  "serpentine",
  "aquatic",
  "hexapod",
  "octopod",
  "other",
]);
export type GameArtBodyPlan = typeof GameArtBodyPlan.Type;

export interface GameArtProviderInfo {
  readonly label: string;
  readonly lanes: ReadonlyArray<GameArtLane>;
  /** The settings key holding its API key; null when it needs none (Codex) or signs in instead. */
  readonly keySetting:
    | "gameOpenAiApiKey"
    | "gameGoogleApiKey"
    | "gameTripoApiKey"
    | "gameMeshyApiKey"
    | "gameElevenLabsApiKey"
    | null;
  /** The hosts its adapter talks to, shown in Settings. */
  readonly hosts: ReadonlyArray<string>;
  /** Where the person gets a key or reads the terms. */
  readonly site: string;
}

/** Every provider and what it can make. One table: the server's adapters and Settings read it. */
export const GAME_ART_PROVIDERS: Readonly<Record<GameArtProviderId, GameArtProviderInfo>> = {
  codex: {
    label: "Codex (ChatGPT plan)",
    lanes: ["image", "texture"],
    keySetting: null,
    hosts: [],
    site: "https://openai.com/codex",
  },
  openai: {
    label: "OpenAI",
    lanes: ["image", "texture"],
    keySetting: "gameOpenAiApiKey",
    hosts: ["api.openai.com"],
    site: "https://platform.openai.com/api-keys",
  },
  google: {
    label: "Google Gemini",
    lanes: ["image", "texture"],
    keySetting: "gameGoogleApiKey",
    hosts: ["generativelanguage.googleapis.com"],
    site: "https://aistudio.google.com/apikey",
  },
  tripo: {
    label: "Tripo",
    lanes: ["character", "creature", "model"],
    keySetting: "gameTripoApiKey",
    hosts: ["openapi.tripo3d.com"],
    site: "https://platform.tripo3d.ai",
  },
  meshy: {
    label: "Meshy",
    lanes: ["character", "creature", "model", "texture"],
    keySetting: "gameMeshyApiKey",
    hosts: ["api.meshy.ai"],
    site: "https://www.meshy.ai/api",
  },
  elevenlabs: {
    label: "ElevenLabs",
    lanes: ["sfx", "music", "voice"],
    keySetting: "gameElevenLabsApiKey",
    hosts: ["api.elevenlabs.io"],
    site: "https://elevenlabs.io/app/settings/api-keys",
  },
  kurambit: {
    label: "Kurambit plan",
    lanes: ["image", "character", "creature", "model", "texture", "sfx", "music", "voice"],
    keySetting: null,
    hosts: [],
    site: "https://kurambit.com",
  },
};

/** Per lane, the providers in the order "auto" tries them: the person's own keys first, the plan last. */
export const GAME_ART_LANE_ORDER: Readonly<Record<GameArtLane, ReadonlyArray<GameArtProviderId>>> =
  {
    image: ["codex", "openai", "google", "kurambit"],
    texture: ["google", "openai", "codex", "meshy", "kurambit"],
    character: ["meshy", "tripo", "kurambit"],
    creature: ["tripo", "meshy", "kurambit"],
    model: ["tripo", "meshy", "kurambit"],
    sfx: ["elevenlabs", "kurambit"],
    music: ["elevenlabs", "kurambit"],
    voice: ["elevenlabs", "kurambit"],
  };

/** The person's choice per lane: auto (the order above) or one provider. */
export const GameArtLaneChoice = Schema.Union([Schema.Literal("auto"), GameArtProviderId]);
export type GameArtLaneChoice = typeof GameArtLaneChoice.Type;
/** Settings' per-lane choices; a lane left out is auto. */
export const GameArtLaneChoices = Schema.Struct({
  image: Schema.optionalKey(GameArtLaneChoice),
  texture: Schema.optionalKey(GameArtLaneChoice),
  character: Schema.optionalKey(GameArtLaneChoice),
  creature: Schema.optionalKey(GameArtLaneChoice),
  model: Schema.optionalKey(GameArtLaneChoice),
  sfx: Schema.optionalKey(GameArtLaneChoice),
  music: Schema.optionalKey(GameArtLaneChoice),
  voice: Schema.optionalKey(GameArtLaneChoice),
});
export type GameArtLaneChoices = typeof GameArtLaneChoices.Type;

const GamePath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

export const GameArtOptions = Schema.Struct({
  /** image: a transparent background (sprites, UI). */
  transparent: Schema.optionalKey(Schema.Boolean),
  /** image: "1:1", "16:9", "9:16", "4:3", "3:4". */
  aspect: Schema.optionalKey(Schema.Literals(["1:1", "16:9", "9:16", "4:3", "3:4"])),
  /** character, creature, model: the triangle budget asked of the generator. */
  polycount: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 500, maximum: 200_000 })),
  ),
  /** character, creature: standing height in metres. */
  height: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 50 }))),
  /** creature: its body plan, so the generator rigs it on the right kind of skeleton. */
  body: Schema.optionalKey(GameArtBodyPlan),
  /** creature: clips asked of the generator by plain name ("walk", "run", "attack"). */
  clips: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(16)),
  ),
  /** texture: tiles seamlessly. */
  seamless: Schema.optionalKey(Schema.Boolean),
  /** sfx, music, voice: seconds. */
  seconds: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 300 })),
  ),
  /** sfx, music: loops without a seam. */
  loop: Schema.optionalKey(Schema.Boolean),
});
export type GameArtOptions = typeof GameArtOptions.Type;

/**
 * One look the person may choose, for the image and texture lanes: a different rendering, palette,
 * shape language or camera, never another sample of the same idea.
 */
export const GameArtDirection = Schema.Struct({
  /** What the person reads on the pick card: "Low-poly pastel", "Chunky toon". */
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  /** How this direction looks, added to the shared prompt. */
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  /**
   * A real look the game can reach, sent as the first image: a library pack id (its preview picture)
   * or a game path to an image. Image models drift back to their own polish; a picture holds them.
   */
  style: Schema.optionalKey(GamePath),
});
export type GameArtDirection = typeof GameArtDirection.Type;

/** game_generate: one asset, or 2-4 distinct directions of it for the person to pick from. */
export const GameGenerateInput = Schema.Struct({
  lane: GameArtLane,
  /** What to make, the thing itself; the game's look comes from references and the style anchor. */
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  /** The file stem the result lands under: art/generated/<lane>/<name>/. */
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,47}$/)),
  /** Game-relative images it must match: the key art, a picked concept, a character sheet. */
  references: Schema.optionalKey(Schema.Array(GamePath).check(Schema.isMaxLength(4))),
  /** image and texture: 2-4 distinct looks, one image each, that the person picks from; omitted makes one. */
  directions: Schema.optionalKey(
    Schema.Array(GameArtDirection).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
  ),
  options: Schema.optionalKey(GameArtOptions),
});
export type GameGenerateInput = typeof GameGenerateInput.Type;

export const GameGenerationState = Schema.Literals([
  /** Sent to the provider; waiting on it. */
  "making",
  /** Candidates are in; waiting for the person's pick. */
  "choosing",
  /** The files are in the game. */
  "done",
  "failed",
  "cancelled",
]);
export type GameGenerationState = typeof GameGenerationState.Type;

export const GameGenerationCandidate = Schema.Struct({
  /** Game-relative preview image of this candidate. */
  preview: GamePath,
  /** The direction it was made from, as the pick card shows it. */
  label: Schema.optionalKey(Schema.String),
});
export type GameGenerationCandidate = typeof GameGenerationCandidate.Type;

/** One generation, as every surface reads it. */
export const GameGeneration = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9-]{8,64}$/)),
  threadId: ThreadId,
  lane: GameArtLane,
  provider: GameArtProviderId,
  name: Schema.String,
  prompt: Schema.String,
  references: Schema.Array(GamePath),
  state: GameGenerationState,
  candidates: Schema.Array(GameGenerationCandidate),
  /** The candidate kept: the person's pick, or the only one. */
  chosen: Schema.NullOr(NonNegativeInt),
  /** Who picked: the person, or Keep going's autopilot (the first). */
  chosenBy: Schema.NullOr(Schema.Literals(["person", "autopilot", "only"])),
  /** Game-relative files delivered (models, images, audio). */
  files: Schema.Array(GamePath),
  /** What it was expected to cost, and what it cost, in USD; null when free or unknown. */
  estimateUsd: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GameGeneration = typeof GameGeneration.Type;

export const GameGenerateResult = Schema.Struct({
  text: Schema.String,
  generation: GameGeneration,
});
export type GameGenerateResult = typeof GameGenerateResult.Type;

/** game_generate_wait: until the generation is done, waits on the person's pick, fails, or `seconds` pass. */
export const GameGenerateWaitInput = Schema.Struct({
  id: Schema.String,
  seconds: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 540 }))),
});
export type GameGenerateWaitInput = typeof GameGenerateWaitInput.Type;

export const GameGenerationsInput = Schema.Struct({ threadId: ThreadId });
export type GameGenerationsInput = typeof GameGenerationsInput.Type;
export const GameGenerationsResult = Schema.Struct({
  generations: Schema.Array(GameGeneration),
  /** Spent today across every game, and the person's daily limit (USD). */
  spentTodayUsd: Schema.Number,
  dailyLimitUsd: Schema.Number,
});
export type GameGenerationsResult = typeof GameGenerationsResult.Type;

/** The person picks a candidate; only a person does (Keep going's autopilot takes the first). */
export const GameChooseGenerationInput = Schema.Struct({
  threadId: ThreadId,
  id: Schema.String,
  candidate: NonNegativeInt,
});
export type GameChooseGenerationInput = typeof GameChooseGenerationInput.Type;
export const GameCancelGenerationInput = Schema.Struct({ threadId: ThreadId, id: Schema.String });
export type GameCancelGenerationInput = typeof GameCancelGenerationInput.Type;
export const GameGenerationChangeResult = Schema.Struct({ generation: GameGeneration });
export type GameGenerationChangeResult = typeof GameGenerationChangeResult.Type;

/** One provider's standing, for Settings and game_status. */
export const GameArtProviderStatus = Schema.Struct({
  provider: GameArtProviderId,
  /** A key is saved (or none is needed and the tool it uses is there). */
  ready: Schema.Boolean,
  message: Schema.String,
});
export type GameArtProviderStatus = typeof GameArtProviderStatus.Type;
/** Per lane, the provider a generation would use now (the person's choice or auto); null when none is ready. */
export const GameArtLanes = Schema.Record(GameArtLane, Schema.NullOr(GameArtProviderId));
export type GameArtLanes = typeof GameArtLanes.Type;
export const GameArtProvidersResult = Schema.Struct({
  providers: Schema.Array(GameArtProviderStatus),
  /** Per lane, the provider "auto" would use now; null when none is ready. */
  lanes: GameArtLanes,
  /** Spent today across every game (USD), for Settings, which has no game thread to ask. */
  spentTodayUsd: Schema.optionalKey(Schema.Number),
});
export type GameArtProvidersResult = typeof GameArtProvidersResult.Type;

/** Pushed on a game's operation channel whenever one of its generations changes. */
export const GAME_ART_EVENT = "art";
