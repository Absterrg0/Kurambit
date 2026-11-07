// ElevenLabs (https://elevenlabs.io/docs/api-reference): synchronous, the answer is the audio.
// Sound effects (v3, up to 30 s, seamless loops), music (v2.5, 3 s to 5 min) and voice lines (v4,
// one default voice). Each model id is set explicitly: the reference still defaults to sound v2
// and music v1, both deprecated. The cost is the price table's: the answer reports no dollars.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  type ArtAdapter,
  type ArtContext,
  type ArtRequest,
  requireKey,
  roundUsd,
} from "./adapter.ts";

const BASE = "https://api.elevenlabs.io/v1";
export const ELEVENLABS_MODELS = {
  sfx: "eleven_text_to_sound_v3",
  music: "music_v2_5",
  voice: "eleven_v4",
} as const;
/** The voice ElevenLabs' own text-to-speech examples use: the default until the person picks one. */
export const ELEVENLABS_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";
/** USD, 2026-11: per minute of sound effects and of music, per 1K characters spoken. */
const PRICE = { sfxMinute: 0.12, musicMinute: 0.15, voiceKChars: 0.08 } as const;
const DEFAULT_SECONDS = { sfx: 2, music: 60 } as const;

const sfxSeconds = (request: Pick<ArtRequest, "options">) =>
  Math.min(30, Math.max(0.5, request.options.seconds ?? DEFAULT_SECONDS.sfx));
const musicSeconds = (request: Pick<ArtRequest, "options">) =>
  Math.min(300, Math.max(3, request.options.seconds ?? DEFAULT_SECONDS.music));

/** The request for one sound: the shape the fixtures check. */
export const elevenLabsRequest = (request: Omit<ArtRequest, "references">, key: string) => {
  const headers = { "xi-api-key": key, accept: "audio/mpeg" };
  switch (request.lane) {
    case "music":
      return {
        method: "POST" as const,
        url: `${BASE}/music?output_format=mp3_44100_128`,
        headers,
        json: {
          prompt:
            request.options.loop === true
              ? `${request.prompt}\n\nIt loops: the end flows back into the start without a seam.`
              : request.prompt,
          music_length_ms: Math.round(musicSeconds(request) * 1000),
          model_id: ELEVENLABS_MODELS.music,
        },
      };
    case "voice":
      return {
        method: "POST" as const,
        url: `${BASE}/text-to-speech/${ELEVENLABS_DEFAULT_VOICE}?output_format=mp3_44100_128`,
        headers,
        json: { text: request.prompt, model_id: ELEVENLABS_MODELS.voice },
      };
    default:
      return {
        method: "POST" as const,
        url: `${BASE}/sound-generation?output_format=mp3_44100_128`,
        headers,
        json: {
          text: request.prompt,
          model_id: ELEVENLABS_MODELS.sfx,
          duration_seconds: sfxSeconds(request),
          loop: request.options.loop === true,
          prompt_influence: 0.3,
        },
      };
  }
};

const estimate = (request: Omit<ArtRequest, "references">) => {
  switch (request.lane) {
    case "music":
      return roundUsd((musicSeconds(request) / 60) * PRICE.musicMinute);
    case "voice":
      return roundUsd((request.prompt.length / 1000) * PRICE.voiceKChars);
    default:
      return roundUsd((sfxSeconds(request) / 60) * PRICE.sfxMinute);
  }
};

const start = (context: ArtContext, request: ArtRequest) =>
  Effect.gen(function* () {
    const key = yield* requireKey("elevenlabs", context);
    const bytes = yield* context.http.bytes("elevenlabs", elevenLabsRequest(request, key));
    return {
      kind: "done" as const,
      candidates: [[{ role: "asset" as const, ext: "mp3", bytes }]],
      costUsd: estimate(request),
    };
  });

export const ELEVENLABS_MUSIC_LICENCE =
  "ElevenLabs music on a paid self-serve plan: commercial use except film, TV, radio and Studio Games (a monetized game over $500k lifetime revenue, or from a developer over $1M a year, needs Enterprise Music). The free plan has no commercial licence.";

export const elevenlabs: ArtAdapter = {
  id: "elevenlabs",
  estimate: (request) => estimate(request),
  refuse: (request) =>
    request.lane === "sfx" || request.lane === "music" || request.lane === "voice"
      ? null
      : `ElevenLabs makes sound effects, music and voices, not ${request.lane}.`,
  start,
  pollEvery: Duration.seconds(5),
  licence:
    "ElevenLabs output on a paid plan: commercial licence while subscribed, kept indefinitely. The free plan has no commercial licence and must credit elevenlabs.io.",
  laneLicence: { music: ELEVENLABS_MUSIC_LICENCE },
  checkKey: (context) =>
    requireKey("elevenlabs", context).pipe(
      Effect.flatMap((key) =>
        context.http.json("elevenlabs", {
          method: "GET",
          url: `${BASE}/user`,
          headers: { "xi-api-key": key },
        }),
      ),
      Effect.asVoid,
    ),
};
