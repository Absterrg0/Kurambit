// @effect-diagnostics nodeBuiltinImport:off -- Maintainer report: reads earlier runs and writes static files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  gameFactsView,
  type GameBuildFacts,
  type GameCheckResult,
  type ModelSelection,
} from "../../packages/contracts/src/index.ts";
import { CRITERIA, CRITERION_LABELS, THRESHOLDS, type GameScore, type Verdict } from "./score.ts";

/** A watched or shown fact that moved between two builds, worded as the facts view words it. */
export interface BenchFactMove {
  readonly id: string;
  readonly label: string;
  readonly a: string | null;
  readonly b: string | null;
}

/** One keep-going step as the run recorded it, and its facts against the build it started from. */
export interface BenchStep {
  readonly n: number;
  readonly why: string;
  readonly text: string;
  /** kept, undone, kept-moved-on, no-change, not-measured or stopped. */
  readonly verdict: string | null;
  readonly reason: string;
  readonly gain: boolean;
  readonly minutes: number | null;
  /** Input + output, as the provider reported them. */
  readonly tokens: number | null;
  readonly build: string | null;
  readonly base: string | null;
  readonly improved: ReadonlyArray<BenchFactMove>;
  readonly regressed: ReadonlyArray<BenchFactMove>;
  /** A frame of the step build's random-input play, for a person to look at; never scored. */
  readonly frame: string | null;
}

/** Phase 2: keep going on the first turn's game. No score: what the steps did, and what it cost. */
export interface BenchKeepGoing {
  readonly asked: number;
  /** Why the run ended before the bench stopped it; null when the bench stopped it. */
  readonly ending: string | null;
  readonly seconds: number;
  readonly steps: ReadonlyArray<BenchStep>;
  readonly first: string;
  readonly final: string | null;
  /** The game's last build against its first turn's. */
  readonly net: {
    readonly improved: ReadonlyArray<BenchFactMove>;
    readonly regressed: ReadonlyArray<BenchFactMove>;
  };
  /** Phase 1's floor read on the last build, for comparison; not part of the run's score. */
  readonly finalScore: GameScore | null;
}

export interface BenchGame {
  readonly id: string;
  readonly genre: string;
  readonly name: string;
  readonly brief: string;
  readonly root: string | null;
  readonly threadId: string | null;
  readonly turn: {
    readonly status: string;
    /** The turn's own wall time, from the server's run record. */
    readonly seconds: number | null;
    /** From sending the brief to the turn's end. */
    readonly sinceBriefSeconds: number | null;
    /** The agent's closing message, cut to a paragraph. */
    readonly lastMessage: string | null;
    readonly usage: {
      readonly input: number;
      readonly cached: number;
      readonly output: number;
      readonly providerTurns: number;
      /** Provider turns whose usage was partial or missing: totals undercount. */
      readonly partial: number;
    } | null;
  };
  readonly build: {
    readonly id: string;
    readonly summary: string;
    readonly files: ReadonlyArray<string>;
  } | null;
  readonly facts: GameBuildFacts | null;
  readonly check: {
    readonly calls: number;
    readonly result: GameCheckResult | null;
    /** Why the last check gave no result (busy, tool failed …). */
    readonly refused: string | null;
    readonly raw: unknown;
  };
  readonly shots: ReadonlyArray<string>;
  readonly shotsFrom: string | null;
  /** How long the first build's facts took once seen measuring; absent in older runs. */
  readonly factsSeconds?: number | null;
  readonly score: GameScore;
  /** Absent in older runs; null when the run asked for no steps. */
  readonly keepGoing?: BenchKeepGoing | { readonly skipped: string } | null;
  readonly error?: string;
}

export interface BenchRun {
  readonly stamp: string;
  readonly startedAt: string;
  readonly seconds: number;
  readonly commit: string;
  readonly briefsVersion: number;
  /** Absent in runs from before the score had a version. */
  readonly scoreVersion?: number;
  readonly model: ModelSelection | null;
  readonly games: ReadonlyArray<BenchGame>;
}

const mark = (verdict: Verdict) =>
  verdict.result === "pass" ? "✓" : verdict.result === "fail" ? "✗" : "–";

