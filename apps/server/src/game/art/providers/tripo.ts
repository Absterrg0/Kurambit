// Tripo (API v3, https://developers.tripo3d.ai/en/docs/introduction): every step is a task polled
// by id. A model is one task (H3.1 image or text to 3D, textured, smart low poly when asked); a
// model in parts is made untextured (Tripo makes parts only so) and textured by a second task; a
// character adds a rig on the Unreal bone names and a few preset clips; a creature is rigged on its
// own body plan's skeleton with the one clip Tripo has for it. A game's own mesh is uploaded and
// rigged as it is (the rig takes a file token as its input). Credits are frozen at a task's start
// and released if it fails, so a failed stage costs what the stages before it did. Each task
// reports the credits it consumed. Result URLs expire after 5 minutes: files are downloaded at once.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { GameArtBodyPlan } from "@kurambit/contracts";
import {
  type ArtAdapter,
  type ArtContext,
  type ArtFile,
  type ArtRemote,
  type ArtRequest,
  type ArtRestore,
  type ArtStep,
  ArtProviderError,
  UNKNOWN_STATUS_LIMIT,
  field,
  numberField,
  pendingStage,
  requireKey,
  roundUsd,
  stringField,
} from "./adapter.ts";

const BASE = "https://openapi.tripo3d.ai/v3";
const TRIPO_MODEL = "v3.1-20260211";
const RIG_BIPED = "v3.0-20260909";
const RIG_CREATURE = "v2.5-20260210";
/** The texture model the docs recommend for v3.x geometry (docs/models-texture). */
const TEXTURE_MODEL = "v3.0-20250812";
/** smart_low_poly's fixed triangle range (docs/generation-image-to-model). */
const LOW_POLY_FACES = { min: 500, max: 20_000 } as const;
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
  imageBare: 0.2,
  textBare: 0.1,
  smartLowPoly: 0.1,
  parts: 0.2,
  texture: 0.1,
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

type Stage = "upload" | "mesh" | "texture" | "rig" | "retarget";
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
  /** The next paid stage, saved before it is started (see `pendingStage`). */
  readonly pending?: "texture" | "rig" | "retarget" | null;
  /** Answers in a row whose status was none of the documented ones. */
  readonly unknown?: number;
  /** The person looks at the model before the rig: its files come with the pending rig. */
  readonly review?: boolean;
  /** A model in parts: textured by its own task after the untextured parts are made. */
  readonly parts?: boolean;
  /** The texture task's guide: the reference's file token (the docs recommend re-sending it), else the prompt. */
  readonly texturePrompt?: { readonly image: string } | { readonly text: string } | null;
  /** How Tripo normalized an uploaded mesh it rigged (the rig task reports it). */
  readonly restore?: ArtRestore | null;
}

/**
 * The asked clips; unasked, a character's idle, walk and run, and a creature rigged from the game's
 * own mesh its body plan's one preset (a hand-made dragon gets a walk). A generated creature asks.
 */
const clipsOf = (request: Pick<ArtRequest, "lane" | "options">): ReadonlyArray<string> =>
  request.lane === "model"
    ? []
    : (
        request.options.clips ??
        (request.lane === "character"
          ? CHARACTER_CLIPS
          : request.options.mesh !== undefined &&
              CREATURE_PRESET[request.options.body ?? "other"] !== undefined
            ? ["walk"]
            : [])
      ).slice(0, MAX_CLIPS);

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

/**
 * The generation task's body: the shape the fixtures check. Parts are refused with a texture
 * (error 1004) and dropped under smart_low_poly, so a model in parts asks for neither.
 */
export const tripoMeshBody = (
  request: Omit<ArtRequest, "references">,
  fileToken: string | null,
) => {
  const parts = request.options.parts === true;
  const lowPoly = request.options.lowPoly === true && !parts;
  const polycount = request.options.polycount;
  return {
    model: TRIPO_MODEL,
    // image-to-model takes the uploaded file's token as its `input`.
    ...(fileToken === null ? { prompt: request.prompt.slice(0, 1024) } : { input: fileToken }),
    texture: !parts,
    pbr: !parts,
    ...(parts ? { generate_parts: true } : {}),
    ...(lowPoly ? { smart_low_poly: true } : {}),
    ...(polycount === undefined
      ? {}
      : {
          face_limit: lowPoly
            ? Math.min(LOW_POLY_FACES.max, Math.max(LOW_POLY_FACES.min, Math.round(polycount)))
            : Math.round(polycount),
        }),
    auto_size: true,
  };
};

