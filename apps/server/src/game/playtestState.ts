import type {
  GameAcceptanceCriterion,
  GamePlaytestProbe,
  GamePlaytestState,
  GamePlaytestStateChange,
  GamePlaytestStateValue,
} from "@t3tools/contracts";
import { parseScenarioExpectation } from "./scenarioEvaluation.ts";

/**
 * A clock is not gameplay. Review-r1 rejected a playtest that "responded" only
 * because time advanced, so these values stay visible in the probe snapshot but
 * never count as a state change on their own.
 */
const CLOCK_KEYS = new Set(["run_seconds", "best_seconds"]);

/**
 * Seating a freshly spawned body settles it by a few centimetres; a held
 * movement key covers several units a second. Below this the player stood still.
 */
export const MIN_PLAYER_MOVEMENT = 0.75;

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Turns the probe samples into the before/after picture the result reports.
 * Movement and state changes are measured only between samples that have a
 * player: opening the game from its menu changes the scene, but the player did
 * not play until the body existed.
 */
export function summarizePlaytestSamples(samples: readonly GamePlaytestProbe[]): GamePlaytestState {
  const gameplay = samples.filter((sample) => sample.player !== null);
  let playerMoved = 0;
  for (let index = 1; index < gameplay.length; index++) {
    const previous = gameplay[index - 1]!.player!;
    const current = gameplay[index]!.player!;
    playerMoved += Math.hypot(
      current.x - previous.x,
      current.y - previous.y,
      current.z - previous.z,
    );
  }
  const firstValues = new Map<string, GamePlaytestStateValue>();
  const changedValues = new Map<string, GamePlaytestStateValue>();
  for (const sample of gameplay) {
    for (const [key, value] of Object.entries(sample.gameState)) {
      if (CLOCK_KEYS.has(key)) continue;
      if (!firstValues.has(key)) {
        firstValues.set(key, value);
        continue;
      }
      if (changedValues.has(key) || firstValues.get(key) !== value) changedValues.set(key, value);
    }
  }
  const changes: GamePlaytestStateChange[] = [];
  for (const [key, after] of changedValues) {
    const before = firstValues.get(key)!;
    // A value that returned to where it started is not evidence of anything.
    if (before !== after) changes.push({ key, before, after });
  }
  changes.sort((left, right) => left.key.localeCompare(right.key));
  return {
    before: samples[0] ?? null,
    after: samples.at(-1) ?? null,
    playerMoved: round(playerMoved),
    changes,
  };
}

/**
 * What a playtest with a probe needs to count as gameplay: the player actually
 * travelled, or a numeric run value changed. A boolean or a label alone is not
 * a mechanic.
 */
export function playtestShowsGameplay(state: GamePlaytestState): boolean {
  if (state.playerMoved > MIN_PLAYER_MOVEMENT) return true;
  return state.changes.some(
    (change) => typeof change.before === "number" && typeof change.after === "number",
  );
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

/**
 * Which approved `observe` criteria this run happened to satisfy. Informational
 * only: the scenario runner remains the gate, and this report never feeds
 * qualification.
 */
export function satisfiedObservations(
  criteria: readonly GameAcceptanceCriterion[],
  state: GamePlaytestState | null,
): string[] {
  if (state === null) return [];
  const final = state.after?.gameState ?? null;
  const satisfied: string[] = [];
  for (const criterion of criteria) {
    const observe = criterion.observe;
    if (observe === undefined) continue;
    const expectation = parseScenarioExpectation(observe.expect);
    if (expectation === null) continue;
    if (expectation.kind === "changes") {
      if (state.changes.some((change) => change.key === observe.key)) satisfied.push(criterion.id);
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
