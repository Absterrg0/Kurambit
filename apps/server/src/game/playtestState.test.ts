import { describe, expect, it } from "@effect/vitest";
import type {
  GameAcceptanceCriterion,
  GamePlaytestFrame,
  GamePlaytestProbe,
  GamePlaytestState,
} from "@t3tools/contracts";
import {
  describePlaytestState,
  evaluatePlaytestRun,
  MIN_PLAYER_MOVEMENT,
  satisfiedObservations,
  selectPlaytestCoverFrame,
  summarizePlaytestSamples,
} from "./playtestState.ts";

const menu: GamePlaytestProbe = { gameState: { state: 0 }, player: null };
const gameplay = (
  gameState: Record<string, number | boolean | string>,
  x = 0,
): GamePlaytestProbe => ({ gameState, player: { x, y: 0, z: 0 } });
const before = (probe: GamePlaytestProbe, afterInput = false) => ({ probe, afterInput });
const played = (probe: GamePlaytestProbe) => ({ probe, afterInput: true });

describe("summarizePlaytestSamples", () => {
  it("measures from the gameplay baseline, not from the menu", () => {
    const state = summarizePlaytestSamples([
      before(menu),
      played(gameplay({ state: 1, collected: 0 }, 0)),
      played(gameplay({ state: 1, collected: 0 }, 0)),
    ]);
    expect(state.before?.gameState).toEqual({ state: 1, collected: 0 });
    expect(state.after?.gameState.state).toBe(1);
    expect(state.playerMoved).toBe(0);
    expect(state.changes).toEqual([]);
  });

  it("ignores samples only the menu could have produced", () => {
    const state = summarizePlaytestSamples([
      before(gameplay({ state: 0 }, 0)),
      played(menu),
      played(gameplay({ state: 1, collected: 0 }, 0)),
    ]);
    // The baseline is the first post-input sample with a player present: the
    // pre-input gameplay-shaped sample and the menu sample prove no play.
    expect(state.before?.gameState.state).toBe(1);
    expect(state.playerMoved).toBe(0);
  });

  it("adds the distance travelled between the baseline and the last gameplay sample", () => {
    const state = summarizePlaytestSamples([
      before(menu),
      played(gameplay({ state: 1 }, 0)),
      played(gameplay({ state: 1 }, 30)),
      played(gameplay({ state: 1 }, 60)),
    ]);
    expect(state.playerMoved).toBe(60);
  });

  it("reports changes away from the baseline, not boot constants", () => {
    const state = summarizePlaytestSamples([
      before(menu),
      played(gameplay({ state: 1, collected: 0, run_seconds: 0.5 })),
      played(gameplay({ state: 1, collected: 2, run_seconds: 9.5 })),
    ]);
    // Entering play changed `state`, but the baseline is the first post-input
    // gameplay sample: state is 1 THERE, so the change the run caused is `collected`.
    expect(state.changes).toEqual([
      { key: "collected", before: 0, after: 2 },
      { key: "run_seconds", before: 0.5, after: 9.5 },
    ]);
  });
});

