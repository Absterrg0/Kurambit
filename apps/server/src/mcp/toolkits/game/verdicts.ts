// Each game op's verdict from its answer as encoded: the first line's numbers, the findings, and
// a `next:` only when there is an error to fix first. An op without its own reads "done".
import type { Verdict } from "./results.ts";

type Answer = Record<string, any>;
const num = (value: unknown, digits = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "?";
const firstSentence = (text: unknown) =>
  typeof text === "string" ? (text.split(/(?<=[.!?])\s/)[0] ?? "").trim() : "";
const issueLine = (issue: Answer) =>
  [issue.message ?? issue.text ?? JSON.stringify(issue), issue.file ?? issue.where ?? ""]
    .filter((part) => part !== "")
    .join(" at ");

/** A look's verdict; a final is a look with the status line. */
const check = (answer: Answer): Verdict => {
  const errors: ReadonlyArray<Answer> = answer.errors ?? [];
  const numbers = [
    answer.ok === true ? "boots" : "does not boot",
    `${errors.length} error${errors.length === 1 ? "" : "s"}`,
    ...(typeof answer.performance === "string" ? [answer.performance] : []),
    ...(answer.status === undefined ? [] : [answer.status]),
  ];
  const next = errors.length > 0 ? "fix the first error where it points." : undefined;
  return {
    line: numbers.join(" · "),
    findings: errors.map(issueLine),
    notes: typeof answer.fresh === "string" ? answer.fresh.split("\n") : [],
    ...(next === undefined ? {} : { next }),
    said: ["errors", "performance", "fresh"],
  };
};

const outcome = (play: Answer | null | undefined) =>
  play == null
    ? "still playing"
    : `${play.left === true ? "left" : play.won === true ? "won" : "lost"} at ${num(play.seconds)} s`;

const VERDICTS: Readonly<Record<string, (answer: Answer) => Verdict>> = {
  "game_check.look": check,
  "game_check.final": check,
  "game_play.act": (answer) => ({
    line: `${num(answer.nominalMs)} ms of play${
      answer.probe?.gameState?.state === undefined ? "" : ` · state ${answer.probe.gameState.state}`
    }`,
    findings: (answer.consoleMessages ?? [])
      .filter((message: Answer) => message.type === "error")
      .map((message: Answer) => message.text),
    said: ["message"],
  }),
  "game_play.close": (answer) => ({
    line: `closed after ${answer.actions ?? 0} acts, ${num(answer.totalNominalMs)} ms of play`,
    said: ["message"],
  }),
  "game_play.replay": (answer) =>
    answer.run !== undefined && answer.at !== undefined
      ? {
          line: `run ${answer.run} at ${num(answer.at, 1)} s: ${answer.ended === null ? "in play" : outcome(answer.ended)}${answer.differs === null ? "" : ` · differs from ${num(answer.differs?.seconds, 1)} s`}`,
        }
      : Array.isArray(answer.plays)
        ? {
            line: `${answer.plays.length} saved plays replayed`,
            findings: answer.plays.map(
              (play: Answer) => `${play.name}: ${outcome(play.now ?? play.outcome)}`,
            ),
          }
        : {
            line: `${Array.isArray(answer.saved) ? answer.saved.length : "?"} saved plays`,
          },
  "game_play.eval": (answer) => ({
    line: `${typeof answer.value} value${answer.truncated === true ? " (cut to fit)" : ""}`,
  }),
  "game_play.model_sheet": (answer) => ({
    line: `${(answer.sheets ?? []).length} sheets${(answer.missing ?? []).length > 0 ? ` · missing ${(answer.missing as Array<string>).join(", ")}` : ""}`,
  }),
  "game_blender.code": (answer) => ({
    line: `ran · ${String(answer.output ?? "").split("\n").length} lines of output`,
  }),
  "game_blender.look": (answer) => ({
    line: `${answer.screenshot === undefined ? 0 : 1} picture${answer.review === undefined ? "" : " · reviewed"}`,
    ...(typeof answer.fresh === "string"
      ? { notes: answer.fresh.split("\n"), said: ["fresh"] }
      : {}),
  }),
  "game_blender.export": (answer) => ({
    line: `${answer.file ?? answer.path ?? "exported"}${answer.triangles === undefined ? "" : ` · ${answer.triangles} triangles`}`,
  }),
  "game_builds.list": (answer) => ({
    line: `${(answer.builds ?? []).length} builds, newest first${answer.current == null ? "" : ` · folder at ${answer.current}`}`,
  }),
  "game_builds.undo": (answer) => ({
    line:
      answer._tag === "undone"
        ? firstSentence(answer.message)
        : "nothing moved: later work changed the same lines",
  }),
};

/**
 * The verdict of an op that has none of its own: the first sentence of its message, which then
 * leaves the details.
 */
export const verdictOf = (tool: string, op: string, answer: Answer): Verdict =>
  VERDICTS[`${tool}.${op}`]?.(answer) ?? {
    line: firstSentence(answer.message) || "done",
    findings:
      typeof answer.message === "string"
        ? answer.message
            .slice(firstSentence(answer.message).length)
            .split(/(?<=[.!?])\s+/)
            .map((sentence: string) => sentence.trim())
            .filter((sentence: string) => sentence !== "")
        : [],
    said: ["message"],
  };
