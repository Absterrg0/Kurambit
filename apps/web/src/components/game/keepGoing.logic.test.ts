import { describe, expect, it } from "vite-plus/test";
import { GameBuildId, ThreadId, type GameBuild, type GameStepVerdict } from "@kurambit/contracts";

import {
  FINISHED_DONE,
  LIVE_TURN,
  MAIN_CHAT,
  NEVER_RAN,
  NO_TURN_LOOP,
  OTHER_CHAT,
  PAUSED_STALLED,
} from "./keepGoing.fixtures";
import {
  keepGoingBannerView,
  keepGoingControlView,
  keepGoingHidesNext,
  keepGoingRequest,
  reelHeading,
  runPick,
  reelSteps,
  stepVerdictText,
} from "./keepGoing.logic";

const control = (
  status: Parameters<typeof keepGoingControlView>[0]["status"],
  overrides: Partial<Parameters<typeof keepGoingControlView>[0]> = {},
) =>
  keepGoingControlView({
    status,
    error: null,
    threadId: MAIN_CHAT,
    canOperate: true,
    sending: false,
    chosenBudget: undefined,
    ...overrides,
  });

describe("the keep-going control", () => {
  it("is off with a one-hour budget on a game that never ran it", () => {
    const view = control(NEVER_RAN);
    expect(view).toMatchObject({
      pressed: false,
      disabled: null,
      modesDisabled: null,
      budget: 60,
      budgetDisabled: false,
      budgetLabel: "Keep going's budget",
    });
  });

  it("is pressed while on here, and holds the budget at what is left of it", () => {
    expect(control(LIVE_TURN)).toMatchObject({
      pressed: true,
      budgetDisabled: true,
      budgetLabel: "40 min left",
    });
    expect(control({ ...LIVE_TURN, budgetLeftMinutes: 120 }).budgetLabel).toBe("2 hours left");
    expect(
      control({ ...LIVE_TURN, budgetMinutes: null, budgetLeftMinutes: null }).budgetLabel,
    ).toBe("No limit");
  });

  it("is disabled with its reason on an engine without a turn loop, and without permission", () => {
    expect(control(NO_TURN_LOOP).disabled).toBe(NO_TURN_LOOP.blocked);
    expect(control(NEVER_RAN, { canOperate: false }).disabled).not.toBeNull();
    expect(control(NEVER_RAN, { sending: true }).disabled).not.toBeNull();
    expect(control(null, { error: "Keep going is not built" }).disabled).toBe(
      "Keep going is not built",
    );
  });

  it("leaves Off enabled in another chat while the run is live there", () => {
    const blocked = { ...LIVE_TURN, blocked: "Keep going is on in Main chat" };
    const view = control(blocked, { threadId: OTHER_CHAT });
    expect(view).toMatchObject({
      pressed: false,
      disabled: null,
      modesDisabled: "Keep going is on in Main chat",
    });
    expect(keepGoingRequest(blocked, OTHER_CHAT, "off", undefined)).toEqual({ mode: "off" });
  });

  it("keeps the run's own budget on a resume unless the person picked one", () => {
    expect(control(PAUSED_STALLED).budget).toBe(60);
    expect(control(PAUSED_STALLED, { chosenBudget: null }).budget).toBeNull();
    expect(keepGoingRequest(PAUSED_STALLED, MAIN_CHAT, "on", undefined)).toEqual({ mode: "on" });
    expect(keepGoingRequest(PAUSED_STALLED, MAIN_CHAT, "on", 120)).toEqual({
      mode: "on",
      budgetMinutes: 120,
    });
  });

  it("sends nothing to turn it on while on here, or Off with nothing live", () => {
    expect(keepGoingRequest(LIVE_TURN, MAIN_CHAT, "on", 30)).toBeNull();
    expect(keepGoingRequest(NEVER_RAN, MAIN_CHAT, "off", undefined)).toBeNull();
  });
});

describe("the run picker", () => {
  // After a restart the store holds no pick: the picker must read what the banner reads.
  it("follows the run on in this chat unless the person picked", () => {
    expect(runPick(undefined, LIVE_TURN, MAIN_CHAT)).toBe("keep-going");
    expect(runPick(undefined, LIVE_TURN, OTHER_CHAT)).toBe("once");
    expect(runPick(undefined, PAUSED_STALLED, MAIN_CHAT)).toBe("once");
    expect(runPick("once", LIVE_TURN, MAIN_CHAT)).toBe("once");
    expect(runPick("keep-going", NEVER_RAN, MAIN_CHAT)).toBe("keep-going");
  });
});

