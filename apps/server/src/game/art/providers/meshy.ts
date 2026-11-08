// Meshy (https://docs.meshy.ai/en/api): tasks polled by id. A model is one task (image, multi-image or text to 3D,
// remeshed to the asked face count, or made by a Smart Topology model at it when low-poly is
// asked); a character adds rigging (humanoids only), which
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
  type ArtStep,
  ArtProviderError,
  UNKNOWN_STATUS_LIMIT,
  dataUri,
  field,
  pendingStage,
  requireKey,
  roundUsd,
  stringField,
} from "./adapter.ts";

const BASE = "https://api.meshy.ai/openapi/v1";
/** Text to 3D is the one task on v2 (its preview and refine, and its GET). */
const urlOf = (kind: Kind | "rigging" | "animations") =>
  kind === "text-to-3d" ? "https://api.meshy.ai/openapi/v2/text-to-3d" : `${BASE}/${kind}`;
const MESHY_MODEL = "meshy-7.1";
/** The Smart Topology model the docs name for game characters and low-poly assets. */
const MESHY_LOW_POLY_MODEL = "meshy-t2.5";
/** meshy-t2.5's target_polycount range (docs/api/image-to-3d). */
const LOW_POLY_FACES = { min: 100, max: 30_000 } as const;
/** USD per credit at the Pro plan's rate (1,000 credits for $20), 2026-11. */
const CREDIT = 0.02;
/** A textured mesh: 30 on meshy-7.1, 15 on Smart Topology (text: a 5 preview plus a 10 refine). */
const CREDITS = { mesh: 30, lowPolyMesh: 15, rig: 5, action: 3 } as const;
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
  /** The next paid stage, saved before it is started (see `pendingStage`). */
  readonly pending?: "refine" | "rig" | "animate" | null;
  /** The library actions the animate stage asks for, found when the rig finished. */
  readonly actions?: ReadonlyArray<number>;
  /** Answers in a row whose status was none of the documented ones. */
  readonly unknown?: number;
  /** The person looks at the model before the rig: its files come with the pending rig. */
  readonly review?: boolean;
  /** What the model stage costs, in credits (Meshy reports none). */
  readonly meshCredits?: number;
}

const meshCreditsOf = (request: Pick<ArtRequest, "options">) =>
  request.options.lowPoly === true ? CREDITS.lowPolyMesh : CREDITS.mesh;

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

