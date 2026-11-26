export interface GameLibraryStatusInput {
  /** The most urgent state of the game's chats (resolveGameSidebarStatus). */
  readonly chats: "approval" | "input" | "working" | "failed" | "other";
  /** Keep going's own line while a run is live here ("Keep going · step 3"). */
  readonly keepGoing: string | null;
  /** An engine's own build (an export) is running. */
  readonly operationRunning: boolean;
  /** A turn has ended and its build is being saved (useTurnLanding). */
  readonly saving: boolean;
  /** The number the build being made will have, as the game screen's top bar says it. */
  readonly nextBuild: number;
  /** The folder's build, else the newest one, as a sentence names it, with when it was made. */
  readonly build: {
    readonly name: string;
    readonly at: string;
    /** It was measured and does not start: its own outcome, said in place of its name alone. */
    readonly doesNotStart?: boolean;
  } | null;
  /** The game's builds have been read; before that nothing is said about them. */
  readonly known: boolean;
}

/** One line for a game in the library (the sidebar and Home), read from the top bar's sources. */
export interface GameLibraryStatus {
  readonly text: string;
  /** broken: the game's build does not start, the outcome the triangle marks everywhere. */
  readonly tone: "live" | "failed" | "broken" | "idle" | "pending";
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
  // The top bar's own words; it holds the turn's clock, the library only says what is made.
  if (input.saving) return line(`Saving build ${input.nextBuild}`, "live");
  if (input.chats === "working") return line(`Making build ${input.nextBuild}`, "live");
  if (input.operationRunning) return line("Building", "live");
  if (input.chats === "failed") return line("The last turn failed", "failed");
  if (input.build?.doesNotStart === true)
    // The row already names the game; its build's outcome is the line.
    return line("Does not start", "broken", { at: input.build.at });
  if (input.build !== null) return line(input.build.name, "idle", { at: input.build.at });
  if (!input.known) return line("", "pending");
  // No build yet: a new game before its first turn lands, or a folder opened as it is.
  return line("No builds yet", "idle");
};
