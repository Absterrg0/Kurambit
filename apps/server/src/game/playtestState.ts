import type {
  GameAcceptanceCriterion,
  GamePlaytestProbe,
  GamePlaytestState,
  GamePlaytestStateChange,
  GamePlaytestStateValue,
} from "@t3tools/contracts";
import { parseScenarioExpectation } from "./scenarioEvaluation.ts";

/**
 * One thing the StudioProbe reported during a run, and what made the run
 * sample it: values only mean "the game was played" once a step the game
 * receives as player input has been dispatched, so the recorder marks every
 * sample taken after the first key, click or mouse-move step.
 */
export interface GamePlaytestSample {
  readonly probe: GamePlaytestProbe;
  readonly afterInput: boolean;
}

/**
 * Seating a freshly spawned body settles it by a few centimetres; a held
 * movement key covers several units a second. Below this the player stood still.
 */
export const MIN_PLAYER_MOVEMENT = 0.75;

const round = (value: number) => Math.round(value * 1000) / 1000;

const ordinal = (value: GamePlaytestStateValue): number | string =>
  typeof value === "boolean" ? (value ? 1 : 0) : value;

/**
 * Whether a GameState value's sampled ride only ever rose — the shape of a
 * clock, and of any value whose rise no gameplay caused. This is why no key
 * carries a name in these rules: run_seconds, best_seconds and every future
 * clock are excluded by shape, not by spelling.
 */
const strictlyIncreasing = (values: readonly GamePlaytestStateValue[]): boolean => {
  if (values.length < 2) return false;
  return values.slice(1).every((value, index) => {
    const previous = ordinal(values[index]!);
    const current = ordinal(value);
    if (typeof previous !== "number" || typeof current !== "number") {
      // Labels have no ride direction and no ordering a probe can vouch for,
      // so a label the run moved away from IS the change being asked for.
      return true;
    }
    return current > previous;
  });
};

/**
 * The sample a run's states are measured against: the first one taken after
 * input with a player present. Opening the game from its menu changes the
 * scene, but the player did not play until the body existed after an input
 * step; a run without such a sample has no baseline and proves nothing.
 */
export const playtestBaseline = (samples: readonly GamePlaytestSample[]): number | null => {
  const index = samples.findIndex((sample) => sample.afterInput && sample.probe.player !== null);
  return index === -1 ? null : index;
};

const lastGameplayProbe = (samples: readonly GamePlaytestSample[]): GamePlaytestProbe | null =>
  samples.findLast((sample) => sample.probe.player !== null)?.probe ?? null;

/**
 * Turns the probe samples into the before/after picture the result reports.
 * `before` is the gameplay baseline probe, movement is the net displacement
 * from it, and `changes` lists GameState values that moved away from the
 * baseline, so the reported state is what playing produced rather than what
 * the menu looked like.
 */
export function summarizePlaytestSamples(
  samples: readonly GamePlaytestSample[],
): GamePlaytestState {
  const startIndex = playtestBaseline(samples);
  const baseline = startIndex === null ? null : samples[startIndex]!.probe;
  const last = lastGameplayProbe(samples);
  let playerMoved = 0;
  if (baseline?.player != null && last?.player != null) {
    playerMoved = Math.hypot(
      last.player.x - baseline.player.x,
      last.player.y - baseline.player.y,
      last.player.z - baseline.player.z,
    );
  }
  const changes: GamePlaytestStateChange[] = [];
  if (startIndex !== null) {
    const baselineValues = samples[startIndex]!.probe.gameState;
    const reported = new Set<string>();
    for (const sample of samples.slice(startIndex)) {
      for (const [key, value] of Object.entries(sample.probe.gameState)) {
        if (reported.has(key)) continue;
        const before = baselineValues[key];
        // A GameState key that only exists after play (the baseline state never
        // named it) has no proven starting value to change from.
        if (before === undefined || before === value) continue;
        reported.add(key);
        changes.push({ key, before, after: value });
      }
    }
    changes.sort((left, right) => left.key.localeCompare(right.key));
  }
  return {
    before: baseline,
    after: last,
    playerMoved: round(playerMoved),
    changes,
  };
}

