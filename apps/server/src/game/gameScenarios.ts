// @effect-diagnostics nodeBuiltinImport:off -- Scenario files and runner results live on the native filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  GAME_SCENARIO_LIMITS,
  GameScenarioEvidence,
  type GameScenarioLayout,
  type GameScenarioSpatial,
  parseGameScenario,
  type GameAcceptanceCriterion,
  type GameScenario,
} from "@t3tools/contracts";
import { LEGACY_PLAYING_MATCH_ID } from "./scenarioEvaluation.ts";

const decodeEvidence = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ...GameScenarioEvidence.fields,
      spatial: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);

/** The runner request is internal, but it is still typed and encoded outside the game. */
const ScenarioRequest = Schema.Struct({
  scenarioPath: Schema.String,
  observations: Schema.Array(
    Schema.Struct({ id: Schema.String, key: Schema.String, expect: Schema.String }),
  ),
  sampleEvery: Schema.Number,
  bootFrames: Schema.Number,
  /** Native capture only: record step-boundary input/frame timeline plus physicsHz. The exam omits it. */
  recordTimeline: Schema.optionalKey(Schema.Boolean),
  /** Runtime calibration only: fixed global seed applied before the main scene loads. */
  seed: Schema.optionalKey(Schema.Number),
  recordRuntimeState: Schema.optionalKey(Schema.Boolean),
  /**
   * Bounded runtime layout probes near input step boundaries. The exam sets
   * it; native capture and calibration omit it, so their result shape is
   * unchanged when inspection is not requested.
   */
  recordLayout: Schema.optionalKey(Schema.Boolean),
  /**
   * Bounded runtime spatial snapshots (player origin/velocity plus Area
   * collision-shape world bounds) at the same probe schedule. The exam sets
   * it alongside layout; native capture, calibration and the test runner omit
   * it, so their result shape stays byte-compatible when not requested.
   */
  recordSpatial: Schema.optionalKey(Schema.Boolean),
  /**
   * Per-run isolation prefix the runner verifies before the game main plays.
   * The service passes the XDG data home it gave this child; a user:// that
   * escapes it fails closed instead of looking clean.
   */
  expectedUserDataPrefix: Schema.optionalKey(Schema.String),
});
const encodeScenarioRequest = Schema.encodeSync(Schema.fromJsonString(ScenarioRequest));
export const scenarioRequestJson = (input: {
  readonly scenarioPath: string;
  readonly observations: readonly {
    readonly id: string;
    readonly key: string;
    readonly expect: string;
  }[];
  readonly sampleEvery: number;
  readonly bootFrames: number;
  readonly recordTimeline?: boolean | undefined;
  readonly seed?: number | undefined;
  readonly recordRuntimeState?: boolean | undefined;
  readonly recordLayout?: boolean | undefined;
  readonly recordSpatial?: boolean | undefined;
  readonly expectedUserDataPrefix?: string | undefined;
}) =>
  encodeScenarioRequest({
    scenarioPath: input.scenarioPath,
    observations: input.observations.map((observation) => ({ ...observation })),
    sampleEvery: input.sampleEvery,
    bootFrames: input.bootFrames,
    ...(input.recordTimeline === undefined ? {} : { recordTimeline: input.recordTimeline }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.recordRuntimeState === undefined
      ? {}
      : { recordRuntimeState: input.recordRuntimeState }),
    ...(input.recordLayout === undefined ? {} : { recordLayout: input.recordLayout }),
    ...(input.recordSpatial === undefined ? {} : { recordSpatial: input.recordSpatial }),
    ...(input.expectedUserDataPrefix === undefined
      ? {}
      : { expectedUserDataPrefix: input.expectedUserDataPrefix }),
  });

export interface ScenarioFile {
  readonly scenario: GameScenario;
  /** Absolute path, passed to the runner so it never resolves game paths itself. */
  readonly path: string;
}

export interface ScenarioFilesRead {
  readonly scenarios: readonly ScenarioFile[];
  readonly errors: readonly string[];
}

/** Input actions Godot always defines; the runner still checks the live InputMap. */
const isBuiltinAction = (action: string) => action.startsWith("ui_");

/**
 * Reads `godot/tests/scenarios/*.json`. Every file is independently validated, so
 * one bad route names itself instead of hiding the working ones. The cap applies
 * to files, not only valid routes, or a folder could hold a thousand entries.
 */
