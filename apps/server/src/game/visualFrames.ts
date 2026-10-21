import type {
  GameAcceptanceCriterion,
  GamePlaytestProbe,
  GamePlaytestState,
  GamePlaytestStateValue,
  GameVisualFrame,
} from "@t3tools/contracts";
import { parseScenarioExpectation } from "./scenarioEvaluation.ts";

/**
 * A frame as persisted by `playtestEvidence.ts`. Captions are carried for the
 * prompt and for the person reading the evidence; they never choose the frame,
 * because t29's "04-double-jump.png" does not show a second jump and
 * "04-moon-pearl.png" was still 0/5 collected.
 */
export interface VisualEvidenceFrame {
  readonly label: string;
  readonly file: string;
  readonly probe?: GamePlaytestProbe;
}

const numeric = (value: GamePlaytestStateValue | undefined): number | null =>
  typeof value === "boolean" ? (value ? 1 : 0) : typeof value === "number" ? value : null;

type Expectation = ReturnType<typeof parseScenarioExpectation>;

const satisfied = (
  expectation: NonNullable<Expectation>,
  value: GamePlaytestStateValue | undefined,
): boolean => {
  if (value === undefined) return false;
  if (expectation.kind === "changes") return true;
  const current = numeric(value);
  if (current === null) return false;
  return expectation.kind === "equals"
    ? current === expectation.value
    : expectation.kind === "atLeast"
      ? current >= expectation.value
      : current <= expectation.value;
};

/** Core criteria with a probe-decidable observation, keyed for frame selection. */
const observedCriteria = (acceptance: readonly GameAcceptanceCriterion[]) =>
  acceptance.flatMap((criterion) => {
    if (criterion.kind === "presentation" || criterion.observe === undefined) return [];
    const expectation = parseScenarioExpectation(criterion.observe.expect);
    return expectation === null ? [] : [{ criterion, key: criterion.observe.key, expectation }];
  });

/**
 * Only a design whose `lose` criterion observes a GameState key has a hazard to
 * photograph; the "No lose state" promise has no lose transition at all.
 */
export const requiresHazardFrame = (acceptance: readonly GameAcceptanceCriterion[]): boolean =>
  observedCriteria(acceptance).some(({ criterion }) => criterion.kind === "lose");

/**
 * Whether a frame is on the way to the lose condition: the key moved from its
 * baseline in the direction that ends the run. A winning playtest never reaches
 * a met lose criterion, but the hit that cost a life is the hazard the review
 * needs to see, and reaching the condition counts as the same movement.
 */
const movedTowardLose = (
  expectation: NonNullable<Expectation>,
  from: GamePlaytestStateValue | undefined,
  to: GamePlaytestStateValue | undefined,
): boolean => {
  const start = numeric(from);
  const next = numeric(to);
  if (start === null || next === null || next === start) return false;
  if (expectation.kind === "atLeast") return next > start;
  if (expectation.kind === "atMost") return next < start;
  if (expectation.kind === "equals")
    return Math.abs(next - expectation.value) < Math.abs(start - expectation.value);
  // A lose claim cannot observe `changes`; scenario grading rejects that form.
  return false;
};

/** A bounded, factual line about what the probe showed at this frame. */
const frameEvidence = (baseline: GamePlaytestProbe | null, probe: GamePlaytestProbe): string => {
  const parts: string[] = [];
  if (probe.player === null) parts.push("no player body");
  else if (baseline?.player != null)
    parts.push(
      `player moved ${Math.round(
        Math.hypot(
          probe.player.x - baseline.player.x,
          probe.player.y - baseline.player.y,
          probe.player.z - baseline.player.z,
        ),
      )} units`,
    );
  else parts.push("player present");
  const changed = Object.entries(probe.gameState)
    .filter(([key, value]) => baseline?.gameState[key] !== value)
    .slice(0, 4)
    .map(([key, value]) => `${key} ${String(baseline?.gameState[key])}→${String(value)}`);
  if (changed.length > 0) parts.push(changed.join(", "));
  return parts.join("; ").slice(0, 240);
};

