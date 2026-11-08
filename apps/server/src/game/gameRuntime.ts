// @effect-diagnostics nodeBuiltinImport:off -- Resolves and copies Kurambit's runtime files on the native filesystem.
// Kurambit's runtime: the code a game loads but does not own (three.js, its addons, the demo
// shell), kept once in the server's templates under runtime/<engine>/<major>/ instead of copied
// into every game. A game pins a major in game.json; every minor and patch of that major reaches
// it, and a breaking change is a new major folder beside the old ones, which stay. The game's
// pages load it at _kurambit/runtime/<engine>/<major>/, which the game servers answer from here
// (gameWebServer) and which an export holds as real files, so a release runs with no Kurambit.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { GameEngineId, manifestRuntime, type GameManifest } from "@kurambit/contracts";
import type { GameTemplates } from "./GameTemplates.ts";
import { copyTree } from "./gameFiles.ts";
import { readWebBuild } from "./webBuild.ts";

/** Where a page finds the runtime, relative to the game's served folder (and inside an export). */
export const RUNTIME_ROUTE = "_kurambit/runtime";
/** The runtimes' folder in the server's templates. */
export const runtimesDirectory = (templates: string) => NodePath.join(templates, "runtime");

const isEngine = Schema.is(GameEngineId);

/** The runtimes folder a game's page is served with: null for a game that carries its own copy. */
export const runtimesFor = (templates: GameTemplates["Service"], manifest: GameManifest) =>
  manifestRuntime(manifest) === null
    ? Effect.succeed(null)
    : Effect.map(templates.directory, runtimesDirectory);

/**
 * The runtime file a request path names ("/_kurambit/runtime/three/1/shell/shell.js"), as an
 * absolute path under `runtimes`; null when the path is not the runtime's or names no engine
 * and major. The caller has already refused `..`, backslashes and NULs; the realpath check
 * keeps a link from reaching outside the runtime.
 */
export const runtimeRequestFile = async (
  runtimes: string,
  requestPath: string,
): Promise<string | null> => {
  const prefix = `/${RUNTIME_ROUTE}/`;
  if (!requestPath.startsWith(prefix)) return null;
  const [engine, major, ...rest] = requestPath.slice(prefix.length).split("/");
  if (engine === undefined || !isEngine(engine) || !/^[1-9][0-9]{0,3}$/.test(major ?? ""))
    return null;
  if (rest.length === 0 || rest.some((segment) => segment === "" || segment === ".")) return null;
  const base = await NodeFSP.realpath(NodePath.join(runtimes, engine, major!)).catch(() => null);
  if (base === null) return null;
  const real = await NodeFSP.realpath(NodePath.join(base, ...rest)).catch(() => null);
  return real !== null && real.startsWith(base + NodePath.sep) ? real : null;
};

const RuntimeInfo = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const decodeInfo = Schema.decodeUnknownOption(RuntimeInfo);

/**
 * The runtime a game of this major loads now, for the facts: its version and a digest of its
 * files ("three 1.2.0+3f2a9c1d0b7e"), so a runtime edit that forgot its version bump still
 * reads as a different runtime. Null when this server ships no such major.
 */
export const runtimeVersion = async (
  runtimes: string,
  engine: GameEngineId,
  major: number,
): Promise<string | null> => {
  const folder = NodePath.join(runtimes, engine, String(major));
  const info = await NodeFSP.readFile(NodePath.join(folder, "runtime.json"), "utf8").catch(
    () => null,
  );
  const version = info === null ? Option.none() : decodeInfo(info);
  const files = await readWebBuild(folder);
  if (Option.isNone(version) || "problem" in files) return null;
  return `${engine} ${version.value.version}+${files.buildId.slice(0, 12)}`;
};

/**
 * Copies the runtime major a game loads into a staged export at the path its pages load it
 * from, licences and provenance included, so the release runs from any static server.
 */
export const copyRuntimeInto = async (
  runtimes: string,
  engine: GameEngineId,
  major: number,
  staging: string,
  signal?: AbortSignal,
): Promise<void> => {
  const target = NodePath.join(staging, ...RUNTIME_ROUTE.split("/"), engine, String(major));
  // A folder of the game's own at that path is replaced: the release carries the real runtime.
  await NodeFSP.rm(target, { recursive: true, force: true });
  await copyTree(NodePath.join(runtimes, engine, String(major)), target, signal);
};

/** Whether this server ships the runtime major a game loads. */
export const hasRuntime = (runtimes: string, engine: GameEngineId, major: number) =>
  NodeFSP.access(NodePath.join(runtimes, engine, String(major), "runtime.json")).then(
    () => true,
    () => false,
  );
