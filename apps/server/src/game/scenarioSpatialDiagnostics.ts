import type { GameScenarioEvidence, GameScenarioSpatial } from "@t3tools/contracts";

/**
 * Turns frozen scenario spatial snapshots into a bounded critic file.
 * Pure so the binding rule (same source, readable evidence, bounded output)
 * is testable without engines: stale, missing or unreadable evidence selects
 * nothing, and the formatted file always says where the numbers came from
 * without ever claiming a Web verdict.
 */
export const NATIVE_WORLD_MAX_CHARS = 32_768;
export const NATIVE_WORLD_MAX_SCENARIOS = 8;

export interface NativeWorldScenario {
  readonly id: string;
  readonly spatial: GameScenarioSpatial;
}

export interface NativeWorldSelection {
  readonly sourceId: string;
  readonly evidenceDirectory: string;
  readonly scenarios: readonly NativeWorldScenario[];
  /** Scenarios left out by the file cap. */
  readonly omitted: number;
  /** True when any scan or the file cap itself stopped early. */
  readonly truncated: boolean;
}

/**
 * Binds frozen scenario spatial snapshots to the selected build's exact
 * source. Anything else selects nothing: a stale, missing or unreadable
 * state record is an honest omission, never a file, and a run with no
 * spatial snapshots needs no file. Zero layout findings still deliver a
 * spatial packet when snapshots exist.
 */
export function selectNativeSpatial(input: {
  readonly stateSourceId: string | null;
  readonly stateEvidenceDirectory: string | null;
  readonly exportInputSourceId: string | null;
  readonly scenarios: readonly GameScenarioEvidence[];
}): NativeWorldSelection | null {
  const { stateSourceId, stateEvidenceDirectory, exportInputSourceId, scenarios } = input;
  if (stateSourceId === null || stateEvidenceDirectory === "" || stateEvidenceDirectory === null)
    return null;
  if (exportInputSourceId === null || exportInputSourceId !== stateSourceId) return null;
  const kept: NativeWorldScenario[] = [];
  let truncated = false;
  for (const scenario of scenarios) {
    const spatial = scenario.spatial;
    if (spatial === undefined) continue;
    if (spatial.coverage.truncated) truncated = true;
    kept.push({ id: scenario.id, spatial });
    if (kept.length >= NATIVE_WORLD_MAX_SCENARIOS) {
      if (scenarios.length > kept.length) truncated = true;
      break;
    }
  }
  if (kept.length === 0) return null;
  const total = scenarios.filter((scenario) => scenario.spatial !== undefined).length;
  return {
    sourceId: stateSourceId,
    evidenceDirectory: stateEvidenceDirectory,
    scenarios: kept,
    omitted: Math.max(0, total - kept.length),
    truncated: truncated || total !== kept.length,
  };
}

/**
 * Bounded JSON measurements for the critic evidence file: world-space player
 * origins/velocities plus Area collision-shape bounds, never a verdict.
 * No code or script content rides along. The note states the two honesty
 * rules every consumer must keep: native headless geometry may diverge from
 * Web cadence/runtime, and a point-in-box test never means a whole body is
 * inside or any game trigger fired. One line per snapshot keeps the player
 * origin next to the target bounds so the two are easy to compare.
 */