/**
 * Picks at most six frames that carry evidence of the states a visual review
 * needs: early gameplay, a real core interaction, a hazard moment, a later
 * area and the finish. The probe decides; a run whose evidence has no probe
 * state falls back to run order, because those frames cannot prove gameplay
 * and the positional fallback must not pretend a caption did.
 */
export function selectVisualFrames(input: {
  readonly frames: readonly VisualEvidenceFrame[];
  readonly state: GamePlaytestState | null;
  readonly acceptance: readonly GameAcceptanceCriterion[];
  /** Game-relative evidence folder the frame files live in. */
  readonly evidenceDirectory: string;
}): GameVisualFrame[] {
  const { frames } = input;
  if (frames.length === 0) return [];
  const indexed = frames.map((frame, index) => ({ frame, index }));
  const baseline =
    input.state?.before ?? frames.find((frame) => frame.probe?.player != null)?.probe ?? null;
  const criteria = observedCriteria(input.acceptance);
  const hasProbeState = frames.some((frame) => frame.probe !== undefined) && baseline !== null;

  const chosen = new Map<string, GameVisualFrame>();
  const pick = (entry: (typeof indexed)[number] | undefined, role: GameVisualFrame["role"]) => {
    if (entry === undefined) return;
    const file = entry.frame.file;
    if (chosen.has(file)) return;
    chosen.set(file, {
      id: `F${chosen.size + 1}`,
      label: entry.frame.label,
      path: `${input.evidenceDirectory}/${file}`,
      role,
      ...(entry.frame.probe === undefined || baseline === null
        ? {}
        : { evidence: frameEvidence(baseline, entry.frame.probe) }),
    });
  };

  if (hasProbeState) {
    const gameplay = indexed.filter((entry) => entry.frame.probe?.player != null);
    pick(gameplay[0], "early");

    // Hazard before interaction: the pass rule requires a hazard frame, and the
    // first damage frame is usually also the first `lives` mechanic frame.
    const hazard = gameplay.find((entry) => {
      const probe = entry.frame.probe;
      if (probe === undefined) return false;
      return criteria.some(({ criterion, key, expectation }) => {
        if (criterion.kind !== "lose") return false;
        const baselineValue = baseline.gameState[key];
        return (
          baselineValue !== undefined &&
          !satisfied(expectation, baselineValue) &&
          movedTowardLose(expectation, baselineValue, probe.gameState[key])
        );
      });
    });
    pick(hazard, "hazard");

    const progressed = gameplay.find((entry) => {
      const probe = entry.frame.probe;
      if (probe === undefined || chosen.has(entry.frame.file)) return false;
      return criteria.some(({ criterion, key, expectation }) => {
        // Lose progress belongs to the hazard role; a frame carries one role.
        if (criterion.kind === "lose") return false;
        const baselineValue = baseline.gameState[key];
        if (baselineValue === undefined) return false;
        const value = probe.gameState[key];
        // A `changes` claim is relative to the baseline, not something the
        // baseline can already satisfy.
        if (expectation.kind === "changes") return value !== undefined && value !== baselineValue;
        if (satisfied(expectation, baselineValue)) return false;
        return satisfied(expectation, value);
      });
    });
    pick(progressed, "interaction");

    const finishEntry = indexed.at(-1);
    // A later area is the last observed gameplay before the run's final frame.
    const later = gameplay.findLast((entry) => entry.index < (finishEntry?.index ?? Infinity));
    pick(later, "later");
    pick(finishEntry, "finish");
    return [...chosen.values()].slice(0, 6);
  }

  // No probe state: run order only. The first frame is the boot screen, and the
  // last is the run's final capture; nothing here can claim an interaction.
  const ordered = indexed.slice(1);
  const usable = ordered.length > 0 ? ordered : indexed;
  pick(usable[0], "early");
  if (usable.length >= 3) pick(usable[usable.length - 2], "later");
  pick(usable.at(-1), "finish");
  return [...chosen.values()];
}