export async function readScenarioFiles(godotProject: string): Promise<ScenarioFilesRead> {
  const directory = NodePath.join(godotProject, "tests/scenarios");
  let names: string[];
  try {
    names = await NodeFSP.readdir(directory);
  } catch {
    return {
      scenarios: [],
      errors: [
        "No scenarios found. Add godot/tests/scenarios/<id>.json with press, hold and wait steps.",
      ],
    };
  }
  const files = names.filter((name) => name.endsWith(".json")).sort();
  const errors: string[] = [];
  if (files.length > GAME_SCENARIO_LIMITS.maxScenarios)
    errors.push(
      `Found ${files.length} scenarios; only ${GAME_SCENARIO_LIMITS.maxScenarios} may run. The extra files were ignored.`,
    );
  const scenarios: ScenarioFile[] = [];
  const ids = new Set<string>();
  for (const name of files.slice(0, GAME_SCENARIO_LIMITS.maxScenarios)) {
    const path = NodePath.join(directory, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    } catch (cause) {
      errors.push(
        `${name} is not readable JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      continue;
    }
    const result = parseGameScenario(parsed);
    if (!result.ok) {
      errors.push(`${name}: ${result.issues.join(" ")}`);
      continue;
    }
    if (ids.has(result.scenario.id)) {
      errors.push(`${name}: the id "${result.scenario.id}" is used by more than one scenario.`);
      continue;
    }
    ids.add(result.scenario.id);
    scenarios.push({ scenario: result.scenario, path });
  }
  return { scenarios, errors };
}

/** The action names project.godot declares under `[input]`. */
export function parseProjectInputActions(project: string): ReadonlySet<string> {
  const actions = new Set<string>();
  let inInput = false;
  for (const raw of project.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inInput = line === "[input]";
      continue;
    }
    if (!inInput || line === "" || line.startsWith(";")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match !== null) actions.add(match[1]!);
  }
  return actions;
}

/**
 * Actions a scenario may press. Godot's built-ins are not written in
 * project.godot, so they are allowed by their documented `ui_` namespace; the
 * runner checks the live InputMap again and rejects anything it does not know.
 */
export function scenarioActionIssues(
  scenario: GameScenario,
  projectActions: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const step of scenario.steps) {
    const actions = "press" in step ? [step.press] : "hold" in step ? step.hold : [];
    for (const action of actions) {
      if (seen.has(action)) continue;
      seen.add(action);
      if (!projectActions.has(action) && !isBuiltinAction(action))
        issues.push(`"${action}" is not an input action in project.godot's InputMap.`);
    }
  }
  return issues;
}

/** Reads each approved observation plus the legacy playing-state proof. */
export function scenarioObservations(
  mode: "criteria" | "legacy" | "none",
  criteria: readonly GameAcceptanceCriterion[],
): { readonly id: string; readonly key: string; readonly expect: string }[] {
  const observations =
    mode === "criteria"
      ? criteria
          .filter(
            (
              criterion,
            ): criterion is GameAcceptanceCriterion & {
              observe: { key: string; expect: string };
            } => criterion.observe !== undefined,
          )
          .map((criterion) => ({
            id: criterion.id,
            key: criterion.observe.key,
            expect: criterion.observe.expect,
          }))
      : [];
  // Always sample `state`; a legacy game proves the menu really started a run
  // with it, and an approved design may also observe it directly.
  observations.push({ id: LEGACY_PLAYING_MATCH_ID, key: "state", expect: "==1" });
  return observations;
}

export function decodeScenarioEvidence(text: string): GameScenarioEvidence | null {
  try {
    const { spatial: rawSpatial, ...evidence } = decodeEvidence(text);
    const spatial = sanitizeScenarioSpatial(rawSpatial);
    return { ...evidence, ...(spatial === undefined ? {} : { spatial }) };
  } catch {
    return null;
  }
}

/**
 * Bounds the runner reports before the service persists them. The runner is
 * trusted for observations (the exam's own data), but layout findings are
 * additive diagnostics: cap their count and text so one run cannot bloat the
 * result, and drop malformed payloads instead of persisting them.
 */
export const SCENARIO_LAYOUT_BOUNDS = {
  /** Findings kept per scenario; the runner already caps at its warning bound. */
  maxFindings: 8,
  /** Chars kept per finding detail or node path. */
  maxFindingChars: 500,
  maxNodePathChars: 300,
  /** Counters are honest small numbers, never unbounded runner math. */
  maxCount: 99_999,
  maxViewport: 16_384,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedInt = (value: unknown, max: number): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return Math.min(value, max);
};

const boundedViewport = (value: unknown): { width: number; height: number } | null => {
  if (!isRecord(value)) return null;
  const width = value.width;
  const height = value.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return null;
  return {
    width: Math.min(width, SCENARIO_LAYOUT_BOUNDS.maxViewport),
    height: Math.min(height, SCENARIO_LAYOUT_BOUNDS.maxViewport),
  };
};

export function sanitizeScenarioLayout(value: unknown): GameScenarioLayout | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.findings)) return undefined;
  if (!isRecord(value.coverage)) return undefined;
  const findings: Array<{
    kind: "clip" | "viewport" | "overlap-risk";
    subject: string;
    detail: string;
    nodePath: string;
    scenarioFrame: number;
    step: number | null;
    viewport: { width: number; height: number };
  }> = [];
  for (const entry of value.findings.slice(0, SCENARIO_LAYOUT_BOUNDS.maxFindings)) {
    if (!isRecord(entry)) continue;
    if (entry.kind !== "clip" && entry.kind !== "viewport" && entry.kind !== "overlap-risk")
      continue;
    if (typeof entry.subject !== "string" || typeof entry.detail !== "string") continue;
    if (typeof entry.nodePath !== "string") continue;
    const frame = boundedInt(entry.scenarioFrame, SCENARIO_LAYOUT_BOUNDS.maxCount);
    if (frame === null) continue;
    const step =
      entry.step === null ? null : boundedInt(entry.step, SCENARIO_LAYOUT_BOUNDS.maxCount);
    if (entry.step !== null && step === null) continue;
    const viewport = boundedViewport(entry.viewport);
    if (viewport === null) continue;
    findings.push({
      kind: entry.kind,
      subject: entry.subject.slice(0, SCENARIO_LAYOUT_BOUNDS.maxFindingChars),
      detail: entry.detail.slice(0, SCENARIO_LAYOUT_BOUNDS.maxFindingChars),
      nodePath: entry.nodePath.slice(0, SCENARIO_LAYOUT_BOUNDS.maxNodePathChars),
      scenarioFrame: frame,
      step,
      viewport,
    });
  }
  const coverage = value.coverage;
  const probes = boundedInt(coverage.probes, SCENARIO_LAYOUT_BOUNDS.maxCount);
  const omitted = boundedInt(coverage.omittedProbes, SCENARIO_LAYOUT_BOUNDS.maxCount);
  const inspected = boundedInt(coverage.inspectedControls, SCENARIO_LAYOUT_BOUNDS.maxCount);
  const pairs = boundedInt(coverage.pairs, SCENARIO_LAYOUT_BOUNDS.maxCount);
  const viewport = boundedViewport(coverage.viewport);
  if (
    probes === null ||
    omitted === null ||
    inspected === null ||
    pairs === null ||
    viewport === null ||
    typeof coverage.truncated !== "boolean"
  )
    return undefined;
  return {
    findings,
    coverage: {
      probes,
      omittedProbes: omitted,
      inspectedControls: inspected,
      pairs,
      truncated: coverage.truncated,
      viewport,
    },
  };
}

