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
  satisfiedObservations,
  selectPlaytestCoverFrame,
  summarizePlaytestSamples,
} from "./playtestState.ts";

const menu: GamePlaytestProbe = { gameState: { state: 0 }, player: null };
const gameplay = (
  gameState: Record<string, number | boolean | string>,
  x = 0,
): GamePlaytestProbe => ({ gameState, player: { x, y: 0, z: 0 } });
const ui = (gameState: Record<string, number | boolean | string>): GamePlaytestProbe => ({
  gameState,
  player: null,
});
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

  it("baselines an already-playing run before its first input", () => {
    const state = summarizePlaytestSamples([
      before(gameplay({ state: 1, replies: 0 }, 0)),
      played(gameplay({ state: 1, replies: 1 }, 20)),
      played(gameplay({ state: 1, replies: 1 }, 20)),
    ]);
    expect(state.before?.gameState).toEqual({ state: 1, replies: 0 });
    expect(state.changes).toEqual([{ key: "replies", before: 0, after: 1 }]);
    expect(state.playerMoved).toBe(20);
  });

  it("uses the last pre-input sample, so an autonomous wait is not play", () => {
    const state = summarizePlaytestSamples([
      before(gameplay({ state: 1, replies: 0, run_seconds: 0.4 }, 0)),
      before(gameplay({ state: 1, replies: 0, run_seconds: 3.0 }, 0)),
      played(gameplay({ state: 1, replies: 1, run_seconds: 3.2 }, 0)),
    ]);
    // The clock moved while the route only waited; baselining at boot would
    // report that whole ride as something the click caused.
    expect(state.before?.gameState.run_seconds).toBe(3.0);
    expect(state.changes).toEqual([
      { key: "replies", before: 0, after: 1 },
      { key: "run_seconds", before: 3.0, after: 3.2 },
    ]);
  });

  it("does not baseline a menu that already has a player", () => {
    const state = summarizePlaytestSamples([
      before(gameplay({ state: 0, collected: 0 }, 0)),
      played(gameplay({ state: 1, collected: 5 }, 10)),
      played(gameplay({ state: 1, collected: 5 }, 10)),
    ]);
    expect(state.before?.gameState).toEqual({ state: 1, collected: 5 });
    expect(state.changes).toEqual([]);
  });

  it("baselines a markerless game from the player already in play", () => {
    const state = summarizePlaytestSamples([
      before(gameplay({ replies: 0 }, 0)),
      played(gameplay({ replies: 1 }, 12)),
      played(gameplay({ replies: 1 }, 12)),
    ]);
    expect(state.before?.gameState).toEqual({ replies: 0 });
    expect(state.changes).toEqual([{ key: "replies", before: 0, after: 1 }]);
  });

  it("baselines a typed in-play UI game that has no player node", () => {
    const state = summarizePlaytestSamples([
      before(ui({ state: 1, replies: 0 })),
      played(ui({ state: 1, replies: 1 })),
      played(ui({ state: 1, replies: 1 })),
    ]);
    expect(state.before).toEqual(ui({ state: 1, replies: 0 }));
    expect(state.after).toEqual(ui({ state: 1, replies: 1 }));
    expect(state.playerMoved).toBe(0);
    expect(state.changes).toEqual([{ key: "replies", before: 0, after: 1 }]);
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

  it("qualifies an already-playing first click whose change happened in that click", () => {
    const reply: GameAcceptanceCriterion[] = [
      {
        id: "press-reply",
        kind: "content",
        text: "send the first reply",
        observe: { key: "replies", expect: ">=1" },
      },
    ];
    const firstClick = run({
      acceptance: reply,
      samples: [
        before(gameplay({ state: 1, replies: 0 }, 0)),
        played(gameplay({ state: 1, replies: 1 }, 20)),
        played(gameplay({ state: 1, replies: 1 }, 20)),
      ],
    });
    expect(firstClick.qualifies).toBe(true);
    expect(firstClick.blockers).toEqual([]);
    expect(firstClick.achieved).toEqual(["press-reply"]);
    expect(firstClick.interaction).toContain("replies 0→1");
  });

  it("qualifies an already-playing markerless first press", () => {
    const reply: GameAcceptanceCriterion[] = [
      {
        id: "press-reply",
        kind: "content",
        text: "send the first reply",
        observe: { key: "replies", expect: ">=1" },
      },
    ];
    const firstPress = run({
      acceptance: reply,
      samples: [before(gameplay({ replies: 0 }, 0)), played(gameplay({ replies: 1 }, 20))],
    });
    expect(firstPress.qualifies).toBe(true);
    expect(firstPress.achieved).toEqual(["press-reply"]);
  });

  it("qualifies an approved no-player UI choice without an avatar", () => {
    const choice: GameAcceptanceCriterion[] = [
      {
        id: "press-reply",
        kind: "content",
        text: "send the first reply",
        observe: { key: "replies", expect: ">=1" },
      },
    ];
    const firstChoice = run({
      acceptance: choice,
      samples: [
        before(ui({ state: 1, replies: 0 })),
        played(ui({ state: 1, replies: 1 })),
        played(ui({ state: 1, replies: 1 })),
      ],
    });
    expect(firstChoice.qualifies).toBe(true);
    expect(firstChoice.blockers).toEqual([]);
    expect(firstChoice.achieved).toEqual(["press-reply"]);
    expect(firstChoice.interaction).toContain("replies 0→1");
  });

  it("qualifies an approved choice whose actor ends back at the baseline position", () => {
    const choice: GameAcceptanceCriterion[] = [
      {
        id: "press-reply",
        kind: "content",
        text: "send the first reply",
        observe: { key: "replies", expect: ">=1" },
      },
    ];
    const returned = run({
      acceptance: choice,
      samples: [
        before(gameplay({ state: 1, replies: 0 }, 0)),
        played(gameplay({ state: 1, replies: 1 }, 25)),
        played(gameplay({ state: 1, replies: 1 }, 0)),
      ],
    });
    expect(returned.qualifies).toBe(true);
    expect(returned.achieved).toEqual(["press-reply"]);
  });

  it("an approved movement claim still fails when its observation never changes", () => {
    const distance: GameAcceptanceCriterion[] = [
      {
        id: "walk-distance",
        kind: "mechanic",
        text: "walk far enough",
        observe: { key: "distance", expect: ">=10" },
      },
    ];
    const movedButUnmeasured = run({
      acceptance: distance,
      samples: [
        before(gameplay({ state: 1, distance: 0 }, 0)),
        played(gameplay({ state: 1, distance: 0 }, 12)),
        played(gameplay({ state: 1, distance: 0 }, 12)),
      ],
    });
    expect(movedButUnmeasured.qualifies).toBe(false);
    expect(movedButUnmeasured.achieved).toEqual([]);
    expect(movedButUnmeasured.blockers).toContain("no approved criterion achieved");

    const measured = run({
      acceptance: distance,
      samples: [
        before(gameplay({ state: 1, distance: 0 }, 0)),
        played(gameplay({ state: 1, distance: 12 }, 12)),
        played(gameplay({ state: 1, distance: 12 }, 12)),
      ],
    });
    expect(measured.qualifies).toBe(true);
    expect(measured.achieved).toEqual(["walk-distance"]);
  });

  it("a markerless no-player game stays ambiguous and cannot qualify", () => {
    const choice: GameAcceptanceCriterion[] = [
      {
        id: "press-reply",
        kind: "content",
        text: "send the first reply",
        observe: { key: "replies", expect: ">=1" },
      },
    ];
    const markerless = run({
      acceptance: choice,
      samples: [before(ui({ replies: 0 })), played(ui({ replies: 1 }))],
    });
    expect(markerless.qualifies).toBe(false);
    expect(markerless.blockers).toContain(
      "no gameplay baseline: no player input step found the game in play",
    );
  });

  it("an explicit no-player menu is not play even when values move", () => {
    const choice: GameAcceptanceCriterion[] = [
      {
        id: "press-reply",
        kind: "content",
        text: "send the first reply",
        observe: { key: "replies", expect: ">=1" },
      },
    ];
    const stillMenu = run({
      acceptance: choice,
      samples: [before(ui({ state: 0, replies: 0 })), played(ui({ state: 0, replies: 1 }))],
    });
    expect(stillMenu.qualifies).toBe(false);
    expect(stillMenu.blockers).toContain(
      "no gameplay baseline: no player input step found the game in play",
    );
  });

  it("a no-player UI menu click cannot claim the values it created", () => {
    const choice: GameAcceptanceCriterion[] = [
      {
        id: "press-reply",
        kind: "content",
        text: "send the first reply",
        observe: { key: "replies", expect: ">=1" },
      },
    ];
    const started = run({
      acceptance: choice,
      samples: [before(ui({ state: 0, replies: 0 })), played(ui({ state: 1, replies: 1 }))],
    });
    expect(started.qualifies).toBe(false);
    expect(started.achieved).toEqual([]);
    expect(started.blockers).toContain("no approved criterion achieved");
  });

  it("a no-player UI run with no input has no baseline", () => {
    const choice: GameAcceptanceCriterion[] = [
      {
        id: "press-reply",
        kind: "content",
        text: "send the first reply",
        observe: { key: "replies", expect: ">=1" },
      },
    ];
    const waited = run({
      acceptance: choice,
      samples: [before(ui({ state: 1, replies: 0 })), before(ui({ state: 1, replies: 1 }))],
    });
    expect(waited.qualifies).toBe(false);
    expect(waited.blockers).toContain(
      "no gameplay baseline: no player input step found the game in play",
    );
  });

  it("a no-player UI run whose approved value was already true fails", () => {
    const choice: GameAcceptanceCriterion[] = [
      {
        id: "press-reply",
        kind: "content",
        text: "send the first reply",
        observe: { key: "replies", expect: ">=1" },
      },
    ];
    const alreadyTrue = run({
      acceptance: choice,
      samples: [before(ui({ state: 1, replies: 1 })), played(ui({ state: 1, replies: 1 }))],
    });
    expect(alreadyTrue.qualifies).toBe(false);
    expect(alreadyTrue.blockers).toContain("no approved criterion achieved");
  });

  it("a legacy no-player run still needs the player to move", () => {
    const legacy = run({
      acceptance: null,
      samples: [before(ui({ state: 1, replies: 0 })), played(ui({ state: 1, replies: 1 }))],
    });
    expect(legacy.qualifies).toBe(false);
    expect(legacy.blockers).toContain("the player did not move from the gameplay baseline");
  });

  it("a menu click that starts play cannot claim the starting values", () => {
    const total: GameAcceptanceCriterion[] = [
      {
        id: "five-pearls",
        kind: "content",
        text: "five pearls exist",
        observe: { key: "total", expect: "==5" },
      },
    ];
    const started = run({
      acceptance: total,
      samples: [
        // The menu already has a player and a world, but state 0 is the menu.
        before(gameplay({ state: 0, total: 0 }, 0)),
        played(gameplay({ state: 1, total: 5 }, 20)),
        played(gameplay({ state: 1, total: 5 }, 20)),
      ],
    });
    expect(started.qualifies).toBe(false);
    expect(started.achieved).toEqual([]);
    expect(started.blockers).toContain("no approved criterion achieved");
  });

  it("a later action still counts after the menu baseline is established", () => {
    const total: GameAcceptanceCriterion[] = [
      {
        id: "six-pearls",
        kind: "content",
        text: "six pearls exist",
        observe: { key: "total", expect: ">=6" },
      },
    ];
    const later = run({
      acceptance: total,
      samples: [
        before(gameplay({ state: 0, total: 0 }, 0)),
        played(gameplay({ state: 1, total: 5 }, 20)),
        played(gameplay({ state: 1, total: 6 }, 30)),
      ],
    });
    expect(later.qualifies).toBe(true);
    expect(later.achieved).toEqual(["six-pearls"]);
  });

  it("does not fall back to an earlier playing sample when the menu is latest", () => {
    const total: GameAcceptanceCriterion[] = [
      {
        id: "five-pearls",
        kind: "content",
        text: "five pearls exist",
        observe: { key: "total", expect: "==5" },
      },
    ];
    const returnedToMenu = run({
      acceptance: total,
      samples: [
        // The run booted in play, then showed its menu just before the click.
        before(gameplay({ state: 1, total: 0 }, 0)),
        before(gameplay({ state: 0, total: 0 }, 0)),
        played(gameplay({ state: 1, total: 5 }, 10)),
        played(gameplay({ state: 1, total: 5 }, 20)),
      ],
    });
    expect(returnedToMenu.qualifies).toBe(false);
    expect(returnedToMenu.achieved).toEqual([]);
  });

  it("a boolean playing=false marker with a player is still the menu", () => {
    const total: GameAcceptanceCriterion[] = [
      {
        id: "five-pearls",
        kind: "content",
        text: "five pearls exist",
        observe: { key: "total", expect: "==5" },
      },
    ];
    const started = run({
      acceptance: total,
      samples: [
        before(gameplay({ state: false, total: 0 }, 0)),
        played(gameplay({ state: true, total: 5 }, 20)),
        played(gameplay({ state: true, total: 5 }, 20)),
      ],
    });
    expect(started.qualifies).toBe(false);
    expect(started.achieved).toEqual([]);
  });

  it("no input cannot borrow a baseline from autonomous play", () => {
    const reply: GameAcceptanceCriterion[] = [
      {
        id: "press-reply",
        kind: "content",
        text: "send the first reply",
        observe: { key: "replies", expect: ">=1" },
      },
    ];
    const waited = run({
      acceptance: reply,
      // The player exists and the world moves, but no step dispatched input.
      samples: [
        before(gameplay({ state: 1, replies: 0 }, 0)),
        before(gameplay({ state: 1, replies: 1 }, 20)),
      ],
    });
    expect(waited.qualifies).toBe(false);
    expect(waited.blockers).toContain(
      "no gameplay baseline: no player input step found the game in play",
    );
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
      "no gameplay baseline: no player input step found the game in play",
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

  it("picks a no-player UI frame whose typed probe shows the approved progress", () => {
    const state: GamePlaytestState = {
      before: ui({ state: 1, collected: 0 }),
      after: ui({ state: 1, collected: 1 }),
      playerMoved: 0,
      changes: [{ key: "collected", before: 0, after: 1 }],
    };
    const picked = selectPlaytestCoverFrame(
      [
        frame("booted", ui({ state: 1, collected: 0 })),
        frame("choice", ui({ state: 1, collected: 1 })),
        frame("after-steps", ui({ state: 1, collected: 1 })),
      ],
      state,
      acceptance,
    );
    expect(picked?.label).toBe("choice");
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

describe("HUD-state check", () => {
  it("names the GameState values the screen never shows", () => {
    const state = summarizePlaytestSamples([
      played(gameplay({ score: 120, lives: 3, turn: 7, speed: 4.26, mood: "Calm", won: false })),
      played({
        ...gameplay({ score: 120, lives: 3, turn: 12, speed: 4.26, mood: "Calm", won: false }),
        hudText: "SCORE 120\nLives: 3\nTurn 1\nMOOD: calm\n4.3 m/s",
      }),
    ]);
    // turn 12 is not "Turn 1"; a flag is never something a HUD has to print.
    expect(state.notOnScreen).toEqual(["turn"]);
  });

  it("says nothing when the probe reports no screen text", () => {
    expect(summarizePlaytestSamples([played(gameplay({ score: 1 }))]).notOnScreen).toBeUndefined();
  });
});
