// The run's boot step, as the step runner runs it on the game folder.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { GameOperationError, ThreadId } from "@kurambit/contracts";
import { PreviewBrowserInstallingError } from "../../preview/PreviewBrowser.ts";
import type * as GameService from "../GameService.ts";
import { type GameRunMemoryShort, handBackOnLowMemory, memoryEnded } from "./lowMemory.ts";
import type { StepResult } from "./policy.ts";
import { laneProfile } from "../engineProfile.ts";

type Game = GameService.GameService["Service"];

const isBrowserInstalling = Schema.is(PreviewBrowserInstallingError);

export const bootStep = (
  game: Game,
  ctx: {
    readonly creator: ThreadId;
    /** Whose work the check is: the run's, never the creator chat's. */
    readonly owner: string;
    readonly root: string;
    readonly lane: string;
    readonly log: (line: string) => Effect.Effect<void>;
    /** The step may still hand itself back to wait for memory. */
    readonly memoryWaitsLeft: boolean;
  },
): Effect.Effect<StepResult, GameOperationError | GameRunMemoryShort> => {
  // A check that could not run is not a verdict on the build: a busy
  // game or a cancelled check is retried; memory short hands the step back to wait;
  // a missing tool, or memory still short after the waits, ends the
  // run (resumable) rather than rejecting good work. Anything else
  // the check reports is the build failing to boot.
  type Verdict = { readonly ok: boolean; readonly detail: string };
  const judged = (
    what: string,
    attempt: Effect.Effect<Verdict, GameOperationError>,
    tries = 1,
  ): Effect.Effect<StepResult, GameOperationError | GameRunMemoryShort> =>
    handBackOnLowMemory(attempt, what, ctx.memoryWaitsLeft).pipe(
      Effect.map((r) => ({ kind: "boot", ...r }) as const),
      Effect.catchTags({
        GameOperationError: (error) => {
          // Kurambit's first browser install outlasts any number of tries on a
          // slow line; each wait is bounded, and the install ends in a browser
          // or in a tool-missing failure.
          if (isBrowserInstalling(error.cause))
            return ctx
              .log(`${what}: ${error.detail ?? error.reason}; waiting`)
              .pipe(Effect.andThen(judged(what, attempt, tries)));
          // A player build whose sources moved under it says nothing about them.
          const transient =
            error.reason === "busy" ||
            error.reason === "cancelled" ||
            (what === "boot player build" && error.reason === "invalid-input");
          if (transient && tries < 3)
            return ctx
              .log(`${what} ${error.detail ?? error.reason}; retrying`)
              .pipe(
                Effect.andThen(Effect.sleep("5 seconds")),
                Effect.andThen(judged(what, attempt, tries + 1)),
              );
          if (error.reason === "low-memory") return Effect.succeed(memoryEnded(error));
          // The ending shows its first 300 characters: the detail says what to
          // fix on this machine, where the error's message opens with advice
          // written for an agent's tool call.
          if (error.reason === "tool-missing")
            return Effect.succeed({
              kind: "failed",
              reason: `${what} could not run: ${error.detail ?? error.message}`.slice(0, 300),
            } as const);
          return Effect.succeed({
            kind: "boot",
            ok: false,
            detail: (error.detail ?? error.reason).slice(0, 300),
          } as const);
        },
      }),
    );
  const check = game.check(ctx.creator, ctx.owner).pipe(
    Effect.map((r): Verdict => ({
      ok: r.ok,
      // The run log says why a build was rejected, not only that it was.
      detail: r.ok
        ? "boot clean"
        : `check failed: ${
            r.errors
              .slice(0, 3)
              .map((e) => `${e.file ? `${e.file}: ` : ""}${e.message}`.slice(0, 200))
              .join("; ") || "no error lines (see the check log)"
          }`,
    })),
  );
  // An engine whose games play as a built player (Unity) checks the scene in
  // its editor, but testers and samples play the player: a build that only
  // the editor runs (an editor-only API, a scene missing from the build)
  // fails here, where its builder sees why. The player is cached by source,
  // so the tester's first session reuses it.
  const player = game.preparePlayer(ctx.root).pipe(
    Effect.map((p): Verdict => ({
      ok: true,
      detail: `boot clean; Linux player ${p.origin} in ${Math.round(p.ms / 1000)} s`,
    })),
    Effect.catchIf(
      (error) => error.reason === "command-failed",
      (error) => {
        // The first line names the session the build was for; the errors follow it,
        // then the log path and the editor's own output, which only the run log keeps.
        const full = (error.detail ?? "").split("\n").slice(1).join(" ").trim();
        const why = full.replace(/ See \/.*$/s, "");
        return ctx.log(`boot player build failed: ${full.slice(0, 2000)}`).pipe(
          Effect.as<Verdict>({
            ok: false,
            detail: `Linux player build failed: ${why || "no message (see builds/logs)"}`.slice(
              0,
              600,
            ),
          }),
        );
      },
    ),
  );
  return judged("boot check", check).pipe(
    Effect.flatMap((r) =>
      r.kind === "boot" && r.ok && laneProfile(ctx.lane).play === "player"
        ? judged("boot player build", player)
        : Effect.succeed(r),
    ),
  );
};
