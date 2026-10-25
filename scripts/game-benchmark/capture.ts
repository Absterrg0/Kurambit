// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- A maintainer capture writes its own evidence folder and records wall-clock identity.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  GameConsoleMessage,
  GamePlaytestStep,
  isGameplayInputStep,
  playtestInputIssues,
  type GameWebPlaytestResult,
} from "../../packages/contracts/src/index.ts";
import { playtest, type GameWebPlaytestInput } from "../../apps/server/src/game/GameWebPlaytest.ts";
import { playtestStepAction } from "../../apps/server/src/game/playtestInputPairs.ts";
import { chooseFrames } from "../game-grade.ts";
import { defaultHeadlessBrowser, serveWebBuild } from "../lib/web-build-server.ts";
import type { LoadedGameBenchmarkBrief } from "./artifacts.ts";

/**
 * A capture-only frame pack for comparing two revisions.
 *
 * It boots one already-exported Web artifact and dispatches an explicit,
 * bounded route. It never exports, votes, plans, repairs, or asks a model. The
 * result is evidence for the look/feel comparison, not an obligations grade:
 * there is no grade.json, no YES/NO vote, and no calibration control here.
 */

export const CAPTURE_VERSION = 1;
export const CAPTURE_MANIFEST_ROLE = "revision-frame-capture";
export const CAPTURE_MANIFEST_FILE = "frame-pack.json";
const DEFAULT_BOOT_TIMEOUT_MS = 30_000;

const Viewport = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
});

const CaptureRouteFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  label: Schema.optionalKey(Schema.String),
  viewport: Viewport,
  steps: Schema.Array(GamePlaytestStep),
});
export type CaptureRoute = typeof CaptureRouteFile.Type;

const CapturedFrame = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  label: Schema.String,
  sha256: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});
export type CapturedFrame = typeof CapturedFrame.Type;

const CaptureManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literal(CAPTURE_MANIFEST_ROLE),
  captureVersion: Schema.Literal(CAPTURE_VERSION),
  capturedAt: Schema.String,
  brief: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    checksum: Schema.String,
  }),
  artifact: Schema.Struct({
    kind: Schema.Literal("artifact"),
    directory: Schema.String,
    buildId: Schema.NullOr(Schema.String),
    sha256: Schema.String,
    files: Schema.Number,
    bytes: Schema.Number,
  }),
  route: Schema.Struct({
    version: Schema.Literal(1),
    label: Schema.String,
    sha256: Schema.String,
    viewport: Viewport,
    steps: Schema.Array(GamePlaytestStep),
  }),
  capture: Schema.Struct({
    booted: Schema.Boolean,
    bootMs: Schema.NullOr(Schema.Number),
    responded: Schema.Boolean,
    changedPercent: Schema.Number,
    executedInputSteps: Schema.Number,
    success: Schema.Boolean,
    qualifies: Schema.NullOr(Schema.Boolean),
    comparisonReady: Schema.Boolean,
    blockers: Schema.Array(Schema.String),
    consoleErrors: Schema.Number,
    consoleWarnings: Schema.Number,
    consoleMessages: Schema.Array(GameConsoleMessage),
    screenshots: Schema.Number,
    /** Capture-only by construction; no planner, critic, vote or repair ran. */
    modelCalls: Schema.Literal(0),
  }),
  frames: Schema.Array(CapturedFrame),
});
export type CaptureManifest = typeof CaptureManifest.Type;

const decodeCaptureRoute = Schema.decodeUnknownSync(CaptureRouteFile);
const decodeCaptureManifest = Schema.decodeUnknownSync(CaptureManifest);

const asRecord = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

const sha256 = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
};

/** The exact replay route, independent of a human label or file formatting. */
export const captureRouteDigest = (route: CaptureRoute): string =>
  sha256(
    Buffer.from(
      JSON.stringify(
        canonical({
          schemaVersion: route.schemaVersion,
          viewport: route.viewport,
          steps: route.steps,
        }),
      ),
      "utf8",
    ),
  );

const routeLabel = (route: CaptureRoute): string => route.label ?? "ordinary input route";

const assertBoundedRoute = (route: CaptureRoute): void => {
  if (route.steps.length === 0) throw new Error("A capture route needs at least one step.");
  if (!route.steps.some(isGameplayInputStep))
    throw new Error(
      "A capture route needs at least one real input step (key, click or drag); waits and screenshots cannot prove the game took input.",
    );
  const issues = playtestInputIssues({
    width: route.viewport.width,
    height: route.viewport.height,
    bootTimeoutMs: DEFAULT_BOOT_TIMEOUT_MS,
    steps: route.steps,
  });
  if (issues.length > 0)
    throw new Error(`Capture route is not a bounded playtest route:\n${issues.join("\n")}`);
};

