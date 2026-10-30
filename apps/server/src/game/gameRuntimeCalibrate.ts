import { RUNTIME_CALIBRATE_BOUNDS } from "@t3tools/contracts";

export type CalibratePosition = readonly number[] | null;

export interface CalibrateRunSample {
  readonly cadence: number;
  readonly repeat: number;
  readonly scenarioFrames: number;
  readonly enginePhysicsFrames: number;
  readonly renderFrames: number;
  readonly nominalPhysicsSeconds: number;
  readonly firstInputFrame: number | null;
  readonly baselineFrame: number | null;
  readonly playerMoved: boolean;
  readonly playerFirst: CalibratePosition;
  readonly playerBaseline: CalibratePosition;
  readonly playerLast: CalibratePosition;
  readonly playerDisplacement: number | null;
  readonly userDataDirIsolated: boolean;
  readonly gameState: Readonly<Record<string, number | boolean | string | null>>;
  readonly initialGameState?:
    | Readonly<Record<string, number | boolean | string | null>>
    | undefined;
  readonly error: string | null;
  readonly timedOut: boolean;
}

export interface CalibratePairResult {
  readonly label: string;
  readonly cadenceA: number;
  readonly cadenceB: number;
  readonly equivalent: boolean;
  readonly unknown: boolean;
  readonly comparedFields: number;
  readonly unknownFields: string[];
  readonly differences: string[];
}

const positionText = (position: CalibratePosition): string =>
  position === null ? "missing" : `[${position.map((value) => value.toFixed(4)).join(", ")}]`;

const positionsMatch = (
  a: CalibratePosition,
  b: CalibratePosition,
  tolerance: number,
): boolean | null => {
  if (a === null || b === null) return null;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (Math.abs(x - y) > tolerance) return false;
  }
  return true;
};

/** Baseline-to-last displacement in the runner's own units (engine units). */
export const playerDisplacementOf = (
  baseline: CalibratePosition,
  last: CalibratePosition,
): number | null => {
  const first = baseline;
  if (first === null || last === null || first.length !== last.length) return null;
  let sum = 0;
  for (let index = 0; index < first.length; index += 1) {
    const x = first[index]!;
    const y = last[index]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    sum += (x - y) * (x - y);
  }
  return Math.sqrt(sum);
};

/**
 * Compares two runs field by field. Discrete and boolean state compares
 * exactly; player positions compare within the documented tolerance. Any
 * missing value, unobserved probe, error or timeout on either side makes the
 * pair unknown, never equivalent. The caller checks same-rate pairs before
 * trusting any cross-rate pair.
 */
