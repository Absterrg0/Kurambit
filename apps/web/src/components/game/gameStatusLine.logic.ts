import type { GameStagePhase } from "./gameStageLogic";

/** One phrase of the top bar's status line. */
export interface GameStatusPart {
  readonly text: string;
  /** live: work in progress. */
  readonly dot: "live" | null;
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
  /** The game has the keyboard: the person is playing it, not just looking at it. */
  readonly focused: boolean;
  /** The folder's last build, as a sentence names it, when the folder changed since it. */
  readonly changedSince: string | null;
  /** The game has at least one measured build. */
  readonly measured: boolean;
}

const sentence = (phrase: string) => `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;

/**
 * PURE. What the game is doing, in at most two phrases: what plays on the
 * Stage, then the work under way. Only states the app knows; nothing guessed.
 */
export const gameStatusLine = (input: GameStatusInput): ReadonlyArray<GameStatusPart> => {
  const stage: GameStatusPart | null = input.frozen
    ? part(`Frozen on ${input.onStage ?? "the game"}`, { key: { key: "Tab", after: "resumes" } })
    : input.phase === "playing"
      ? input.away && input.onStage !== null
        ? part(`Paused on ${input.onStage} while you're away`)
        : input.focused
          ? part(input.onStage === null ? "Playing" : `Playing ${input.onStage}`)
          : // At rest the line names what plays, in the words the Inspector and sidebar use.
            input.onStage !== null
            ? part(sentence(input.onStage))
            : input.changedSince !== null
              ? part(`Changed since ${input.changedSince} · not measured`)
              : input.measured
                ? null
                : part("Not measured yet")
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

export interface GameLibraryStatusInput {
  /** The most urgent state of the game's chats (resolveGameSidebarStatus). */
  readonly chats: "approval" | "input" | "working" | "failed" | "other";
  /** When the running turn started, while `chats` is working. */
  readonly turnStartedAt: string | null;
  /** Keep going's own line while a run is live here ("Keep going · step 3"). */
  readonly keepGoing: string | null;
  /** An engine's own build (an export) is running. */
  readonly operationRunning: boolean;
  /** The folder's build, else the newest one, as a sentence names it, with when it was made. */
  readonly build: { readonly name: string; readonly at: string } | null;
}

/** One line for a game in the library (the sidebar and Home), read from the top bar's sources. */
export interface GameLibraryStatus {
  readonly text: string;
  readonly tone: "live" | "failed" | "idle";
  /** Ticks an elapsed time after the text. */
  readonly since: string | null;
  /** A relative time after the text ("2m"). */
  readonly at: string | null;
}

/** PURE. What a game is doing now, in one line; a question for the person comes first. */
export const gameLibraryStatus = (input: GameLibraryStatusInput): GameLibraryStatus => {
  const line = (
    text: string,
    tone: GameLibraryStatus["tone"],
    more: Partial<GameLibraryStatus> = {},
  ) => ({
    text,
    tone,
    since: null,
    at: null,
    ...more,
  });
  if (input.chats === "approval" || input.chats === "input")
    return line("Needs your answer", "live");
  if (input.keepGoing !== null) return line(input.keepGoing, "live");
  if (input.chats === "working") return line("Building", "live", { since: input.turnStartedAt });
  if (input.operationRunning) return line("Building", "live");
  if (input.chats === "failed") return line("The last turn failed", "failed");
  if (input.build !== null) return line(input.build.name, "idle", { at: input.build.at });
  // A game opened from a folder plays before Kurambit has measured any build of it.
  return line("Not measured yet", "idle");
};
