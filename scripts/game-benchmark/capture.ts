// @effect-diagnostics nodeBuiltinImport:off -- A maintainer capture reads saved frame packs and checks their bytes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { GameConsoleMessage, GamePlaytestStep } from "../../packages/contracts/src/index.ts";

export const CAPTURE_VERSION = 1;
export const CAPTURE_MANIFEST_ROLE = "revision-frame-capture";
export const CAPTURE_MANIFEST_FILE = "frame-pack.json";

const Viewport = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
});

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

const decodeCaptureManifest = Schema.decodeUnknownSync(CaptureManifest);

const asRecord = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

const sha256 = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

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
