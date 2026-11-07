import { describe, expect, it } from "vite-plus/test";

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
  stepLine,
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
      label: "Keep going",
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
      label: "Autopilot",
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
      label: "Keep going",
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
    expect(control(PAUSED_STALLED).tooltip).toBe(PAUSED_STALLED.message);
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
      lead: "Step 3 · after an undo:",
      line: "Try the undone step another way, or a smaller one",
      detail: "Starts at 14:32",
      held: false,
    });
    expect(keepGoingBannerView(GUIDED_HELD, MAIN_CHAT, clock)).toMatchObject({
      detail: "Waits for you",
      held: true,
    });
  });

  it("says what the live run is doing, phase by phase", () => {
    const title = (status: typeof AUTOPILOT_TURN) => {
      const view = keepGoingBannerView(status, MAIN_CHAT, clock);
      return view?.kind === "live" ? view.title : null;
    };
    expect(title(AUTOPILOT_TURN)).toBe("Keep going · step 3 · your agent is working on it");
    expect(title({ ...AUTOPILOT_TURN, phase: "waiting" })).toBe(
      "Keep going · waits for this turn to end · until 15:10",
    );
    expect(title({ ...AUTOPILOT_TURN, phase: "looking", step: null })).toBe(
      "Keep going · reading the current build's facts",
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

  it("hides the Next banner on Autopilot and while a proposal is pending", () => {
    expect(keepGoingHidesNext(AUTOPILOT_TURN, MAIN_CHAT)).toBe(true);
    expect(keepGoingHidesNext(GUIDED_PROPOSED, MAIN_CHAT)).toBe(true);
    expect(keepGoingHidesNext({ ...GUIDED_PROPOSED, proposal: null }, MAIN_CHAT)).toBe(false);
    expect(keepGoingHidesNext(PAUSED_STALLED, MAIN_CHAT)).toBe(false);
    expect(keepGoingHidesNext(AUTOPILOT_TURN, OTHER_CHAT)).toBe(false);
  });
});

describe("a step's strip line", () => {
  const line = (verdict: Parameters<typeof stepLine>[0]["verdict"], reason = "") =>
    stepLine({ n: 3, verdict, reason });
  it("words every verdict", () => {
    expect(line(null)).toBe("Step 3 · measuring before keeping it");
    expect(line("kept", "no fact got worse")).toBe("Step 3 · kept: no fact got worse");
    expect(line("undone", "Random input now crashes at 12 s")).toBe(
      "Step 3 · undone: Random input now crashes at 12 s",
    );
    // Only the server's moved-on refusal blames a later change; a failed undo says what failed.
    expect(line("kept-moved-on", "the game changed after it (Masher: crashed at 12 s)")).toBe(
      "Step 3 · not undone: the game changed after it (Masher: crashed at 12 s)",
    );
    expect(line("kept-moved-on", "the restore failed: git is busy (Masher: crashed at 12 s)")).toBe(
      "Step 3 · not undone: the restore failed: git is busy (Masher: crashed at 12 s)",
    );
    expect(line("not-measured", "the facts took over 10 min")).toBe(
      "Step 3 · kept: not measured (the facts took over 10 min)",
    );
    expect(line("no-change")).toBe("Step 3 · changed no game files");
    expect(line("stopped")).toBe("Step 3 · stopped by you");
  });
});
