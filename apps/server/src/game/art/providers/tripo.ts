// Tripo (API v3): every step is a task polled by id. A model is one task (H3.1 image or text to
// 3D, smart low poly, textured); a character adds a rig on the Unreal bone names and a few
// preset clips; a creature is rigged on its own body plan's skeleton with the clips Tripo has
// for it. Credits are frozen at a task's start and released if it fails, so a failed stage
// costs what the stages before it did. Files are downloaded the moment a task succeeds.
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
  requireKey,
  roundUsd,
  stringField,
} from "./adapter.ts";

const BASE = "https://openapi.tripo3d.com/v3";
export const TRIPO_MODEL = "v3.1-20260211";
const RIG_BIPED = "v3.0-20260909";
const RIG_CREATURE = "v2.5-20260210";
/** A character's clips when none are asked: the presets the v3 biped rig has. */
const CHARACTER_CLIPS = ["idle", "walk", "run"];
const MAX_CLIPS = 5;

/** USD (1 credit = $0.01), 2026-11. */
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
  readonly clips: ReadonlyArray<string>;
  readonly rig: string | null;
  /** Files already downloaded from earlier stages are not kept here: only ids. */
  readonly mesh: string;
  readonly height?: number;
}

const clipsOf = (request: Pick<ArtRequest, "lane" | "options">): ReadonlyArray<string> =>
  request.lane === "model"
    ? []
    : (request.options.clips ?? (request.lane === "character" ? CHARACTER_CLIPS : [])).slice(
        0,
        MAX_CLIPS,
      );

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

/** The generation task's body: the shape the fixtures check. */
export const tripoMeshBody = (
  request: Omit<ArtRequest, "references">,
  fileToken: string | null,
) => ({
  model: TRIPO_MODEL,
  ...(fileToken === null ? { prompt: request.prompt } : { file_token: fileToken }),
  texture: true,
  pbr: true,
  smart_low_poly: true,
  ...(request.options.polycount !== undefined
    ? { face_limit: Math.min(20_000, Math.round(request.options.polycount)) }
    : {}),
  auto_size: true,
});

export const tripoRigBody = (
  remote: Pick<TripoRemote, "lane" | "body" | "mesh">,
  height?: number,
) =>
  remote.lane === "character"
    ? {
        input: remote.mesh,
        model: RIG_BIPED,
        rig_type: "biped",
        spec: "unreal",
        out_format: "glb",
        ...(height === undefined ? {} : { height }),
      }
    : {
        input: remote.mesh,
        model: RIG_CREATURE,
        rig_type: RIG_TYPE[(remote.body ?? "other") as GameArtBodyPlan] ?? "others",
        out_format: "glb",
      };

export const tripoRetargetBody = (rig: string, clips: ReadonlyArray<string>) => ({
  input: rig,
  animations: clips.map((clip) => `preset:${clip.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`),
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

/** Every https model URL a task's output names, whatever key this version puts it under. */
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
  for (const key of ["pbr_model", "model_url", "model", "model_urls"]) {
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
    const remote: TripoRemote = {
      stage: "mesh",
      task,
      mesh: task,
      rig: null,
      lane: request.lane as TripoRemote["lane"],
      body: request.options.body ?? null,
      clips: clipsOf(request),
      ...(request.options.height === undefined ? {} : { height: request.options.height }),
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
    if (status === "queued" || status === "running" || status === null)
      return { kind: "making" as const, remote: stored };
    if (status !== "success")
      return yield* new ArtProviderError({
        reason: `Tripo's ${remote.stage} task ended ${status}${
          stringField(answer, "data", "error_msg") === null
            ? ""
            : `: ${stringField(answer, "data", "error_msg")}`
        }.`,
      });
    const output = field(answer, "data", "output");
    if (remote.stage === "mesh" && remote.lane !== "model") {
      const rig = yield* post(context, key, "/animations/rig", tripoRigBody(remote, remote.height));
      return {
        kind: "making" as const,
        remote: { ...stored, stage: "rig", task: rig, rig } as ArtRemote,
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
        remote: { ...stored, stage: "retarget", task: retarget } as ArtRemote,
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
          ? (remote.clips[index] ?? `clip${index + 1}`)
          : undefined;
      files.push({
        role: "asset",
        ext: extOf(url),
        bytes: yield* context.http.download(url),
        ...(label === undefined ? {} : { label }),
      });
    }
    const preview =
      stringField(output, "rendered_image") ?? stringField(output, "rendered_image", "url");
    if (preview !== null)
      files.push({
        role: "preview",
        ext: "webp",
        bytes: yield* context.http
          .download(preview)
          .pipe(Effect.orElseSucceed(() => new Uint8Array())),
      });
    return {
      kind: "done" as const,
      candidates: [files.filter((file) => file.bytes.byteLength > 0)],
      costUsd: null,
    };
  });

export const tripo: ArtAdapter = {
  id: "tripo",
  estimate: (request) => {
    const mesh =
      (request.references > 0 ? PRICE.imageTextured : PRICE.textTextured) + PRICE.smartLowPoly;
    if (request.lane === "model") return roundUsd(mesh);
    return roundUsd(mesh + PRICE.rig + clipsOf(request).length * PRICE.clip);
  },
  refuse: (request) =>
    request.lane === "character" || request.lane === "creature" || request.lane === "model"
      ? null
      : `Tripo makes characters, creatures and models, not ${request.lane}.`,
  start,
  poll,
  pollEvery: Duration.seconds(4),
  licence:
    "Tripo API output (paid credits): the user has all rights, including commercial use. Free-tier output belongs to Tripo.",
};
