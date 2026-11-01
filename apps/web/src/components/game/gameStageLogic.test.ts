import { expect, it } from "vite-plus/test";

import {
  buildFailurePrompt,
  countGamePreviewRemounts,
  deriveGameStagePhase,
  gamePreviewFrameKey,
  type GamePreviewServe,
  type GameStageInput,
  nextGamePreviewFrame,
  gameSourceFreshnessLabel,
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

it("remounts the game only for a real reset, never for status churn", () => {
  const URL = "http://127.0.0.1:9/index.html";
  const playing: GamePreviewServe = { previewUrl: URL, servedArtifactId: "artifact:one" };
  // First sight of a serve mounts the game.
  expect(countGamePreviewRemounts([playing])).toBe(1);
  // The same serve read again (another status push, a tab switch) never remounts.
  expect(countGamePreviewRemounts([playing, playing, { ...playing }])).toBe(1);
  // A new preview session is a reset the user chose: Stop, then Play again.
  expect(
    countGamePreviewRemounts([
      playing,
      { previewUrl: null, servedArtifactId: playing.servedArtifactId },
    ]),
  ).toBe(2);
  // A replaced web artifact is the intended reset of a successful rebuild.
  expect(
    countGamePreviewRemounts([playing, { ...playing, servedArtifactId: "artifact:two" }]),
  ).toBe(2);
  // A source edit or a failed rebuild cannot replace the artifact, and a null
  // identity means the read cannot vouch for the bytes: neither remounts, so
  // the honest state is "what is on disk is uncertain", not a reset on screen.
  expect(countGamePreviewRemounts([playing, { ...playing, servedArtifactId: null }])).toBe(1);
});

it("folds frame keys across reads so unrelated churn cannot change the iframe", () => {
  const URL = "http://127.0.0.1:9/index.html";
  const first = nextGamePreviewFrame(null, { previewUrl: URL, servedArtifactId: "a" });
  // The fold pins the read it accepted: later null identities and repeats are
  // absorbed, and the key only moves for a new session or a replaced artifact.
  const absorbed = nextGamePreviewFrame(first, { previewUrl: URL, servedArtifactId: null });
  expect(absorbed.key).toBe(first.key);
  expect(absorbed.serve.servedArtifactId).toBe("a");
  const replaced = nextGamePreviewFrame(first, { previewUrl: URL, servedArtifactId: "b" });
  expect(replaced.key).not.toBe(first.key);
  const restarted = nextGamePreviewFrame(first, { previewUrl: null, servedArtifactId: null });
  expect(restarted.key).not.toBe(first.key);
  // An explicit key read still exists for content that shows one serve at a
  // time, and it carries both halves of the identity.
  expect(gamePreviewFrameKey({ previewUrl: URL, servedArtifactId: "b" })).toBe(`${URL}#b`);
  expect(gamePreviewFrameKey({ previewUrl: null, servedArtifactId: null })).toBe("#");
});

it("describes unknown source freshness and preserves selected Play", () => {
  expect(gameSourceFreshnessLabel("unknown")).toContain("Check");
  expect(gameSourceFreshnessLabel(true)).toContain("Play keeps that build");
  expect(gameSourceFreshnessLabel(false)).toContain("last check");
});