export const compareCalibratePair = (
  a: CalibrateRunSample,
  b: CalibrateRunSample,
  kind: "same-rate" | "cross-rate",
): CalibratePairResult => {
  const label =
    kind === "same-rate"
      ? `${a.cadence}fps repeat ${a.repeat} vs repeat ${b.repeat}`
      : `${a.cadence}fps r${a.repeat} vs ${b.cadence}fps r${b.repeat}`;
  const unknownFields: string[] = [];
  const differences: string[] = [];
  let comparedFields = 0;

  const noteUnknown = (field: string) => {
    if (unknownFields.length < RUNTIME_CALIBRATE_BOUNDS.maxUnknowns)
      unknownFields.push(`${label}: ${field} is missing, unobserved or undecidable`);
  };
  const noteDifference = (field: string) => {
    if (differences.length < RUNTIME_CALIBRATE_BOUNDS.maxDifferences) differences.push(field);
  };

  // A run that errored or timed out proves nothing about physics.
  if (a.error !== null || b.error !== null || a.timedOut || b.timedOut) {
    noteUnknown("run error/timeout");
    return {
      label,
      cadenceA: a.cadence,
      cadenceB: b.cadence,
      equivalent: false,
      unknown: true,
      comparedFields,
      unknownFields,
      differences,
    };
  }
  if (!a.userDataDirIsolated || !b.userDataDirIsolated) {
    noteUnknown("user:// isolation");
    return {
      label,
      cadenceA: a.cadence,
      cadenceB: b.cadence,
      equivalent: false,
      unknown: true,
      comparedFields,
      unknownFields,
      differences,
    };
  }

  // Exact discrete state: did the player move, did baselines exist.
  comparedFields += 1;
  if (a.playerMoved !== b.playerMoved)
    noteDifference(`playerMoved ${String(a.playerMoved)} vs ${String(b.playerMoved)}`);

  comparedFields += 1;
  if ((a.baselineFrame === null) !== (b.baselineFrame === null)) {
    noteUnknown("baseline presence");
  } else if (a.baselineFrame !== b.baselineFrame) {
    // Baseline frame indices must match exactly: different boot timing is a
    // real divergence, not a rounding error.
    noteDifference(`baselineFrame ${String(a.baselineFrame)} vs ${String(b.baselineFrame)}`);
  }

  // Physical positions within tolerance; missing ends are unknown.
  const physicalPairs: ReadonlyArray<{
    readonly name: string;
    readonly x: CalibratePosition;
    readonly y: CalibratePosition;
  }> = [
    { name: "playerFirst", x: a.playerFirst, y: b.playerFirst },
    { name: "playerBaseline", x: a.playerBaseline, y: b.playerBaseline },
    { name: "playerLast", x: a.playerLast, y: b.playerLast },
  ];
  for (const pair of physicalPairs) {
    comparedFields += 1;
    const matched = positionsMatch(pair.x, pair.y, RUNTIME_CALIBRATE_BOUNDS.positionToleranceUnits);
    if (matched === null) noteUnknown(pair.name);
    else if (!matched)
      noteDifference(`${pair.name} ${positionText(pair.x)} vs ${positionText(pair.y)}`);
  }

  comparedFields += 1;
  if (a.playerDisplacement === null || b.playerDisplacement === null) {
    noteUnknown("playerDisplacement");
  } else if (
    !Number.isFinite(a.playerDisplacement) ||
    !Number.isFinite(b.playerDisplacement) ||
    Math.abs(a.playerDisplacement - b.playerDisplacement) >
      RUNTIME_CALIBRATE_BOUNDS.positionToleranceUnits
  ) {
    const text = (value: number | null) => (value === null ? "missing" : value.toFixed(4));
    noteDifference(
      `playerDisplacement ${text(a.playerDisplacement)} vs ${text(b.playerDisplacement)}`,
    );
  }

  // GameState compares exactly: a coin counter or boolean that differs is a
  // real divergence. Keys present on one side only are unknown.
  const keys = new Set([...Object.keys(a.gameState), ...Object.keys(b.gameState)]);
  for (const key of [...keys].sort()) {
    comparedFields += 1;
    const x = a.gameState[key] ?? null;
    const y = b.gameState[key] ?? null;
    if (x === null || y === null || typeof x !== typeof y) {
      noteUnknown(`GameState.${key}`);
    } else if (x !== y) {
      noteDifference(`GameState.${key} ${String(x)} vs ${String(y)}`);
    }
  }

  if (a.initialGameState !== undefined || b.initialGameState !== undefined) {
    if (a.initialGameState === undefined || b.initialGameState === undefined)
      noteUnknown("initial GameState");
    else
      for (const key of [
        ...new Set([...Object.keys(a.initialGameState), ...Object.keys(b.initialGameState)]),
      ].sort()) {
        comparedFields++;
        if (!(key in a.initialGameState) || !(key in b.initialGameState))
          noteUnknown(`initial GameState.${key}`);
        else if (a.initialGameState[key] !== b.initialGameState[key])
          noteDifference(
            `initial GameState.${key} ${String(a.initialGameState[key])} vs ${String(b.initialGameState[key])}`,
          );
      }
  }

  // Step-boundary counters are evidence, not verdict inputs on their own: a
  // nominal-seconds match without matching displacement still differs above.
  comparedFields += 1;
  if (a.scenarioFrames !== b.scenarioFrames)
    noteDifference(`scenarioFrames ${a.scenarioFrames} vs ${b.scenarioFrames}`);

  const unknown = unknownFields.length > 0;
  return {
    label,
    cadenceA: a.cadence,
    cadenceB: b.cadence,
    equivalent: !unknown && differences.length === 0,
    unknown,
    comparedFields,
    unknownFields,
    differences,
  };
};

/**
 * Overall verdict: same-rate stability gates everything. A repeat variance at
 * one cadence is itself a divergence; an unknown anywhere (missing probe,
 * error, timeout, unisolated user://) can never be equivalent. Only when
 * every same-rate and cross-rate pair matches within tolerance is the route
 * measured equivalent for the tested settings.
 */
export const verdictOfPairs = (
  pairs: readonly CalibratePairResult[],
): "equivalent" | "different" | "unknown" => {
  if (pairs.length === 0) return "unknown";
  if (pairs.some((pair) => !pair.unknown && !pair.equivalent)) return "different";
  if (pairs.some((pair) => pair.unknown)) return "unknown";
  return "equivalent";
};
