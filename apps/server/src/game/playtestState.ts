import type {
  GameAcceptanceCriterion,
  GamePlaytestFrame,
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
 * The shared typed play marker native routes already read: `GameState.state`.
 * A boolean false or numeric zero is the menu, so a player or world the menu
 * keeps behind it cannot be mistaken for play. Any other boolean or numeric
 * marker identifies play even when the game has no player node. A missing or
 * non-scalar marker is a markerless game, where the player group itself is the
 * only sign play started; that remains ambiguous when a markerless menu shows
 * a player.
 */
const isMenu = (probe: GamePlaytestProbe): boolean => {
  const marker = probe.gameState.state;
  return marker === false || marker === 0;
};

const hasTypedPlayMarker = (probe: GamePlaytestProbe): boolean => {
  const marker = probe.gameState.state;
  return typeof marker === "boolean" || typeof marker === "number";
};

const inPlayProbe = (probe: GamePlaytestProbe): boolean =>
  hasTypedPlayMarker(probe) ? !isMenu(probe) : probe.player !== null;

const inPlay = (sample: GamePlaytestSample): boolean => inPlayProbe(sample.probe);

/**
 * The sample a run's states are measured against. A run already in play when
 * its first real input arrives is baselined on the probe taken just before
 * that input, so the action the input causes is evidence instead of looking
 * like a value play started with. Otherwise the baseline is the first sample
 * after input where play exists: opening the game from its menu changes the
 * scene, but the player did not play until play existed after an input step.
 * The typed marker holds a hidden menu player back on both sides of the input,
 * and also lets a no-player UI game identify play. The latest pre-input probe
 * (not boot) keeps an autonomous wait or clock from being credited to the
 * first action. A run without real input, or without play, has no baseline
 * and proves nothing.
 */
export const playtestBaseline = (samples: readonly GamePlaytestSample[]): number | null => {
  const firstInput = samples.findIndex((sample) => sample.afterInput);
  if (firstInput === -1) return null;
  const preInput = firstInput - 1;
  if (preInput >= 0 && inPlay(samples[preInput]!)) return preInput;
  for (let index = firstInput; index < samples.length; index++) {
    const sample = samples[index]!;
    if (sample.afterInput && inPlay(sample)) return index;
  }
  return null;
};

const lastGameplayProbe = (samples: readonly GamePlaytestSample[]): GamePlaytestProbe | null =>
  samples.findLast(inPlay)?.probe ?? null;

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
  const screen = samples.findLast((sample) => sample.probe.hudText !== undefined)?.probe;
  return {
    before: baseline,
    after: last,
    playerMoved: round(playerMoved),
    changes,
    ...(screen === undefined ? {} : { notOnScreen: keysNotOnScreen(screen) }),
  };
}

/**
 * The renderings of a value a HUD might plausibly show: the number as is, or
 * rounded the way a label would round it.
 */
const screenForms = (value: number): string[] =>
  Number.isInteger(value)
    ? [String(value)]
    : [
        String(Math.round(value)),
        String(Math.floor(value)),
        value.toFixed(1),
        value.toFixed(2),
        String(value),
      ];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * GameState keys whose value in this probe is not in its on-screen text. A
 * number counts when it stands alone (not inside a longer number); a string
 * when it appears case-insensitively. Booleans and empty strings are flags,
 * not something a HUD prints, so they are never reported.
 */
