import {
  GAME_ENGINES,
  type GameAction,
  type GameEngineId,
  type GameStageKind,
  type GameStatus,
  type GameToolStatus,
  type GameToolchainStatus,
} from "@kurambit/contracts";

/** The engine's own status; null for an engine that needs nothing installed. */
export function engineToolFor(
  toolchain: GameToolchainStatus,
  engine: GameEngineId,
): GameToolStatus | null {
  // three.js needs nothing installed; Blender only serves the art tools, which say so themselves.
  const name = GAME_ENGINES[engine].tool;
  return name === null ? null : (toolchain.tools.find((tool) => tool.tool === name) ?? null);
}

/** A warning is usable: it names a gap (a missing Windows module) rather than a blocker. */
export function toolchainReadyFor(toolchain: GameToolchainStatus, engine: GameEngineId): boolean {
  if (GAME_ENGINES[engine].tool === null) return true;
  const tool = engineToolFor(toolchain, engine);
  return tool !== null && tool.status !== "error";
}

/**
 * What the stage shows for the play surface. Ordered by what the user most
 * needs to know: work in flight, a loaded game, then what to do next.
 */
export type GameStagePhase =
  /** The game's engine is parked: it opens with its chat and builds, and nothing plays. */
  | { kind: "parked"; message: string }
  | { kind: "tools-missing" }
  /** The agent's turn is making the game's first build: nothing to play yet, nothing to press. */
  | { kind: "first-build"; startedAt: number | null }
  | { kind: "building"; message: string; startedAt: number | null }
  /** `open`: the live folder could not be served; `build`: an export failed. */
  | { kind: "failed"; message: string; what: "build" | "open" }
  | { kind: "never-built" }
  | { kind: "ready"; stale: boolean }
  /** A live game that is not being served: Play serves the folder again. */
  | { kind: "stopped" }
  /** The engine plays in its own window, never on the Stage. */
  | { kind: "window" }
  | { kind: "playing"; stale: boolean };

export interface GameStageInput {
  /** How the engine shows the game (`GAME_ENGINES[engine].stage`). */
  stage: GameStageKind;
  /** Why the game's engine is parked (`parkedEngineMessage`), or null while it is active. */
  parked?: string | null;
  toolchainReady: boolean;
  operation: GameStatus["operation"];
  /** A build that can be served from `builds/web` exists. */
  hasWebBuild: boolean;
  webBuildStale: boolean;
  previewUrl: string | null;
  /** A stage action is in flight in this client, before the server reports it. */
  busyStartedAt: number | null;
  /** Which one: a live game's stage reads differently for an open and an export. */
  busyAction?: GameAction | null;
  /** The action whose failure `localError` is. */
  errorAction?: GameAction | null;
  /** The server's word on a live game's serve (`GameStatus.live`). */
  liveServe?: GameStatus["live"];
  /** A stage action failed in this client (RPC failure), not on the server. */
  localError: string | null;
  /** The engine plays each changing turn's build (`GAME_ENGINES[engine].turnLoop`); export engines only. */
  turnLoop: boolean;
  /** The chat's agent turn is running, and when it started. */
  turnRunning: boolean;
  turnStartedAt: number | null;
  /**
   * This stage saw the turn end, the turn's build is listed, and no operation
   * started since: the server's play of it is on its way.
   */
  turnBuildPending: boolean;
}

const operationStartedAt = (operation: GameStatus["operation"]) =>
  operation === null ? null : Date.parse(operation.at);