const formatValue = (value: GamePlaytestStateValue): string => {
  if (typeof value !== "number") return String(value).slice(0, 24);
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 10) / 10);
};

/** The short "collected 0→2, player moved 312" line in the tool result. */
export function describePlaytestState(state: GamePlaytestState | null): string {
  if (state === null) return "no state probe";
  const parts = state.changes
    .slice(0, 4)
    .map((change) => `${change.key} ${formatValue(change.before)}→${formatValue(change.after)}`);
  if (state.playerMoved > MIN_PLAYER_MOVEMENT)
    parts.push(`player moved ${Math.round(state.playerMoved)}`);
  return parts.length === 0 ? "no player movement or GameState change" : parts.join(", ");
}

type Expectation =
  | { readonly kind: "changes" }
  | { readonly kind: "equals"; readonly value: number }
  | { readonly kind: "atLeast"; readonly value: number }
  | { readonly kind: "atMost"; readonly value: number };

const satisfies = (expectation: Expectation, raw: GamePlaytestStateValue): boolean => {
  if (expectation.kind === "changes") return true;
  const value = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
  if (typeof value !== "number") return false;
  if (expectation.kind === "equals") return value === expectation.value;
  if (expectation.kind === "atLeast") return value >= expectation.value;
  return value <= expectation.value;
};

/** The mechanical kinds this stage compresses into one achieved transition. */
const isCoreKind = (kind: GameAcceptanceCriterion["kind"]): boolean =>
  kind === "mechanic" || kind === "content" || kind === "win" || kind === "lose";

/**
 * Which approved criteria a run achieved: each must have been false at the
 * gameplay baseline and true at a sample the run reached. A win or lose has to
 * hold where the run ended, because a value that flashed once and returned to
 * play is not a finished run; mechanic and content claims are proved by the
 * visit itself.
 */
const achievedCriteria = (
  criteria: readonly GameAcceptanceCriterion[],
  baseline: GamePlaytestProbe,
  later: readonly GamePlaytestProbe[],
): string[] => {
  const terminal = later.at(-1) ?? null;
  const achieved: string[] = [];
  for (const criterion of criteria) {
    if (!isCoreKind(criterion.kind)) continue;
    const observe = criterion.observe;
    if (observe === undefined) continue;
    const expectation = parseScenarioExpectation(observe.expect);
    if (expectation === null) continue;
    if (expectation.kind === "changes") {
      // A `changes` observation proves state churn; the approval rules keep
      // terminal claims out of this vocabulary, and here they stay unproven,
      // the same way a route treats a boot constant.
      if (criterion.kind !== "win" && criterion.kind !== "lose") {
        const changed = later.some(
          (probe) =>
            probe.gameState[observe.key] !== undefined &&
            probe.gameState[observe.key] !== baseline.gameState[observe.key],
        );
        if (changed) achieved.push(criterion.id);
      }
      continue;
    }
    const baselineValue = baseline.gameState[observe.key];
    if (baselineValue === undefined || satisfies(expectation, baselineValue)) continue;
    const reached =
      criterion.kind === "win" || criterion.kind === "lose"
        ? terminal !== null &&
          terminal.gameState[observe.key] !== undefined &&
          satisfies(expectation, terminal.gameState[observe.key]!)
        : later.some((probe) => satisfies(expectation, probe.gameState[observe.key] ?? ""));
    if (reached) achieved.push(criterion.id);
  }
  return achieved;
};

export interface PlaytestQualification {
  readonly qualifies: boolean;
  readonly blockers: readonly string[];
  /** What changed from the run's gameplay baseline, human readable. */
  readonly interaction: string;
  /** Ids of the approved criteria this run achieved, when reported. */
  readonly achieved: readonly string[];
}

