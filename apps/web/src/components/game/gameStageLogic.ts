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
}

const operationStartedAt = (operation: GameStatus["operation"]) =>
  operation === null ? null : Date.parse(operation.at);

export function deriveGameStagePhase(input: GameStageInput): GameStagePhase {
  const operation = input.operation;
  const playable = input.hasWebBuild && input.previewUrl !== null;
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
 * The iframe's identity. A tab switch must not change it, or the game restarts;
 * a Stop removes the preview and a new build (or a newly served export) changes
 * the identity, which is the one intended reset.
 */
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

/** How many reloads a run of status reads causes, first mount included. */
export function countGamePreviewRemounts(serves: readonly GamePreviewServe[]): number {
  let frame = null as null | { readonly key: string; readonly serve: GamePreviewServe };
  let remounts = 0;
  for (const serve of serves) {
    const next = nextGamePreviewFrame(frame, serve);
    if (frame !== null && next.key !== frame.key) remounts++;
    frame = next;
  }
  if (frame !== null) remounts++;
  return remounts;
}

/**
 * The iframe's identity from a full status read. Content must call
 * {@link nextGamePreviewFrame} repeatedly (the stage folds it across renders)
 * so unrelated status churn can never change the key.
 */
export function gamePreviewFrameKey(serve: GamePreviewServe): string {
  return frameKeyOf(serve);
}

export function gameSourceFreshnessLabel(value: GameStatus["sourcesDifferFromPlay"]): string {
  return value === "unknown"
    ? "Source freshness unknown. Check to compare with the selected build."
    : value
      ? "Sources differ from the selected build. Play keeps that build."
      : "Sources matched the selected build at the last check.";
}