export function deriveGameStagePhase(input: GameStageInput): GameStagePhase {
  if (input.parked != null) return { kind: "parked", message: input.parked };
  if (input.stage === "window")
    return input.toolchainReady ? { kind: "window" } : { kind: "tools-missing" };
  if (input.stage === "live") return deriveLivePhase(input);
  const operation = input.operation;
  const playable = input.hasWebBuild && input.previewUrl !== null;
  // On an engine that plays every turn, the turn that will make the first
  // build owns the stage until its build plays: the agent's own checks and
  // failed tries inside it are its work in progress. The person's own action
  // still shows.
  const firstBuild =
    input.turnLoop &&
    !input.hasWebBuild &&
    input.toolchainReady &&
    input.busyStartedAt === null &&
    input.localError === null;
  if (firstBuild && input.turnRunning)
    return { kind: "first-build", startedAt: input.turnStartedAt };
  // Work in flight only takes over the stage when there is nothing to play: a
  // rebuild of a game that is already on screen keeps it running, and the new
  // build reloads it when it lands.
  if ((input.busyStartedAt !== null || operation?.state === "running") && !playable)
    return {
      kind: "building",
      message: operation?.state === "running" ? operation.message : "Starting…",
      startedAt: input.busyStartedAt ?? operationStartedAt(operation),
    };
  // A loaded game is never taken over by an unrelated failure: the status
  // strip names the blocker, and the game keeps running.
  if (input.previewUrl !== null && input.hasWebBuild)
    return { kind: "playing", stale: input.webBuildStale };
  // The turn ended and its build is about to play: no "Build & play" to race
  // the server's own, and an older failure was the turn's work in progress.
  if (firstBuild && input.turnBuildPending)
    return { kind: "first-build", startedAt: input.turnStartedAt };
  // Only a failure that leaves nothing to play becomes the whole state.
  const failure = input.localError ?? (operation?.state === "failed" ? operation.message : null);
  if (failure !== null && !playable) return { kind: "failed", message: failure, what: "build" };
  const serveFreshBuild = input.hasWebBuild && !input.webBuildStale;
  if (!input.toolchainReady && !serveFreshBuild) return { kind: "tools-missing" };
  if (input.hasWebBuild) return { kind: "ready", stale: input.webBuildStale };
  return { kind: "never-built" };
}

/**
 * A live game is the folder itself, served in milliseconds: nothing builds, so
 * the agent's operations never take the stage, and serving needs no engine.
 * Only the person's own Play in flight, or its failure, shows instead of it.
 */
function deriveLivePhase(input: GameStageInput): GameStagePhase {
  // A closed serve is stopped even before the stale URL is reread.
  if (input.previewUrl !== null && input.liveServe !== "stopped")
    return { kind: "playing", stale: false };
  const opening = input.busyAction == null || input.busyAction === "preview";
  if (input.busyStartedAt !== null)
    return {
      kind: "building",
      message: opening ? "Opening the game…" : "Exporting the game…",
      startedAt: input.busyStartedAt,
    };
  if (input.localError !== null)
    return {
      kind: "failed",
      message: input.localError,
      what: input.errorAction == null || input.errorAction === "preview" ? "open" : "build",
    };
  return { kind: "stopped" };
}

/** The message the "Ask agent to fix" button puts in the composer. */
export function buildFailurePrompt(error: string): string {
  return `The web preview build failed. Fix the error and rebuild the game.\n\n${error.trim()}`;
}

/** The message "Ask agent to fix" sends for an error the live game threw. */
export function liveErrorPrompt(error: string): string {
  return `The game throws an error on the Stage. Fix it and keep the game booting.\n\n${error.trim()}`;
}

/**
 * What the serving game decides about the iframe. The served artifact identity
 * is separate from currentness: it changes only when the bytes under builds/web
 * were really replaced.
 */
export interface GamePreviewServe {
  previewUrl: string | null;
  /** Identity of the served export's files, or null when it cannot be vouched for. */
  servedArtifactId: string | null;
}

const frameKeyOf = (serve: GamePreviewServe) =>
  `${serve.previewUrl ?? ""}#${serve.servedArtifactId ?? ""}`;

/**
 * The iframe identity after one status read, given what it was running.
 * Remounts happen only for real game resets: a new preview session or a
 * replaced web artifact. A source edit and a failed rebuild leave both
 * untouched, so the loaded game never loses its progress for them; a missing
 * artifact identity never remounts either, because the honest state is "what
 * is on disk is uncertain now", not "what is on screen is a new game".
 */
export function nextGamePreviewFrame(
  previous: { readonly key: string; readonly serve: GamePreviewServe } | null,
  serve: GamePreviewServe,
): { readonly key: string; readonly serve: GamePreviewServe } {
  const candidate = { key: frameKeyOf(serve), serve };
  if (previous === null) return candidate;
  const urlChanged = previous.serve.previewUrl !== serve.previewUrl;
  const artifactReplaced =
    serve.servedArtifactId !== null && serve.servedArtifactId !== previous.serve.servedArtifactId;
  return urlChanged || artifactReplaced ? candidate : previous;
}

/**
 * A live game's identity: its serve and the last settled change under the
 * folder, so each live push is a new game to show.
 */
export const liveServe = (previewUrl: string | null, liveRevision: number): GamePreviewServe => ({
  previewUrl,
  servedArtifactId: previewUrl === null ? null : `live:${liveRevision}`,
});

/**
 * What the play surface runs, and a newer serve of the same preview session it
 * holds back. A tab switch never changes the frame, or the game restarts.
 */