/**
 * Bounds the runner's spatial snapshots before the service persists them.
 * The runner is trusted for observations; spatial snapshots are additive
 * measurements: cap snapshots, areas, shapes and text so one run cannot
 * bloat the result, require finite coordinates, and drop malformed or
 * oversized payloads instead of persisting them. A 32 KB total keeps the
 * sealed critic file bounded.
 */
export const SCENARIO_SPATIAL_BOUNDS = {
  /** Snapshots kept per scenario: boot plus at most three step boundaries. */
  maxSnapshots: 4,
  /** Areas kept per scenario across all snapshots. */
  maxAreas: 16,
  /** Shapes kept per scenario across all snapshots. */
  maxShapes: 32,
  /** Nodes visited per scenario across all snapshots. */
  maxNodes: 600,
  /** Chars kept per node path or type name. */
  maxNodePathChars: 300,
  maxTypeChars: 64,
  /** Counters are honest small numbers, never unbounded runner math. */
  maxCount: 99_999,
  /** Total sanitized JSON bytes kept per scenario. */
  maxChars: 32_768,
} as const;

const boundedCoordList = (value: unknown): number[] | null => {
  if (!Array.isArray(value)) return null;
  if (value.length !== 2 && value.length !== 3) return null;
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    out.push(entry);
  }
  return out;
};

