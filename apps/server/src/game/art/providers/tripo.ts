// Tripo (API v3, https://developers.tripo3d.ai/en/docs/introduction): every step is a task polled
// by id. A model is one task (H3.1 image or text to 3D, smart low poly, textured); a character
// adds a rig on the Unreal bone names and a few preset clips; a creature is rigged on its own body
// plan's skeleton with the one clip Tripo has for it. Credits are frozen at a task's start and
// released if it fails, so a failed stage costs what the stages before it did. Each task reports
// the credits it consumed. Result URLs expire after 5 minutes: files are downloaded at once.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { GameArtBodyPlan } from "@kurambit/contracts";
import {
  type ArtAdapter,
  type ArtContext,
  type ArtFile,
  type ArtRemote,
  type ArtRequest,
  ArtProviderError,
  field,
  numberField,
  requireKey,
  roundUsd,
  stringField,
} from "./adapter.ts";

const BASE = "https://openapi.tripo3d.ai/v3";
export const TRIPO_MODEL = "v3.1-20260211";
const RIG_BIPED = "v3.0-20260909";
const RIG_CREATURE = "v2.5-20260210";
/** A character's clips when none are asked. */
const CHARACTER_CLIPS = ["idle", "walk", "run"];
const MAX_CLIPS = 5;
/** The retarget presets of a v3.0 biped rig (docs/animations-retarget). */
const BIPED_PRESETS = [
  "idle",
  "walk",
  "run",
  "dive",
  "climb",
  "jump",
  "slash",
  "shoot",
  "hurt",
  "fall",
  "turn",
] as const;
/** A v2.5 creature rig's one preset by body plan; avian and other bodies have none. */
const CREATURE_PRESET: Partial<Record<GameArtBodyPlan, string>> = {
  quadruped: "preset:quadruped:walk",
  hexapod: "preset:hexapod:walk",
  octopod: "preset:octopod:walk",
  serpentine: "preset:serpentine:march",
  aquatic: "preset:aquatic:march",
};
/** A creature's one preset moves it along; any of these names asks for it. */
const CREATURE_CLIP_NAMES = new Set(["walk", "march", "move", "locomotion"]);
const USD_PER_CREDIT = 0.01;

/** USD (1 credit = $0.01), developers.tripo3d.ai/en/pricing, 2026-11. */
const PRICE = {
  imageTextured: 0.3,
  textTextured: 0.2,
  smartLowPoly: 0.1,
  rig: 0.25,
  clip: 0.1,
} as const;

const RIG_TYPE: Record<GameArtBodyPlan, string> = {
  quadruped: "quadruped",
  avian: "avian",
  serpentine: "serpentine",
  aquatic: "aquatic",
  hexapod: "hexapod",
  octopod: "octopod",
  other: "others",
};

type Stage = "mesh" | "rig" | "retarget";
interface TripoRemote {
  readonly stage: Stage;
  readonly task: string;
  readonly lane: "character" | "creature" | "model";
  readonly body: string | null;
  /** Retarget presets, already resolved ("preset:walk"). */
  readonly clips: ReadonlyArray<string>;
  readonly rig: string | null;
  /** Files already downloaded from earlier stages are not kept here: only ids. */
  readonly mesh: string;
  /** Credits the finished stages consumed; null once one did not say (rows from before too). */
  readonly credits?: number | null;
}

const clipsOf = (request: Pick<ArtRequest, "lane" | "options">): ReadonlyArray<string> =>
  request.lane === "model"
    ? []
    : (request.options.clips ?? (request.lane === "character" ? CHARACTER_CLIPS : [])).slice(
        0,
        MAX_CLIPS,
      );

const clipKey = (clip: string) => clip.trim().toLowerCase();

/** The retarget presets for the asked clips, or the clip Tripo has no preset for. */
export const tripoPresets = (
  request: Pick<ArtRequest, "lane" | "options">,
): { readonly presets: ReadonlyArray<string> } | { readonly missing: string } => {
  const presets: string[] = [];
  for (const clip of clipsOf(request)) {
    const key = clipKey(clip);
    const preset =
      request.lane === "character"
        ? (BIPED_PRESETS as ReadonlyArray<string>).includes(key)
          ? `preset:${key}`
          : undefined
        : CREATURE_CLIP_NAMES.has(key)
          ? CREATURE_PRESET[request.options.body ?? "other"]
          : undefined;
    if (preset === undefined) return { missing: clip };
    if (!presets.includes(preset)) presets.push(preset);
  }
  return { presets };
};

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

