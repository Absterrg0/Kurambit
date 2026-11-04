// @effect-diagnostics nodeBuiltinImport:off -- Writes the generated check bots beside the game's own bots.
// Scores a rung's state checks on the build checked out in the game root: one
// generated bot per check, run by the shared bot service (so every engine, the
// video and the last frame come for free), judged here by code.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type * as GameService from "../GameService.ts";
import {
  checkBot,
  evaluate,
  inputMs,
  keysOf,
  needlesOf,
  parseExpect,
  readReport,
} from "./checks.ts";
import type { Rung } from "./state.ts";

/** Generated check bots: run state, ignored by git and rewritten each time. */
export const CHECK_BOT_DIR = ".studio/bot/checks";

export type CheckOutcome = {
  /** Index into the rung's checks. */
  readonly k: number;
  readonly what: string;
  readonly pass: boolean;
  readonly evidence: string;
  /** The check run's last frame (where the scenario ended), "" when none was taken. */
  readonly frame: string;
};

export const runStateChecks = (
  game: GameService.GameService["Service"],
  root: string,
  rung: Pick<Rung, "id" | "checks">,
): Effect.Effect<ReadonlyArray<CheckOutcome>> =>
  Effect.forEach(
    rung.checks.flatMap((c, k) => (c.kind === "state" ? [{ c, k }] : [])),
    ({ c, k }) =>
      Effect.gen(function* () {
        const fail = (evidence: string): CheckOutcome => ({
          k,
          what: c.what,
          pass: false,
          evidence,
          frame: "",
        });
        const parsed = parseExpect(c.expect ?? "");
        if ("error" in parsed) return fail(`the check's expect does not read: ${parsed.error}`);
        const input = c.input ?? [];
        const file = `${CHECK_BOT_DIR}/rung-${rung.id}-${k + 1}.mjs`;
        const source = checkBot({
          what: c.what,
          from: c.from ?? "play",
          setup: c.setup ?? null,
          input,
          keys: keysOf(parsed.terms),
          needles: needlesOf(parsed.terms),
        });
        const written = yield* Effect.tryPromise(async () => {
          await NodeFSP.mkdir(NodePath.join(root, CHECK_BOT_DIR), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(root, file), source);
        }).pipe(Effect.result);
        if (written._tag === "Failure") return fail("the check bot could not be written");
        // Boot, leaving the title, the scenario and its settle, with room to spare.
        const seconds = Math.ceil(inputMs(input) / 1000) + 30;
        const ran = yield* game.botRunIn(root, { file, seconds, mode: "play" }).pipe(Effect.result);
        if (ran._tag === "Failure")
          return fail(`the check could not run: ${String(ran.failure.message).slice(0, 300)}`);
        const result = ran.success;
        const seen = readReport(result.status.note);
        if (seen === null)
          return fail(
            `the scenario did not finish in ${seconds} s (${result.status.state}; ${result.status.note.slice(0, 200)})`,
          );
        const verdict = evaluate(parsed.terms, seen);
        const title =
          (seen.stuckOnTitle ?? 0) > 0
            ? `the scenario meant to start in a run never left the title (Enter pressed ${seen.stuckOnTitle} times; make Enter start a run from the title, or start the check from the title); `
            : "";
        const missing =
          verdict.missing.length === 0
            ? ""
            : `; the game reports no ${verdict.missing.join(", ")} (expose it in its game state)`;
        return {
          k,
          what: c.what,
          pass: verdict.pass,
          evidence: `${title}${verdict.detail}${missing}`.slice(0, 600),
          frame: result.frames.at(-1) ?? "",
        };
      }),
    { concurrency: 1 },
  );
