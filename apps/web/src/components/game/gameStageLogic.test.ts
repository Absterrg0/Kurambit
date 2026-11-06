import { expect, it } from "vite-plus/test";

import {
  buildFailurePrompt,
  deriveGameStagePhase,
  type GamePreviewServe,
  type GameStageInput,
  nextGamePreviewFrame,
  LIVE_TURN_WINDOW_MS,
  liveServe,
  liveToShow,
  playHeldFrame,
  reloadFrame,
  remountOrHold,
  gameSourceFreshnessLabel,
  toolchainReadyFor,
} from "./gameStageLogic";

const IN_GAME = { focused: true, hidden: false };
const WATCHING = { focused: false, hidden: false };
const HIDDEN = { focused: false, hidden: true };

const BASE: GameStageInput = {
  stage: "export",
  toolchainReady: true,
  operation: null,
  hasWebBuild: false,
  webBuildStale: true,
  previewUrl: null,
  busyStartedAt: null,
  localError: null,
  turnLoop: true,
  turnRunning: false,
  turnStartedAt: null,
  turnBuildPending: false,
};

const STARTED_AT = "2026-10-20T04:00:00.000Z";

const running = (): GameStageInput["operation"] => ({
  name: "preview",
  state: "running",
  message: "Building the web preview is running.",
  at: STARTED_AT,
  revision: 1,
});
const failed = (message: string): GameStageInput["operation"] => ({
  name: "preview",
  state: "failed",
  message,
  revision: 2,
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
    what: "build",
  });
  // A fresh build that was never served still surfaces the failure with retry.
  expect(
    deriveGameStagePhase({
      ...BASE,
      hasWebBuild: true,
      webBuildStale: false,
      operation: failed("Browser failed to start"),
    }),
  ).toEqual({ kind: "failed", message: "Browser failed to start", what: "build" });
  // A client-side failure is reported the same way while nothing is playable.
  expect(deriveGameStagePhase({ ...BASE, localError: "busy" })).toEqual({
    kind: "failed",
    message: "busy",
    what: "build",
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
});

it("shows the first build in the making while turn 1 runs, and only then", () => {
  const turn = { ...BASE, turnRunning: true, turnStartedAt: 1_000 };
  // The agent's own operations and failed tries inside the turn are its work in progress.
  expect(deriveGameStagePhase({ ...turn, operation: running() })).toEqual({
    kind: "first-build",
    startedAt: 1_000,
  });
  expect(deriveGameStagePhase({ ...turn, operation: failed("Parse") })).toEqual({
    kind: "first-build",
    startedAt: 1_000,
  });
  // A game with a build, an engine to install, or the person's own action is not waiting on turn 1.
  expect(deriveGameStagePhase({ ...PLAYING, turnRunning: true }).kind).toBe("playing");
  expect(deriveGameStagePhase({ ...turn, hasWebBuild: true }).kind).toBe("ready");
  expect(deriveGameStagePhase({ ...turn, toolchainReady: false }).kind).toBe("tools-missing");
  expect(deriveGameStagePhase({ ...turn, busyStartedAt: 2_000 }).kind).toBe("building");
  expect(deriveGameStagePhase({ ...turn, localError: "busy" }).kind).toBe("failed");
  // When the turn ends, its build's own operation takes over until it plays.
  expect(deriveGameStagePhase({ ...BASE, operation: running() }).kind).toBe("building");
});

it("keeps the first build in the making until the turn's build plays, with nothing to race it", () => {
  const ended = { ...BASE, turnBuildPending: true, turnStartedAt: 1_000 };
  // Between the turn's end and its play, there is no Build & play, and an
  // earlier failure inside the turn is not the game's state.
  expect(deriveGameStagePhase(ended)).toEqual({ kind: "first-build", startedAt: 1_000 });
  expect(deriveGameStagePhase({ ...ended, operation: failed("Parse") }).kind).toBe("first-build");
  // Its play started: the build's own progress, then the game.
  expect(deriveGameStagePhase({ ...ended, operation: running() }).kind).toBe("building");
  expect(deriveGameStagePhase({ ...ended, ...PLAYING, turnBuildPending: true }).kind).toBe(
    "playing",
  );
  // A turn that changed nothing has no build coming.
  expect(deriveGameStagePhase(BASE).kind).toBe("never-built");
});

it("shows the first build in the making only on an engine that plays every turn", () => {
  const parked = { ...BASE, turnLoop: false, turnStartedAt: 1_000 };
  expect(deriveGameStagePhase({ ...parked, turnRunning: true }).kind).toBe("never-built");
  expect(deriveGameStagePhase({ ...parked, turnBuildPending: true }).kind).toBe("never-built");
});

