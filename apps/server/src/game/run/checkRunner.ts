// @effect-diagnostics nodeBuiltinImport:off -- Writes the generated check bots beside the game's own bots.
// Scores a rung's state checks on the build checked out in the game root: one
// generated bot per check, run by the shared bot service (so every engine, the
// video and the last frame come for free), judged here by code.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type { GameRunCheckOutcome } from "@kurambit/contracts";
import { plainReason } from "@kurambit/contracts";
import type * as GameService from "../GameService.ts";
import {
  CANNOT_VERIFY,
  checkBot,
  evaluate,
  inputMs,
  keysOf,
  needlesOf,
  parseExpect,
  readReport,
} from "./checks.ts";
import { measuring, toolFailed } from "./handBack.ts";
import type { Rung } from "./state.ts";

/** Generated check bots: run state, ignored by git and rewritten each time. */
export const CHECK_BOT_DIR = ".studio/bot/checks";

export type CheckOutcome = GameRunCheckOutcome;

// What the game did under the scenario, in the bot's harness-measured words.
const GAME_ENDED: Readonly<Record<string, string>> = {
  crashed: "the game crashed during the scenario",
  unresponsive: "the game stopped answering during the scenario",
  "not-booted": "the game did not boot",
};

/**
 * Every check is scored on what the game did, or not at all: a game that
 * crashes, freezes, never boots or never reports the keys fails its check; a
 * check the harness could not run (its bot, the bot service, memory, another
 * operation) fails the whole step as not measured, so no check is passed or
 * failed on it. Writing a check's bot is the run's own work.
 */
export const runStateChecks = (
  game: GameService.GameService["Service"],
  root: string,
  rung: Pick<Rung, "id" | "checks">,
) =>
  Effect.forEach(
    rung.checks.flatMap((c, k) => (c.kind === "state" ? [{ c, k }] : [])),
    ({ c, k }) =>
      Effect.gen(function* () {
        const what = `state check ${k + 1}`;
        const fail = (evidence: string): CheckOutcome => ({
          k,
          what: c.what,
          pass: false,
          evidence,
          frame: "",
        });
        const parsed = parseExpect(c.expect ?? "");
        if ("error" in parsed)
          return fail(`${CANNOT_VERIFY}its expect does not read: ${parsed.error}`);
        // An older ladder's check from a setup state: checks now start from the title or play.
        if (c.setup !== undefined || c.values !== undefined)
          return fail(`${CANNOT_VERIFY}it starts from a setup state, which checks no longer use`);
        const input = c.input ?? [];
        const file = `${CHECK_BOT_DIR}/rung-${rung.id}-${k + 1}.mjs`;
        const source = checkBot({
          what: c.what,
          from: c.from ?? "play",
          input,
          keys: keysOf(parsed.terms),
          needles: needlesOf(parsed.terms),
        });
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(NodePath.join(root, CHECK_BOT_DIR), { recursive: true });
            await NodeFSP.writeFile(NodePath.join(root, file), source);
          },
          catch: (cause) => toolFailed(`${what} (its bot file)`, cause, { roots: [root] }),
        });
        // Boot, leaving the title, the scenario and its settle, with room to spare.
        const seconds = Math.ceil(inputMs(input) / 1000) + 30;
        const ran = yield* game.botRunIn(root, { file, seconds, mode: "play" }).pipe(
          measuring(what, [root]),
          Effect.map((result) => ({ _tag: "ran" as const, result })),
          Effect.catchTags({
            // The game would not boot under the scenario: the build's.
            GameRunBuildFault: (fault) =>
              Effect.succeed({
                _tag: "did-not-boot" as const,
                detail: plainReason(fault.error.detail ?? fault.error.reason, [root]),
              }),
          }),
        );
        if (ran._tag === "did-not-boot") return fail(`the game did not boot (${ran.detail})`);
        const result = ran.result;
        // Our generated bot that never ran, or a run that was stopped, measured nothing.
        if (result.played === false)
          return yield* toolFailed(what, `the check bot did not run: ${result.status.note}`, {
            standing: true,
            roots: [root],
          });
        if (result.status.state === "stopped")
          return yield* toolFailed(what, "the check's bot run was stopped");
        if (result.status.state === "bot-error")
          return yield* toolFailed(what, `the check bot broke: ${result.status.note}`, {
            standing: true,
            roots: [root],
          });
        const ended = GAME_ENDED[result.status.state];
        const frame = result.frames.at(-1) ?? "";
        if (ended !== undefined)
          return {
            ...fail(`${ended} (${plainReason(result.status.note, [root])})`.slice(0, 600)),
            frame,
          };
        if (result.status.state !== "done")
          return {
            ...fail(
              `the scenario did not finish in ${seconds} s (${result.status.state}; ${plainReason(result.status.note, [root]).slice(0, 200)})`,
            ),
            frame,
          };
        const seen = readReport(result.status.evidence);
        // The report is ours and bounded to fit: one missing is our fault, which waiting cannot clear.
        if (seen === null)
          return yield* toolFailed(what, "the check bot finished without its report", {
            standing: true,
          });
        const verdict = evaluate(parsed.terms, seen);
        const title =
          (seen.stuckOnTitle ?? 0) > 0
            ? `the scenario meant to start in a run never left the title (Enter pressed ${seen.stuckOnTitle} times; make Enter start a run from the title, or start the check from the title); `
            : "";
        const missing =
          verdict.missing.length === 0
            ? ""
            : `; the game reports no ${verdict.missing.join(", ")} (expose it in its game state)`;
        const cut =
          (seen.cut ?? []).length === 0
            ? ""
            : `; the report cut ${(seen.cut ?? []).join(", ")} to its first 60 characters (lists and objects are read as their JSON text)`;
        return {
          k,
          what: c.what,
          pass: verdict.pass,
          evidence: `${title}${verdict.detail}${missing}${cut}`.slice(0, 600),
          frame,
        };
      }),
    { concurrency: 1 },
  );