const minutes = (s: number | null) => (s === null ? "–" : `${(s / 60).toFixed(1)} min`);
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);

function totals(run: BenchRun) {
  const passed = run.games.reduce((sum, game) => sum + game.score.passed, 0);
  const failed = run.games.reduce((sum, game) => sum + game.score.failed, 0);
  const measured = run.games.reduce((sum, game) => sum + game.score.measured, 0);
  const possible = run.games.reduce((sum, game) => sum + game.score.total, 0);
  const byCriterion = Object.fromEntries(
    CRITERIA.map((criterion) => [
      criterion,
      run.games.filter((game) => game.score.verdicts[criterion].result === "pass").length,
    ]),
  ) as Record<(typeof CRITERIA)[number], number>;
  const usage = run.games.reduce(
    (sum, game) => ({
      input: sum.input + (game.turn.usage?.input ?? 0),
      cached: sum.cached + (game.turn.usage?.cached ?? 0),
      output: sum.output + (game.turn.usage?.output ?? 0),
      partial: sum.partial + (game.turn.usage?.partial ?? 0),
    }),
    { input: 0, cached: 0, output: 0, partial: 0 },
  );
  const turnSeconds = run.games.reduce((sum, game) => sum + (game.turn.seconds ?? 0), 0);
  return { passed, failed, measured, possible, byCriterion, usage, turnSeconds };
}

/** The newest earlier run in the same folder, by its date-stamped name. */
async function previousRun(outRoot: string, stamp: string): Promise<BenchRun | null> {
  const names = await NodeFSP.readdir(outRoot).catch(() => [] as Array<string>);
  for (const name of names
    .filter((n) => n < stamp)
    .toSorted()
    .toReversed()) {
    const text = await NodeFSP.readFile(NodePath.join(outRoot, name, "results.json"), "utf8").catch(
      () => null,
    );
    if (text !== null) return JSON.parse(text) as BenchRun;
  }
  return null;
}

const signed = (n: number) => (n > 0 ? `+${n}` : n === 0 ? "±0" : String(n));
/** A floor as "passed / measured", with what could not be measured beside it. */
const floor = (score: { passed: number; measured: number; possible: number }) =>
  `${score.passed} / ${score.measured} measured${score.possible > score.measured ? ` (${score.possible - score.measured} not measured)` : ""}`;
const gameFloor = (score: GameScore) =>
  floor({ passed: score.passed, measured: score.measured, possible: score.total });

const phase2 = (game: BenchGame): BenchKeepGoing | null =>
  game.keepGoing === undefined || game.keepGoing === null || "skipped" in game.keepGoing
    ? null
    : game.keepGoing;

/** Keep going across the run: how its steps ended, what they cost, and which facts they moved. */
function keepGoingTotals(run: BenchRun) {
  const runs = run.games.flatMap((game) => {
    const kg = phase2(game);
    return kg === null ? [] : [kg];
  });
  const steps = runs.flatMap((kg) => kg.steps);
  const count = (verdict: string) => steps.filter((step) => step.verdict === verdict).length;
  const kept = count("kept");
  const tokensAll = steps.reduce((sum, step) => sum + (step.tokens ?? 0), 0);
  const minutesAll = steps.reduce((sum, step) => sum + (step.minutes ?? 0), 0);
  const tally = (moves: ReadonlyArray<BenchFactMove>) => {
    const by = new Map<string, number>();
    for (const move of moves) by.set(move.label, (by.get(move.label) ?? 0) + 1);
    return [...by.entries()].toSorted((a, b) => b[1] - a[1]);
  };
  const keptSteps = steps.filter((step) => step.verdict === "kept");
  return {
    games: runs.length,
    steps: steps.length,
    kept,
    undone: count("undone"),
    noChange: count("no-change"),
    notMeasured: count("not-measured"),
    other: steps.length - kept - count("undone") - count("no-change") - count("not-measured"),
    tokens: tokensAll,
    minutes: minutesAll,
    tokensPerKept: kept === 0 ? null : tokensAll / kept,
    minutesPerKept: kept === 0 ? null : minutesAll / kept,
    /** What kept steps made better and worse (kept-but-worse is a fact keep going does not guard). */
    improved: tally(keptSteps.flatMap((step) => step.improved)),
    regressed: tally(keptSteps.flatMap((step) => step.regressed)),
    /** What the undone steps made worse: why they were undone. */
    undoneFor: tally(
      steps.filter((step) => step.verdict === "undone").flatMap((step) => step.regressed),
    ),
    netImproved: tally(runs.flatMap((kg) => kg.net.improved)),
    netRegressed: tally(runs.flatMap((kg) => kg.net.regressed)),
  };
}

