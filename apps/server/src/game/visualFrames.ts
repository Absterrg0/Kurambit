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

/** A gameplay frame: the probe found the player body in it. */
const isGameplay = (probe: GamePlaytestProbe | undefined): probe is GamePlaytestProbe =>
  probe !== undefined && probe.player !== null;

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
 * baseline in the direction that ends the run. The frame where the claim is met
 * is the run's end, not a hazard, so callers exclude it.
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
 * Whether an approved `win` or `lose` claim is met in this frame: the run ended
 * there, so the frame is a result screen, never gameplay evidence. A `changes`
 * claim is relative to the baseline and would mark every later frame an end,
 * so it cannot decide the end of a run (approval rejects that form anyway).
 */
const isEndFrame = (
  criteria: ReturnType<typeof observedCriteria>,
  probe: GamePlaytestProbe,
): boolean =>
  criteria.some(
    ({ criterion, key, expectation }) =>
      (criterion.kind === "win" || criterion.kind === "lose") &&
      expectation.kind !== "changes" &&
      satisfied(expectation, probe.gameState[key]),
  );

/**
 * Picks at most six frames that carry evidence of the states a visual review
 * needs: early gameplay, a real core interaction, a hazard moment, a later
 * area, the approach to the goal and the run's result screen. The probe
 * decides; a run whose evidence has no probed frame selects nothing, because
 * run order cannot prove a frame is gameplay.
 *
 * A frame where an approved win or lose claim is already met is the end of the
 * run. It may fill only `result`: t38's reviews judged the end-of-run panel as
 * "early gameplay" and scored a game they had never seen.
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
    input.state?.before ?? frames.find((frame) => isGameplay(frame.probe))?.probe ?? null;
  if (baseline === null) return [];
  const criteria = observedCriteria(input.acceptance);
  const running = indexed.filter(
    (entry) => isGameplay(entry.frame.probe) && !isEndFrame(criteria, entry.frame.probe),
  );

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

  pick(running[0], "early");

  // Hazard before interaction: the pass rule requires a hazard frame, and the
  // first damage frame is usually also the first `lives` mechanic frame. Only a
  // hit that stopped short of the lose condition is a hazard; the frame where
  // the claim is met is the run's end.
  const hazard = running.find((entry) => {
    const probe = entry.frame.probe;
    if (probe === undefined) return false;
    return criteria.some(({ criterion, key, expectation }) => {
      if (criterion.kind !== "lose") return false;
      const baselineValue = baseline.gameState[key];
      return (
        baselineValue !== undefined &&
        !satisfied(expectation, baselineValue) &&
        !satisfied(expectation, probe.gameState[key]) &&
        movedTowardLose(expectation, baselineValue, probe.gameState[key])
      );
    });
  });
  pick(hazard, "hazard");

  const progressed = running.find((entry) => {
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

  // The finish is the last gameplay frame the run reached before it ended: the
  // approach to the goal. A run whose final gameplay frames all filled another
  // role has no separate approach, so it selects no finish and is not judged.
  const finish = running.findLast((entry) => !chosen.has(entry.frame.file));
  const later =
    finish === undefined
      ? undefined
      : running.findLast((entry) => entry.index < finish.index && !chosen.has(entry.frame.file));
  pick(later, "later");
  pick(finish, "finish");

  const result = indexed.find(
    (entry) => entry.frame.probe !== undefined && isEndFrame(criteria, entry.frame.probe),
  );
  pick(result, "result");
  return [...chosen.values()].slice(0, 6);
}

/**
 * The gameplay evidence a review cannot work without. A result screen shows the
 * player behind a panel, so a run that only captured end screens must not spend
 * a judgement: the agent needs screenshot steps that show the game.
 */
export const missingVisualEvidence = (input: {
  readonly frames: readonly GameVisualFrame[];
  readonly hazardRequired: boolean;
}): readonly GameVisualFrame["role"][] => {
  const roles = new Set(input.frames.map((frame) => frame.role));
  const missing: GameVisualFrame["role"][] = [];
  if (!roles.has("early")) missing.push("early");
  if (input.hazardRequired && !roles.has("hazard")) missing.push("hazard");
  if (!roles.has("finish")) missing.push("finish");
  return missing;
};

/** What the agent must capture to fill a missing role, in the playtest's own vocabulary. */
export const VISUAL_EVIDENCE_STEP: Record<GameVisualFrame["role"], string> = {
  early: "a mid-run frame after play has started",
  interaction: "the core interaction as it happens",
  hazard: "one hazard hit that costs health or a life without ending the run",
  later: "a later area",
  finish: "the approach to the goal, before the result screen",
  result: "the result screen",
};