// A remount restarts the game: under a player's hands it loses their progress.
it("never reloads a new build under a player whose game has focus", () => {
  const URL = "http://127.0.0.1:9/index.html";
  const serve = (id: string | null, previewUrl: string | null = URL): GamePreviewServe => ({
    previewUrl,
    servedArtifactId: id,
  });
  const first = remountOrHold(null, serve("a"), IN_GAME);
  expect(first.held).toBeNull();
  // Nothing new: the same object, so the render does not set state.
  expect(remountOrHold(first, serve("a"), IN_GAME)).toBe(first);
  expect(remountOrHold(first, serve(null), IN_GAME)).toBe(first);

  // Not in the game: the new build plays at once.
  const played = remountOrHold(first, serve("b"), WATCHING);
  expect(played.key).not.toBe(first.key);
  expect(played.held).toBeNull();

  // In the game: the frame stays and the build waits, even after focus leaves.
  const held = remountOrHold(first, serve("b"), IN_GAME);
  expect(held.key).toBe(first.key);
  expect(held.held?.servedArtifactId).toBe("b");
  expect(remountOrHold(held, serve("b"), WATCHING)).toBe(held);
  expect(remountOrHold(held, serve(null), WATCHING)).toBe(held);
  // Play is the one remount the person asks for.
  const asked = playHeldFrame(held);
  expect(asked.key).toBe(played.key);
  expect(asked.held).toBeNull();
  expect(playHeldFrame(first)).toBe(first);

  // A newer build decides again; the build on screen served again leaves nothing waiting.
  expect(remountOrHold(held, serve("c"), IN_GAME).held?.servedArtifactId).toBe("c");
  expect(remountOrHold(held, serve("c"), WATCHING)).toMatchObject({ held: null });
  expect(remountOrHold(held, serve("a"), IN_GAME)).toEqual({ ...first, held: null });

  // A new or stopped preview session has no old frame to keep.
  expect(
    remountOrHold(held, serve("b", "http://127.0.0.1:10/index.html"), IN_GAME).held,
  ).toBeNull();
  expect(remountOrHold(first, serve(null, null), IN_GAME).key).not.toBe(first.key);
});

it("plays a live game whenever it is served, and never waits on a build", () => {
  const live = { ...BASE, stage: "live" as const, webBuildStale: false };
  expect(deriveGameStagePhase({ ...live, previewUrl: "http://127.0.0.1:1/" })).toEqual({
    kind: "playing",
    stale: false,
  });
  // An agent's operation or failure is not the live game's state, nor is turn 1.
  expect(
    deriveGameStagePhase({ ...live, operation: running(), turnRunning: true, turnLoop: true }),
  ).toEqual({ kind: "stopped" });
  expect(deriveGameStagePhase({ ...live, operation: failed("Export") }).kind).toBe("stopped");
  // Only the person's own Play shows, and its failure.
  expect(deriveGameStagePhase({ ...live, busyStartedAt: 1_000 }).kind).toBe("building");
  expect(deriveGameStagePhase({ ...live, localError: "no port" })).toEqual({
    kind: "failed",
    message: "no port",
    what: "open",
  });
  // A window engine shows its card, unless its engine is missing.
  expect(deriveGameStagePhase({ ...BASE, stage: "window" })).toEqual({ kind: "window" });
  expect(deriveGameStagePhase({ ...BASE, stage: "window", toolchainReady: false }).kind).toBe(
    "tools-missing",
  );
});

// A hidden Stage that reloads plays a game nobody sees; one that never catches up shows a stale one.
it("holds a live change silently while hidden and loads it when shown", () => {
  const URL = "http://127.0.0.1:9/";
  const first = remountOrHold(null, liveServe(URL, 0), WATCHING);
  const change = liveServe(URL, 1);
  const hidden = remountOrHold(first, change, HIDDEN);
  expect(hidden).toMatchObject({ key: first.key, heldFor: "hidden" });
  expect(remountOrHold(hidden, change, HIDDEN)).toBe(hidden);
  // Shown again: it loads, unless the person is already in the game.
  const shown = remountOrHold(hidden, change, WATCHING);
  expect(shown).toMatchObject({ held: null, heldFor: null });
  expect(shown.key).not.toBe(first.key);
  expect(remountOrHold(hidden, change, IN_GAME)).toMatchObject({
    key: first.key,
    heldFor: "focus",
  });
  // A later change while hidden replaces what waits.
  expect(remountOrHold(hidden, liveServe(URL, 2), HIDDEN).held?.servedArtifactId).toBe("live:2");
  // Every live push is a new identity; none before the serve.
  expect(liveServe(null, 3).servedArtifactId).toBeNull();
});

it("reloads on request, with what is held or the same serve again", () => {
  const URL = "http://127.0.0.1:9/";
  const first = remountOrHold(null, liveServe(URL, 0), WATCHING);
  const again = reloadFrame(first, 1);
  expect(again.key).not.toBe(first.key);
  expect(again.serve).toEqual(first.serve);
  // The fold keeps the reload: the same serve read again is absorbed.
  expect(remountOrHold(again, liveServe(URL, 0), WATCHING)).toBe(again);
  const held = remountOrHold(first, liveServe(URL, 1), IN_GAME);
  expect(reloadFrame(held, 2)).toMatchObject({ held: null, serve: liveServe(URL, 1) });
});