const moveText = (move: BenchFactMove) => `${move.label} (${move.a ?? "?"} → ${move.b ?? "?"})`;
const tallyText = (tally: ReadonlyArray<readonly [string, number]>) =>
  tally.length === 0 ? "none" : tally.map(([label, n]) => `${label} ×${n}`).join(", ");
const perKept = (value: number | null, unit: (n: number) => string) =>
  value === null ? "no step kept" : unit(value);

function keepGoingHtml(game: BenchGame): string {
  if (game.keepGoing === undefined || game.keepGoing === null) return "";
  if ("skipped" in game.keepGoing)
    return `<h3>Keep going</h3><p class="meta">Not run: ${escape(game.keepGoing.skipped)}</p>`;
  const kg = game.keepGoing;
  const rows = kg.steps
    .map(
      (step) =>
        `<tr><td>${step.n}</td><td>${step.frame === null ? "" : `<img src="${escape(step.frame)}" alt="" loading="lazy">`}</td><td><b>${escape(step.verdict ?? "in flight")}</b> · ${escape(step.why)}<br>${escape(step.text)}<br><span class="meta">${escape(step.reason)}</span></td><td>${step.improved.map((m) => `<div>↑ ${escape(moveText(m))}</div>`).join("")}${step.regressed.map((m) => `<div>↓ ${escape(moveText(m))}</div>`).join("")}</td><td>${step.minutes === null ? "–" : `${step.minutes} min`}<br>${step.tokens === null ? "–" : tokens(step.tokens)}</td></tr>`,
    )
    .join("");
  return `<h3>Keep going: ${kg.steps.length} of ${kg.asked} step(s)${kg.ending === null ? "" : `, ended ${escape(kg.ending)}`}</h3>
<p class="meta">${minutes(kg.seconds)} · first build → last: ${kg.net.improved.length === 0 ? "nothing better" : `better ${escape(kg.net.improved.map(moveText).join("; "))}`}; ${kg.net.regressed.length === 0 ? "nothing worse" : `worse ${escape(kg.net.regressed.map(moveText).join("; "))}`}${kg.finalScore === null ? "" : ` · floor on the last build ${gameFloor(kg.finalScore)}`}</p>
<table class="steps"><tbody>${rows}</tbody></table>`;
}

function checkLines(game: BenchGame): Array<string> {
  if (game.check.calls === 0) return ["The agent never ran game_check."];
  const result = game.check.result;
  if (result === null)
    return [
      `game_check ran ${game.check.calls}×; the last gave no result: ${game.check.refused ?? "unreadable"}`,
    ];
  const lines = [
    `game_check ran ${game.check.calls}×; the last: ${result.ok ? "ok" : "not ok"}, ${result.errors.length} error(s), ${result.warnings.length} warning(s).`,
    ...result.errors.slice(0, 3).map((issue) => `error: ${issue.message.slice(0, 200)}`),
  ];
  // Whatever else a newer check reports (the scene report) is shown as it came.
  const extra = Object.entries(result).filter(
    ([key]) => !["ok", "errors", "warnings", "entries", "durationMs"].includes(key),
  );
  for (const [key, value] of extra) lines.push(`${key}: ${JSON.stringify(value).slice(0, 600)}`);
  return lines;
}

function factLines(game: BenchGame): Array<string> {
  if (game.facts === null) return [];
  return gameFactsView(game.facts).map((view) =>
    view.reading._tag === "measured"
      ? `${view.label}: ${view.reading.text}`
      : view.reading._tag === "pending"
        ? `${view.label}: pending`
        : `${view.label}: not measured (${view.reading.why})`,
  );
}

