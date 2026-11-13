import type { GameStagePhase } from "./gameStageLogic";

/** One phrase of the top bar's status line. */
export interface GameStatusPart {
  readonly text: string;
  /** live: work in progress. failed: the build's outcome is that it does not start. */
  readonly dot: "live" | "failed" | null;
  readonly strong: boolean;
  /** Ticks an elapsed time after the text. */
  readonly since: number | null;
  /** The phrase in a full sentence, for its tooltip: the line itself is compressed. */
  readonly hint: string | null;
  /** A shorter phrase for a narrow top bar, so the line is never cut mid-word. */
  readonly short: string | null;
}

const part = (text: string, more: Partial<Omit<GameStatusPart, "text">> = {}): GameStatusPart => ({
  text,
  dot: null,
  strong: false,
  since: null,
  hint: null,
  short: null,
  ...more,
});

export interface GameStatusInput {
  readonly phase: GameStagePhase["kind"];
  /** The build on the Stage, as a sentence names it ("build 7"); null before one. */
  readonly onStage: string | null;
  /** The build on the Stage was measured and does not start: said with its name. */
  readonly onStageDoesNotStart: boolean;
  /** The build on the Stage plays from a copy, not the game folder. */
  readonly copy: boolean;
  /** The game's builds have been read: before that, nothing is said about them. */
  readonly known: boolean;
  readonly needsChoice: boolean;
  /** The step keep going is on, in this chat; null when it is not running here. */
  readonly keepGoingStep: number | null;
  readonly keepGoingLive: boolean;
  /** Keep going's next step is proposed to start at this time ("3:11 PM"); null otherwise. */
  readonly keepGoingStartsAt: string | null;
  readonly turnRunning: boolean;
  readonly turnStartedAt: number | null;
  /** The number the build being made will take. */
  readonly nextBuild: number;
  /** An engine's own build running (an export), with when it started. */
  readonly operation: { readonly text: string; readonly since: number | null } | null;
  /** The game is served live from its folder. */
  readonly live: boolean;
  /** The folder's last build, as a sentence names it, when the folder changed since it. */
  readonly changedSince: string | null;
  /** The game has at least one measured build. */
  readonly measured: boolean;
  /** The turn has ended and its build is being saved, before it is listed. */
  readonly landing: boolean;
  /** An Undo or Redo the person asked for, while it restores: "Undoing build 2". */
  readonly restoring: string | null;
}

const sentence = (phrase: string) => `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;

/**
 * PURE. What the game is doing, in at most two phrases: what plays on the
 * Stage, then the work under way. Only states the app knows; nothing guessed.
 */
export const gameStatusLine = (input: GameStatusInput): ReadonlyArray<GameStatusPart> => {
  // The line always says which build plays and whether it was measured: pausing, freezing or
  // playing the game changes the Stage, never this line.
  const stage: GameStatusPart | null =
    input.phase === "playing"
      ? !input.known
        ? null
        : input.copy && input.onStage !== null
          ? part(`Playing ${input.onStage} from a copy`, {
              short: "Playing a copy",
              hint: "The game folder is untouched. Back to the current game puts it on the Stage again.",
            })
          : // At rest the line names what plays, in the words the Inspector and sidebar use.
            input.onStage !== null
            ? part(
                `${sentence(input.onStage)}${input.onStageDoesNotStart ? " · does not start" : ""}`,
                {
                  ...(input.onStageDoesNotStart ? { dot: "failed" as const } : {}),
                  hint: `The Stage plays ${input.onStage}, and the Inspector shows its checks.`,
                },
              )
            : input.changedSince !== null
              ? part(`Changed since ${input.changedSince} · not measured`, {
                  short: "Changed · not measured",
                  hint: `The game folder has changed since ${input.changedSince}, so the Stage plays something no build has measured yet. The next build measures it.`,
                })
              : input.measured || input.landing
                ? null
                : part("Not measured yet", {
                    hint: "No build of this game has been measured. Your agent's next change becomes its first build, measured by a bot.",
                  })
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
    ? part("The agent needs a choice", {
        strong: true,
        dot: "live",
        hint: "Your agent is waiting for your answer in the Log.",
      })
    : input.keepGoingLive && input.keepGoingStep !== null && input.keepGoingStartsAt !== null
      ? // A step proposed for later is not work under way: no working dot until it starts.
        part(`Keep going · step ${input.keepGoingStep} at ${input.keepGoingStartsAt}`, {
          hint: "Keep going proposed its next step; it starts then unless you change or skip it.",
        })
      : input.keepGoingLive && input.keepGoingStep !== null
        ? part(`Keep going · step ${input.keepGoingStep}`, {
            strong: true,
            dot: "live",
            hint: "Keep going is improving the game a step at a time, each step a build.",
          })
        : input.keepGoingLive
          ? part("Keep going", {
              strong: true,
              dot: "live",
              hint: "Keep going is improving the game a step at a time, each step a build.",
            })
          : input.restoring !== null
            ? part(input.restoring, { strong: true, dot: "live" })
            : input.landing
              ? part(`Saving build ${input.nextBuild}…`, {
                  strong: true,
                  dot: "live",
                  hint: `The agent's turn has ended. Build ${input.nextBuild} is being saved, then it plays here and a bot measures it.`,
                })
              : input.turnRunning
                ? part(`Making build ${input.nextBuild}`, {
                    strong: true,
                    dot: "live",
                    since: input.turnStartedAt,
                    hint: `Your agent is changing the game. When the turn ends it becomes build ${input.nextBuild}, played and measured here.`,
                  })
                : input.operation !== null && !input.live
                  ? part(input.operation.text, { dot: "live", since: input.operation.since })
                  : null;
  return [stage, work].filter((entry) => entry !== null);
};

export interface GameLibraryStatusInput {
  /** The most urgent state of the game's chats (resolveGameSidebarStatus). */
  readonly chats: "approval" | "input" | "working" | "failed" | "other";
  /** Keep going's own line while a run is live here ("Keep going · step 3"). */
  readonly keepGoing: string | null;
  /** Its next step is proposed to start at this time ("3:11 PM"): it waits, not works. */
  readonly keepGoingStartsAt: string | null;
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
  readonly tone: "live" | "failed" | "idle" | "pending";
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
  if (input.keepGoing !== null)
    return input.keepGoingStartsAt === null
      ? line(input.keepGoing, "live")
      : // Short enough for a sidebar row: whose step it is, and the time the run waits for.
        line(`Keep going at ${input.keepGoingStartsAt}`, "idle");
  // The top bar's own words; it holds the turn's clock, the library only says what is made.
  if (input.saving) return line(`Saving build ${input.nextBuild}`, "live");
  if (input.chats === "working") return line(`Making build ${input.nextBuild}`, "live");
  if (input.operationRunning) return line("Building", "live");
  if (input.chats === "failed") return line("The last turn failed", "failed");
  if (input.build?.doesNotStart === true)
    // The row already names the game; its build's outcome is the line.
    return line("Does not start", "failed", { at: input.build.at });
  if (input.build !== null) return line(input.build.name, "idle", { at: input.build.at });
  if (!input.known) return line("", "pending");
  // A game opened from a folder plays before Kurambit has measured any build of it.
  return line("Not measured yet", "idle");
};
