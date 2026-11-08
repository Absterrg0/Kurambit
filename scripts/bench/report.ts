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
    readonly usage: {
      readonly input: number;
      readonly cached: number;
      readonly output: number;
      readonly providerTurns: number;
      /** Provider turns whose usage was partial or missing: totals undercount. */
      readonly partial: number;
    } | null;
  };
  readonly build: { readonly id: string; readonly summary: string } | null;
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
  readonly score: GameScore;
  readonly error?: string;
}

export interface BenchRun {
  readonly stamp: string;
  readonly startedAt: string;
  readonly seconds: number;
  readonly commit: string;
  readonly briefsVersion: number;
  readonly model: ModelSelection | null;
  readonly games: ReadonlyArray<BenchGame>;
}

const mark = (verdict: Verdict) =>
  verdict.result === "pass" ? "✓" : verdict.result === "fail" ? "✗" : "–";

const minutes = (s: number | null) => (s === null ? "–" : `${(s / 60).toFixed(1)} min`);
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);

function totals(run: BenchRun) {
  const passed = run.games.reduce((sum, game) => sum + game.score.passed, 0);
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
  return { passed, possible, byCriterion, usage, turnSeconds };
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

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function html(run: BenchRun, previous: BenchRun | null): string {
  const t = totals(run);
  const p = previous === null ? null : totals(previous);
  const prevGame = (id: string) => previous?.games.find((game) => game.id === id) ?? null;
  const rows = run.games
    .map((game) => {
      const before = prevGame(game.id);
      const criteria = CRITERIA.map((criterion) => {
        const verdict = game.score.verdicts[criterion];
        return `<li>${mark(verdict)} ${escape(CRITERION_LABELS[criterion])}: ${escape(verdict.detail)}</li>`;
      }).join("");
      const shots =
        game.shots.length === 0
          ? "<p>No screenshots.</p>"
          : `<div class="shots">${game.shots.map((shot) => `<img src="${escape(shot)}" alt="" loading="lazy">`).join("")}</div>`;
      const usage = game.turn.usage;
      return `<section>
<h2>${escape(game.name)} <span>${escape(game.genre)}</span></h2>
<p class="brief">${escape(game.brief)}</p>
<p class="score">${game.score.passed} / ${game.score.total}${before === null ? "" : ` (${signed(game.score.passed - before.score.passed)} from the previous run)`}</p>
${shots}
<ul class="criteria">${criteria}</ul>
<p>Turn: ${escape(game.turn.status)}, ${minutes(game.turn.seconds)}${usage === null ? "" : `, ${tokens(usage.input)} input (${tokens(usage.cached)} cached), ${tokens(usage.output)} output${usage.partial > 0 ? `, ${usage.partial} turn(s) with partial usage` : ""}`}.${game.error ? ` Runner error: ${escape(game.error)}` : ""}</p>
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
ul{margin:6px 0;padding-left:18px}.criteria{list-style:none;padding:0}
table{border-collapse:collapse;margin:10px 0}td{padding:2px 14px 2px 0;font-variant-numeric:tabular-nums}
details summary{cursor:pointer;color:var(--muted)}
@media (max-width:560px){.shots{grid-template-columns:1fr}}
</style></head><body>
<h1>First ten minutes: ${t.passed} / ${t.possible}</h1>
<p class="meta">${escape(run.stamp)} · commit ${escape(run.commit)} · ${escape(run.model ? `${run.model.instanceId}/${run.model.model}` : "no model")} · briefs v${run.briefsVersion} · ${run.games.length} games · run ${minutes(run.seconds)} · turns ${minutes(t.turnSeconds)} · ${tokens(t.usage.input)} input (${tokens(t.usage.cached)} cached), ${tokens(t.usage.output)} output${t.usage.partial > 0 ? ` (${t.usage.partial} provider turns reported partial usage)` : ""}</p>
<p class="meta">${previous === null ? "No earlier run to compare with." : `Previous run ${escape(previous.stamp)} (commit ${escape(previous.commit)}): ${p!.passed} / ${p!.possible}, ${signed(t.passed - p!.passed)}.`}</p>
<table><tbody>${criteriaTotals}</tbody></table>
<p class="meta">✓ pass · ✗ fail · – not measured. Thresholds: ends no sooner than ${THRESHOLDS.instantEndSeconds} s with no skill, ${THRESHOLDS.minFps} fps, playable within ${THRESHOLDS.firstPlayableSeconds} s of the brief.</p>
${rows}
</body></html>
`;
}

function markdown(run: BenchRun, previous: BenchRun | null): string {
  const t = totals(run);
  const p = previous === null ? null : totals(previous);
  const lines = [
    `# Bench ${run.stamp}: ${t.passed} / ${t.possible}`,
    "",
    `Commit ${run.commit}, ${run.model ? `${run.model.instanceId}/${run.model.model}` : "no model"}, ${run.games.length} games, run ${minutes(run.seconds)}, turns ${minutes(t.turnSeconds)}, ${tokens(t.usage.input)} input (${tokens(t.usage.cached)} cached), ${tokens(t.usage.output)} output.`,
    previous === null
      ? "No earlier run to compare with."
      : `Previous run ${previous.stamp} (${previous.commit}): ${p!.passed} / ${p!.possible}, ${signed(t.passed - p!.passed)}.`,
    "",
    `| Game | Score | ${CRITERIA.map((c) => CRITERION_LABELS[c]).join(" | ")} | Turn |`,
    `|---|---|${CRITERIA.map(() => "---").join("|")}|---|`,
    ...run.games.map(
      (game) =>
        `| ${game.name} | ${game.score.passed}/${game.score.total} | ${CRITERIA.map((c) => mark(game.score.verdicts[c])).join(" | ")} | ${minutes(game.turn.seconds)} |`,
    ),
    `| Total | ${t.passed}/${t.possible} | ${CRITERIA.map((c) => `${t.byCriterion[c]}${p === null ? "" : ` (${signed(t.byCriterion[c] - p.byCriterion[c])})`}`).join(" | ")} | ${minutes(t.turnSeconds)} |`,
    "",
    "## What failed",
    "",
    ...run.games.flatMap((game) => {
      const failed = CRITERIA.filter((c) => game.score.verdicts[c].result !== "pass");
      return failed.length === 0
        ? []
        : [
            `- **${game.name}**: ${failed.map((c) => `${CRITERION_LABELS[c]} ${mark(game.score.verdicts[c])} ${game.score.verdicts[c].detail}`).join("; ")}`,
          ];
    }),
    "",
  ];
  return lines.join("\n");
}

export async function writeReport(outRoot: string, runDir: string, run: BenchRun) {
  const previous = await previousRun(outRoot, run.stamp);
  const htmlPath = NodePath.join(runDir, "report.html");
  const markdownPath = NodePath.join(runDir, "summary.md");
  await NodeFSP.writeFile(htmlPath, html(run, previous));
  await NodeFSP.writeFile(markdownPath, markdown(run, previous));
  return { html: htmlPath, markdown: markdownPath };
}