/** A game's verdicts grouped by their reason, so one missing build reads once, not five times. */
function byReason(game: BenchGame) {
  const groups: Array<{ detail: string; criteria: Array<(typeof CRITERIA)[number]> }> = [];
  for (const criterion of CRITERIA) {
    const detail = game.score.verdicts[criterion].detail;
    const group = groups.find((candidate) => candidate.detail === detail);
    if (group) group.criteria.push(criterion);
    else groups.push({ detail, criteria: [criterion] });
  }
  return groups;
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function html(run: BenchRun, previous: BenchRun | null, note: string | null): string {
  const t = totals(run);
  const p = previous === null ? null : totals(previous);
  const prevGame = (id: string) => previous?.games.find((game) => game.id === id) ?? null;
  const rows = run.games
    .map((game) => {
      const before = prevGame(game.id);
      const criteria = byReason(game)
        .map(
          (group) =>
            `<li>${group.criteria.map((c) => `${mark(game.score.verdicts[c])} ${escape(CRITERION_LABELS[c])}`).join(", ")}: ${escape(group.detail)}</li>`,
        )
        .join("");
      const shots =
        game.shots.length === 0
          ? "<p>No screenshots.</p>"
          : `<div class="shots">${game.shots.map((shot) => `<img src="${escape(shot)}" alt="" loading="lazy">`).join("")}</div>`;
      const usage = game.turn.usage;
      return `<section>
<h2>${escape(game.name)} <span>${escape(game.genre)}</span></h2>
<p class="brief">${escape(game.brief)}</p>
<p class="score">${gameFloor(game.score)}${before === null ? "" : ` (${signed(game.score.passed - before.score.passed)} passed, ${signed(game.score.failed - before.score.failed)} failed from the previous run)`}</p>
${shots}
<ul class="criteria">${criteria}</ul>
<p>Turn: ${escape(game.turn.status)}, ${minutes(game.turn.seconds)}${game.factsSeconds == null ? "" : `; facts ${Math.round(game.factsSeconds)} s`}${usage === null ? "" : `, ${tokens(usage.input)} input (${tokens(usage.cached)} cached), ${tokens(usage.output)} output${usage.partial > 0 ? `, ${usage.partial} turn(s) with partial usage` : ""}`}.${game.error ? ` Runner error: ${escape(game.error)}` : ""}</p>
${game.turn.lastMessage === null ? "" : `<blockquote>${escape(game.turn.lastMessage)}</blockquote>`}
${keepGoingHtml(game)}
<details><summary>Facts and check</summary>
<ul>${factLines(game)
        .map((line) => `<li>${escape(line)}</li>`)
        .join("")}</ul>
<ul>${checkLines(game)
        .map((line) => `<li>${escape(line)}</li>`)
        .join("")}</ul>
${game.root === null ? "" : `<p class="path">${escape(game.root)}</p>`}
</details>
</section>`;
    })
    .join("\n");
  const criteriaTotals = CRITERIA.map(
    (criterion) =>
      `<tr><td>${escape(CRITERION_LABELS[criterion])}</td><td>${t.byCriterion[criterion]} / ${run.games.length}</td><td>${p === null ? "" : signed(t.byCriterion[criterion] - p.byCriterion[criterion])}</td></tr>`,
  ).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bench ${escape(run.stamp)}</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#6b6862;--rule:#dedbd3}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#e9e6df;--muted:#9a968d;--rule:#33312d}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1040px;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0}h2 span{color:var(--muted);font-weight:400;font-size:14px;margin-left:6px}
p{margin:6px 0}.meta,.brief,.path{color:var(--muted)}.score{font-size:20px;font-variant-numeric:tabular-nums}
section{border-top:1px solid var(--rule);padding:18px 0}
.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0}.shots img{width:100%;height:auto;display:block}
h3{font-size:15px;margin:14px 0 4px}.steps td{vertical-align:top;padding:6px 12px 6px 0;font-size:14px}.steps img{width:200px;height:auto;display:block}
ul{margin:6px 0;padding-left:18px}.criteria{list-style:none;padding:0}
table{border-collapse:collapse;margin:10px 0}td{padding:2px 14px 2px 0;font-variant-numeric:tabular-nums}
details summary{cursor:pointer;color:var(--muted)}
blockquote{margin:6px 0;padding-left:12px;border-left:2px solid var(--rule);color:var(--muted);white-space:pre-wrap}
@media (max-width:560px){.shots{grid-template-columns:1fr}.steps img{width:120px}}
</style></head><body>
<h1>First ten minutes: ${floor(t)}</h1>
<p class="meta">${escape(run.stamp)} · commit ${escape(run.commit)} · ${escape(run.model ? `${run.model.instanceId}/${run.model.model}` : "no model")} · briefs v${run.briefsVersion} · ${run.games.length} games · run ${minutes(run.seconds)} · turns ${minutes(t.turnSeconds)} · ${tokens(t.usage.input)} input (${tokens(t.usage.cached)} cached), ${tokens(t.usage.output)} output${t.usage.partial > 0 ? ` (${t.usage.partial} provider turns reported partial usage)` : ""}</p>
<p class="meta">${previous === null ? escape(note ?? "") : `Previous run ${escape(previous.stamp)} (commit ${escape(previous.commit)}): ${floor(p!)}; ${signed(t.passed - p!.passed)} passed, ${signed(t.failed - p!.failed)} failed.`}</p>
<table><tbody>${criteriaTotals}</tbody></table>
<p class="meta">✓ pass · ✗ fail · – not measured. Thresholds: ends no sooner than ${THRESHOLDS.instantEndSeconds} s with no skill, ${THRESHOLDS.minFps} fps, playable within ${THRESHOLDS.firstPlayableSeconds} s of the brief.</p>
${keepGoingSummaryHtml(run)}
${rows}
</body></html>
`;
}

function keepGoingSummaryHtml(run: BenchRun): string {
  const k = keepGoingTotals(run);
  if (k.games === 0) return "";
  return `<h3>Keep going</h3>
<p>${k.steps} step(s) on ${k.games} game(s): ${k.kept} kept, ${k.undone} undone, ${k.noChange} changed nothing, ${k.notMeasured} kept unjudged${k.other > 0 ? `, ${k.other} other` : ""}. ${perKept(k.tokensPerKept, tokens)} tokens and ${perKept(k.minutesPerKept, (n) => `${n.toFixed(1)} min`)} per kept step.</p>
<p class="meta">Kept steps made better: ${escape(tallyText(k.improved))}; worse: ${escape(tallyText(k.regressed))}. Undone for: ${escape(tallyText(k.undoneFor))}. First build → last: better ${escape(tallyText(k.netImproved))}; worse ${escape(tallyText(k.netRegressed))}.</p>`;
}

function keepGoingMarkdown(run: BenchRun): Array<string> {
  const k = keepGoingTotals(run);
  if (k.games === 0) return [];
  return [
    "## Keep going",
    "",
    `${k.steps} step(s) on ${k.games} game(s): ${k.kept} kept, ${k.undone} undone, ${k.noChange} changed nothing, ${k.notMeasured} kept unjudged${k.other > 0 ? `, ${k.other} other` : ""}. ${perKept(k.tokensPerKept, tokens)} tokens and ${perKept(k.minutesPerKept, (n) => `${n.toFixed(1)} min`)} per kept step (all steps' cost over the kept ones).`,
    "",
    `- Kept steps made better: ${tallyText(k.improved)}; worse: ${tallyText(k.regressed)}`,
    `- Undone for: ${tallyText(k.undoneFor)}`,
    `- First build → last: better ${tallyText(k.netImproved)}; worse ${tallyText(k.netRegressed)}`,
    "",
    "| Game | Step | Verdict | Why | Better | Worse | Min | Tokens | Frame |",
    "|---|---|---|---|---|---|---|---|---|",
    ...run.games.flatMap((game) => {
      const kg = phase2(game);
      if (kg === null)
        return game.keepGoing !== undefined &&
          game.keepGoing !== null &&
          "skipped" in game.keepGoing
          ? [`| ${game.name} | – | not run | ${game.keepGoing.skipped} | | | | | |`]
          : [];
      return kg.steps.map(
        (step) =>
          `| ${game.name} | ${step.n} | ${step.verdict ?? "in flight"} | ${step.why}: ${step.text.replace(/\|/g, "/").slice(0, 90)} | ${step.improved.map((m) => m.label).join(", ")} | ${step.regressed.map((m) => m.label).join(", ")} | ${step.minutes ?? "–"} | ${step.tokens === null ? "–" : tokens(step.tokens)} | ${step.frame ?? ""} |`,
      );
    }),
    "",
  ];
}

