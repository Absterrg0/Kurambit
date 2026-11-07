// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- The pipeline's candidates are files under the game's logs, and the kit speaks one JSON line on stdout.
// The asset pipeline's server side, beside GameBlender: a review is a candidate GLB the
// one-shot pass wrote under builds/logs/blender-pipeline/<key>/, keyed by exactly what was
// reviewed (each object's digest, the style lock and the kit), and an export promotes that
// candidate as it is, or refuses. Nothing here runs Blender; GameBlender does.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GAME_MODEL_SIDECAR_SUFFIX,
  GameAssetPart,
  type GameAssetSource,
  type GameModelClip,
  GameModelMeasure,
  GameModelRefusal,
  GameModelSidecar,
} from "@kurambit/contracts";
import { walkFiles } from "./walkFiles.ts";

/** Game-relative home of the candidates; the logs cleanup makes an old review expire. */
export const PIPELINE_DIR = "builds/logs/blender-pipeline";
/** The Blender kit's folder in the templates. */
export const KIT_DIR = "blender-kit";
const CANDIDATE_JSON = "candidate.json";
export const CANDIDATE_GLB = "candidate.glb";
const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;

/**
 * The kit's version: every kit file's path and bytes, so a changed kit makes every review
 * stale by construction and nothing is bumped by hand. Python's caches are not the kit.
 */
export const kitVersion = async (kitDir: string): Promise<string> => {
  const files = await walkFiles(kitDir, {
    enter: (_full, name) => name !== "__pycache__" && !name.startsWith("."),
    match: (name) => !name.endsWith(".pyc"),
  });
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files.toSorted()) {
    hash.update(`${NodePath.relative(kitDir, file).split(NodePath.sep).join("/")}\0`);
    hash.update(await NodeFSP.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
};

/** What one kit entry said on stdout: its one result line, its refusal, or nothing (it raised). */
export type KitOutput =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "refused"; readonly reason: string; readonly text: string }
  | { readonly kind: "none" };

export const kitOutput = (stdout: string): KitOutput => {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    // Not anchored: the MCP reply prefixes the first stdout line ("Code executed successfully: ").
    const match = /(KURAMBIT_RESULT|KURAMBIT_REFUSED) (\{.*\})\s*$/.exec(lines[index]!);
    if (match === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(match[2]!);
    } catch {
      return { kind: "none" };
    }
    if (match[1] === "KURAMBIT_RESULT") return { kind: "result", value };
    const refusal = value as { readonly reason?: unknown; readonly text?: unknown };
    return {
      kind: "refused",
      reason: typeof refusal.reason === "string" ? refusal.reason : "invalid-input",
      text: typeof refusal.text === "string" ? refusal.text : "The Blender kit refused.",
    };
  }
  return { kind: "none" };
};

export const KitDigest = Schema.Struct({
  objects: Schema.Array(Schema.String),
  perObject: Schema.Record(Schema.String, Schema.String),
});
export type KitDigest = typeof KitDigest.Type;

/**
 * A review's key: the objects as they are (name and digest each, in name order), the lock and
 * the kit. A change to any of them since a review leaves the export no candidate to promote.
 */
export const reviewKey = (
  perObject: Readonly<Record<string, string>>,
  styleHash: string,
  kit: string,
): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(perObject).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    )
    .update(`\0${styleHash}\0${kit}`)
    .digest("hex");

/** What `run.py pass` prints (§2.8). */
export const PassResult = Schema.Struct({
  kind: Schema.Literals(["character", "prop"]),
  objects: Schema.Array(Schema.String),
  measured: GameModelMeasure,
  refusals: Schema.Array(GameModelRefusal),
  parts: Schema.Array(GameAssetPart).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  usedPalette: Schema.Array(Schema.String),
  /** Every armature the candidate carries, with its bone names: the lock's rig is checked on them. */
  armatures: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});