/** The first task's endpoint and body: the shape the fixtures check. */
export const meshyMeshRequest = (request: ArtRequest) => {
  const kind: Kind =
    request.references.length === 0
      ? "text-to-3d"
      : request.references.length === 1
        ? "image-to-3d"
        : "multi-image-to-3d";
  const polycount = request.options.polycount;
  // Low-poly is made at the face count by a Smart Topology model (no remesh, triangles only);
  // the docs say not to remesh meshy-7.1 down to a game budget instead.
  const topology =
    request.options.lowPoly === true
      ? {
          model_type: "smart-topology",
          ai_model: MESHY_LOW_POLY_MODEL,
          ...(polycount === undefined
            ? {}
            : {
                target_polycount: Math.min(
                  LOW_POLY_FACES.max,
                  Math.max(LOW_POLY_FACES.min, Math.round(polycount)),
                ),
              }),
        }
      : {
          ai_model: MESHY_MODEL,
          topology: "triangle",
          should_remesh: true,
          ...(polycount === undefined ? {} : { target_polycount: Math.round(polycount) }),
        };
  const shape = {
    ...topology,
    ...(request.lane === "character" ? { pose_mode: "a-pose" } : {}),
  };
  const body =
    kind === "text-to-3d"
      ? { mode: "preview", prompt: request.prompt.slice(0, 800), ...shape }
      : {
          ...(kind === "image-to-3d"
            ? { image_url: dataUri(request.references[0]!) }
            : { image_urls: request.references.slice(0, 4).map(dataUri) }),
          should_texture: true,
          enable_pbr: true,
          target_formats: ["glb"],
          ...shape,
        };
  return { kind, url: urlOf(kind), body };
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
      meshCredits: meshCreditsOf(request),
      ...(request.review === true ? { review: true } : {}),
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
      url: `${urlOf(remote.kind)}/${encodeURIComponent(remote.task)}`,
      headers: auth(key),
    });
    const status = stringField(task, "status");
    if (status === "PENDING" || status === "IN_PROGRESS")
      return {
        kind: "making" as const,
        remote: remote.unknown === undefined ? stored : ({ ...stored, unknown: 0 } as ArtRemote),
      };
    // A reshaped answer reads as no status: a few in a row are waited out, then given up.
    if (status === null) {
      const unknown = (remote.unknown ?? 0) + 1;
      if (unknown >= UNKNOWN_STATUS_LIMIT)
        return yield* new ArtProviderError({
          reason: `Meshy answered its ${remote.stage} task ${unknown} times in a row with no status; Kurambit stopped asking.`,
        });
      return { kind: "making" as const, remote: { ...stored, unknown } as ArtRemote };
    }
    if (status !== "SUCCEEDED")
      return yield* new ArtProviderError({
        reason: `Meshy's ${remote.stage} task ended ${status.toLowerCase()}${
          stringField(task, "task_error", "message") === null
            ? ""
            : `: ${stringField(task, "task_error", "message")}`
        }.`,
      });
    // A text request's preview is untextured: refine it before anything else.
    if (remote.stage === "mesh" && remote.kind === "text-to-3d")
      return {
        kind: "making" as const,
        remote: { ...stored, pending: "refine", unknown: 0 } as ArtRemote,
      };
    if ((remote.stage === "mesh" || remote.stage === "refine") && remote.lane === "character") {
      const next = { ...stored, pending: "rig", unknown: 0 } as ArtRemote;
      if (remote.review !== true) return { kind: "making" as const, remote: next };
      // The person looks at the model before the rig is bought; Meshy deletes it in 3 days.
      const url = stringField(task, "model_urls", "glb");
      if (url === null)
        return yield* new ArtProviderError({
          reason: "Meshy finished the model without a model file.",
        });
      return {
        kind: "making" as const,
        remote: next,
        files: [
          {
            role: "asset",
            ext: "glb",
            bytes: yield* context.http.download(url),
            label: "model",
          } satisfies ArtFile,
        ],
        spent: { usd: roundUsd(CREDIT * (remote.meshCredits ?? CREDITS.mesh)), estimated: true },
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
        if (ids.length > 0)
          // The rig's files are kept now: Meshy deletes them in 3 days, and the clips may take longer.
          return {
            kind: "making" as const,
            remote: { ...stored, pending: "animate", actions: ids, unknown: 0 } as ArtRemote,
            files,
          };
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

/** Starts the saved pending stage, once. */
const advance = (context: ArtContext, stored: ArtRemote) =>
  Effect.gen(function* () {
    const key = yield* requireKey("meshy", context);
    const remote = stored as unknown as MeshyRemote;
    const post = (kind: Kind | "rigging" | "animations", body: unknown) =>
      context.http
        .json("meshy", { method: "POST", url: urlOf(kind), headers: auth(key), json: body })
        .pipe(Effect.flatMap(created));
    switch (pendingStage(stored)) {
      case "refine": {
        const refine = yield* post("text-to-3d", {
          mode: "refine",
          preview_task_id: remote.task,
          enable_pbr: true,
        });
        return {
          kind: "making" as const,
          remote: { ...stored, stage: "refine", task: refine, pending: null } as ArtRemote,
        } satisfies ArtStep;
      }
      case "rig": {
        const rig = yield* post("rigging", {
          input_task_id: remote.task,
          height_meters: remote.height ?? 1.7,
        });
        return {
          kind: "making" as const,
          remote: {
            ...stored,
            stage: "rig",
            kind: "rigging",
            task: rig,
            rig,
            pending: null,
          } as ArtRemote,
          note: "Rigging.",
        } satisfies ArtStep;
      }
      case "animate": {
        const animate = yield* post("animations", {
          rig_task_id: remote.task,
          action_ids: remote.actions ?? [],
        });
        return {
          kind: "making" as const,
          remote: {
            ...stored,
            stage: "animate",
            kind: "animations",
            task: animate,
            pending: null,
          } as ArtRemote,
          note: "Adding clips.",
        } satisfies ArtStep;
      }
      default:
        return yield* new ArtProviderError({ reason: "Meshy has no stage waiting to start." });
    }
  });

export const meshy: ArtAdapter = {
  id: "meshy",
  estimate: (request) =>
    roundUsd(
      CREDIT *
        (meshCreditsOf(request) +
          (request.lane === "character"
            ? CREDITS.rig +
              Math.min(MAX_ACTIONS, request.options.clips?.length ?? 0) * CREDITS.action
            : 0)),
    ),
  refuse: (request) =>
    request.options.parts === true
      ? "Meshy makes no separate parts. Choose Tripo for models in Settings → Art providers."
      : request.options.mesh !== undefined
        ? "Kurambit rigs the game's own mesh through Tripo. Choose Tripo for this lane in Settings → Art providers."
        : request.options.lowPoly === true && request.references > 1
          ? "Meshy makes low-poly (Smart Topology) from one picture, not several: pass the one picture of the subject, or choose Tripo."
          : request.lane === "creature"
            ? "Meshy rigs humanoids only. Choose Tripo for creatures in Settings → Art providers."
            : request.lane === "texture"
              ? "Meshy textures a model, not a tileable surface. Choose Google, OpenAI or Codex for textures in Settings → Art providers."
              : request.lane === "character" || request.lane === "model"
                ? null
                : `Meshy makes characters and models, not ${request.lane}.`,
  start,
  poll,
  advance,
  pollEvery: Duration.seconds(5),
  checkKey: (context) =>
    requireKey("meshy", context).pipe(
      Effect.flatMap((key) =>
        context.http.json("meshy", { method: "GET", url: `${BASE}/balance`, headers: auth(key) }),
      ),
      Effect.asVoid,
    ),
  licence:
    "Meshy API output on a paid plan: owned by the user. Free-plan output is Meshy's, licensed CC BY 4.0.",
};