/** The texture task over a model in parts: every part is textured (no part_names), with PBR. */
export const tripoTextureBody = (remote: Pick<TripoRemote, "mesh" | "texturePrompt">) => ({
  input: remote.mesh,
  model: TEXTURE_MODEL,
  pbr: true,
  ...(remote.texturePrompt === null || remote.texturePrompt === undefined
    ? {}
    : { texture_prompt: remote.texturePrompt }),
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

/** Uploads a file (an image or a model) and answers its token. */
const upload = (context: ArtContext, key: string, bytes: Uint8Array, mime: string, name: string) =>
  Effect.gen(function* () {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), name);
    const uploaded = yield* context.http.json("tripo", {
      method: "POST",
      url: `${BASE}/files`,
      headers: auth(key),
      form,
    });
    const token = stringField(uploaded, "data", "file_token");
    if (token === null)
      return yield* new ArtProviderError({ reason: "Tripo took the file but gave no file token." });
    return token;
  });

/**
 * The game's own mesh: uploaded (free), then rigged from its file token as the rig's first and only
 * model stage. The rig is the first paid request, saved as pending before it is sent.
 */
const startUpload = (context: ArtContext, key: string, request: ArtRequest, path: string) =>
  Effect.gen(function* () {
    const bytes = yield* context.readFile(path);
    const token = yield* upload(
      context,
      key,
      bytes,
      "model/gltf-binary",
      path.split(/[\\/]/).pop() ?? "mesh.glb",
    );
    const resolved = tripoPresets(request);
    const remote: TripoRemote = {
      stage: "upload",
      task: token,
      mesh: token,
      rig: null,
      lane: request.lane as TripoRemote["lane"],
      body: request.options.body ?? null,
      clips: "presets" in resolved ? resolved.presets : [],
      credits: 0,
      pending: "rig",
    };
    return {
      kind: "making" as const,
      remote: remote as unknown as ArtRemote,
      note: "Rigging the game's mesh.",
    };
  });

const start = (context: ArtContext, request: ArtRequest) =>
  Effect.gen(function* () {
    const key = yield* requireKey("tripo", context);
    if (request.uploads?.mesh !== undefined)
      return yield* startUpload(context, key, request, request.uploads.mesh);
    let fileToken: string | null = null;
    const reference = request.references[0];
    if (reference !== undefined)
      fileToken = yield* upload(
        context,
        key,
        reference.bytes,
        reference.mime,
        reference.path.split("/").pop() ?? "reference.png",
      );
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
      ...(request.review === true ? { review: true } : {}),
      ...(request.options.parts === true
        ? {
            parts: true,
            texturePrompt:
              fileToken === null ? { text: request.prompt.slice(0, 1024) } : { image: fileToken },
          }
        : {}),
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
    if (status === "queued" || status === "running")
      return {
        kind: "making" as const,
        remote: remote.unknown === undefined ? stored : ({ ...stored, unknown: 0 } as ArtRemote),
      };
    if (status === "failed" || status === "cancelled") {
      const message = stringField(answer, "data", "error_message");
      return yield* new ArtProviderError({
        reason: `Tripo's ${remote.stage} task ended ${status}${message === null ? "" : `: ${message}`}.`,
        // A failed task's credits are released; the stages before it were spent.
        ...(spent === null ? {} : { costUsd: roundUsd(spent * USD_PER_CREDIT) }),
      });
    }
    // The docs allow other values ("unknown") that are neither an end nor a failure, and a
    // reshaped answer reads as none: a few in a row are waited out, then the job is given up.
    if (status !== "success") {
      const unknown = (remote.unknown ?? 0) + 1;
      if (unknown >= UNKNOWN_STATUS_LIMIT)
        return yield* new ArtProviderError({
          reason: `Tripo answered its ${remote.stage} task ${unknown} times in a row with ${status === null ? "no status" : `status "${status}"`}; Kurambit stopped asking.`,
        });
      return { kind: "making" as const, remote: { ...stored, unknown } as ArtRemote };
    }
    const consumed = numberField(answer, "data", "credits_consumed");
    const credits = spent === null || consumed === null ? null : spent + consumed;
    const output = field(answer, "data", "output");
    if (remote.stage === "mesh" && remote.parts === true)
      return {
        kind: "making" as const,
        remote: { ...stored, pending: "texture", credits, unknown: 0 } as ArtRemote,
      };
    if (remote.stage === "mesh" && remote.lane !== "model") {
      const next = { ...stored, pending: "rig", credits, unknown: 0 } as ArtRemote;
      if (remote.review !== true) return { kind: "making" as const, remote: next };
      // The person looks at the model before the rig is bought: it comes now, while its URL lives.
      const urls = tripoModelUrls(output);
      if (urls.length === 0)
        return yield* new ArtProviderError({
          reason: "Tripo finished the model without a model file.",
          ...(credits === null ? {} : { costUsd: roundUsd(credits * USD_PER_CREDIT) }),
        });
      const files: ArtFile[] = [
        {
          role: "asset",
          ext: extOf(urls[0]!),
          bytes: yield* context.http.download(urls[0]!),
          label: "model",
        },
      ];
      return {
        kind: "making" as const,
        remote: next,
        files,
        ...(credits === null
          ? {}
          : { spent: { usd: roundUsd(credits * USD_PER_CREDIT), estimated: false } }),
      };
    }
    // A mesh Tripo imported (an upload) comes back normalized, and the rig says how.
    const restore = remote.stage === "rig" ? (restoreOf(output) ?? null) : (remote.restore ?? null);
    if (remote.stage === "rig" && remote.clips.length > 0)
      return {
        kind: "making" as const,
        remote: { ...stored, pending: "retarget", credits, unknown: 0, restore } as ArtRemote,
      };
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
      ...(restore === null ? {} : { restore }),
    };
  });