/** `candidate.json`: the pass's result as measured, plus what makes it this review's. */
const Candidate = Schema.Struct({
  ...PassResult.fields,
  key: Schema.String,
  kit: Schema.String,
  digest: Schema.Record(Schema.String, Schema.String),
  at: Schema.String,
  /** The export's default stem, and the name the concept is looked up by. */
  subject: Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,64}$/)),
  concept: Schema.NullOr(Schema.String),
});
export type Candidate = typeof Candidate.Type;
const CandidateJson = Schema.fromJsonString(Candidate);
const decodeCandidate = Schema.decodeUnknownOption(CandidateJson);
export const encodeCandidate = Schema.encodeSync(CandidateJson);

/**
 * The candidate a review left at `dir`, or null: no review, an unreadable record, or a GLB that
 * is not there as a plain file. A link is never followed, so the export never promotes one.
 */
export const readCandidate = async (dir: string): Promise<Candidate | null> => {
  const plainFile = async (path: string, max: number) => {
    const stat = await NodeFSP.lstat(path).catch(() => null);
    return stat !== null && stat.isFile() && stat.size <= max;
  };
  if (!(await plainFile(NodePath.join(dir, CANDIDATE_GLB), Number.MAX_SAFE_INTEGER))) return null;
  if (!(await plainFile(NodePath.join(dir, CANDIDATE_JSON), MAX_CANDIDATE_BYTES))) return null;
  const text = await NodeFSP.readFile(NodePath.join(dir, CANDIDATE_JSON), "utf8").catch(() => null);
  return text === null ? null : Option.getOrNull(decodeCandidate(text));
};
export const candidateJsonPath = (dir: string) => NodePath.join(dir, CANDIDATE_JSON);

/** A name fit for a file stem and the concept lookup. */
export const subjectName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "model";

/** The route an asset's body came by (a prop's: its first part's). */
export const routeOf = (parts: ReadonlyArray<GameAssetPart>): GameAssetSource["route"] => {
  const lead = parts.find((part) => part.what === "body") ?? parts[0];
  if (lead === undefined || lead.from === "made" || lead.from === "mpfb2") return "blender";
  return lead.from === "tripo" ? "tripo" : "library";
};

/** `<stem>.asset.json` beside the GLB, as the export writes it. */
export const sidecarOf = (
  candidate: Candidate,
  glb: { readonly name: string; readonly sha256: string; readonly bytes: number },
): GameModelSidecar => ({
  version: 1,
  model: glb.name,
  sha256: glb.sha256,
  bytes: glb.bytes,
  ...candidate.measured,
  measured: { kit: candidate.kit, key: candidate.key, reviewedAt: candidate.at },
  source: {
    route: routeOf(candidate.parts),
    parts: candidate.parts,
    standIn: null,
    concept: candidate.concept,
  },
});
const encodeSidecar = Schema.encodeSync(GameModelSidecar);
export const sidecarText = (sidecar: GameModelSidecar) =>
  `${JSON.stringify(encodeSidecar(sidecar), null, 2)}\n`;
export const sidecarPathOf = (glb: string) => glb.replace(/\.glb$/i, GAME_MODEL_SIDECAR_SUFFIX);

const partText = (part: GameAssetPart) => {
  const from =
    part.from === "made" ? "made in this game" : part.from === "mpfb2" ? "MPFB2" : part.from;
  const extra = [
    part.licence,
    ...(part.ai ? ["made by a generative model"] : []),
    ...(part.credits === null ? [] : [`${part.credits} credits`]),
  ].filter((entry) => entry !== "" && entry !== "made in this game");
  return `${part.what} ${from}${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`;
};

/** The ASSETS.md line of one export: where every part came from, from the stamps. */
export const ledgerLine = (file: string, candidate: Candidate) =>
  `- \`${file}\` — made in Blender by game_blender_export, with its sidecar \`${NodePath.posix.basename(sidecarPathOf(file))}\`: ${[...new Set(candidate.parts.map(partText))].join(", ")}. Depicts / loaded by: (fill in).`;

