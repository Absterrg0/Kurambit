// @effect-diagnostics nodeBuiltinImport:off -- the record is a file in the game folder, read beside the model it describes.
// Where a generated file came from: the `<name>.generation.json` game_generate writes beside its
// files under art/generated/<lane>/<name>/. The Blender pipeline stamps an import with it, so the
// review, the export's sidecar and ASSETS.md credit the provider, the AI flag and the cost. The
// record only names the generation: what is stamped comes from the server's own row of it, so a
// hand-written record beside any model imports nothing.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type GameArtLane, GameOperationError } from "@kurambit/contracts";
import type { GameArtDelivered } from "./art/GameArt.ts";

export const GENERATED_DIR = "art/generated";

/** The one field of the record the pipeline reads: which generation wrote it. */
const GenerationRecord = Schema.Struct({ id: Schema.String });
const decodeRecord = Schema.decodeUnknownResult(Schema.fromJsonString(GenerationRecord));

/** A generated file's stamp, as the kit writes it on what it imports. */
export interface GeneratedSource {
  readonly lane: GameArtLane;
  /** The generation that delivered it and the file, as the import binds a creature's rig to them. */
  readonly generation: { readonly id: string; readonly path: string };
  /** A creature's own rig id, `<provider>-<body plan>`: its sidecar's skeleton. */
  readonly rig: string;
  readonly stamp: {
    readonly from: string;
    readonly licence: string;
    readonly ai: true;
    readonly credits: number | null;
  };
}

const MODEL = /\.(glb|gltf|fbx)$/i;

/**
 * The model at a game-relative path under art/generated/ and its generation record. Refused,
 * never guessed: a path outside art/generated/ or the game, a link, another file type, or a
 * folder with no record that reads as one (the ledger could not credit it).
 */
export const generatedSource = (
  realRoot: string,
  relative: string,
  operation: string,
  /** The server's finished generation that delivered this game-relative path, or null. */
  delivered: (
    id: string,
    path: string,
  ) => Effect.Effect<GameArtDelivered | null, GameOperationError>,
): Effect.Effect<{ readonly file: string; readonly source: GeneratedSource }, GameOperationError> =>
  Effect.gen(function* () {
    const refuse = (detail: string) =>
      Effect.fail(
        new GameOperationError({ operation, path: relative, reason: "invalid-input", detail }),
      );
    const normal = NodePath.posix.normalize(relative.replaceAll("\\", "/"));
    if (!normal.startsWith(`${GENERATED_DIR}/`) || !MODEL.test(normal))
      return yield* refuse(
        `${relative} is not a model game_generate delivered: give the game-relative .glb, .gltf or .fbx under ${GENERATED_DIR}/<lane>/<name>/, as the generation's files list it.`,
      );
    const absolute = NodePath.join(realRoot, normal);
    const real = yield* Effect.promise(() => NodeFSP.realpath(absolute).catch(() => null));
    if (real === null || real !== absolute)
      return yield* refuse(
        `${relative} is not a file in this game${real === null ? "" : " (it is a link)"}: pick the generation up with game_generate_wait, which lists its files.`,
      );
    const dir = NodePath.dirname(real);
    const records = yield* Effect.promise(() =>
      NodeFSP.readdir(dir)
        .then((names) => names.filter((name) => name.endsWith(".generation.json")))
        .catch(() => [] as string[]),
    );
    const own = `${NodePath.basename(dir)}.generation.json`;
    const name = records.includes(own) ? own : records.length === 1 ? records[0] : undefined;
    if (name === undefined)
      return yield* refuse(
        `${NodePath.posix.dirname(normal)} holds ${records.length === 0 ? "no" : "more than one"} generation record (<name>.generation.json), so the ledger cannot say where ${NodePath.basename(normal)} came from. Only files game_generate delivered are imported as generated.`,
      );
    const text = yield* Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(dir, name), "utf8").catch(() => ""),
    );
    const decoded = decodeRecord(text);
    if (Result.isFailure(decoded))
      return yield* refuse(
        `${NodePath.posix.dirname(normal)}/${name} does not read as a generation record: ${decoded.failure.message.slice(0, 600)}`,
      );
    const row = yield* delivered(decoded.success.id, normal);
    if (row === null)
      return yield* refuse(
        `${normal} is not a file a finished generation of this game delivered (its record names generation ${decoded.success.id.slice(0, 64)}). Only what game_generate delivered is imported as generated: game_generate_wait lists a generation's files.`,
      );
    const generation = row.generation;
    return {
      file: real,
      source: {
        lane: generation.lane,
        generation: { id: generation.id, path: normal },
        rig: `${generation.provider}-${row.body ?? "creature"}`,
        stamp: {
          from: generation.provider,
          licence: row.licence.slice(0, 200),
          ai: true,
          credits: generation.costUsd,
        },
      },
    };
  });

const titleCase = (snake: string) =>
  snake
    .split("_")
    .filter((word) => word !== "")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("_");

/**
 * The clip a motion-lane GLB adds to a character, from its file name beside the generation's
 * name: `slam.glb` is Slam, `slam.loop.glb` Slam_Loop, a locomotion set's `walk.walk_fwd_loop.glb`
 * Walk_Fwd_Loop (the set's own names, which animate() reads as walk and run).
 */
export const motionClipName = (generationName: string, path: string): string => {
  const stem = NodePath.posix.basename(path.replaceAll("\\", "/")).replace(/\.[^.]+$/, "");
  const label = stem.startsWith(`${generationName}.`) ? stem.slice(generationName.length + 1) : "";
  if (label === "") return titleCase(generationName);
  return label === "loop" ? `${titleCase(generationName)}_Loop` : titleCase(label);
};