/** The generation task's body: the shape the fixtures check. */
export const tripoMeshBody = (
  request: Omit<ArtRequest, "references">,
  fileToken: string | null,
) => ({
  model: TRIPO_MODEL,
  // image-to-model takes the uploaded file's token as its `input`.
  ...(fileToken === null ? { prompt: request.prompt.slice(0, 1024) } : { input: fileToken }),
  texture: true,
  pbr: true,
  smart_low_poly: true,
  ...(request.options.polycount !== undefined
    ? { face_limit: Math.min(20_000, Math.round(request.options.polycount)) }
    : {}),
  auto_size: true,
});

export const tripoRigBody = (remote: Pick<TripoRemote, "lane" | "body" | "mesh">) =>
  remote.lane === "character"
    ? {
        input: remote.mesh,
        model: RIG_BIPED,
        rig_type: "biped",
        spec: "unreal",
        out_format: "glb",
      }
    : {
        input: remote.mesh,
        model: RIG_CREATURE,
        rig_type: RIG_TYPE[(remote.body ?? "other") as GameArtBodyPlan] ?? "others",
        out_format: "glb",
      };

export const tripoRetargetBody = (rig: string, presets: ReadonlyArray<string>) => ({
  input: rig,
  animations: presets,
  animate_in_place: true,
  export_with_geometry: true,
  out_format: "glb",
});

const taskIdOf = (answer: unknown) => {
  const id = stringField(answer, "data", "task_id");
  return id === null
    ? Effect.fail(new ArtProviderError({ reason: "Tripo answered without a task id." }))
    : Effect.succeed(id);
};

const post = (context: ArtContext, key: string, path: string, body: unknown) =>
  context.http
    .json("tripo", { method: "POST", url: `${BASE}${path}`, headers: auth(key), json: body })
    .pipe(Effect.flatMap(taskIdOf));

/**
 * Every https model URL a task's output names. The docs give `model_url` (a string) for every task;
 * how a retarget of several clips keys its files is undocumented, so lists and other keys are read too.
 */
export const tripoModelUrls = (output: unknown): ReadonlyArray<string> => {
  const urls: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("https://")) urls.push(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (typeof value === "object" && value !== null) {
      const url = (value as Record<string, unknown>).url;
      if (typeof url === "string") add(url);
      else Object.values(value).forEach(add);
    }
  };
  for (const key of ["model_url", "model_urls", "pbr_model", "model"]) {
    add(field(output, key));
    if (urls.length > 0) break;
  }
  return [...new Set(urls)];
};

const extOf = (url: string) => {
  const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
  return ext === "fbx" || ext === "obj" ? ext : "glb";
};

const start = (context: ArtContext, request: ArtRequest) =>
  Effect.gen(function* () {
    const key = yield* requireKey("tripo", context);
    let fileToken: string | null = null;
    const reference = request.references[0];
    if (reference !== undefined) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([reference.bytes], { type: reference.mime }),
        reference.path.split("/").pop() ?? "reference.png",
      );
      const uploaded = yield* context.http.json("tripo", {
        method: "POST",
        url: `${BASE}/files`,
        headers: auth(key),
        form,
      });
      fileToken = stringField(uploaded, "data", "file_token");
      if (fileToken === null)
        return yield* new ArtProviderError({
          reason: "Tripo took the reference but gave no file token.",
        });
    }
    const task = yield* post(
      context,
      key,
      fileToken === null ? "/generation/text-to-model" : "/generation/image-to-model",
      tripoMeshBody(request, fileToken),
    );
    const resolved = tripoPresets(request);
    const remote: TripoRemote = {
      stage: "mesh",
      task,
      mesh: task,
      rig: null,
      lane: request.lane as TripoRemote["lane"],
      body: request.options.body ?? null,
      clips: "presets" in resolved ? resolved.presets : [],
      credits: 0,
    };
    return {
      kind: "making" as const,
      remote: remote as unknown as ArtRemote,
      note: "Making the mesh.",
    };
  });