describe("the keep-going banner", () => {
  it("says what the live run is doing, phase by phase", () => {
    const title = (status: typeof LIVE_TURN) => {
      const view = keepGoingBannerView(status, MAIN_CHAT);
      return view?.kind === "live" ? view.title : null;
    };
    expect(title(LIVE_TURN)).toBe("Keep going · step 3 · your agent is working on it");
    expect(keepGoingBannerView(LIVE_TURN, MAIN_CHAT)).toMatchObject({
      line: "Keep going · step 3",
    });
    expect(title({ ...LIVE_TURN, phase: "waiting" })).toBe(
      "Keep going · waits for this turn to end · 40 min left",
    );
    expect(title({ ...LIVE_TURN, phase: "looking", step: null })).toBe(
      "Keep going · reading the current build's checks",
    );
    expect(title({ ...LIVE_TURN, phase: "measuring" })).toBe(
      "Keep going · step 3 · measuring the build before keeping it",
    );
    expect(title({ ...LIVE_TURN, phase: "undoing", step: 2 })).toBe(
      "Undoing step 2: Random input now crashes at 12 s",
    );
  });

  it("reads a pause with Resume and the end without one, until the person sends a turn", () => {
    expect(keepGoingBannerView(PAUSED_STALLED, MAIN_CHAT)).toMatchObject({
      kind: "paused",
      title: PAUSED_STALLED.message,
    });
    expect(keepGoingBannerView(FINISHED_DONE, MAIN_CHAT)).toMatchObject({
      kind: "ended",
      title: FINISHED_DONE.message,
    });
    // The step turns before the pause leave it; the person's next message retires it.
    expect(
      keepGoingBannerView(PAUSED_STALLED, MAIN_CHAT, "2026-11-06T14:35:00.000Z"),
    ).toMatchObject({ kind: "paused" });
    expect(keepGoingBannerView(PAUSED_STALLED, MAIN_CHAT, "2026-11-06T18:00:00.000Z")).toBeNull();
  });

  it("shows only in the run's own chat, and never for a game that never ran it", () => {
    expect(keepGoingBannerView(LIVE_TURN, OTHER_CHAT)).toBeNull();
    expect(keepGoingBannerView(NEVER_RAN, MAIN_CHAT)).toBeNull();
  });

  it("says what the run did once the person stopped it", () => {
    const message = "Keep going stopped. 2 steps, 2 kept, 11 of 30 min.";
    expect(
      keepGoingBannerView({ ...PAUSED_STALLED, ending: "stopped", message }, MAIN_CHAT),
    ).toMatchObject({ kind: "paused", title: message });
  });

  it("hides the Next banner while on here", () => {
    expect(keepGoingHidesNext(LIVE_TURN, MAIN_CHAT)).toBe(true);
    expect(keepGoingHidesNext(PAUSED_STALLED, MAIN_CHAT)).toBe(false);
    expect(keepGoingHidesNext(LIVE_TURN, OTHER_CHAT)).toBe(false);
  });
});

describe("a step's verdict", () => {
  const line = (verdict: Parameters<typeof stepVerdictText>[0]["verdict"], reason = "") =>
    stepVerdictText({ n: 3, verdict, reason, move: "" });
  it("words every verdict", () => {
    expect(line(null)).toBe("measuring before keeping it");
    expect(line("kept", "no fact got worse")).toBe("kept: no fact got worse");
    expect(line("undone", "Random input now crashes at 12 s")).toBe(
      "undone: Random input now crashes at 12 s",
    );
    // Only the server's moved-on refusal blames a later change; a failed undo says what failed.
    expect(line("kept-moved-on", "the game changed after it (Masher: crashed at 12 s)")).toBe(
      "not undone: the game changed after it (Masher: crashed at 12 s)",
    );
    expect(line("kept-moved-on", "the restore failed: git is busy (Masher: crashed at 12 s)")).toBe(
      "not undone: the restore failed: git is busy (Masher: crashed at 12 s)",
    );
    expect(line("not-measured", "the facts took over 10 min")).toBe(
      "kept: not measured (the facts took over 10 min)",
    );
    expect(line("no-change")).toBe("changed no game files");
    expect(line("stopped")).toBe("stopped by you");
  });
});

const reelBuild = (
  id: string,
  base: string | null,
  step: { readonly n: number; readonly verdict: GameStepVerdict } | null,
): GameBuild => ({
  id: GameBuildId.make(id.repeat(40)),
  at: "2026-11-22T03:00:00.000Z",
  source: {
    _tag: "turn",
    threadId: ThreadId.make("thread-main"),
    threadTitle: "Main chat",
    turn: 1,
    runId: `run-${id}`,
    request: "",
    step: step === null ? null : { ...step, reason: "", move: "" },
  },
  number: 1,
  name: `Build ${id}`,
  undone: false,
  summary: "",
  files: [],
  fileCount: 0,
  available: true,
  noPlay: null,
  noRestore: null,
  still: null,
  base: base === null ? null : GameBuildId.make(base.repeat(40)),
  facts: { state: "measured", chips: [], notMeasured: 0, good: 0, bad: 0 },
});

describe("reelSteps", () => {
  // Oldest first: an earlier run's step, the person's turn, then this run's steps 4 to 6,
  // where step 6 was made from build b because step 5 was undone.
  const marks = [
    reelBuild("1", null, { n: 3, verdict: "kept" }),
    reelBuild("a", "1", null),
    reelBuild("b", "a", { n: 4, verdict: "kept" }),
    reelBuild("c", "b", { n: 5, verdict: "undone" }),
    reelBuild("d", "b", { n: 6, verdict: "kept" }),
  ];

  it("lists the whole run from its first step, each beside the build it was made from", () => {
    expect(
      reelSteps(marks, 4).map(({ build, before }) => [build.name, before?.name ?? null]),
    ).toEqual([
      ["Build b", "Build a"],
      ["Build c", "Build b"],
      ["Build d", "Build b"],
    ]);
    expect(reelHeading(marks, 4)).toBe("Steps 4–6 · 2 kept · 1 undone");
  });

  it("shows the newest steps when no run scopes it", () => {
    expect(reelSteps(marks, null).map(({ build }) => build.name)).toEqual([
      "Build 1",
      "Build b",
      "Build c",
      "Build d",
    ]);
  });
});
