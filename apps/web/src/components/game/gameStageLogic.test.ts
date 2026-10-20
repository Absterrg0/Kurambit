import { expect, it } from "vite-plus/test";

import {
  buildFailurePrompt,
  deriveGameStagePhase,
  gamePreviewFrameKey,
  type GameStageInput,
} from "./gameStageLogic";

const BASE: GameStageInput = {
  toolchainReady: true,
  operation: null,
  hasWebBuild: false,
  webBuildStale: true,
  previewUrl: null,
  busyStartedAt: null,
  localError: null,
};

const STARTED_AT = "2026-10-20T04:00:00.000Z";

const running = (): GameStageInput["operation"] => ({
  name: "preview",
  state: "running",
  message: "Building the web preview is running.",
  at: STARTED_AT,
});
const failed = (message: string): GameStageInput["operation"] => ({
  name: "preview",
  state: "failed",
  message,
  at: STARTED_AT,
});
const PLAYING: GameStageInput = {
  ...BASE,
  hasWebBuild: true,
  webBuildStale: false,
  previewUrl: "http://127.0.0.1:1/",
};

it("offers one path per state: tools, never built, ready, playing", () => {
  expect(deriveGameStagePhase({ ...BASE, toolchainReady: false })).toEqual({
    kind: "tools-missing",
  });
  expect(deriveGameStagePhase(BASE)).toEqual({ kind: "never-built" });
  expect(deriveGameStagePhase({ ...BASE, hasWebBuild: true, webBuildStale: false })).toEqual({
    kind: "ready",
    stale: false,
  });
  expect(deriveGameStagePhase(PLAYING)).toEqual({ kind: "playing", stale: false });
  expect(deriveGameStagePhase({ ...PLAYING, webBuildStale: true })).toEqual({
    kind: "playing",
    stale: true,
  });
});

it("keeps a loaded game running while a later failure is reported on the side", () => {
  // A failed rebuild of a game that is still playable must not tear down the
  // iframe: the status strip shows the error and the stale chip stays.
  expect(
    deriveGameStagePhase({ ...PLAYING, webBuildStale: true, operation: failed("Parse") }),
  ).toEqual({ kind: "playing", stale: true });
  // With nothing loaded, the failure is the state the user needs to act on.
  expect(deriveGameStagePhase({ ...BASE, operation: failed("Export failed") })).toEqual({
    kind: "failed",
    message: "Export failed",
  });
  // A fresh build that was never served still surfaces the failure with retry.
  expect(
    deriveGameStagePhase({
      ...BASE,
      hasWebBuild: true,
      webBuildStale: false,
      operation: failed("Browser failed to start"),
    }),
  ).toEqual({ kind: "failed", message: "Browser failed to start" });
  // A client-side failure is reported the same way while nothing is playable.
  expect(deriveGameStagePhase({ ...BASE, localError: "busy" })).toEqual({
    kind: "failed",
    message: "busy",
  });
});

it("keeps a loaded game on screen while a rebuild runs", () => {
  // The iframe must survive the rebuild: the new build reloads it when it lands.
  expect(deriveGameStagePhase({ ...PLAYING, operation: running(), busyStartedAt: 1_000 })).toEqual({
    kind: "playing",
    stale: false,
  });
});

it("shows a build in flight with the second it started, local or from the server", () => {
  expect(deriveGameStagePhase({ ...BASE, busyStartedAt: 1_000 })).toEqual({
    kind: "building",
    message: "Starting…",
    startedAt: 1_000,
  });
  expect(deriveGameStagePhase({ ...BASE, operation: running(), busyStartedAt: 1_000 })).toEqual({
    kind: "building",
    message: "Building the web preview is running.",
    startedAt: 1_000,
  });
  // An agent-started build shows elapsed time from the operation's own start.
  expect(deriveGameStagePhase({ ...BASE, operation: running() })).toEqual({
    kind: "building",
    message: "Building the web preview is running.",
    startedAt: Date.parse(STARTED_AT),
  });
});

it("blocks on tools only when no fresh build can be served without them", () => {
  // A stale build with no tools needs the setup screen, not a Play that fails.
  expect(deriveGameStagePhase({ ...BASE, toolchainReady: false, hasWebBuild: true })).toEqual({
    kind: "tools-missing",
  });
  // A fresh build is served from disk without launching Godot at all.
  expect(
    deriveGameStagePhase({
      ...BASE,
      toolchainReady: false,
      hasWebBuild: true,
      webBuildStale: false,
    }),
  ).toEqual({ kind: "ready", stale: false });
  expect(deriveGameStagePhase({ ...PLAYING, toolchainReady: false })).toEqual({
    kind: "playing",
    stale: false,
  });
});

it("carries the error into the message it asks the agent to fix", () => {
  expect(buildFailurePrompt("  ERROR: Parse Error at main.gd  ")).toContain(
    "ERROR: Parse Error at main.gd",
  );
  expect(buildFailurePrompt("boom")).toContain("Fix the error and rebuild the game.");
});

it("keeps the preview identity across tabs and changes it for a new build or a stop", () => {
  const playing = {
    previewUrl: "http://127.0.0.1:9/index.html",
    buildId: "source:first",
    buildUpdatedAt: "2026-10-20T04:00:00.000Z",
  };
  const key = gamePreviewFrameKey(playing);
  // A tab switch re-renders the stage with the same data: no reload.
  expect(gamePreviewFrameKey({ ...playing })).toBe(key);
  // A new export (even with the same mtime second) is a new identity.
  expect(gamePreviewFrameKey({ ...playing, buildId: "source:second" })).not.toBe(key);
  // Stop clears the preview; Play again starts a fresh session.
  expect(gamePreviewFrameKey({ ...playing, previewUrl: null })).not.toBe(key);
  // Builds without a qualification record still reset on the artifact time.
  expect(
    gamePreviewFrameKey({ ...playing, buildId: null, buildUpdatedAt: "2026-10-20T05:00:00.000Z" }),
  ).not.toBe(gamePreviewFrameKey({ ...playing, buildId: null }));
});