/**
 * The playtest stage's verdict. A probe-equipped run is honest gameplay
 * evidence only through achieved play:
 *
 * - with an approved acceptance, the player must have moved away from the
 *   gameplay baseline AND at least one approved mechanic/content/win/lose
 *   criterion that was false at the baseline must have come true during the
 *   run;
 * - without acceptance (legacy), movement plus a GameState change whose
 *   sampled ride is not strictly increasing from the baseline on, so a clock
 *   can never be the whole story;
 * - a game whose policy never owed a probe keeps its pixel rule, which the
 *   caller reaches for through `probeRequired` with zero samples.
 */
export function evaluatePlaytestRun(input: {
  readonly samples: readonly GamePlaytestSample[];
  readonly stepsGiven: boolean;
  readonly booted: boolean;
  readonly probeRequired: boolean;
  /** The approved acceptance, or null for a game created without a design. */
  readonly acceptance: readonly GameAcceptanceCriterion[] | null;
}): PlaytestQualification {
  const blockers: string[] = [];
  const state = input.samples.length > 0 ? summarizePlaytestSamples(input.samples) : null;
  let achieved: string[] = [];
  if (!input.booted) blockers.push("the game did not boot");
  if (!input.stepsGiven) blockers.push("no input steps were given");
  if (input.probeRequired && input.samples.length === 0)
    blockers.push("the StudioProbe autoload is missing");
  else if (input.probeRequired) {
    const startIndex = playtestBaseline(input.samples);
    if (startIndex === null) {
      blockers.push("no gameplay baseline: the player never appeared after an input step");
    } else if (state !== null) {
      const baseline = input.samples[startIndex]!.probe;
      const later = input.samples.slice(startIndex + 1).map((sample) => sample.probe);
      if (state.playerMoved <= MIN_PLAYER_MOVEMENT)
        blockers.push("the player did not move from the gameplay baseline");
      if (input.acceptance === null) {
        // Legacy: movement is one half. The other is a GameState value whose
        // ride, sampled from the baseline on, did not only rise.
        const turned = state.changes.some((change) => {
          const values: GamePlaytestStateValue[] = [change.before];
          for (const probe of later) {
            const value = probe.gameState[change.key];
            if (value !== undefined) values.push(value);
          }
          return !strictlyIncreasing(values);
        });
        if (!turned)
          blockers.push("no GameState value changed on a ride a stopped clock would not show");
      } else {
        achieved = achievedCriteria(input.acceptance, baseline, later);
        if (achieved.length === 0) blockers.push("no approved criterion achieved");
      }
    }
  }
  return {
    qualifies: blockers.length === 0,
    blockers,
    interaction: state === null ? "no state probe" : describePlaytestState(state),
    achieved,
  };
}

/**
 * The criteria this run happened to satisfy, for the informational report the
 * tool attaches. The metric is the run's final gameplay state against its
 * baseline, so a value the run ends at reads the way a route would have.
 */
export function satisfiedObservations(
  criteria: readonly GameAcceptanceCriterion[],
  state: GamePlaytestState | null,
): string[] {
  if (state === null) return [];
  const final = state.after?.gameState ?? null;
  const baseline = state.before?.gameState ?? null;
  const satisfied: string[] = [];
  for (const criterion of criteria) {
    const observe = criterion.observe;
    if (observe === undefined) continue;
    const expectation = parseScenarioExpectation(observe.expect);
    if (expectation === null) continue;
    if (expectation.kind === "changes") {
      if (
        baseline !== null &&
        final !== null &&
        baseline[observe.key] !== undefined &&
        final[observe.key] !== undefined &&
        final[observe.key] !== baseline[observe.key]
      )
        satisfied.push(criterion.id);
      continue;
    }
    const raw = final === null ? undefined : final[observe.key];
    // `won ==1` is how the design vocabulary spells a boolean win.
    const value = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
    if (typeof value !== "number") continue;
    const matched =
      expectation.kind === "equals"
        ? value === expectation.value
        : expectation.kind === "atLeast"
          ? value >= expectation.value
          : value <= expectation.value;
    if (matched) satisfied.push(criterion.id);
  }
  return satisfied;
}
