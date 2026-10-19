import type { GameStatus } from "@t3tools/contracts";

/**
 * What the stage shows for the play surface. Ordered by what the user most
 * needs to know: work in flight, then a broken build, then what to do next.
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
  if (input.busyStartedAt !== null)
    return {
      kind: "building",
      message: operation?.state === "running" ? operation.message : "Starting…",
      startedAt: input.busyStartedAt,
    };
  if (operation?.state === "running")
    return {
      kind: "building",
      message: operation.message,
      startedAt: operationStartedAt(operation),
    };
  // A loaded game is never taken over by an unrelated failure: the failure
  // still shows in the stage's status strip. Only a failure that leaves nothing
  // to play becomes the whole state.
  const playable = input.hasWebBuild && input.previewUrl !== null;
  const failure = input.localError ?? (operation?.state === "failed" ? operation.message : null);
  if (failure !== null && !playable) return { kind: "failed", message: failure };
  const serveFreshBuild = input.hasWebBuild && !input.webBuildStale;
  if (!input.toolchainReady && !serveFreshBuild) return { kind: "tools-missing" };
  if (input.previewUrl !== null && input.hasWebBuild)
    return { kind: "playing", stale: input.webBuildStale };
  if (input.hasWebBuild) return { kind: "ready", stale: input.webBuildStale };
  return { kind: "never-built" };
}

/** The message the "Ask agent to fix" button puts in the composer. */
export function buildFailurePrompt(error: string): string {
  return `The web preview build failed. Fix the error and rebuild the game.\n\n${error.trim()}`;
}