const poll = (context: ArtContext, stored: ArtRemote) =>
  Effect.gen(function* () {
    const key = yield* requireKey("tripo", context);
    const remote = stored as unknown as TripoRemote;
    const answer = yield* context.http.json("tripo", {
      method: "GET",
      url: `${BASE}/tasks/${encodeURIComponent(remote.task)}`,
      headers: auth(key),
    });
    const status = stringField(answer, "data", "status");
    const spent = remote.credits === undefined ? null : remote.credits;
    // Documented: queued, running, success, failed, cancelled. Anything else (unknown) is neither
    // an end nor a failure; the person can cancel a job that never ends.
    if (status === "failed" || status === "cancelled") {
      const message = stringField(answer, "data", "error_message");
      return yield* new ArtProviderError({
        reason: `Tripo's ${remote.stage} task ended ${status}${message === null ? "" : `: ${message}`}.`,
        // A failed task's credits are released; the stages before it were spent.
        ...(spent === null ? {} : { costUsd: roundUsd(spent * USD_PER_CREDIT) }),
      });
    }
    if (status !== "success") return { kind: "making" as const, remote: stored };
    const consumed = numberField(answer, "data", "credits_consumed");
    const credits = spent === null || consumed === null ? null : spent + consumed;
    const output = field(answer, "data", "output");
    if (remote.stage === "mesh" && remote.lane !== "model") {
      const rig = yield* post(context, key, "/animations/rig", tripoRigBody(remote));
      return {
        kind: "making" as const,
        remote: { ...stored, stage: "rig", task: rig, rig, credits } as ArtRemote,
        note: "Rigging.",
      };
    }
    if (remote.stage === "rig" && remote.clips.length > 0) {
      const retarget = yield* post(
        context,
        key,
        "/animations/retarget",
        tripoRetargetBody(remote.task, remote.clips),
      );
      return {
        kind: "making" as const,
        remote: { ...stored, stage: "retarget", task: retarget, credits } as ArtRemote,
        note: "Adding clips.",
      };
    }
    const urls = tripoModelUrls(output);
    if (urls.length === 0)
      return yield* new ArtProviderError({ reason: "Tripo finished without a model file." });
    const files: ArtFile[] = [];
    for (const [index, url] of urls.entries()) {
      const label =
        remote.stage === "retarget" && urls.length > 1
          ? (remote.clips[index]?.split(":").pop() ?? `clip${index + 1}`)
          : undefined;
      files.push({
        role: "asset",
        ext: extOf(url),
        bytes: yield* context.http.download(url),
        ...(label === undefined ? {} : { label }),
      });
    }
    const preview = stringField(output, "rendered_image_url");
    if (preview !== null)
      files.push({
        role: "preview",
        ext: /\.(png|jpe?g)$/i.exec(new URL(preview).pathname)?.[1]?.toLowerCase() ?? "webp",
        bytes: yield* context.http
          .download(preview)
          .pipe(Effect.orElseSucceed(() => new Uint8Array())),
      });
    return {
      kind: "done" as const,
      candidates: [files.filter((file) => file.bytes.byteLength > 0)],
      costUsd: credits === null ? null : roundUsd(credits * USD_PER_CREDIT),
    };
  });

export const tripo: ArtAdapter = {
  id: "tripo",
  estimate: (request) => {
    const mesh =
      (request.references > 0 ? PRICE.imageTextured : PRICE.textTextured) + PRICE.smartLowPoly;
    if (request.lane === "model") return roundUsd(mesh);
    const resolved = tripoPresets(request);
    return roundUsd(
      mesh + PRICE.rig + ("presets" in resolved ? resolved.presets.length : 0) * PRICE.clip,
    );
  },
  refuse: (request) => {
    if (request.lane !== "character" && request.lane !== "creature" && request.lane !== "model")
      return `Tripo makes characters, creatures and models, not ${request.lane}.`;
    const resolved = tripoPresets(request);
    if (!("missing" in resolved)) return null;
    if (request.lane === "character")
      return `Tripo has no "${resolved.missing}" clip for a character; its clips are ${BIPED_PRESETS.join(", ")}.`;
    const preset = CREATURE_PRESET[request.options.body ?? "other"];
    return preset === undefined
      ? `Tripo has no clips for a ${request.options.body ?? "other"} body; ask for none.`
      : `Tripo has one clip for a ${request.options.body} body, "${preset.split(":").pop()}"; ask for "walk" or none.`;
  },
  start,
  poll,
  pollEvery: Duration.seconds(4),
  checkKey: (context) =>
    requireKey("tripo", context).pipe(
      Effect.flatMap((key) =>
        context.http.json("tripo", {
          method: "GET",
          url: `${BASE}/account/balance`,
          headers: auth(key),
        }),
      ),
      Effect.asVoid,
    ),
  licence:
    "Tripo API output (paid credits): the user has all rights, including commercial use. Free-tier output belongs to Tripo.",
};
