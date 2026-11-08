// Uthana (https://uthana.com/docs/api, read with its official client @uthana/client 0.8.0):
// GraphQL at uthana.com/graphql with the key as the HTTP Basic user. A motion is made on a
// character Uthana holds, and every download retargets it onto that character's skeleton.
//
// 1. The body is uploaded with auto_rig false, so Uthana keeps the standard skeleton. It is free
//    (no rig is made), and the same file uploaded again answers the first character's id, so it
//    is safe to repeat and nothing is cached here.
// 2. The motion, one paid request, saved as pending before it is sent: text to motion 3.0 (a job
//    polled to FINISHED), video to motion 3.0 (a job), or the locomotion set (one synchronous
//    create_locomotion per direction and speed, each its own pending stage). With loop, a looped
//    copy (create_looped_motion, also paid) follows.
// 3. Each motion is downloaded as a GLB retargeted onto the body, at 30 fps (the clip library's
//    rate) and in place (the game moves the character). Downloads are free and unlimited.
//
// Uthana reports no cost per request: it bills each second of output at its published rate, and
// the cost recorded is each delivered clip's measured length at those rates.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { glbJson, longestAnimationSeconds } from "../../gltfJson.ts";
import {
  type ArtAdapter,
  type ArtContext,
  type ArtFile,
  type ArtRemote,
  type ArtRequest,
  type ArtStep,
  ArtProviderError,
  UNKNOWN_STATUS_LIMIT,
  base64,
  field,
  pendingStage,
  requireKey,
  roundUsd,
  stringField,
} from "./adapter.ts";

const GRAPHQL = "https://uthana.com/graphql";
const UTHANA_TEXT_MODEL = "text-to-motion-3.0";
const UTHANA_VIDEO_MODEL = "video-to-motion-3.0";
/** USD per second of output motion, uthana.com/pricing and llms.txt, 2026-11. */
const PRICE = { text: 0.1, video: 0.06, locomotion: 0.02, loop: 0.01 } as const;
/** create_text_to_motion_job's length: whole seconds, 4 to 10, 8 when omitted. */
const TEXT_SECONDS = { min: 4, max: 10, default: 8 } as const;
/** Uthana takes videos of 2 to 60 seconds; an unstated length is estimated at the most. */
const VIDEO_SECONDS = { min: 2, max: 60 } as const;
/** Two stride pairs per locomotion clip: a cycle that repeats, and short. */
const STRIDES = 2;
/**
 * The locomotion set: walking and running in eight directions, named as the clip library names
 * its loops, so animate()'s walk and run find the forward ones. Seconds are the estimate's.
 */
const GAITS = [
  { gait: "Walk", speed: 1.3, seconds: 2.5 },
  { gait: "Run", speed: 3.5, seconds: 2 },
] as const;
const DIRECTIONS = [
  { name: "Fwd", angle: 0 },
  { name: "Fwd_Right", angle: 45 },
  { name: "Right", angle: 90 },
  { name: "Bwd_Right", angle: 135 },
  { name: "Bwd", angle: 180 },
  { name: "Bwd_Left", angle: -135 },
  { name: "Left", angle: -90 },
  { name: "Fwd_Left", angle: -45 },
] as const;
const UTHANA_LOCOMOTION = GAITS.flatMap((gait) =>
  DIRECTIONS.map((direction) => ({
    clip: `${gait.gait}_${direction.name}_Loop`,
    speed: gait.speed,
    angle: direction.angle,
    seconds: gait.seconds,
  })),
);
const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
const MAX_BODY_BYTES = 30 * 1024 * 1024;
/** Job states the API documents (RESERVED, READY) and ones its rate-limit page names. */
const WORKING = new Set([
  "RESERVED",
  "READY",
  "QUEUED",
  "DELAYED",
  "RUNNING",
  "STARTED",
  "PENDING",
]);

