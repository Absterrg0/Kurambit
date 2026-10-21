import { describe, expect, it } from "@effect/vitest";
import type {
  GamePlaytestProbe,
  GamePlaytestState,
  GamePlaytestStateChange,
} from "@t3tools/contracts";
import {
  describePlaytestState,
  MIN_PLAYER_MOVEMENT,
  playtestShowsGameplay,
  satisfiedObservations,
  summarizePlaytestSamples,
} from "./playtestState.ts";

const menu: GamePlaytestProbe = { gameState: { state: 0 }, player: null };
const gameplay = (
  gameState: Record<string, number | boolean | string>,
  x = 0,
): GamePlaytestProbe => ({ gameState, player: { x, y: 0, z: 0 } });

describe("summarizePlaytestSamples", () => {
  it("keeps the first and last sample and ignores the menu-to-game transition", () => {
    const state = summarizePlaytestSamples([
      menu,
      gameplay({ state: 1, collected: 0 }, 0),
      gameplay({ state: 1, collected: 0 }, 0),
    ]);
    expect(state.before).toEqual(menu);
    expect(state.after?.gameState.state).toBe(1);
    expect(state.playerMoved).toBe(0);
    expect(state.changes).toEqual([]);
  });

  it("adds the distance travelled between gameplay samples", () => {
    const state = summarizePlaytestSamples([
      menu,
      gameplay({ state: 1 }, 0),
      gameplay({ state: 1 }, 30),
      gameplay({ state: 1 }, 60),
    ]);
    expect(state.playerMoved).toBe(60);
  });

  it("reports numeric changes and ignores clocks", () => {
    const state = summarizePlaytestSamples([
      menu,
      gameplay({ state: 1, collected: 0, run_seconds: 0.5, best_seconds: 0 }),
      gameplay({ state: 1, collected: 2, run_seconds: 9.5, best_seconds: 0 }),
    ]);
    expect(state.changes).toEqual([{ key: "collected", before: 0, after: 2 }]);
  });
});

describe("playtestShowsGameplay", () => {
  const withState = (
    playerMoved: number,
    changes: GamePlaytestStateChange[] = [],
  ): GamePlaytestState => ({
    before: null,
    after: null,
    playerMoved,
    changes,
  });

  it("needs more than the seating of a spawned body", () => {
    expect(playtestShowsGameplay(withState(MIN_PLAYER_MOVEMENT))).toBe(false);
    expect(playtestShowsGameplay(withState(MIN_PLAYER_MOVEMENT + 1))).toBe(true);
  });

  it("accepts a numeric GameState change but not a boolean or string alone", () => {
    expect(playtestShowsGameplay(withState(0, [{ key: "collected", before: 0, after: 2 }]))).toBe(
      true,
    );
    expect(playtestShowsGameplay(withState(0, [{ key: "won", before: false, after: true }]))).toBe(
      false,
    );
    expect(
      playtestShowsGameplay(withState(0, [{ key: "level_name", before: "Ridge", after: "Steps" }])),
    ).toBe(false);
  });
});

describe("describePlaytestState", () => {
  it("says when a game has no probe", () => {
    expect(describePlaytestState(null)).toBe("no state probe");
  });

  it("summarises a run the way the tool reports it", () => {
    const state = summarizePlaytestSamples([
      menu,
      gameplay({ state: 1, collected: 0 }, 0),
      gameplay({ state: 1, collected: 2 }, 312),
    ]);
    expect(describePlaytestState(state)).toBe("collected 0→2, player moved 312");
  });

  it("says when nothing happened", () => {
    const state = summarizePlaytestSamples([menu, gameplay({ state: 1 }, 0)]);
    expect(describePlaytestState(state)).toBe("no player movement or GameState change");
  });
});

describe("satisfiedObservations", () => {
  const state = summarizePlaytestSamples([
    menu,
    gameplay({ collected: 2, won: true, lives: 3 }, 5),
  ]);
  const criteria = [
    {
      id: "two",
      kind: "content" as const,
      text: "two",
      observe: { key: "collected", expect: ">=2" },
    },
    { id: "won", kind: "win" as const, text: "won", observe: { key: "won", expect: "==1" } },
    { id: "few", kind: "mechanic" as const, text: "few", observe: { key: "lives", expect: "<=3" } },
    {
      id: "changed",
      kind: "mechanic" as const,
      text: "changed",
      observe: { key: "collected", expect: "changes" },
    },
    {
      id: "missing",
      kind: "mechanic" as const,
      text: "missing",
      observe: { key: "ammo", expect: ">=1" },
    },
    { id: "visual", kind: "mechanic" as const, text: "no observe" },
  ];

  it("reports only the criteria the snapshot satisfies", () => {
    // `changes` is measured between gameplay samples, and this run has only one,
    // so the pickups it shows in the final value are not a recorded change.
    expect(satisfiedObservations(criteria, state)).toEqual(["two", "won", "few"]);
  });

  it("has nothing to report without a probe", () => {
    expect(satisfiedObservations(criteria, null)).toEqual([]);
  });
});
