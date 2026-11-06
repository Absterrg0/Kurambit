import {
  GAME_ENGINES,
  type GameEngineId,
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
  | { kind: "tools-missing" }
  /** The agent's turn is making the game's first build: nothing to play yet, nothing to press. */
  | { kind: "first-build"; startedAt: number | null }
  | { kind: "building"; message: string; startedAt: number | null }
  | { kind: "failed"; message: string }
  | { kind: "never-built" }
  | { kind: "ready"; stale: boolean }
  | { kind: "playing"; stale: boolean };

export interface GameStageInput {
  toolchainReady: boolean;
  operation: GameStatus["operation"];
  /** A build that can be served from `builds/web` exists. */
  hasWebBuild: boolean;
  webBuildStale: boolean;
  previewUrl: string | null;
  /** A stage action is in flight in this client, before the server reports it. */
  busyStartedAt: number | null;
  /** A stage action failed in this client (RPC failure), not on the server. */
  localError: string | null;
  /** The chat's agent turn is running, and when it started. */
  turnRunning: boolean;
  turnStartedAt: number | null;
}

const operationStartedAt = (operation: GameStatus["operation"]) =>
  operation === null ? null : Date.parse(operation.at);

export function deriveGameStagePhase(input: GameStageInput): GameStagePhase {
  const operation = input.operation;
  const playable = input.hasWebBuild && input.previewUrl !== null;
  // The turn that will make the first build owns the stage until it ends: the
  // agent's own checks and failed tries inside it are its work in progress,
  // and its build plays when it lands. The person's own action still shows.
  if (
    input.turnRunning &&
    !input.hasWebBuild &&
    input.toolchainReady &&
    input.busyStartedAt === null &&
    input.localError === null
  )
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
  // Only a failure that leaves nothing to play becomes the whole state.
  const failure = input.localError ?? (operation?.state === "failed" ? operation.message : null);
  if (failure !== null && !playable) return { kind: "failed", message: failure };
  const serveFreshBuild = input.hasWebBuild && !input.webBuildStale;
  if (!input.toolchainReady && !serveFreshBuild) return { kind: "tools-missing" };
  if (input.hasWebBuild) return { kind: "ready", stale: input.webBuildStale };
  return { kind: "never-built" };
}

/** The message the "Ask agent to fix" button puts in the composer. */
export function buildFailurePrompt(error: string): string {
  return `The web preview build failed. Fix the error and rebuild the game.\n\n${error.trim()}`;
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
 * What the play surface runs, and a newer build of the same preview session it
 * holds back. A tab switch never changes the frame, or the game restarts.
 */
export interface GameFrameFold {
  readonly key: string;
  readonly serve: GamePreviewServe;
  /** A replaced artifact that arrived while the person was in the game. */
  readonly held: GamePreviewServe | null;
}

/**
 * PURE. The frame after one status read. A new build never reloads under a
 * player whose game frame has focus: it is held until they press Play, and a
 * still newer build decides again. A new preview session (or none) always
 * remounts, because the old frame's server is gone. Returns `previous` itself
 * when nothing changed, so a render can compare by identity.
 */
export function remountOrHold(
  previous: GameFrameFold | null,
  next: GamePreviewServe,
  gameFocused: boolean,
): GameFrameFold {
  if (previous === null) return { ...nextGamePreviewFrame(null, next), held: null };
  if (previous.held !== null && frameKeyOf(previous.held) === frameKeyOf(next)) return previous;
  const shown = nextGamePreviewFrame(previous, next);
  if (shown === previous) {
    // The shown build is served again (an undo of what was held): nothing is waiting.
    const backToShown =
      next.servedArtifactId !== null && next.servedArtifactId === previous.serve.servedArtifactId;
    return previous.held !== null && backToShown ? { ...previous, held: null } : previous;
  }
  const sameSession = shown.serve.previewUrl === previous.serve.previewUrl;
  return gameFocused && sameSession
    ? { ...previous, held: next }
    : { key: shown.key, serve: shown.serve, held: null };
}

/** PURE. Plays the held build: the one remount the person asked for. */
export function playHeldFrame(fold: GameFrameFold): GameFrameFold {
  return fold.held === null ? fold : { key: frameKeyOf(fold.held), serve: fold.held, held: null };
}

export function gameSourceFreshnessLabel(value: GameStatus["sourcesDifferFromPlay"]): string {
  return value === "unknown"
    ? "Source freshness unknown. Check to compare with the selected build."
    : value
      ? "Sources differ from the selected build. Play keeps that build."
      : "Sources matched the selected build at the last check.";
}