type Mode = "text" | "video" | "locomotion";
interface Motion {
  readonly id: string;
  /** The clip's name in its file's name (a locomotion clip's), or null for the one clip. */
  readonly label: string | null;
  /** USD per second of this clip: every paid stage that made it. */
  readonly rate: number;
}
interface UthanaRemote {
  readonly mode: Mode;
  /** The uploaded body's character id: every motion is made and downloaded on it. */
  readonly character: string;
  readonly prompt: string;
  /** Text: the whole seconds asked for. */
  readonly length: number;
  readonly loop: boolean;
  /** Video: its absolute path, read when the motion is sent. */
  readonly video: string | null;
  /** The text or video job, while Uthana runs it. */
  readonly job: string | null;
  /** The motions made so far; the ones still in `pending` follow. */
  readonly motions: ReadonlyArray<Motion>;
  /** The next paid stage, saved before it is sent (see `pendingStage`). */
  readonly pending: "motion" | "loop" | null;
  /** Answers in a row whose status was none of the known ones. */
  readonly unknown?: number;
}

const auth = (key: string) => ({
  authorization: `Basic ${base64(new TextEncoder().encode(`${key}:`))}`,
});

const textSeconds = (request: Pick<ArtRequest, "options">) =>
  Math.min(
    TEXT_SECONDS.max,
    Math.max(TEXT_SECONDS.min, Math.round(request.options.seconds ?? TEXT_SECONDS.default)),
  );
const videoSeconds = (request: Pick<ArtRequest, "options">) =>
  Math.min(
    VIDEO_SECONDS.max,
    Math.max(VIDEO_SECONDS.min, request.options.seconds ?? VIDEO_SECONDS.max),
  );
const modeOf = (request: Pick<ArtRequest, "options">): Mode =>
  request.options.locomotion === true
    ? "locomotion"
    : request.options.video !== undefined
      ? "video"
      : "text";

/** A GraphQL answer's data, or the provider's own refusal: GraphQL answers its errors at HTTP 200. */
const dataOf = (answer: unknown, what: string) => {
  const errors = field(answer, "errors");
  if (Array.isArray(errors) && errors.length > 0) {
    const message = stringField(errors[0], "message") ?? "no reason given";
    return Effect.fail(
      new ArtProviderError({
        reason: `Uthana refused ${what}: ${message.slice(0, 400).replace(/[^.!?]$/, "$&.")}`,
        status: 200,
      }),
    );
  }
  return Effect.succeed(field(answer, "data"));
};

const graphql = (context: ArtContext, key: string, what: string, query: string, variables = {}) =>
  context.http
    .json("uthana", {
      method: "POST",
      url: GRAPHQL,
      headers: auth(key),
      json: { query, variables },
    })
    .pipe(Effect.flatMap((answer) => dataOf(answer, what)));

/** One file and its mutation, as the GraphQL multipart request spec sends it (the client's way). */
const upload = (
  context: ArtContext,
  key: string,
  what: string,
  query: string,
  variables: Record<string, unknown>,
  file: { readonly bytes: Uint8Array; readonly name: string },
) => {
  const form = new FormData();
  form.append("operations", JSON.stringify({ query, variables: { ...variables, file: null } }));
  form.append("map", JSON.stringify({ "0": ["variables.file"] }));
  form.append("0", new Blob([Buffer.from(file.bytes)]), file.name);
  return context.http
    .json("uthana", { method: "POST", url: GRAPHQL, headers: auth(key), form })
    .pipe(Effect.flatMap((answer) => dataOf(answer, what)));
};

const readUpload = (context: ArtContext, path: string, limit: number, what: string) =>
  context.readFile(path).pipe(
    Effect.flatMap((bytes) =>
      bytes.byteLength > limit
        ? Effect.fail(
            new ArtProviderError({
              reason: `The ${what} is larger than Uthana takes (${Math.round(limit / 1024 / 1024)} MB).`,
            }),
          )
        : Effect.succeed({ bytes, name: path.replace(/^.*[\\/]/, "") }),
    ),
  );

