import { describe, expect, it } from "vite-plus/test";
import {
  GAME_ART_EVENT,
  GAME_BUILDS_EVENT,
  GAME_FACTS_EVENT,
  GAME_SAVED_MEDIA_EVENT,
  type GameOperationEvent,
} from "@kurambit/contracts";
import { gameEventScope } from "./gameEventScope";

const event = (name: string): GameOperationEvent => ({
  root: "/g",
  name,
  state: "running",
  message: "",
  at: "2026-11-06T00:00:00.000Z",
});

// Each query rereads only on its own pushes: a run step must not reread the
// stage's status, nor an export the run.
describe("gameEventScope", () => {
  it("keeps run, saved-media, builds, facts, art and operation pushes apart", () => {
    expect(gameEventScope(event("run"))).toBe("run");
    expect(gameEventScope(event(GAME_SAVED_MEDIA_EVENT))).toBe("saved");
    expect(gameEventScope(event(GAME_BUILDS_EVENT))).toBe("builds");
    expect(gameEventScope(event(GAME_FACTS_EVENT))).toBe("facts");
    expect(gameEventScope(event(GAME_ART_EVENT))).toBe("art");
    expect(gameEventScope(event("Export Web"))).toBe("operation");
    expect(gameEventScope(event("Run capture"))).toBe("operation");
  });
});
