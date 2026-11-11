import type { GameStagePhase } from "./gameStageLogic";

/** One phrase of the top bar's status line. */
export interface GameStatusPart {
  readonly text: string;
  /** live: work in progress; ok: a game playing. */
  readonly dot: "live" | "ok" | null;
  readonly strong: boolean;
  /** Ticks an elapsed time after the text. */
  readonly since: number | null;
  /** A key hint after the text, then its words: "Tab resumes". */
  readonly key: { readonly key: string; readonly after: string } | null;
}

const part = (text: string, more: Partial<Omit<GameStatusPart, "text">> = {}): GameStatusPart => ({
  text,
  dot: null,
  strong: false,
  since: null,
  key: null,
  ...more,
});

export interface GameStatusInput {
  readonly phase: GameStagePhase["kind"];
  /** The build on the Stage, as a sentence names it ("build 7"); null before one. */
  readonly onStage: string | null;
  readonly frozen: boolean;
  /** Held because the Stage lost focus, not by the person. */
  readonly away: boolean;
  readonly needsChoice: boolean;
  /** The step keep going is on, in this chat; null when it is not running here. */
  readonly keepGoingStep: number | null;
  readonly keepGoingLive: boolean;
  readonly turnRunning: boolean;
  readonly turnStartedAt: number | null;
  /** The number the build being made will take. */
  readonly nextBuild: number;
  /** An engine's own build running (an export), with when it started. */
  readonly operation: { readonly text: string; readonly since: number | null } | null;
  /** The game is served live from its folder. */
  readonly live: boolean;
}

/**
 * PURE. What the game is doing, in at most two phrases: what plays on the
 * Stage, then the work under way. Only states the app knows; nothing guessed.
 */
export const gameStatusLine = (input: GameStatusInput): ReadonlyArray<GameStatusPart> => {
  const stage: GameStatusPart | null = input.frozen
    ? part(`Frozen on ${input.onStage ?? "the game"}`, { key: { key: "Tab", after: "resumes" } })
    : input.phase === "playing"
      ? input.away && input.onStage !== null
        ? part("Paused while you're away · click the game to play on")
        : part(input.onStage === null ? "Playing" : `Playing ${input.onStage}`, { dot: "ok" })
      : input.phase === "stopped"
        ? part("Stopped")
        : input.phase === "ready"
          ? part("Ready to play")
          : input.phase === "never-built"
            ? part("No web build yet")
            : input.phase === "failed"
              ? part("The build failed")
              : input.phase === "tools-missing"
                ? part("The engine is not ready")
                : input.phase === "parked"
                  ? part("Paused")
                  : input.phase === "window"
                    ? part("Plays in its own window")
                    : null;
  const work: GameStatusPart | null = input.needsChoice
    ? part("The agent needs a choice", { strong: true, dot: "live" })
    : input.keepGoingLive && input.keepGoingStep !== null
      ? part(`Keep going, step ${input.keepGoingStep}`, { strong: true, dot: "live" })
      : input.keepGoingLive
        ? part("Keep going", { strong: true, dot: "live" })
        : input.turnRunning
          ? part(`Making build ${input.nextBuild}`, {
              strong: true,
              dot: "live",
              since: input.turnStartedAt,
            })
          : input.operation !== null && !input.live
            ? part(input.operation.text, { dot: "live", since: input.operation.since })
            : null;
  return [stage, work].filter((entry) => entry !== null);
};
