// The run's boot step, as the step runner runs it on the game folder.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { gameOperationFault, type GameEngineId, type ThreadId } from "@kurambit/contracts";
import { PreviewBrowserInstallingError } from "../../preview/PreviewBrowser.ts";
import type * as GameService from "../GameService.ts";
import { engineProfile } from "../engineProfile.ts";
import { type NotMeasured, measuring } from "./handBack.ts";
import type { StepResult } from "./policy.ts";

type Game = GameService.GameService["Service"];
type Boot = Extract<StepResult, { readonly kind: "boot" }>;

const isBrowserInstalling = Schema.is(PreviewBrowserInstallingError);

/**
 * The boot verdict on the build in the folder: its check, and for an engine
 * whose games play as a built player (Unity) the player build too. Only the
 * build's own faults are a verdict (`ok: false`); a tool that failed, memory
 * short or the game held fail as not measured, and the step runner hands
 * them back or pauses the run.
 */
export const bootStep = (
  game: Game,
  ctx: {
    readonly creator: ThreadId;
    /** Whose work the check is: the run's, never the creator chat's. */
    readonly owner: string;
    readonly root: string;
    readonly engine: GameEngineId;
    readonly log: (line: string) => Effect.Effect<void>;
  },
): Effect.Effect<Boot, NotMeasured> => {
  const roots = [ctx.root];
  // Kurambit's first browser install outlasts any number of tries on a slow
  // line; each wait is bounded, and the install ends in a browser or in a
  // tool-missing failure. It answers `busy` too, so it is waited out here.
  const installed = <A, E extends { readonly cause?: unknown; readonly detail?: string }, R>(
    what: string,
    attempt: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    attempt.pipe(
      Effect.catchIf(
        (error) => isBrowserInstalling(error.cause),
        (error) =>
          ctx
            .log(`${what}: ${error.detail ?? "the browser is installing"}; waiting`)
            .pipe(Effect.andThen(installed(what, attempt))),
      ),
    );
  const check = measuring(
    "boot check",
    roots,
  )(installed("boot check", game.check(ctx.creator, ctx.owner))).pipe(
    Effect.map((r): Boot => ({
      kind: "boot",
      ok: r.ok,
      // The step's result says why a build was rejected, not only that it was.
      detail: r.ok
        ? "boot clean"
        : `check failed: ${
            r.errors
              .slice(0, 3)
              .map((e) => `${e.file ? `${e.file}: ` : ""}${e.message}`.slice(0, 200))
              .join("; ") || "no error lines (see the check log)"
          }`,
    })),
    Effect.catchTags({
      GameRunBuildFault: (fault) =>
        Effect.succeed<Boot>({
          kind: "boot",
          ok: false,
          detail: (fault.error.detail ?? fault.error.reason).slice(0, 300),
        }),
    }),
  );
  // An engine whose games play as a built player (Unity) checks the scene in
  // its editor, but testers and samples play the player: a build that only
  // the editor runs (an editor-only API, a scene missing from the build)
  // fails here, where its builder sees why. Only the build's own fault is a
  // verdict; a request of ours that was refused is our fault, read as a tool's
  // (contract §1). The player is cached by source, so the tester's first
  // session reuses it.
  const player = game.preparePlayer(ctx.root).pipe(
    Effect.map((p): Boot => ({
      kind: "boot",
      ok: true,
      detail: `boot clean; Linux player ${p.origin} in ${Math.round(p.ms / 1000)} s`,
    })),
    Effect.catchIf(
      (error) => gameOperationFault(error.reason) === "build",
      (error) => {
        // The first line names the session the build was for; the errors follow it,
        // then the log path and the editor's own output, which only the server log keeps.
        const full = (error.detail ?? "").split("\n").slice(1).join(" ").trim();
        const why = full.replace(/ See \/.*$/s, "") || (error.detail ?? "").split("\n")[0];
        return ctx.log(`boot player build failed: ${full.slice(0, 2000)}`).pipe(
          Effect.as<Boot>({
            kind: "boot",
            ok: false,
            detail: `Linux player build failed: ${why || "no message (see builds/logs)"}`.slice(
              0,
              600,
            ),
          }),
        );
      },
    ),
    measuring("boot player build", roots),
    Effect.catchTags({
      // Only a build or request fault is a verdict, and those were read above.
      GameRunBuildFault: (fault) =>
        Effect.succeed<Boot>({
          kind: "boot",
          ok: false,
          detail: `Linux player build failed: ${fault.error.detail ?? fault.error.reason}`.slice(
            0,
            600,
          ),
        }),
    }),
  );
  return check.pipe(
    Effect.flatMap((r) =>
      r.ok && engineProfile(ctx.engine).play === "player" ? player : Effect.succeed(r),
    ),
  );
};
