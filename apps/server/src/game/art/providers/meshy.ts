// Meshy (API v1): tasks polled by id. A model is one task (image, multi-image or text to 3D with
// Smart Topology at the asked face count); a character adds rigging (humanoids only), which
// brings walking and running clips, and the asked clips from Meshy's animation library. Meshy
// deletes API files after 3 days, so each is downloaded the moment its task succeeds.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  type ArtAdapter,
  type ArtContext,
  type ArtFile,
  type ArtRemote,
  type ArtRequest,
  ArtProviderError,
  dataUri,
  field,
  requireKey,
  roundUsd,
  stringField,
} from "./adapter.ts";

const BASE = "https://api.meshy.ai/openapi/v1";
export const MESHY_MODEL = "meshy-7.1";
/** USD per credit at the Pro plan's rate (1,000 credits for $20), 2026-11. */
const CREDIT = 0.02;
const CREDITS = { mesh: 30, rig: 5, action: 3 } as const;
const MAX_ACTIONS = 10;

type Kind = "image-to-3d" | "multi-image-to-3d" | "text-to-3d";
interface MeshyRemote {
  readonly stage: "mesh" | "refine" | "rig" | "animate";
  readonly kind: Kind | "rigging" | "animations";
  readonly task: string;
  readonly lane: "character" | "model";
  readonly height: number | null;
  readonly clips: ReadonlyArray<string>;
  /** The rigged character and its clips, downloaded as each stage finished. */
  readonly rig: string | null;
}

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

/** The first task's endpoint and body: the shape the fixtures check. */
export const meshyMeshRequest = (request: ArtRequest) => {
  const kind: Kind =
    request.references.length === 0
      ? "text-to-3d"
      : request.references.length === 1
        ? "image-to-3d"
        : "multi-image-to-3d";
  const shape = {
    ai_model: MESHY_MODEL,
    topology: "triangle",
    should_remesh: true,
    ...(request.options.polycount === undefined
      ? {}
      : { target_polycount: Math.round(request.options.polycount) }),
    ...(request.lane === "character" ? { pose_mode: "a-pose" } : {}),
  };
  const body =
    kind === "text-to-3d"
      ? { mode: "preview", prompt: request.prompt.slice(0, 600), ...shape }
      : {
          ...(kind === "image-to-3d"
            ? { image_url: dataUri(request.references[0]!) }
            : { image_urls: request.references.slice(0, 4).map(dataUri) }),
          should_texture: true,
          enable_pbr: true,
          target_formats: ["glb"],
          ...shape,
        };
  return { kind, url: `${BASE}/${kind}`, body };
};

const created = (answer: unknown) => {
  const id = stringField(answer, "result");
  return id === null
    ? Effect.fail(new ArtProviderError({ reason: "Meshy answered without a task id." }))
    : Effect.succeed(id);
};

const start = (context: ArtContext, request: ArtRequest) =>
  Effect.gen(function* () {
    const key = yield* requireKey("meshy", context);
    const first = meshyMeshRequest(request);
    const task = yield* context.http
      .json("meshy", { method: "POST", url: first.url, headers: auth(key), json: first.body })
      .pipe(Effect.flatMap(created));
    const remote: MeshyRemote = {
      stage: "mesh",
      kind: first.kind,
      task,
      lane: request.lane as MeshyRemote["lane"],
      height: request.options.height ?? null,
      clips: (request.options.clips ?? []).slice(0, MAX_ACTIONS),
      rig: null,
    };
    return {
      kind: "making" as const,
      remote: remote as unknown as ArtRemote,
      note: "Making the mesh.",
    };
  });