const boundedCoordOrNull = (value: unknown): number[] | null => {
  if (value === null) return null;
  return boundedCoordList(value);
};

export function sanitizeScenarioSpatial(value: unknown): GameScenarioSpatial | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.snapshots)) return undefined;
  if (!isRecord(value.coverage)) return undefined;
  let truncated = false;
  if (value.snapshots.length > SCENARIO_SPATIAL_BOUNDS.maxSnapshots) truncated = true;
  const snapshots: Array<GameScenarioSpatial["snapshots"][number]> = [];
  let totalAreas = 0;
  let totalShapes = 0;
  for (const rawSnapshot of value.snapshots.slice(0, SCENARIO_SPATIAL_BOUNDS.maxSnapshots)) {
    if (!isRecord(rawSnapshot)) {
      truncated = true;
      continue;
    }
    const frame = boundedInt(rawSnapshot.scenarioFrame, SCENARIO_SPATIAL_BOUNDS.maxCount);
    if (frame === null) {
      truncated = true;
      continue;
    }
    const step =
      rawSnapshot.step === null
        ? null
        : boundedInt(rawSnapshot.step, SCENARIO_SPATIAL_BOUNDS.maxCount);
    if (rawSnapshot.step !== null && step === null) {
      truncated = true;
      continue;
    }
    if (!isRecord(rawSnapshot.player)) {
      truncated = true;
      continue;
    }
    const playerRaw = rawSnapshot.player;
    if (typeof playerRaw.present !== "boolean") {
      truncated = true;
      continue;
    }
    const position = boundedCoordOrNull(playerRaw.position);
    if (playerRaw.position !== null && position === null) {
      truncated = true;
      continue;
    }
    const velocity = boundedCoordOrNull(playerRaw.velocity);
    if (playerRaw.velocity !== null && velocity === null) {
      truncated = true;
      continue;
    }
    const bodyKind =
      playerRaw.bodyKind === null
        ? null
        : typeof playerRaw.bodyKind === "string"
          ? playerRaw.bodyKind.slice(0, SCENARIO_SPATIAL_BOUNDS.maxTypeChars)
          : null;
    if (playerRaw.bodyKind !== null && bodyKind === null) {
      truncated = true;
      continue;
    }
    if (!Array.isArray(rawSnapshot.areas)) {
      truncated = true;
      continue;
    }
    const areas: Array<GameScenarioSpatial["snapshots"][number]["areas"][number]> = [];
    for (const rawArea of rawSnapshot.areas) {
      if (totalAreas >= SCENARIO_SPATIAL_BOUNDS.maxAreas) {
        truncated = true;
        break;
      }
      if (!isRecord(rawArea)) {
        truncated = true;
        continue;
      }
      if (
        typeof rawArea.nodePath !== "string" ||
        typeof rawArea.type !== "string" ||
        typeof rawArea.monitoring !== "boolean" ||
        typeof rawArea.monitorable !== "boolean" ||
        typeof rawArea.visible !== "boolean" ||
        !Array.isArray(rawArea.shapes)
      ) {
        truncated = true;
        continue;
      }
      if (rawArea.type !== "Area2D" && rawArea.type !== "Area3D") {
        truncated = true;
        continue;
      }
      const shapes: Array<
        GameScenarioSpatial["snapshots"][number]["areas"][number]["shapes"][number]
      > = [];
      for (const rawShape of rawArea.shapes) {
        if (totalShapes >= SCENARIO_SPATIAL_BOUNDS.maxShapes) {
          truncated = true;
          break;
        }
        if (!isRecord(rawShape)) {
          truncated = true;
          continue;
        }
        if (
          typeof rawShape.nodePath !== "string" ||
          typeof rawShape.shapeKind !== "string" ||
          typeof rawShape.disabled !== "boolean" ||
          typeof rawShape.conservative !== "boolean" ||
          !isRecord(rawShape.bounds)
        ) {
          truncated = true;
          continue;
        }
        const boundsRaw = rawShape.bounds;
        if (
          boundsRaw.kind !== "rect2" &&
          boundsRaw.kind !== "aabb3" &&
          boundsRaw.kind !== "unknown"
        ) {
          truncated = true;
          continue;
        }
        let bounds: GameScenarioSpatial["snapshots"][number]["areas"][number]["shapes"][number]["bounds"];
        if (boundsRaw.kind === "unknown") {
          if (boundsRaw.min !== null || boundsRaw.max !== null) {
            truncated = true;
            continue;
          }
          bounds = { kind: "unknown", min: null, max: null };
        } else {
          const min = boundedCoordList(boundsRaw.min);
          const max = boundedCoordList(boundsRaw.max);
          if (min === null || max === null || min.length !== max.length) {
            truncated = true;
            continue;
          }
          if (boundsRaw.kind === "rect2" && min.length !== 2) {
            truncated = true;
            continue;
          }
          if (boundsRaw.kind === "aabb3" && min.length !== 3) {
            truncated = true;
            continue;
          }
          bounds = { kind: boundsRaw.kind, min, max };
        }
        const contains =
          rawShape.containsPlayerOrigin === null
            ? null
            : typeof rawShape.containsPlayerOrigin === "boolean"
              ? rawShape.containsPlayerOrigin
              : null;
        if (rawShape.containsPlayerOrigin !== null && contains === null) {
          truncated = true;
          continue;
        }
        shapes.push({
          nodePath: rawShape.nodePath.slice(0, SCENARIO_SPATIAL_BOUNDS.maxNodePathChars),
          shapeKind: rawShape.shapeKind.slice(0, SCENARIO_SPATIAL_BOUNDS.maxTypeChars),
          disabled: rawShape.disabled,
          bounds,
          conservative: rawShape.conservative,
          containsPlayerOrigin: contains,
        });
        totalShapes += 1;
      }
      areas.push({
        nodePath: rawArea.nodePath.slice(0, SCENARIO_SPATIAL_BOUNDS.maxNodePathChars),
        type: rawArea.type,
        monitoring: rawArea.monitoring,
        monitorable: rawArea.monitorable,
        visible: rawArea.visible,
        shapes,
      });
      totalAreas += 1;
    }
    snapshots.push({
      scenarioFrame: frame,
      step,
      player: {
        present: playerRaw.present,
        position,
        velocity,
        bodyKind,
      },
      areas,
    });
  }
  const coverage = value.coverage;
  const coverageSnapshots = boundedInt(coverage.snapshots, SCENARIO_SPATIAL_BOUNDS.maxCount);
  const omittedSnapshots = boundedInt(coverage.omittedSnapshots, SCENARIO_SPATIAL_BOUNDS.maxCount);
  const visitedNodes = boundedInt(coverage.visitedNodes, SCENARIO_SPATIAL_BOUNDS.maxCount);
  const areaCount = boundedInt(coverage.areas, SCENARIO_SPATIAL_BOUNDS.maxCount);
  const shapeCount = boundedInt(coverage.shapes, SCENARIO_SPATIAL_BOUNDS.maxCount);
  const skippedFreed = boundedInt(coverage.skippedFreed, SCENARIO_SPATIAL_BOUNDS.maxCount);
  if (
    coverageSnapshots === null ||
    omittedSnapshots === null ||
    visitedNodes === null ||
    areaCount === null ||
    shapeCount === null ||
    skippedFreed === null ||
    typeof coverage.truncated !== "boolean"
  )
    return undefined;
  if (
    visitedNodes > SCENARIO_SPATIAL_BOUNDS.maxNodes ||
    areaCount > SCENARIO_SPATIAL_BOUNDS.maxAreas ||
    shapeCount > SCENARIO_SPATIAL_BOUNDS.maxShapes ||
    coverageSnapshots > SCENARIO_SPATIAL_BOUNDS.maxSnapshots
  )
    truncated = true;
  if (snapshots.length === 0) return undefined;
  const sanitized: GameScenarioSpatial = {
    snapshots,
    coverage: {
      snapshots: Math.min(coverageSnapshots, SCENARIO_SPATIAL_BOUNDS.maxSnapshots),
      omittedSnapshots,
      visitedNodes: Math.min(visitedNodes, SCENARIO_SPATIAL_BOUNDS.maxCount),
      areas: Math.min(areaCount, SCENARIO_SPATIAL_BOUNDS.maxCount),
      shapes: Math.min(shapeCount, SCENARIO_SPATIAL_BOUNDS.maxCount),
      skippedFreed,
      truncated: truncated || coverage.truncated,
    },
  };
  try {
    if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > SCENARIO_SPATIAL_BOUNDS.maxChars)
      return undefined;
  } catch {
    return undefined;
  }
  return sanitized;
}