const UTHANA_QUERIES = {
  character: `mutation CreateCharacter($name: String!, $file: Upload!, $auto_rig: Boolean) {
  create_character(name: $name, file: $file, auto_rig: $auto_rig) { character { id name } auto_rig_confidence message }
}`,
  textJob: `mutation CreateTextToMotionJob($prompt: String!, $model: String!, $character_id: String, $length: Float) {
  create_text_to_motion_job(prompt: $prompt, model: $model, character_id: $character_id, length: $length) { job { id status } }
}`,
  videoJob: `mutation CreateVideoToMotion($file: Upload!, $motion_name: String!, $model: String) {
  create_video_to_motion(file: $file, motion_name: $motion_name, model: $model) { job { id status } }
}`,
  locomotion: `mutation CreateLocomotion($character_id: String!, $strides: Int, $move_speed: Float, $travel_angle: Float) {
  create_locomotion(character_id: $character_id, strides: $strides, move_speed: $move_speed, travel_angle: $travel_angle) { motion { id name } }
}`,
  loop: `mutation CreateLoopedMotion($character_id: String!, $motion_id: String!, $loop_mode: String!) {
  create_looped_motion(character_id: $character_id, motion_id: $motion_id, loop_mode: $loop_mode) { motion { id name } }
}`,
  job: `query GetJob($job_id: String!) { job(job_id: $job_id) { id status result } }`,
  usage: `query Usage { org { payg_enabled payg_total_usd } }`,
} as const;

const start = (context: ArtContext, request: ArtRequest) =>
  Effect.gen(function* () {
    const key = yield* requireKey("uthana", context);
    const bodyPath = request.uploads?.body;
    if (bodyPath === undefined)
      return yield* new ArtProviderError({ reason: "No body was given to make the motion on." });
    const mode = modeOf(request);
    const video = mode === "video" ? (request.uploads?.video ?? null) : null;
    if (mode === "video" && video === null)
      return yield* new ArtProviderError({ reason: "No video was given to copy the move from." });
    const body = yield* readUpload(context, bodyPath, MAX_BODY_BYTES, "body");
    const made = yield* upload(
      context,
      key,
      "the body",
      UTHANA_QUERIES.character,
      { name: "Kurambit body", auto_rig: false },
      body,
    );
    const character = stringField(made, "create_character", "character", "id");
    if (character === null)
      return yield* new ArtProviderError({
        reason: "Uthana took the body but answered no character id.",
      });
    const remote: UthanaRemote = {
      mode,
      character,
      prompt: request.prompt,
      length: textSeconds(request),
      loop: mode !== "locomotion" && request.options.loop === true,
      video,
      job: null,
      motions: [],
      pending: "motion",
    };
    return {
      kind: "making" as const,
      remote: remote as unknown as ArtRemote,
      note: "Body uploaded.",
    };
  });

const motionId = (data: unknown, mutation: string) => {
  const id = stringField(data, mutation, "motion", "id");
  return id === null
    ? Effect.fail(
        new ArtProviderError({ reason: `Uthana answered ${mutation} with no motion id.` }),
      )
    : Effect.succeed(id);
};