/** Library actions whose names match the asked clips, at most ten. */
const actionIds = (library: unknown, clips: ReadonlyArray<string>): ReadonlyArray<number> => {
  const entries = Array.isArray(library)
    ? library
    : (field(library, "result") ?? field(library, "data"));
  if (!Array.isArray(entries)) return [];
  const ids: number[] = [];
  for (const clip of clips) {
    const wanted = clip.toLowerCase();
    const match = entries.find((entry) => {
      const name = stringField(entry, "name") ?? stringField(entry, "action_name");
      return name !== null && name.toLowerCase().includes(wanted);
    });
    const id = field(match, "action_id") ?? field(match, "id");
    if (typeof id === "number" && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, MAX_ACTIONS);
};

const poll = (context: ArtContext, stored: ArtRemote) =>
  Effect.gen(function* () {
    const key = yield* requireKey("meshy", context);
    const remote = stored as unknown as MeshyRemote;
    const task = yield* context.http.json("meshy", {
      method: "GET",
      url: `${BASE}/${remote.kind}/${encodeURIComponent(remote.task)}`,
      headers: auth(key),
    });
    const status = stringField(task, "status");
    if (status === "PENDING" || status === "IN_PROGRESS" || status === null)
      return { kind: "making" as const, remote: stored };
    if (status !== "SUCCEEDED")
      return yield* new ArtProviderError({
        reason: `Meshy's ${remote.stage} task ended ${status.toLowerCase()}${
          stringField(task, "task_error", "message") === null
            ? ""
            : `: ${stringField(task, "task_error", "message")}`
        }.`,
      });
    const post = (path: string, body: unknown) =>
      context.http
        .json("meshy", { method: "POST", url: `${BASE}/${path}`, headers: auth(key), json: body })
        .pipe(Effect.flatMap(created));
    // A text request's preview is untextured: refine it before anything else.
    if (remote.stage === "mesh" && remote.kind === "text-to-3d") {
      const refine = yield* post("text-to-3d", {
        mode: "refine",
        preview_task_id: remote.task,
        enable_pbr: true,
      });
      return {
        kind: "making" as const,
        remote: { ...stored, stage: "refine", task: refine } as ArtRemote,
      };
    }
    if ((remote.stage === "mesh" || remote.stage === "refine") && remote.lane === "character") {
      const rig = yield* post("rigging", {
        input_task_id: remote.task,
        height_meters: remote.height ?? 1.7,
      });
      return {
        kind: "making" as const,
        remote: { ...stored, stage: "rig", kind: "rigging", task: rig, rig } as ArtRemote,
        note: "Rigging.",
      };
    }
    const files: ArtFile[] = [];
    const download = (url: string | null, role: ArtFile["role"], ext: string, label?: string) =>
      url === null
        ? Effect.void
        : context.http.download(url).pipe(
            Effect.map((bytes) => {
              files.push({ role, ext, bytes, ...(label === undefined ? {} : { label }) });
            }),
          );
    if (remote.stage === "rig") {
      yield* download(stringField(task, "result", "rigged_character_glb_url"), "asset", "glb");
      yield* download(
        stringField(task, "result", "basic_animations", "walking_glb_url"),
        "asset",
        "glb",
        "walk",
      );
      yield* download(
        stringField(task, "result", "basic_animations", "running_glb_url"),
        "asset",
        "glb",
        "run",
      );
      if (remote.clips.length > 0) {
        const library = yield* context.http.json("meshy", {
          method: "GET",
          url: `${BASE}/animations/library`,
          headers: auth(key),
        });
        const ids = actionIds(library, remote.clips);
        if (ids.length > 0) {
          // The rig's files are kept now: Meshy deletes them in 3 days, and the clips may take longer.
          const animate = yield* post("animations", { rig_task_id: remote.task, action_ids: ids });
          return {
            kind: "making" as const,
            remote: {
              ...stored,
              stage: "animate",
              kind: "animations",
              task: animate,
            } as ArtRemote,
            files,
            note: "Adding clips.",
          };
        }
      }
    } else if (remote.stage === "animate") {
      yield* download(stringField(task, "result", "animation_glb_url"), "asset", "glb", "clips");
    } else {
      yield* download(stringField(task, "model_urls", "glb"), "asset", "glb");
      yield* download(stringField(task, "thumbnail_url"), "preview", "png");
    }
    if (!files.some((file) => file.role === "asset"))
      return yield* new ArtProviderError({ reason: "Meshy finished without a model file." });
    return { kind: "done" as const, candidates: [files], costUsd: null };
  });

export const meshy: ArtAdapter = {
  id: "meshy",
  estimate: (request) =>
    roundUsd(
      CREDIT *
        (CREDITS.mesh +
          (request.lane === "character"
            ? CREDITS.rig +
              Math.min(MAX_ACTIONS, request.options.clips?.length ?? 0) * CREDITS.action
            : 0)),
    ),
  refuse: (request) =>
    request.lane === "creature"
      ? "Meshy rigs humanoids only. Choose Tripo for creatures in Settings → Art providers."
      : request.lane === "texture"
        ? "Meshy textures a model, not a tileable surface. Choose Google, OpenAI or Codex for textures in Settings → Art providers."
        : request.lane === "character" || request.lane === "model"
          ? null
          : `Meshy makes characters and models, not ${request.lane}.`,
  start,
  poll,
  pollEvery: Duration.seconds(5),
  licence:
    "Meshy API output on a paid plan: owned by the user. Free-plan output is Meshy's, licensed CC BY 4.0.",
};