describe("evaluatePlaytestRun", () => {
  const run = (
    overrides: Partial<Parameters<typeof evaluatePlaytestRun>[0]> & {
      samples?: { probe: GamePlaytestProbe; afterInput: boolean }[];
    },
  ) => {
    const samples = overrides.samples ?? [
      before(menu),
      played(gameplay({ state: 1, run_seconds: 0.4 }, 0)),
      played(gameplay({ state: 1, run_seconds: 2.2 }, 0)),
      played(gameplay({ state: 1, run_seconds: 4.6 }, 0)),
    ];
    return evaluatePlaytestRun({
      samples,
      stepsGiven: true,
      booted: true,
      responded: true,
      consoleErrors: 0,
      probeRequired: true,
      acceptance: null,
      ...overrides,
    });
  };

  it("rejects a run where only a clock moved", () => {
    const clockOnly = run({});
    expect(clockOnly.qualifies).toBe(false);
    expect(clockOnly.blockers).toContain("the player did not move from the gameplay baseline");
    expect(clockOnly.blockers).toContain(
      "no GameState value changed on a ride a stopped clock would not show",
    );
  });

  it("rejects a relocating pointer or a paused flag alone: the body never played", () => {
    const answer = run({
      samples: [
        before(menu),
        // A pause overlay flips a boolean; no movement anywhere.
        played(gameplay({ state: 1, paused: false })),
        played(gameplay({ state: 1, paused: true })),
        played(gameplay({ state: 1, paused: false })),
      ],
    });
    expect(answer.qualifies).toBe(false);
    expect(answer.blockers).toContain("the player did not move from the gameplay baseline");
  });

  it("qualifies on an approved criterion that was false at the baseline and true later", () => {
    const pickup: GameAcceptanceCriterion[] = [
      {
        id: "pickup",
        kind: "content",
        text: "collect one pearl",
        observe: { key: "collected", expect: ">=1" },
      },
    ];
    const ok = run({
      acceptance: pickup,
      samples: [
        before(menu),
        played(gameplay({ state: 1, collected: 0 }, 4)),
        played(gameplay({ state: 1, collected: 1 }, 8)),
        played(gameplay({ state: 1, collected: 1 }, 10)),
      ],
    });
    expect(ok.qualifies).toBe(true);
    expect(ok.achieved).toEqual(["pickup"]);
  });

  it("a win claim has to hold where the run ended", () => {
    const win: GameAcceptanceCriterion[] = [
      { id: "win-run", kind: "win", text: "win a run", observe: { key: "won", expect: "==1" } },
    ];
    const flashedAndReverted = run({
      acceptance: win,
      samples: [
        before(menu),
        played(gameplay({ state: 1, won: false }, 4)),
        played(gameplay({ state: 3, won: true }, 8)),
        played(gameplay({ state: 0, won: false }, 6)),
      ],
    });
    expect(flashedAndReverted.qualifies).toBe(false);
    const won = run({
      acceptance: win,
      samples: [
        before(menu),
        played(gameplay({ state: 1, won: false }, 4)),
        played(gameplay({ state: 3, won: true }, 8)),
      ],
    });
    expect(won.qualifies).toBe(true);
  });

  it("a criterion already true at the baseline cannot qualify the run", () => {
    const win: GameAcceptanceCriterion[] = [
      { id: "gate", kind: "win", text: "win", observe: { key: "won", expect: "==1" } },
    ];
    const preWon = run({
      acceptance: win,
      samples: [
        before(menu),
        played(gameplay({ state: 3, won: true }, 4)),
        played(gameplay({ state: 3, won: true }, 8)),
      ],
    });
    expect(preWon.qualifies).toBe(false);
    expect(preWon.blockers).toContain("no approved criterion achieved");
  });

  it("movement and one non-clock GameState change qualify a legacy game", () => {
    const legacy = run({
      samples: [
        before(menu),
        played(gameplay({ state: 1, jumps: 0, run_seconds: 0.4 }, 3)),
        played(gameplay({ state: 1, jumps: 1, run_seconds: 1.2 }, 6)),
        played(gameplay({ state: 1, jumps: 1, run_seconds: 3.0 }, 9)),
      ],
    });
    expect(legacy.qualifies).toBe(true);
    expect(legacy.interaction).toContain("jumps 0→1");
  });

  it("a legacy game whose changes all read like clocks still fails", () => {
    const clockOnly = run({
      samples: [
        before(menu),
        played(gameplay({ state: 1, run_seconds: 0.4, best_seconds: 0 }, 3)),
        played(gameplay({ state: 1, run_seconds: 2.4, best_seconds: 3 }, 7)),
      ],
    });
    expect(clockOnly.qualifies).toBe(false);
  });

  it("one strictly rising step is not the non-clock change the legacy rule asks for", () => {
    // jumps 0→1 seen exactly once is indistinguishable from a timer bumping on
    // its way up; later samples showing it hold give the change its shape.
    const singleStep = run({
      samples: [
        before(menu),
        played(gameplay({ state: 1, jumps: 0 }, 3)),
        played(gameplay({ state: 1, jumps: 1 }, 7)),
      ],
    });
    expect(singleStep.qualifies).toBe(false);
  });

  it("universal checks still block a crashed, frozen or unplayed game", () => {
    expect(run({ booted: false }).blockers).toContain("the game did not boot");
    expect(run({ consoleErrors: 1 }).blockers).toContain("1 console error(s)");
    expect(run({ stepsGiven: false }).blockers).toContain("no input steps were given");
    expect(run({ responded: false }).blockers).toContain(
      "the game did not visibly respond to the input steps",
    );
    expect(run({ samples: [], probeRequired: true }).blockers).toContain(
      "the StudioProbe autoload is missing or never answered",
    );
  });

  it("a run whose samples never gained a gameplay baseline fails honestly", () => {
    expect(run({ samples: [before(menu)] }).blockers).toContain(
      "no gameplay baseline: the player never appeared after an input step",
    );
  });

  it("a game that never owed a probe keeps its pixel rule", () => {
    const tolerated = run({
      samples: [],
      probeRequired: false,
      acceptance: null,
    });
    expect(tolerated.qualifies).toBe(true);
  });
});