const LOCOMOTION = /walk|run|jog|sprint/i;
/** Clips whose first and last poses should agree. */
export const isLoopClip = (clip: GameModelClip) => /_loop$/i.test(clip.name);
/** Horizontal pelvis travel past which an in-place clip is said to drift, metres. */
export const DRIFT_METRES = 0.1;

const metres = (value: number) => `${value.toFixed(2)} m`;

/** The review's measurement, as the agent reads it. */
export const measurementText = (
  candidate: Candidate,
  budgets: { readonly character: number; readonly prop: number; readonly texture: number },
  bytes: number,
) => {
  const m = candidate.measured;
  const budget = m.kind === "character" ? budgets.character : budgets.prop;
  const lines = [
    `Measured: a ${m.kind}${m.skeleton === null ? "" : ` on ${m.skeleton}`}${m.restDeviation === null ? "" : `, rest frames ${m.restDeviation.toFixed(1)}° off the standard skeleton at most`}.`,
    `- ${m.triangles.toLocaleString("en-US")} triangles of ${budget.toLocaleString("en-US")}; ${m.materials} material${m.materials === 1 ? "" : "s"}; textures ${m.textures.length === 0 ? "none" : m.textures.map((t) => `${t.width}x${t.height}`).join(", ")} (largest side allowed ${budgets.texture}); ${(bytes / 1048576).toFixed(2)} MB.`,
    `- ${metres(m.height)} tall, footprint ${metres(m.footprint.width)} x ${metres(m.footprint.depth)}.`,
  ];
  if (m.clips.length > 0)
    lines.push(
      `- Clips: ${m.clips
        .map((clip) =>
          [
            `${clip.name} ${clip.seconds.toFixed(2)} s`,
            ...(isLoopClip(clip) ? [clip.loops ? "loops" : "loop seam broken"] : []),
            ...(Math.abs(clip.rootDrift) > DRIFT_METRES
              ? [`root drifts ${metres(clip.rootDrift)}`]
              : []),
            ...(clip.groundSpeed !== null
              ? [`ground speed ${clip.groundSpeed.toFixed(2)} m/s (${clip.groundSpeedFrom})`]
              : LOCOMOTION.test(clip.name)
                ? ["ground speed not measured"]
                : []),
          ].join(", "),
        )
        .join("; ")}.`,
    );
  if (m.springs.length > 0)
    lines.push(
      `- Springs: ${m.springs.map((spring) => `${spring.name} (${spring.bones.join(", ")})`).join("; ")}.`,
    );
  return lines.join("\n");
};

/**
 * The subject's concept: its section of art/CONCEPT.md (a heading naming it, to the next
 * heading as high) and art/concepts/<name>.png. Both are read only as real files in the game.
 */
export const conceptOf = async (realRoot: string, name: string) => {
  const plain = async (relative: string) => {
    const absolute = NodePath.join(realRoot, relative);
    const stat = await NodeFSP.lstat(absolute).catch(() => null);
    return stat !== null && stat.isFile() ? absolute : null;
  };
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/[_\-\s]+/g, " ")
      .trim();
  const wanted = words(name);
  const doc = await plain("art/CONCEPT.md");
  let section: string | null = null;
  if (doc !== null) {
    const lines = (await NodeFSP.readFile(doc, "utf8").catch(() => "")).split("\n");
    const start = lines.findIndex((line) => {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      return heading !== null && words(heading[2]!).includes(wanted);
    });
    if (start >= 0) {
      const level = /^(#+)/.exec(lines[start]!)![1]!.length;
      const end = lines.findIndex(
        (line, index) =>
          index > start && /^(#{1,6})\s/.test(line) && /^(#+)/.exec(line)![1]!.length <= level,
      );
      section = lines
        .slice(start, end < 0 ? undefined : end)
        .join("\n")
        .trim()
        .slice(0, 3000);
    }
  }
  const png = await plain(`art/concepts/${name}.png`);
  const refs = [
    ...(section === null ? [] : [`art/CONCEPT.md#${name}`]),
    ...(png === null ? [] : [`art/concepts/${name}.png`]),
  ];
  return { section, png, ref: refs.length === 0 ? null : refs.join(" and ") };
};