export function keysNotOnScreen(probe: GamePlaytestProbe): string[] {
  const text = probe.hudText ?? "";
  const lower = text.toLowerCase();
  const missing: string[] = [];
  for (const [key, value] of Object.entries(probe.gameState)) {
    if (typeof value === "boolean") continue;
    if (typeof value === "string") {
      const needle = value.trim().toLowerCase();
      if (needle !== "" && !lower.includes(needle)) missing.push(key);
      continue;
    }
    const shown = screenForms(value).some((form) =>
      new RegExp(`(?<![\\d.])${escapeRegExp(form)}(?![\\d])`).test(text),
    );
    if (!shown) missing.push(key);
  }
  return missing.toSorted();
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

/** One approved criterion compressed to what a probe sample can decide. */
interface CriterionCheck {
  readonly id: string;
  readonly key: string;
  /** Win and lose claims only count when the run ends still satisfying them. */
  readonly terminal: boolean;
  readonly expectation: Expectation;
}

const coreChecks = (criteria: readonly GameAcceptanceCriterion[]): CriterionCheck[] => {
  const checks: CriterionCheck[] = [];
  for (const criterion of criteria) {
    if (!isCoreKind(criterion.kind)) continue;
    const observe = criterion.observe;
    if (observe === undefined) continue;
    const expectation = parseScenarioExpectation(observe.expect);
    if (expectation === null) continue;
    checks.push({
      id: criterion.id,
      key: observe.key,
      terminal: criterion.kind === "win" || criterion.kind === "lose",
      expectation,
    });
  }
  return checks;
};

/**
 * Whether one checklist item holds in a specific probe. A `changes` item is a
 * relative claim: it holds only where the key has moved off the baseline value.
 */
const checkSatisfiedAt = (
  check: CriterionCheck,
  probe: GamePlaytestProbe,
  baselineValue: GamePlaytestStateValue | undefined,
): boolean => {
  if (check.expectation.kind === "changes") {
    const value = probe.gameState[check.key];
    return value !== undefined && value !== baselineValue;
  }
  const raw = probe.gameState[check.key];
  // `won ==1` is how the design vocabulary spells a boolean claim.
  const value = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
  return typeof value === "number" && satisfies(check.expectation, value);
};

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
  for (const check of coreChecks(criteria)) {
    const baselineValue = baseline.gameState[check.key];
    // The probe can only prove a transition it saw both ends of: a key the
    // baseline never named has no value the run changed away from.
    if (baselineValue === undefined) continue;
    if (checkSatisfiedAt(check, baseline, baselineValue)) continue;
    if (check.expectation.kind === "changes") {
      // Terminal claims live in the equals/atLeast/atMost vocabulary; here a
      // `changes` win claim stays unproven, the way a route treats a boot constant.
      if (check.terminal) continue;
      if (later.some((probe) => checkSatisfiedAt(check, probe, baselineValue)))
        achieved.push(check.id);
      continue;
    }
    const reached = check.terminal
      ? terminal !== null && checkSatisfiedAt(check, terminal, baselineValue)
      : later.some((probe) => checkSatisfiedAt(check, probe, baselineValue));
    if (reached) achieved.push(check.id);
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
 * - with an approved acceptance, at least one approved mechanic/content/win/
 *   lose criterion that was false at the gameplay baseline must have come true
 *   during the run. The approved criteria are the intended behavior, so no
 *   extra avatar displacement is required: dialogue, card and puzzle games
 *   often keep the player node still or have none at all;
 * - without acceptance (legacy), movement plus a GameState change whose
 *   sampled ride is not strictly increasing from the baseline on, so a clock
 *   can never be the whole story;
 * - a game whose policy never owed a probe keeps its pixel rule, which the
 *   caller reaches for through `probeRequired` with zero samples.
 *
 * The universal checks (boot, console errors, steps given, a visible response)
 * stay in the verdict too so no qualification can rely on a game that crashed
 * or froze.
 */
export function evaluatePlaytestRun(input: {
  readonly samples: readonly GamePlaytestSample[];
  readonly stepsGiven: boolean;
  readonly booted: boolean;
  /** Whether the sampled frames kept changing while the steps ran. */
  readonly responded: boolean;
  readonly consoleErrors: number;
  readonly probeRequired: boolean;
  /** The approved acceptance, or null for a game created without a design. */
  readonly acceptance: readonly GameAcceptanceCriterion[] | null;
}): PlaytestQualification {
  const blockers: string[] = [];
  const state = input.samples.length > 0 ? summarizePlaytestSamples(input.samples) : null;
  let achieved: string[] = [];
  if (!input.booted) blockers.push("the game did not boot");
  if (input.consoleErrors > 0) blockers.push(`${input.consoleErrors} console error(s)`);
  if (!input.stepsGiven) blockers.push("no input steps were given");
  if (!input.responded) blockers.push("the game did not visibly respond to the input steps");
  if (input.probeRequired && input.samples.length === 0)
    blockers.push("the StudioProbe autoload is missing or never answered");
  else if (input.probeRequired) {
    const startIndex = playtestBaseline(input.samples);
    if (startIndex === null) {
      blockers.push("no gameplay baseline: no player input step found the game in play");
    } else if (state !== null) {
      const baseline = input.samples[startIndex]!.probe;
      const later = input.samples.slice(startIndex + 1).map((sample) => sample.probe);
      if (input.acceptance === null) {
        // Legacy: movement is one half. The other is a GameState value whose
        // ride, sampled from the baseline on, did not only rise.
        if (state.playerMoved <= MIN_PLAYER_MOVEMENT)
          blockers.push("the player did not move from the gameplay baseline");
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
        if (achieved.length === 0) {
          blockers.push("no approved criterion achieved");
          const alreadySatisfied = coreChecks(input.acceptance)
            .filter(
              (check) =>
                check.expectation.kind !== "changes" &&
                checkSatisfiedAt(check, baseline, baseline.gameState[check.key]),
            )
            .map((check) => check.id);
          if (alreadySatisfied.length > 0)
            blockers.push(
              `the first gameplay sample already satisfies ${alreadySatisfied.join(", ")}; observe gameplay before attempting that target so its transition can be measured`,
            );
        }
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

/** Net distance between two player positions, the movement a frame can show. */
const playerDisplacement = (
  from: NonNullable<GamePlaytestProbe["player"]>,
  to: NonNullable<GamePlaytestProbe["player"]>,
): number => Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);

/** The final frame every web playtest captures, the run's last observed word. */
const AFTER_STEPS_LABEL = "after-steps";

/**
 * The frame that represents a run, chosen from what its persisted probe state
 * proves, not from what its screenshots are captioned: the first frame in play
 * where an approved criterion moved off its baseline value, else the first
 * frame with a player away from the baseline, else the run's final frame.
 * Screens the labels could never vouch for do not feed this.
 */
export const selectPlaytestCoverFrame = (
  frames: readonly GamePlaytestFrame[],
  state: GamePlaytestState | null,
  acceptance: readonly GameAcceptanceCriterion[] | null,
): GamePlaytestFrame | null => {
  const baseline = state?.before ?? null;
  if (baseline !== null) {
    const checks = coreChecks(acceptance ?? []);
    const progressed = frames.find((frame) => {
      const probe = frame.probe;
      if (probe === undefined || !inPlayProbe(probe)) return false;
      return checks.some((check) => {
        const baselineValue = baseline.gameState[check.key];
        // The transition has to start inside the observed world, the same way
        // qualification reads it: a key the baseline never named is unproven.
        if (baselineValue === undefined) return false;
        if (checkSatisfiedAt(check, baseline, baselineValue)) return false;
        return checkSatisfiedAt(check, probe, baselineValue);
      });
    });
    if (progressed !== undefined) return progressed;
    const originPlayer = baseline.player;
    if (originPlayer !== null) {
      const from: { x: number; y: number; z: number } = originPlayer;
      const moved = frames.find((frame) => {
        const at = frame.probe?.player;
        if (at === null || at === undefined) return false;
        return playerDisplacement(from, at) > MIN_PLAYER_MOVEMENT;
      });
      if (moved !== undefined) return moved;
    }
  }
  return frames.findLast((frame) => frame.label === AFTER_STEPS_LABEL) ?? null;
};