describe("selectPlaytestCoverFrame", () => {
  const frame = (label: string, probe?: GamePlaytestProbe): GamePlaytestFrame => ({
    label,
    path: `${label}.png`,
    ...(probe === undefined ? {} : { probe }),
  });
  const acceptance: GameAcceptanceCriterion[] = [
    {
      id: "pickup",
      kind: "content",
      text: "collect",
      observe: { key: "collected", expect: ">=1" },
    },
  ];

  it("uses observed gameplay frames from the persisted probe, and captions never win", () => {
    const state: GamePlaytestState = {
      before: gameplay({ state: 1, collected: 0 }, 4),
      after: gameplay({ state: 1, collected: 1 }, 8),
      playerMoved: 4,
      changes: [{ key: "collected", before: 0, after: 1 }],
    };
    const picked = selectPlaytestCoverFrame(
      [
        frame("booted"),
        frame("menu", gameplay({ state: 1, collected: 0 }, 4)),
        frame("pose", gameplay({ state: 1, collected: 1 }, 8)),
      ],
      state,
      acceptance,
    );
    expect(picked?.label).toBe("pose");
    // A screenshot whose own probe shows no progress cannot be the cover.
    expect(
      selectPlaytestCoverFrame(
        [frame("menu", gameplay({ state: 1, collected: 0 }, 4))],
        state,
        acceptance,
      ),
    ).toBeNull();
  });

  it("falls back to movement, then the after-steps frame", () => {
    const state: GamePlaytestState = {
      before: gameplay({ state: 1 }, 4),
      after: gameplay({ state: 1 }, 10),
      playerMoved: 6,
      changes: [],
    };
    expect(
      selectPlaytestCoverFrame([frame("after-steps", gameplay({ state: 1 }, 10))], state, null)
        ?.label,
    ).toBe("after-steps");
    const moved = frame("walk", gameplay({ state: 1 }, 10));
    expect(
      selectPlaytestCoverFrame(
        [frame("idle", gameplay({ state: 1 }, 4)), frame("after-steps")],
        state,
        null,
      )?.label,
    ).toBe("after-steps");
    expect(
      selectPlaytestCoverFrame([frame("idle", gameplay({ state: 1 }, 4)), moved], state, null)
        ?.label,
    ).toBe("walk");
  });

  it("keeps the after-steps frame when no probe pairs with any frame", () => {
    expect(
      selectPlaytestCoverFrame([frame("booted"), frame("after-steps")], null, acceptance)?.label,
    ).toBe("after-steps");
    expect(selectPlaytestCoverFrame([frame("booted")], null, acceptance)).toBeNull();
  });
});

describe("describePlaytestState", () => {
  it("says when a game has no probe", () => {
    expect(describePlaytestState(null)).toBe("no state probe");
  });

  it("summarises a run the way the tool reports it", () => {
    const state = summarizePlaytestSamples([
      before(menu),
      played(gameplay({ state: 1, collected: 0 }, 0)),
      played(gameplay({ state: 1, collected: 2 }, 312)),
    ]);
    expect(describePlaytestState(state)).toBe("collected 0→2, player moved 312");
  });

  it("says when nothing happened", () => {
    const state = summarizePlaytestSamples([before(menu), played(gameplay({ state: 1 }, 0))]);
    expect(describePlaytestState(state)).toBe("no player movement or GameState change");
  });
});

describe("satisfiedObservations", () => {
  const state = summarizePlaytestSamples([
    before(menu),
    before(gameplay({ collected: 2, won: true, lives: 3 }, 5), true),
  ]);
  const criteria: GameAcceptanceCriterion[] = [
    {
      id: "two",
      kind: "content",
      text: "two",
      observe: { key: "collected", expect: ">=2" },
    },
    { id: "won", kind: "win", text: "won", observe: { key: "won", expect: "==1" } },
    { id: "few", kind: "mechanic", text: "few", observe: { key: "lives", expect: "<=3" } },
    {
      id: "changed",
      kind: "mechanic",
      text: "changed",
      observe: { key: "collected", expect: "changes" },
    },
    {
      id: "missing",
      kind: "mechanic",
      text: "missing",
      observe: { key: "ammo", expect: ">=1" },
    },
    { id: "visual", kind: "mechanic", text: "no observe" },
  ];

  it("reports only the criteria the snapshot satisfies", () => {
    expect(satisfiedObservations(criteria, state)).toEqual(["two", "won", "few"]);
  });

  it("has nothing to report without a probe", () => {
    expect(satisfiedObservations(criteria, null)).toEqual([]);
  });
});