/** Sends the saved pending stage, once. */
const advance = (context: ArtContext, stored: ArtRemote) =>
  Effect.gen(function* () {
    const key = yield* requireKey("uthana", context);
    const remote = stored as unknown as UthanaRemote;
    // A refusal of the first paid request bought nothing: Uthana accepts no work it refuses.
    const first = remote.motions.length === 0;
    const refusedFree = <A>(effect: Effect.Effect<A, ArtProviderError>) =>
      effect.pipe(
        Effect.mapError((error) =>
          first && error.status !== undefined && error.status < 500
            ? new ArtProviderError({ reason: error.reason, status: error.status, costUsd: 0 })
            : error,
        ),
      );
    const next = (patch: Partial<UthanaRemote>, note?: string): ArtStep => ({
      kind: "making",
      remote: { ...remote, unknown: 0, ...patch } as unknown as ArtRemote,
      ...(note === undefined ? {} : { note }),
    });
    switch (pendingStage(stored)) {
      case "motion": {
        if (remote.mode === "locomotion") {
          const index = remote.motions.length;
          const gait = UTHANA_LOCOMOTION[index];
          if (gait === undefined)
            return yield* new ArtProviderError({
              reason: "Uthana's locomotion set is already made.",
            });
          const data = yield* refusedFree(
            graphql(context, key, `the ${gait.clip} locomotion`, UTHANA_QUERIES.locomotion, {
              character_id: remote.character,
              strides: STRIDES,
              move_speed: gait.speed,
              travel_angle: gait.angle,
            }),
          );
          const id = yield* motionId(data, "create_locomotion");
          const motions = [...remote.motions, { id, label: gait.clip, rate: PRICE.locomotion }];
          return next(
            { motions, pending: motions.length < UTHANA_LOCOMOTION.length ? "motion" : null },
            `${motions.length} of ${UTHANA_LOCOMOTION.length} locomotion clips made.`,
          );
        }
        if (remote.mode === "video") {
          const video = yield* readUpload(context, remote.video ?? "", MAX_VIDEO_BYTES, "video");
          const data = yield* refusedFree(
            upload(
              context,
              key,
              "the video",
              UTHANA_QUERIES.videoJob,
              { motion_name: remote.prompt.slice(0, 120), model: UTHANA_VIDEO_MODEL },
              video,
            ),
          );
          const job = stringField(data, "create_video_to_motion", "job", "id");
          if (job === null)
            return yield* new ArtProviderError({
              reason: "Uthana answered the video with no job id.",
            });
          return next({ job, pending: null }, "Copying the move from the video.");
        }
        const data = yield* refusedFree(
          graphql(context, key, "the motion", UTHANA_QUERIES.textJob, {
            prompt: remote.prompt,
            model: UTHANA_TEXT_MODEL,
            character_id: remote.character,
            length: remote.length,
          }),
        );
        const job = stringField(data, "create_text_to_motion_job", "job", "id");
        if (job === null)
          return yield* new ArtProviderError({
            reason: "Uthana answered the motion with no job id.",
          });
        return next({ job, pending: null }, "Making the motion.");
      }
      case "loop": {
        const base = remote.motions[0];
        if (base === undefined)
          return yield* new ArtProviderError({ reason: "There is no motion to loop yet." });
        const data = yield* graphql(context, key, "the loop", UTHANA_QUERIES.loop, {
          character_id: remote.character,
          motion_id: base.id,
          loop_mode: "closed",
        });
        const id = yield* motionId(data, "create_looped_motion");
        // The looped copy keeps the motion's length, so its seconds bill both stages.
        return next(
          { motions: [{ id, label: "loop", rate: base.rate + PRICE.loop }], pending: null },
          "Looped.",
        );
      }
      default:
        return yield* new ArtProviderError({ reason: "Uthana has no stage waiting to start." });
    }
  });

const downloadUrl = (character: string, motion: string) =>
  `https://uthana.com/motion/file/motion_viewer/${encodeURIComponent(character)}/${encodeURIComponent(motion)}/glb/${encodeURIComponent(motion)}.glb?fps=30&in_place=true`;

/** Every motion made, as GLBs on the body; the cost is their measured seconds at their rates. */
const deliver = (context: ArtContext, key: string, remote: UthanaRemote) =>
  Effect.gen(function* () {
    const files: ArtFile[] = [];
    let cost = 0;
    for (const motion of remote.motions) {
      const bytes = yield* context.http.bytes("uthana", {
        method: "GET",
        url: downloadUrl(remote.character, motion.id),
        headers: auth(key),
      });
      const seconds = longestAnimationSeconds(glbJson(bytes));
      if (seconds === null)
        return yield* new ArtProviderError({
          reason: `Uthana's file for ${motion.label ?? "the motion"} is not a GLB with a clip in it.`,
        });
      cost += seconds * motion.rate;
      files.push({
        role: "asset",
        ext: "glb",
        bytes,
        ...(motion.label === null ? {} : { label: motion.label }),
      });
    }
    return {
      kind: "done" as const,
      candidates: [files],
      costUsd: roundUsd(cost),
    } satisfies ArtStep;
  });