/** Reads and validates an explicit ordinary-input replay route. */
export async function loadCaptureRoute(path: string): Promise<CaptureRoute> {
  const bytes = await NodeFSP.readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${path} is not JSON.`);
  }
  const route = decodeCaptureRoute(parsed);
  assertBoundedRoute(route);
  return route;
}

export interface ArtifactIdentity {
  readonly directory: string;
  readonly buildId: string | null;
  readonly sha256: string;
  readonly files: number;
  readonly bytes: number;
}

/**
 * Hashes the exact served bytes. Paths, sizes and contents all take part, so a
 * file added, removed or changed changes the identity; a symlink is refused
 * because two readers could serve different bytes from the same manifest.
 */
export async function hashArtifact(
  directory: string,
  buildId: string | null = null,
): Promise<ArtifactIdentity> {
  const root = NodePath.resolve(directory);
  const entries: Array<{ relative: string; file: string; size: number }> = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    const children = await NodeFSP.readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const file = NodePath.join(current, child.name);
      const relative = prefix === "" ? child.name : `${prefix}/${child.name}`;
      if (child.isSymbolicLink())
        throw new Error(`Artifact contains a symlink, so its bytes are ambiguous: ${file}`);
      if (child.isDirectory()) {
        await walk(file, relative);
        continue;
      }
      if (!child.isFile()) throw new Error(`Artifact contains a non-file entry: ${file}`);
      const stat = await NodeFSP.stat(file);
      entries.push({ relative, file, size: stat.size });
    }
  };
  await walk(root, "");
  const digest = NodeCrypto.createHash("sha256");
  digest.update("revision-capture-artifact-v1\0");
  let bytes = 0;
  for (const entry of entries) {
    digest.update(`${entry.relative}\0${entry.size}\0`);
    digest.update(await NodeFSP.readFile(entry.file));
    bytes += entry.size;
  }
  return { directory: root, buildId, sha256: digest.digest("hex"), files: entries.length, bytes };
}

const isInside = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(`${parent}${NodePath.sep}`);

export type CapturePlaytest = (input: GameWebPlaytestInput) => Promise<GameWebPlaytestResult>;

const runPlaytest: CapturePlaytest = (input) =>
  Effect.runPromise(
    playtest({
      ...input,
      steps: [...input.steps],
      captureAllSteps: true,
      probeRequired: false,
      acceptance: null,
    }),
  );

export interface CaptureRevisionOptions {
  /** The exact saved Web export to serve read-only. It is never exported or modified. */
  readonly artifact: {
    readonly directory: string;
    readonly buildId?: string;
  };
  readonly brief: Pick<LoadedGameBenchmarkBrief, "id" | "title" | "checksum">;
  readonly route: CaptureRoute;
  readonly out: string;
  readonly browser?: string;
  /** Refuse the run when the served bytes differ from this digest. */
  readonly expectedArtifactSha256?: string;
  /** The fixture seam: the real headless playtest unless a test supplies one. */
  readonly deps?: { readonly playtest?: CapturePlaytest };
}

export interface CaptureRevisionResult {
  readonly manifest: CaptureManifest;
  readonly manifestPath: string;
  readonly frames: ReadonlyArray<{ readonly path: string; readonly label: string }>;
}

interface CandidateFrame {
  readonly key: string;
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly routeStep?: number;
}

const actionOfStep = (step: GamePlaytestStep): string | null => {
  if ("waitMs" in step) return null;
  if ("screenshot" in step) return `screenshot "${step.screenshot}"`;
  return playtestStepAction(step);
};

const framesFromPlaytest = (
  result: GameWebPlaytestResult,
  route: CaptureRoute,
): {
  readonly boot: CandidateFrame | null;
  readonly actions: ReadonlyArray<CandidateFrame>;
  readonly after: CandidateFrame | null;
} => {
  const bootShot = result.screenshots.find((shot) => shot.label === "booted");
  const afterShot = result.screenshots.findLast((shot) => shot.label === "after-steps");
  const afterByStep = new Map<number, CandidateFrame>();
  const screenshotShots = new Map<string, CandidateFrame>();
  for (const shot of result.screenshots) {
    const candidate: CandidateFrame = {
      key: `shot:${shot.label}:${shot.width}x${shot.height}`,
      data: shot.data,
      width: shot.width,
      height: shot.height,
      label: shot.label,
    };
    if (shot.inputPair?.phase === "after") afterByStep.set(shot.inputPair.stepIndex, candidate);
    else if (shot.label !== "booted" && shot.label !== "after-steps")
      screenshotShots.set(shot.label, candidate);
  }
  const actions: CandidateFrame[] = [];
  for (const [index, step] of route.steps.entries()) {
    const action = actionOfStep(step);
    if (action === null) continue;
    const shot =
      "screenshot" in step ? screenshotShots.get(step.screenshot) : afterByStep.get(index);
    if (shot === undefined)
      throw new Error(
        `The playtest returned no frame for route step ${index + 1} (${action}); the capture is incomplete.`,
      );
    actions.push({
      ...shot,
      key: `${shot.key}:step:${index}`,
      label: action,
      routeStep: index,
    });
  }
  return {
    boot:
      bootShot === undefined
        ? null
        : {
            key: "shot:booted",
            data: bootShot.data,
            width: bootShot.width,
            height: bootShot.height,
            label: "boot, no input",
          },
    actions,
    after:
      afterShot === undefined
        ? null
        : {
            key: "shot:after-steps",
            data: afterShot.data,
            width: afterShot.width,
            height: afterShot.height,
            label: "after route, no input",
          },
  };
};

/**
 * Boots the exact artifact, replays the route and writes a frame pack. The only
 * dependency that can be injected is the playtest: there is no review or
 * generation seam to call.
 */
export async function captureRevisionFrames(
  options: CaptureRevisionOptions,
): Promise<CaptureRevisionResult> {
  const out = NodePath.resolve(options.out);
  const artifactDirectory = NodePath.resolve(options.artifact.directory);
  if (isInside(artifactDirectory, out))
    throw new Error(
      `Capture output ${out} is inside the served artifact ${artifactDirectory}; choose a directory outside the exact build.`,
    );
  const index = NodePath.join(artifactDirectory, "index.html");
  const indexStat = await NodeFSP.stat(index).catch(() => null);
  if (indexStat === null || !indexStat.isFile() || indexStat.size === 0)
    throw new Error(`No nonempty index.html in the artifact directory: ${artifactDirectory}.`);
  assertBoundedRoute(options.route);

  const before = await hashArtifact(artifactDirectory, options.artifact.buildId ?? null);
  if (
    options.expectedArtifactSha256 !== undefined &&
    before.sha256 !== options.expectedArtifactSha256.toLowerCase()
  )
    throw new Error(
      `Artifact bytes do not match the expected sha256: expected ${options.expectedArtifactSha256.toLowerCase()}, found ${before.sha256} at ${artifactDirectory}.`,
    );

  // A failed recapture must not leave an older manifest looking like this run's.
  await NodeFSP.rm(NodePath.join(out, CAPTURE_MANIFEST_FILE), { force: true });
  const browser = options.browser ?? (await defaultHeadlessBrowser());
  const served = await serveWebBuild(artifactDirectory);
  try {
    const result = await (options.deps?.playtest ?? runPlaytest)({
      executable: browser,
      url: served.url,
      profileDirectory: NodePath.join(out, "profile"),
      width: options.route.viewport.width,
      height: options.route.viewport.height,
      bootTimeoutMs: DEFAULT_BOOT_TIMEOUT_MS,
      steps: [...options.route.steps],
      captureAllSteps: true,
      probeRequired: false,
      acceptance: null,
    });
    const after = await hashArtifact(artifactDirectory, options.artifact.buildId ?? null);
    if (after.sha256 !== before.sha256)
      throw new Error(
        `The served artifact changed during capture (${before.sha256} -> ${after.sha256}); the frames are not evidence of one exact build.`,
      );

    const selected = framesFromPlaytest(result, options.route);
    const candidates = [
      ...(selected.boot === null ? [] : [selected.boot]),
      ...selected.actions,
      ...(selected.after === null ? [] : [selected.after]),
    ];
    const byKey = new Map(candidates.map((frame) => [frame.key, frame]));
    const bootFrame =
      selected.boot === null
        ? null
        : {
            id: "F1",
            path: selected.boot.key,
            label: selected.boot.label,
          };
    const stepFrames = selected.actions.map((frame) => ({
      path: frame.key,
      note: "",
      actions: [frame.label],
      step: (frame.routeStep ?? 0) + 1,
    }));
    if (selected.after !== null)
      stepFrames.push({
        path: selected.after.key,
        note: "the route ended",
        actions: ["after route"],
        step: options.route.steps.length + 1,
      });
    const chosen = chooseFrames(bootFrame, stepFrames);

    const framesDirectory = NodePath.join(out, "frames");
    await NodeFSP.rm(framesDirectory, { recursive: true, force: true });
    await NodeFSP.mkdir(framesDirectory, { recursive: true });
    const frames: CapturedFrame[] = [];
    const saved: Array<{ path: string; label: string }> = [];
    for (const [index, frame] of chosen.entries()) {
      const candidate = byKey.get(frame.path);
      if (candidate === undefined)
        throw new Error(`The chosen frame ${frame.path} is missing from the capture.`);
      const bytes = Buffer.from(candidate.data, "base64");
      const file = `frames/frame-${String(index + 1).padStart(2, "0")}.png`;
      const path = NodePath.join(out, file);
      await NodeFSP.writeFile(path, bytes);
      frames.push({
        id: frame.id,
        file,
        label: frame.label,
        sha256: sha256(bytes),
        width: candidate.width,
        height: candidate.height,
      });
      saved.push({ path, label: frame.label });
    }

    const consoleErrors = result.consoleMessages.filter(
      (message) => message.level === "error",
    ).length;
    const consoleWarnings = result.consoleMessages.filter(
      (message) => message.level === "warning",
    ).length;
    const executedInputSteps = result.executedInputSteps ?? 0;
    const manifest: CaptureManifest = {
      schemaVersion: 1,
      role: CAPTURE_MANIFEST_ROLE,
      captureVersion: CAPTURE_VERSION,
      capturedAt: new Date().toISOString(),
      brief: {
        id: options.brief.id,
        title: options.brief.title,
        checksum: options.brief.checksum,
      },
      artifact: { kind: "artifact", ...before },
      route: {
        version: 1,
        label: routeLabel(options.route),
        sha256: captureRouteDigest(options.route),
        viewport: options.route.viewport,
        steps: options.route.steps,
      },
      capture: {
        booted: result.booted,
        bootMs: result.bootMs,
        responded: result.responded,
        changedPercent: result.changedPercent,
        executedInputSteps,
        success: result.success,
        qualifies: result.qualifies ?? null,
        comparisonReady: result.booted && executedInputSteps > 0 && frames.length > 0,
        blockers: [...(result.blockers ?? [])],
        consoleErrors,
        consoleWarnings,
        consoleMessages: result.consoleMessages,
        screenshots: result.screenshots.length,
        modelCalls: 0,
      },
      frames,
    };
    await NodeFSP.mkdir(out, { recursive: true });
    const manifestPath = NodePath.join(out, CAPTURE_MANIFEST_FILE);
    await NodeFSP.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { manifest, manifestPath, frames: saved };
  } finally {
    await served.close();
    await NodeFSP.rm(NodePath.join(out, "profile"), { recursive: true, force: true });
  }
}

export interface LoadedFramePack {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: CaptureManifest;
  readonly frames: ReadonlyArray<{
    readonly path: string;
    readonly label: string;
    readonly sha256: string;
  }>;
}

/**
 * Reads a saved pack and refuses it if any frame's bytes changed after capture.
 * The manifest is the identity; a recomputed hash cannot be substituted.
 */
export async function readFramePack(manifestPath: string): Promise<LoadedFramePack> {
  const absolute = NodePath.resolve(manifestPath);
  const bytes = await NodeFSP.readFile(absolute).catch(() => {
    throw new Error(`No frame pack manifest at ${absolute}.`);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${absolute} is not a JSON frame pack manifest.`);
  }
  const record = asRecord(parsed);
  if (record.role !== CAPTURE_MANIFEST_ROLE)
    throw new Error(
      `${absolute} is not a ${CAPTURE_MANIFEST_ROLE} manifest; a saved grade cannot be read as a capture pack.`,
    );
  let manifest: CaptureManifest;
  try {
    manifest = decodeCaptureManifest(parsed);
  } catch (cause) {
    throw new Error(
      `${absolute} does not decode as a capture manifest: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const frames: Array<{ path: string; label: string; sha256: string }> = [];
  for (const frame of manifest.frames) {
    const path = NodePath.resolve(NodePath.dirname(absolute), frame.file);
    const frameBytes = await NodeFSP.readFile(path).catch(() => {
      throw new Error(`Frame ${frame.id} is missing from the pack: ${path}.`);
    });
    const actual = sha256(frameBytes);
    if (actual !== frame.sha256)
      throw new Error(
        `Frame ${frame.id} changed since capture: expected ${frame.sha256}, found ${actual} at ${path}.`,
      );
    frames.push({ path, label: frame.label, sha256: actual });
  }
  if (frames.length === 0) throw new Error(`Frame pack ${absolute} holds no frames.`);
  return { manifestPath: absolute, manifestSha256: sha256(bytes), manifest, frames };
}