/** `normalize_scale` and `normalize_translation` of a task whose input was a file token. */
const restoreOf = (output: unknown): ArtRestore | undefined => {
  const scale = numberField(output, "normalize_scale");
  const translation = field(output, "normalize_translation");
  if (scale === null || scale <= 0) return undefined;
  const moved =
    Array.isArray(translation) &&
    translation.length === 3 &&
    translation.every((value) => typeof value === "number" && Number.isFinite(value))
      ? (translation as unknown as readonly [number, number, number])
      : ([0, 0, 0] as const);
  return { scale, translation: moved };
};

/** Starts the saved pending stage, once. */
const advance = (context: ArtContext, stored: ArtRemote) =>
  Effect.gen(function* () {
    const key = yield* requireKey("tripo", context);
    const remote = stored as unknown as TripoRemote;
    switch (pendingStage(stored)) {
      case "texture": {
        const texture = yield* post(context, key, "/models/texture", tripoTextureBody(remote));
        return {
          kind: "making" as const,
          remote: { ...stored, stage: "texture", task: texture, pending: null } as ArtRemote,
          note: "Texturing the parts.",
        } satisfies ArtStep;
      }
      case "rig": {
        const rig = yield* post(context, key, "/animations/rig", tripoRigBody(remote));
        return {
          kind: "making" as const,
          remote: { ...stored, stage: "rig", task: rig, rig, pending: null } as ArtRemote,
          note: "Rigging.",
        } satisfies ArtStep;
      }
      case "retarget": {
        const retarget = yield* post(
          context,
          key,
          "/animations/retarget",
          tripoRetargetBody(remote.task, remote.clips),
        );
        return {
          kind: "making" as const,
          remote: { ...stored, stage: "retarget", task: retarget, pending: null } as ArtRemote,
          note: "Adding clips.",
        } satisfies ArtStep;
      }
      default:
        return yield* new ArtProviderError({ reason: "Tripo has no stage waiting to start." });
    }
  });

export const tripo: ArtAdapter = {
  id: "tripo",
  estimate: (request) => {
    const image = request.references > 0;
    const parts = request.options.parts === true;
    const mesh =
      request.options.mesh !== undefined
        ? 0
        : parts
          ? (image ? PRICE.imageBare : PRICE.textBare) + PRICE.parts + PRICE.texture
          : (image ? PRICE.imageTextured : PRICE.textTextured) +
            (request.options.lowPoly === true ? PRICE.smartLowPoly : 0);
    if (request.lane === "model") return roundUsd(mesh);
    const resolved = tripoPresets(request);
    return roundUsd(
      mesh + PRICE.rig + ("presets" in resolved ? resolved.presets.length : 0) * PRICE.clip,
    );
  },
  refuse: (request) => {
    if (request.lane !== "character" && request.lane !== "creature" && request.lane !== "model")
      return `Tripo makes characters, creatures and models, not ${request.lane}.`;
    if (request.options.parts === true && request.options.lowPoly === true)
      return "Tripo makes parts or smart low-poly, not both (its low-poly drops the parts): ask for one.";
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
  advance,
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
      Effect.map((answer) => {
        const balance = Number(
          (answer as { data?: { balance?: unknown } } | null)?.data?.balance ?? Number.NaN,
        );
        if (!Number.isFinite(balance)) return undefined;
        // A key with no credits works but cannot make anything: say so before a turn finds out.
        return balance > 0
          ? { ready: true, note: `Key works. ${balance} credits left.` }
          : {
              ready: false,
              note: "Key works, but the account has no credits: buy some at platform.tripo3d.ai.",
            };
      }),
    ),
  licence:
    "Tripo API output (paid credits): the user has all rights, including commercial use. Free-tier output belongs to Tripo.",
};
