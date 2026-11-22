import { describe, expect, it } from "vite-plus/test";
import { GameBuildId, ThreadId, type GameBuild, type GameStepVerdict } from "@kurambit/contracts";

import {
  AUTOPILOT_TURN,
  FINISHED_DONE,
  GUIDED_HELD,
  GUIDED_PROPOSED,
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
  reelSteps,
  stepVerdictText,
} from "./keepGoing.logic";

const clock = (at: string) => at.slice(11, 16);
const control = (
  status: Parameters<typeof keepGoingControlView>[0]["status"],
  overrides: Partial<Parameters<typeof keepGoingControlView>[0]> = {},
) =>
  keepGoingControlView(
    {
      status,
      error: null,
      threadId: MAIN_CHAT,
      canOperate: true,
      sending: false,
      chosenBudget: undefined,
      ...overrides,
    },
    clock,
  );

describe("the keep-going control", () => {
  it("is off with a one-hour budget on a game that never ran it", () => {
    const view = control(NEVER_RAN);
    expect(view).toMatchObject({
      pressed: false,
      value: "off",
      disabled: null,
      modesDisabled: null,
      budget: 60,
      budgetDisabled: false,
      budgetLabel: "Budget",
    });
  });

  it("names the live mode, is pressed, and holds the budget at its end time", () => {
    expect(control(AUTOPILOT_TURN)).toMatchObject({
      pressed: true,
      value: "autopilot",
      budgetDisabled: true,
      budgetLabel: "Until 15:10",
    });
    expect(control({ ...AUTOPILOT_TURN, budgetMinutes: null, endsAt: null }).budgetLabel).toBe(
      "No limit",
    );
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
    const blocked = { ...AUTOPILOT_TURN, blocked: "Keep going is on in Main chat" };
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
    expect(keepGoingRequest(PAUSED_STALLED, MAIN_CHAT, "guided", undefined)).toEqual({
      mode: "guided",
    });
    expect(keepGoingRequest(PAUSED_STALLED, MAIN_CHAT, "autopilot", 120)).toEqual({
      mode: "autopilot",
      budgetMinutes: 120,
    });
  });

  it("sends nothing for the mode it already has, or Off with nothing live", () => {
    expect(keepGoingRequest(AUTOPILOT_TURN, MAIN_CHAT, "autopilot", 30)).toBeNull();
    expect(keepGoingRequest(NEVER_RAN, MAIN_CHAT, "off", undefined)).toBeNull();
    expect(keepGoingRequest(AUTOPILOT_TURN, MAIN_CHAT, "guided", undefined)).toEqual({
      mode: "guided",
    });
  });
});

describe("the keep-going banner", () => {
  it("shows the proposal with its start time, and waits while held", () => {
    expect(keepGoingBannerView(GUIDED_PROPOSED, MAIN_CHAT, clock)).toMatchObject({
      kind: "proposal",
      lead: "Step 3:",
      line: "Try the undone step another way, or a smaller one",
      detail: "at 14:32",
      why: "after an undo",
      held: false,
    });
    expect(keepGoingBannerView(GUIDED_HELD, MAIN_CHAT, clock)).toMatchObject({
      detail: "waits for you",
      held: true,
    });
  });

  it("says what the live run is doing, phase by phase", () => {
    const title = (status: typeof AUTOPILOT_TURN) => {
      const view = keepGoingBannerView(status, MAIN_CHAT, clock);
      return view?.kind === "live" ? view.title : null;
    };
    expect(title(AUTOPILOT_TURN)).toBe("Keep going · step 3 · your agent is working on it");
    expect(keepGoingBannerView(AUTOPILOT_TURN, MAIN_CHAT, clock)).toMatchObject({
      line: "Keep going · step 3",
    });
    expect(title({ ...AUTOPILOT_TURN, phase: "waiting" })).toBe(
      "Keep going · waits for this turn to end · until 15:10",
    );
    expect(title({ ...AUTOPILOT_TURN, phase: "looking", step: null })).toBe(
      "Keep going · reading the current build's checks",
    );
    expect(title({ ...AUTOPILOT_TURN, phase: "measuring" })).toBe(
      "Keep going · step 3 · measuring the build before keeping it",
    );
    expect(title({ ...AUTOPILOT_TURN, phase: "undoing", step: 2 })).toBe(
      "Undoing step 2: Random input now crashes at 12 s",
    );
  });

  it("reads a pause with Resume in its last mode, and the end without one", () => {
    expect(keepGoingBannerView(PAUSED_STALLED, MAIN_CHAT, clock)).toMatchObject({
      kind: "paused",
      title: PAUSED_STALLED.message,
      resume: "guided",
    });
    expect(
      keepGoingBannerView({ ...PAUSED_STALLED, profile: "autopilot" }, MAIN_CHAT, clock),
    ).toMatchObject({ resume: "autopilot" });
    expect(keepGoingBannerView(FINISHED_DONE, MAIN_CHAT, clock)).toMatchObject({
      kind: "ended",
      title: FINISHED_DONE.message,
    });
  });

  it("shows only in the run's own chat, and never for a game that never ran it", () => {
    expect(keepGoingBannerView(AUTOPILOT_TURN, OTHER_CHAT, clock)).toBeNull();
    expect(keepGoingBannerView(NEVER_RAN, MAIN_CHAT, clock)).toBeNull();
  });

  it("says nothing once the person turned it off", () => {
    expect(
      keepGoingBannerView({ ...PAUSED_STALLED, ending: "stopped" }, MAIN_CHAT, clock),
    ).toBeNull();
  });

  it("hides the Next banner on Autopilot and while a proposal is pending", () => {
    expect(keepGoingHidesNext(AUTOPILOT_TURN, MAIN_CHAT)).toBe(true);
    expect(keepGoingHidesNext(GUIDED_PROPOSED, MAIN_CHAT)).toBe(true);
    expect(keepGoingHidesNext({ ...GUIDED_PROPOSED, proposal: null }, MAIN_CHAT)).toBe(false);
    expect(keepGoingHidesNext(PAUSED_STALLED, MAIN_CHAT)).toBe(false);
    expect(keepGoingHidesNext(AUTOPILOT_TURN, OTHER_CHAT)).toBe(false);
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
