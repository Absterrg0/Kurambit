// Each game op's verdict from its answer as encoded: the first line's numbers, the findings, and
// the `next:` the server writes from the state. An op without its own reads "done".
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

const check =
  (final: boolean) =>
  (answer: Answer): Verdict => {
    const errors: ReadonlyArray<Answer> = answer.errors ?? [];
    const qa: ReadonlyArray<string> =
      answer.qa?.status === "measured" ? (answer.qa.problems ?? []) : [];
    const screens: ReadonlyArray<string> =
      answer.screens?.status === "measured" ? (answer.screens.problems ?? []) : [];
    const scene: ReadonlyArray<string> =
      answer.scene?.status === "measured" ? (answer.scene.lines ?? []) : [];
    const problems = [...qa, ...screens];
    const numbers = [
      answer.ok === true ? "boots" : "does not boot",
      `${errors.length} error${errors.length === 1 ? "" : "s"}`,
      ...(final ? [`${problems.length} QA problem${problems.length === 1 ? "" : "s"}`] : []),
      ...(typeof answer.performance === "string" ? [answer.performance] : []),
      ...(answer.status === undefined ? [] : [answer.status]),
    ];
    const next =
      errors.length > 0
        ? "fix the first error where it points, then look again."
        : final && problems.length > 0
          ? "fix each QA problem (they are bugs), then run final again."
          : final
            ? "if the critique of the frame finds nothing major, end the turn: what changed, then a Next: line."
            : answer.review === undefined
              ? "critique the frame as your first look's review said, fix the biggest gap, look again; final before you end the turn."
              : "write the critique the review asks for, fix the biggest gap, look again; final before you end the turn.";
    return {
      line: numbers.join(" · "),
      findings: [...errors.map(issueLine), ...problems, ...(final ? scene : [])],
      next,
      said: ["errors", "performance", "qa.problems", "screens.problems", "scene.lines"],
    };
  };

const outcome = (play: Answer | null | undefined) =>
  play == null
    ? "still playing"
    : `${play.left === true ? "left" : play.won === true ? "won" : "lost"} at ${num(play.seconds)} s`;

export const VERDICTS: Readonly<Record<string, (answer: Answer) => Verdict>> = {
  "game_check.look": check(false),
  "game_check.final": check(true),
  "game_play.act": (answer) => ({
    line: `${num(answer.nominalMs)} ms of play · ${answer.callsLeft ?? "?"} acts left${
      answer.probe?.gameState?.state === undefined ? "" : ` · state ${answer.probe.gameState.state}`
    }`,
    findings: (answer.consoleMessages ?? [])
      .filter((message: Answer) => message.type === "error")
      .map((message: Answer) => message.text),
    next: `act again with sessionId "${answer.sessionId}", or close it.`,
    said: ["message"],
  }),
  "game_play.close": (answer) => ({
    line: `closed after ${answer.actions ?? 0} acts, ${num(answer.totalNominalMs)} ms of play`,
    next: "none.",
    said: ["message"],
  }),
  "game_play.bot": (answer) => {
    const play = answer.play as string | undefined;
    const won = answer.status?.won === true || answer.status?.outcome === "won";
    return {
      line: `${answer.status?.label ?? answer.status?.state ?? "ended"} · ${num(answer.gameSeconds, 1)} s of game in ${num(answer.wallSeconds, 1)} s${play === undefined ? "" : ` · play ${play}`}`,
      findings: (answer.findings ?? []).map(
        (finding: Answer) => `${finding.summary} (${num(finding.t, 1)} s)`,
      ),
      next:
        won && play !== undefined
          ? `save it: game_play {"replay": {"save": "<name>", "run": "${play}"}}.`
          : "read the findings, fix the game or the bot, and run it again.",
      said: ["findings", "message"],
    };
  },
  "game_play.replay": (answer) =>
    answer.run !== undefined && answer.at !== undefined
      ? {
          line: `run ${answer.run} at ${num(answer.at, 1)} s: ${answer.ended === null ? "in play" : outcome(answer.ended)}${answer.differs === null ? "" : ` · differs from ${num(answer.differs?.seconds, 1)} s`}`,
          next: "look at the frame; another moment is the same call with a new at.",
        }
      : Array.isArray(answer.plays)
        ? {
            line: `${answer.plays.length} saved plays replayed`,
            findings: answer.plays.map(
              (play: Answer) => `${play.name}: ${outcome(play.now ?? play.outcome)}`,
            ),
            next: "none.",
          }
        : {
            line: `${Array.isArray(answer.saved) ? answer.saved.length : "?"} saved plays`,
            next: "none: every build replays the saved plays.",
          },
  "game_play.eval": (answer) => ({
    line: `${typeof answer.value} value${answer.truncated === true ? " (cut to fit)" : ""}`,
    next: "none.",
  }),
  "game_play.model_sheet": (answer) => ({
    line: `${(answer.sheets ?? []).length} sheets${(answer.missing ?? []).length > 0 ? ` · missing ${(answer.missing as Array<string>).join(", ")}` : ""}`,
    next: "compare each side with the reference, fix the largest difference, sheet it again.",
  }),
  "game_blender.code": (answer) => ({
    line: `ran · ${String(answer.output ?? "").split("\n").length} lines of output`,
    next: "game_blender look to see the scene.",
  }),
  "game_blender.look": (answer) => ({
    line: `${(answer.screenshots ?? []).length} picture(s)${answer.review === undefined ? "" : " · reviewed"}`,
    next:
      answer.review === undefined
        ? 'look with mode "review" at the objects you will export.'
        : "export the reviewed objects, or fix what the review shows and look again.",
  }),
  "game_blender.export": (answer) => ({
    line: `${answer.file ?? answer.path ?? "exported"}${answer.triangles === undefined ? "" : ` · ${answer.triangles} triangles`}`,
    next: "load it in the game from where it is, then game_check.",
  }),
  "game_builds.list": (answer) => ({
    line: `${(answer.builds ?? []).length} builds, newest first${answer.current == null ? "" : ` · folder at ${answer.current}`}`,
    next: "none; undo only when the person asks.",
  }),
  "game_builds.undo": (answer) => ({
    line:
      answer._tag === "undone"
        ? firstSentence(answer.message)
        : "nothing moved: later work changed the same lines",
    next: answer._tag === "undone" ? "none." : "tell the person; they can go back to a build.",
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
    next: "none.",
    said: ["message"],
  };
