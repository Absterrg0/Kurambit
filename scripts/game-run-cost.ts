// @effect-diagnostics nodeBuiltinImport:off -- A maintainer report that reads a state database read-only.
// What a game's threads cost: tokens, tool calls and wall time per role, read
// from the turns the server already persisted. Point it at a copy or a stopped
// server's database; it opens read-only either way.
//
//   node scripts/game-run-cost.ts <statev2.sqlite> <game name or project id> [--since ISO]
//
// The harness-versus-raw comparison is the same report on two games: one made
// by a production run, one by a single plain thread on the same brief and model.
import * as NodeSqlite from "node:sqlite";

const [file, game, ...rest] = process.argv.slice(2);
if (file === undefined || game === undefined) {
  console.error("usage: node scripts/game-run-cost.ts <statev2.sqlite> <game> [--since ISO]");
  process.exit(2);
}
const sinceAt = rest.indexOf("--since");
const since = sinceAt >= 0 ? (rest[sinceAt + 1] ?? "") : "";

const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
const projects = db
  .prepare(
    `select distinct project_id as id from orchestration_v2_projection_threads
     where project_id = ? or (title = ? and deleted_at is null)`,
  )
  .all(game, game) as Array<{ id: string }>;
if (projects.length !== 1) {
  console.error(`${projects.length} projects match "${game}"; pass its project id.`);
  process.exit(1);
}
const projectId = projects[0]!.id;

const threads = db
  .prepare(
    `select thread_id as id, title, created_at as createdAt from orchestration_v2_projection_threads
     where project_id = ? and created_at >= ? order by created_at`,
  )
  .all(projectId, since) as Array<{ id: string; title: string; createdAt: string }>;

const turnsOf = db.prepare(
  `select started_at as startedAt, completed_at as completedAt,
          json_extract(payload_json, '$.turnTokenUsage') as usage
   from orchestration_v2_projection_provider_turns where thread_id = ?`,
);
const toolsOf = db.prepare(
  `select coalesce(json_extract(payload_json, '$.toolName'), type) as name, count(*) as n
   from orchestration_v2_projection_turn_items
   where thread_id = ? and type in ('dynamic_tool', 'command_execution', 'file_change', 'file_search')
   group by name`,
);

interface Row {
  turns: number;
  input: number;
  cached: number;
  output: number;
  partial: number;
  seconds: number;
  tools: Map<string, number>;
}
const roles = new Map<string, Row>();
for (const thread of threads) {
  // "studio builder-2" and "studio builder-3" are one role; the creator thread keeps its title.
  const role = thread.title.startsWith("studio ")
    ? thread.title.slice("studio ".length).replace(/[-\s]?\d+$/, "")
    : `creator (${thread.title})`;
  const row = roles.get(role) ?? {
    turns: 0,
    input: 0,
    cached: 0,
    output: 0,
    partial: 0,
    seconds: 0,
    tools: new Map(),
  };
  for (const turn of turnsOf.all(thread.id) as Array<{
    startedAt: string | null;
    completedAt: string | null;
    usage: string | null;
  }>) {
    row.turns += 1;
    if (turn.startedAt !== null && turn.completedAt !== null)
      row.seconds += (Date.parse(turn.completedAt) - Date.parse(turn.startedAt)) / 1000;
    const usage = turn.usage === null ? null : JSON.parse(turn.usage);
    if (usage?.usageStatus !== "complete") row.partial += 1;
    row.input += usage?.inputTokens ?? 0;
    row.cached += usage?.cachedInputTokens ?? 0;
    row.output += usage?.outputTokens ?? 0;
  }
  for (const tool of toolsOf.all(thread.id) as Array<{ name: string; n: number }>)
    row.tools.set(tool.name, (row.tools.get(tool.name) ?? 0) + tool.n);
  roles.set(role, row);
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const total = { turns: 0, input: 0, cached: 0, output: 0, partial: 0, seconds: 0, tools: 0 };
console.log(`project ${projectId}, ${threads.length} threads${since ? ` since ${since}` : ""}`);
console.log("role                 turns  input (cached)    output  tools  minutes");
for (const [role, row] of [...roles].sort((a, b) => b[1].input - a[1].input)) {
  const tools = [...row.tools.values()].reduce((a, b) => a + b, 0);
  total.turns += row.turns;
  total.input += row.input;
  total.cached += row.cached;
  total.output += row.output;
  total.partial += row.partial;
  total.seconds += row.seconds;
  total.tools += tools;
  console.log(
    `${role.slice(0, 20).padEnd(20)} ${String(row.turns).padStart(5)}  ${k(row.input).padStart(6)} (${k(row.cached).padStart(6)})  ${k(row.output).padStart(7)}  ${String(tools).padStart(5)}  ${(row.seconds / 60).toFixed(1).padStart(7)}`,
  );
}
console.log(
  `${"total".padEnd(20)} ${String(total.turns).padStart(5)}  ${k(total.input).padStart(6)} (${k(total.cached).padStart(6)})  ${k(total.output).padStart(7)}  ${String(total.tools).padStart(5)}  ${(total.seconds / 60).toFixed(1).padStart(7)}`,
);
// Turns whose provider reported no or partial usage undercount the totals; say so.
if (total.partial > 0) console.log(`${total.partial} turns reported partial or no usage.`);