it("says a closed live serve is stopped, and names an export as one", () => {
  const live = { ...BASE, stage: "live" as const, webBuildStale: false };
  // The server closed it (the palette, another client, the agent): never "Live".
  expect(
    deriveGameStagePhase({ ...live, previewUrl: "http://127.0.0.1:1/", liveServe: "stopped" }),
  ).toEqual({ kind: "stopped" });
  expect(deriveGameStagePhase({ ...live, busyStartedAt: 1, busyAction: "rebuild" })).toMatchObject({
    kind: "building",
    message: "Exporting the game…",
  });
  expect(
    deriveGameStagePhase({ ...live, localError: "disk full", errorAction: "rebuild" }),
  ).toMatchObject({ kind: "failed", what: "build" });
});

// A reload into the title after every save makes a live game unplayable; one into play
// after the person's own Reload hides the title they asked for.
it("lands a live remount in play, and a first load, new session or Reload on the title", () => {
  const URL = "http://127.0.0.1:9/";
  const first = remountOrHold(null, liveServe(URL, 0), WATCHING);
  expect(first.intoPlay).toBe(false);
  const changed = remountOrHold(first, liveServe(URL, 1), WATCHING);
  expect(changed.intoPlay).toBe(true);
  expect(reloadFrame(changed, 1).intoPlay).toBe(false);
  expect(playHeldFrame(remountOrHold(first, liveServe(URL, 1), IN_GAME)).intoPlay).toBe(true);
  const hidden = remountOrHold(first, liveServe(URL, 1), HIDDEN);
  expect(remountOrHold(hidden, liveServe(URL, 1), WATCHING).intoPlay).toBe(true);
  expect(remountOrHold(changed, liveServe("http://127.0.0.1:10/", 1), WATCHING).intoPlay).toBe(
    false,
  );
});

// Thirty saves in a turn must not restart the game thirty times.
it("applies live changes at most once a window while the turn runs, and at once after", () => {
  const shown = { revision: 1, at: 1_000 };
  const soon = { revision: 2, at: 4_000 };
  // No turn: at once.
  expect(liveToShow({ latest: soon, shown, turnRunning: false, now: 4_000 }).show.revision).toBe(2);
  // In a turn, inside the window: it waits, with one wake at the window's end.
  expect(liveToShow({ latest: soon, shown, turnRunning: true, now: 4_000 })).toEqual({
    show: shown,
    wakeAt: 1_000 + LIVE_TURN_WINDOW_MS,
  });
  // The latest wins at the wake, and a push past the window applies at once.
  const later = { revision: 5, at: 9_000 };
  expect(
    liveToShow({ latest: later, shown, turnRunning: true, now: 1_000 + LIVE_TURN_WINDOW_MS }),
  ).toEqual({ show: { revision: 5, at: 11_000 }, wakeAt: null });
  expect(
    liveToShow({ latest: { revision: 2, at: 12_000 }, shown, turnRunning: true, now: 12_000 }).show
      .revision,
  ).toBe(2);
  // The turn ends: what waits applies.
  expect(liveToShow({ latest: soon, shown, turnRunning: false, now: 5_000 }).wakeAt).toBeNull();
  // Nothing new, nothing to wake for.
  expect(liveToShow({ latest: shown, shown, turnRunning: true, now: 2_000 })).toEqual({
    show: shown,
    wakeAt: null,
  });
});

it("describes unknown source freshness and preserves selected Play", () => {
  expect(gameSourceFreshnessLabel("unknown")).toContain("Check");
  expect(gameSourceFreshnessLabel(true)).toContain("Play keeps that build");
  expect(gameSourceFreshnessLabel(false)).toContain("last check");
});

it("counts only the engine the game needs", () => {
  const tool = (
    name: "blender" | "godot" | "uv" | "unity",
    status: "ready" | "warning" | "error",
  ) => ({
    tool: name,
    installed: status !== "error",
    path: null,
    version: null,
    source: null,
    status,
    message: "",
    downloadUrl: null,
  });
  const withoutUnity = {
    tools: [
      tool("blender", "error"),
      tool("godot", "warning"),
      tool("uv", "ready"),
      tool("unity", "error"),
    ],
  };
  expect(toolchainReadyFor(withoutUnity, "godot")).toBe(true);
  expect(toolchainReadyFor(withoutUnity, "three")).toBe(true);
  expect(toolchainReadyFor(withoutUnity, "unity")).toBe(false);
  const withoutGodot = { tools: [tool("godot", "error"), tool("unity", "ready")] };
  expect(toolchainReadyFor(withoutGodot, "three")).toBe(true);
  expect(toolchainReadyFor(withoutGodot, "godot")).toBe(false);
  expect(toolchainReadyFor(withoutGodot, "unity")).toBe(true);
});