const poll = (context: ArtContext, stored: ArtRemote) =>
  Effect.gen(function* () {
    const key = yield* requireKey("uthana", context);
    const remote = stored as unknown as UthanaRemote;
    if (remote.job === null || remote.motions.length > 0)
      return yield* deliver(context, key, remote);
    const data = yield* graphql(context, key, "the job lookup", UTHANA_QUERIES.job, {
      job_id: remote.job,
    });
    const status = stringField(data, "job", "status")?.toUpperCase() ?? null;
    if (status !== null && WORKING.has(status))
      return {
        kind: "making" as const,
        remote: remote.unknown === undefined ? stored : ({ ...stored, unknown: 0 } as ArtRemote),
      };
    if (status === "FAILED") {
      const result = field(data, "job", "result");
      const message =
        typeof result === "string" ? result : (stringField(result, "message") ?? "no reason given");
      return yield* new ArtProviderError({
        reason: `Uthana's motion job failed: ${message.slice(0, 400).replace(/[^.!?]$/, "$&.")}`,
      });
    }
    if (status !== "FINISHED") {
      const unknown = (remote.unknown ?? 0) + 1;
      if (unknown >= UNKNOWN_STATUS_LIMIT)
        return yield* new ArtProviderError({
          reason: `Uthana answered its motion job ${unknown} times in a row with no status it documents${status === null ? "" : ` (${status})`}; Kurambit stopped asking.`,
        });
      return { kind: "making" as const, remote: { ...stored, unknown } as ArtRemote };
    }
    const id = stringField(data, "job", "result", "result", "id");
    if (id === null)
      return yield* new ArtProviderError({ reason: "Uthana finished the job with no motion id." });
    const rate = remote.mode === "video" ? PRICE.video : PRICE.text;
    const made: UthanaRemote = {
      ...remote,
      job: null,
      motions: [{ id, label: null, rate }],
      pending: remote.loop ? "loop" : null,
      unknown: 0,
    };
    if (remote.loop) return { kind: "making" as const, remote: made as unknown as ArtRemote };
    return yield* deliver(context, key, made);
  });

export const uthana: ArtAdapter = {
  id: "uthana",
  estimate: (request) => {
    const loop = request.options.loop === true ? PRICE.loop : 0;
    switch (modeOf(request)) {
      case "locomotion":
        return roundUsd(
          UTHANA_LOCOMOTION.reduce((sum, clip) => sum + clip.seconds * PRICE.locomotion, 0),
        );
      case "video":
        return roundUsd(videoSeconds(request) * (PRICE.video + loop));
      case "text":
        return roundUsd(textSeconds(request) * (PRICE.text + loop));
    }
  },
  refuse: (request) =>
    request.lane !== "motion"
      ? `Uthana makes motion, not ${request.lane}.`
      : request.options.locomotion === true && request.options.video !== undefined
        ? "The locomotion set is made from Uthana's own walk and run, not from a video: ask one or the other."
        : null,
  start,
  poll,
  advance,
  pollEvery: Duration.seconds(5),
  checkKey: (context) =>
    requireKey("uthana", context).pipe(
      Effect.flatMap((key) => graphql(context, key, "the key check", UTHANA_QUERIES.usage)),
      Effect.map((data) => {
        const balance = field(data, "org", "payg_total_usd");
        if (typeof balance !== "number") return undefined;
        return balance > 0
          ? { ready: true, note: `Key works; $${balance.toFixed(2)} of credit left.` }
          : {
              ready: false,
              note: "Key works, but its credit is used up: add credit at uthana.com.",
            };
      }),
    ),
  licence:
    "Uthana output on bought (pay-as-you-go) credit: owned by the user. Output on the free plan (the sign-up credit) is Uthana's, licensed CC BY 4.0.",
};