export function formatNativeWorld(selection: NativeWorldSelection): string {
  const note =
    "Same-source headless world measurements at scenario probe frames (boot plus step boundaries); " +
    "native geometry may diverge from Web cadence/runtime, so verify on Web frames and never cite as proof. " +
    "containsPlayerOrigin tests the probed player origin point only and never means an entire body is inside or any game trigger fired. " +
    "Absence of areas never means full coverage; truncated means a cap stopped the scan.";
  const compactScenarios = selection.scenarios.map((scenario) => ({
    id: scenario.id,
    snapshots: scenario.spatial.snapshots.map((snapshot) =>
      formatSnapshotLine(scenario.id, snapshot),
    ),
  }));
  const scenarios = [...compactScenarios];
  let omitted = selection.omitted;
  let truncated = selection.truncated;
  while (true) {
    const text = `${JSON.stringify(
      {
        note,
        sourceId: selection.sourceId.slice(0, 64),
        evidenceDirectory: selection.evidenceDirectory.slice(0, 300),
        scenarios,
        omitted,
        truncated,
      },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(text, "utf8") <= NATIVE_WORLD_MAX_CHARS) return text;
    // Preserve complete measurements and valid JSON; an oversized scenario
    // is omitted rather than cutting a coordinate or string in half.
    scenarios.pop();
    omitted += 1;
    truncated = true;
  }
}

const formatVector = (value: ReadonlyArray<number> | null): string =>
  value === null ? "unknown" : `[${value.join(",")}]`;

const formatSnapshotLine = (
  scenarioId: string,
  snapshot: GameScenarioSpatial["snapshots"][number],
): string => {
  const player = snapshot.player;
  const playerText =
    player.present && player.position !== null
      ? `player=${formatVector(player.position)}`
      : "player=absent";
  const velocityText =
    player.present && player.velocity !== null
      ? `vel=${formatVector(player.velocity)}`
      : "vel=unknown";
  const areas = snapshot.areas.map((area) => {
    const { min, max, contains, conservative } = aggregateArea(area);
    const flags = `${area.monitoring === false ? " monitoring=false" : ""}${conservative ? " conservative" : ""}`;
    return (
      `${area.nodePath} min=${formatVector(min)} max=${formatVector(max)} ` +
      `containsPlayerOrigin=${contains === null ? "unknown" : contains}${flags}`
    );
  });
  const head =
    `${scenarioId} frame=${snapshot.scenarioFrame} ` +
    `step=${snapshot.step === null ? "-" : snapshot.step} ${playerText} ${velocityText}`;
  return areas.length === 0 ? head : `${head} | ${areas.join("; ")}`;
};

/** Area rollup: one world min/max and one origin test per Area node. */
const aggregateArea = (
  area: GameScenarioSpatial["snapshots"][number]["areas"][number],
): {
  readonly min: ReadonlyArray<number> | null;
  readonly max: ReadonlyArray<number> | null;
  readonly contains: boolean | null;
  readonly conservative: boolean;
} => {
  const enabled = area.shapes.filter((shape) => !shape.disabled);
  let contains: boolean | null = null;
  if (enabled.length > 0) {
    if (enabled.some((shape) => shape.containsPlayerOrigin === true)) contains = true;
    else if (enabled.every((shape) => shape.containsPlayerOrigin === false)) contains = false;
  }
  const known = enabled.filter(
    (shape) =>
      shape.bounds.kind !== "unknown" &&
      shape.bounds.min !== null &&
      shape.bounds.max !== null &&
      shape.bounds.min.length === shape.bounds.max.length,
  );
  // Only bounds that shaped the union can qualify the line; unknown or
  // disabled shapes never contributed a min/max.
  const conservative = known.some((shape) => shape.conservative);
  if (known.length === 0) return { min: null, max: null, contains, conservative: false };
  const dimension = known[0]!.bounds.min!.length;
  if (!known.every((shape) => shape.bounds.min!.length === dimension))
    return { min: null, max: null, contains, conservative: false };
  const min = [...known[0]!.bounds.min!];
  const max = [...known[0]!.bounds.max!];
  for (const shape of known.slice(1)) {
    const shapeMin = shape.bounds.min!;
    const shapeMax = shape.bounds.max!;
    for (let index = 0; index < dimension; index++) {
      if (shapeMin[index]! < min[index]!) min[index] = shapeMin[index]!;
      if (shapeMax[index]! > max[index]!) max[index] = shapeMax[index]!;
    }
  }
  return { min, max, contains, conservative };
};