function markdown(run: BenchRun, previous: BenchRun | null, note: string | null): string {
  const t = totals(run);
  const p = previous === null ? null : totals(previous);
  const lines = [
    `# Bench ${run.stamp}: ${floor(t)}`,
    "",
    `Commit ${run.commit}, ${run.model ? `${run.model.instanceId}/${run.model.model}` : "no model"}, ${run.games.length} games, run ${minutes(run.seconds)}, turns ${minutes(t.turnSeconds)}, ${tokens(t.usage.input)} input (${tokens(t.usage.cached)} cached), ${tokens(t.usage.output)} output.`,
    previous === null
      ? (note ?? "")
      : `Previous run ${previous.stamp} (${previous.commit}): ${floor(p!)}; ${signed(t.passed - p!.passed)} passed, ${signed(t.failed - p!.failed)} failed.`,
    "",
    `| Game | Score | ${CRITERIA.map((c) => CRITERION_LABELS[c]).join(" | ")} | Turn |`,
    `|---|---|${CRITERIA.map(() => "---").join("|")}|---|`,
    ...run.games.map(
      (game) =>
        `| ${game.name} | ${game.score.passed}/${game.score.measured} | ${CRITERIA.map((c) => mark(game.score.verdicts[c])).join(" | ")} | ${minutes(game.turn.seconds)} |`,
    ),
    `| Total | ${t.passed}/${t.measured} | ${CRITERIA.map((c) => `${t.byCriterion[c]}${p === null ? "" : ` (${signed(t.byCriterion[c] - p.byCriterion[c])})`}`).join(" | ")} | ${minutes(t.turnSeconds)} |`,
    "",
    "## What failed",
    "",
    ...run.games.flatMap((game) => {
      const failed = byReason(game).filter((group) =>
        group.criteria.some((c) => game.score.verdicts[c].result !== "pass"),
      );
      return failed.length === 0
        ? []
        : [
            `- **${game.name}**: ${failed.map((group) => `${group.criteria.map((c) => `${CRITERION_LABELS[c]} ${mark(game.score.verdicts[c])}`).join(", ")}: ${group.detail}`).join("; ")}`,
          ];
    }),
    "",
    ...keepGoingMarkdown(run),
  ];
  return lines.join("\n");
}

/** Why the run before cannot be diffed with this one, or null when it can. */
const incomparable = (run: BenchRun, earlier: BenchRun) =>
  earlier.scoreVersion !== run.scoreVersion
    ? `it was scored by score version ${earlier.scoreVersion ?? 0}, this run by ${run.scoreVersion}`
    : earlier.briefsVersion !== run.briefsVersion
      ? `it ran briefs v${earlier.briefsVersion}, this run v${run.briefsVersion}`
      : null;

export async function writeReport(outRoot: string, runDir: string, run: BenchRun) {
  const earlier = await previousRun(outRoot, run.stamp);
  const why = earlier === null ? null : incomparable(run, earlier);
  const previous = why === null ? earlier : null;
  const note =
    earlier === null
      ? "No earlier run to compare with."
      : why !== null
        ? `Previous run ${earlier.stamp} is not compared: ${why}.`
        : null;
  const htmlPath = NodePath.join(runDir, "report.html");
  const markdownPath = NodePath.join(runDir, "summary.md");
  await NodeFSP.writeFile(htmlPath, html(run, previous, note));
  await NodeFSP.writeFile(markdownPath, markdown(run, previous, note));
  return { html: htmlPath, markdown: markdownPath };
}