export interface GameFrameFold {
  readonly key: string;
  readonly serve: GamePreviewServe;
  /**
   * The load lands in play, not on the title: a remount for a change the
   * person was watching. The first load, a new session and Reload go to the title.
   */
  readonly intoPlay: boolean;
  /** A newer serve the frame did not load yet. */
  readonly held: GamePreviewServe | null;
  /** Why: the person is in the game (the chip asks), or the Stage is hidden (it loads when shown). */
  readonly heldFor: "focus" | "hidden" | null;
}

const showing = (serve: GamePreviewServe, intoPlay: boolean): GameFrameFold => ({
  key: frameKeyOf(serve),
  serve,
  intoPlay,
  held: null,
  heldFor: null,
});

/**
 * PURE. The frame after one read of what is served. A new build or a
 * live change remounts a visible frame nobody is in. Under a player whose
 * frame has focus it is held until they press Reload, even after focus
 * leaves; while the Stage is hidden it is held silently and loads when the
 * Stage is shown. A still newer serve decides again. A new preview session (or
 * none) always remounts, because the old frame's server is gone. Returns
 * `previous` itself when nothing changed, so a render can compare by identity.
 */
export function remountOrHold(
  previous: GameFrameFold | null,
  next: GamePreviewServe,
  view: { readonly focused: boolean; readonly hidden: boolean },
): GameFrameFold {
  if (previous === null) return showing(next, false);
  if (previous.held !== null && frameKeyOf(previous.held) === frameKeyOf(next)) {
    if (previous.heldFor !== "hidden" || view.hidden) return previous;
    return view.focused ? { ...previous, heldFor: "focus" } : showing(next, true);
  }
  const shown = nextGamePreviewFrame(previous, next);
  if (shown === previous) {
    // The shown serve is back (an undo of what was held): nothing is waiting.
    const backToShown =
      next.servedArtifactId !== null && next.servedArtifactId === previous.serve.servedArtifactId;
    return previous.held !== null && backToShown
      ? { ...previous, held: null, heldFor: null }
      : previous;
  }
  if (shown.serve.previewUrl !== previous.serve.previewUrl) return showing(next, false);
  if (view.hidden) return { ...previous, held: next, heldFor: "hidden" };
  if (view.focused) return { ...previous, held: next, heldFor: "focus" };
  return showing(next, true);
}

/** PURE. Loads what is held: the one remount the person asked for, back into play. */
export function playHeldFrame(fold: GameFrameFold): GameFrameFold {
  return fold.held === null ? fold : showing(fold.held, true);
}

/** PURE. Reloads the frame now, even with nothing new: the header's Reload, to the title. */
export function reloadFrame(fold: GameFrameFold, at: number): GameFrameFold {
  const serve = fold.held ?? fold.serve;
  return { ...showing(serve, false), key: `${frameKeyOf(serve)}#reload:${at}` };
}

/** The hash the three.js shell reads to skip its title and start the run. */
export const LIVE_PLAY_HASH = "#kurambit-play";

/** A live change the Stage has applied: its push count and when it applied it (ms). */
export interface LiveShown {
  readonly revision: number;
  readonly at: number;
}

/** While this chat's turn runs, a live change applies at most this often. */
export const LIVE_TURN_WINDOW_MS = 10_000;

/**
 * PURE. Which live change the frame shows. With no turn running, the
 * latest at once. While this chat's turn runs, at most one change per window
 * (the latest wins); `wakeAt` is when the waiting one may apply, for one
 * timeout. A turn that ends applies what waits at once.
 */
export function liveToShow(input: {
  readonly latest: LiveShown;
  readonly shown: LiveShown | null;
  readonly turnRunning: boolean;
  /** The latest moment this render knows of: a push's time or a wake's. */
  readonly now: number;
}): { readonly show: LiveShown; readonly wakeAt: number | null } {
  const { latest, shown } = input;
  if (shown === null) return { show: latest, wakeAt: null };
  if (latest.revision === shown.revision) return { show: shown, wakeAt: null };
  const due = shown.at + LIVE_TURN_WINDOW_MS;
  if (!input.turnRunning || input.now >= due)
    return {
      show: { revision: latest.revision, at: Math.max(input.now, latest.at) },
      wakeAt: null,
    };
  return { show: shown, wakeAt: due };
}

export function gameSourceFreshnessLabel(value: GameStatus["sourcesDifferFromPlay"]): string {
  return value === "unknown"
    ? "Source freshness unknown. Check to compare with the selected build."
    : value
      ? "Sources differ from the selected build. Play keeps that build."
      : "Sources matched the selected build at the last check.";
}
