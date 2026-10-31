#!/usr/bin/env node
// Studio `bot`: run a written game bot in real time through the play runner.
// A bot file (ESM) exports what Aura's Harness has (Apache-2.0, adapted with
// attribution; code below is our own): goal, observe, options with facts and
// per-tick executors, status (running/done/failed), stallSeconds, and an
// optional policy pick. Decisions come from Jev (--jev: System One Choice
// over the options, key read here only, never logged) or the bot's policy.
// Ticks are back-to-back paused-mode acts at ~10 Hz; Jev decides async (its
// latency never blocks the executor). Writes a JSON trace of decisions+state.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    dir: { type: "string" },
    bot: { type: "string" },
    jev: { type: "boolean", default: false },
    out: { type: "string" },
    video: { type: "string" },
    seconds: { type: "string", default: "150" },
    "tick-ms": { type: "string", default: "90" },
  },
});
if (!values.dir || !values.bot) {
  console.log(
    "usage: bot.ts --dir GAME --bot bot.mjs [--jev] [--out trace.json] [--video run.mp4] [--seconds 150]",
  );
  process.exit(2);
}
const GAME = NodePath.resolve(values.dir);
const PLAY = NodePath.join(NodeURL.fileURLToPath(import.meta.url), "..", "play.ts");
const TICK_MS = Math.max(50, Number(values["tick-ms"]) || 90);
const BUDGET_MS = Math.max(20, Number(values.seconds) || 150) * 1000;
for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]) delete process.env[name];

const env = (): NodeJS.ProcessEnv => {
  const home = NodeOS.homedir();
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]) delete clean[name];
  clean.NODE_OPTIONS = "--max-old-space-size=1536";
  clean.TMPDIR = NodePath.join(home, ".gs-tmp");
  clean.STUDIO_RECORD = "1";
  clean.PATH = `${NodePath.join(home, ".gs-tmp/xvfb-local/usr/bin")}${NodePath.delimiter}${clean.PATH ?? ""}`;
  return clean;
};
const execPlay = (args: string[]): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      process.execPath,
      [PLAY, "--dir", GAME, ...args],
      { env: env(), timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`play ${args[0]} failed: ${error.message.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as Record<string, unknown>);
        } catch {
          reject(new Error(`play ${args[0]} returned non-JSON`));
        }
      },
    );
  });

// Jev: exact System One request shape from the typesafe-sdk package
// (POST {base}/v1/systemone, {state, model, questions:{pick:{type:choice,
// instructions, criteria}}}). Only this process reads the key file; builder
// and tester sessions never have it. The key is never printed or logged.
type JevHandle = { base: string; key: string } | null;
const jevFromFile = async (): Promise<JevHandle> => {
  try {
    const text = await NodeFSP.readFile(
      NodePath.join(NodeOS.homedir(), ".config/game-studio/typesafe.env"),
      "utf8",
    );
    const line = text.split("\n").find((l) => l.startsWith("TYPESAFE_API_KEY="));
    const key = (line ?? "").slice("TYPESAFE_API_KEY=".length).trim();
    if (!key) return null;
    const base =
      (text.split("\n").find((l) => l.startsWith("TYPESAFE_BASE_URL=")) ?? "")
        .slice("TYPESAFE_BASE_URL=".length)
        .trim() || "https://api.typesafe.ai";
    return { base: base.replace(/\/$/, ""), key };
  } catch {
    return null;
  }
};
const jevPick = async (
  jev: JevHandle,
  goal: string,
  facts: unknown,
  opts: Array<{ name: string; description: string; facts: unknown }>,
  nowDoing: string | null,
  recent: Array<{ name: string; ok: boolean }>,
): Promise<string | null> => {
  if (!jev) return null;
  const criteria: Record<string, string> = {};
  for (const o of opts)
    criteria[o.name] = `${o.description} Facts: ${JSON.stringify(o.facts).slice(0, 500)}`;
  const body = {
    state:
      `Goal: ${goal}. Situation: ${JSON.stringify(facts).slice(0, 2000)}. ` +
      `Doing now: ${nowDoing ?? "nothing"}. Recent: ${JSON.stringify(recent.slice(-6))}.`,
    model: "jev-latest",
    questions: {
      pick: {
        type: "choice",
        instructions: `Which option best serves the goal now? Let "${nowDoing ?? "none"}" finish unless another is clearly better.`,
        criteria,
      },
    },
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${jev.base}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jev.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { answers?: { pick?: { choice?: string } } };
    const choice = data.answers?.pick?.choice ?? null;
    return choice && criteria[choice] !== undefined ? choice : null;
  } catch {
    return null;
  }
};

const botMod = (await import(NodePath.resolve(values.bot!))) as Record<string, unknown>;
const goal = typeof botMod["goal"] === "string" ? (botMod["goal"] as string) : "play the game";
const stallSeconds =
  typeof botMod["stallSeconds"] === "number" ? (botMod["stallSeconds"] as number) : 45;
const observe = botMod["observe"] as (api: unknown, last: unknown) => unknown;
const listOptions = botMod["options"] as (obs: unknown) => Array<Record<string, unknown>>;
const readStatus = botMod["status"] as (obs: unknown) => {
  state: string;
  note?: string;
  evidence?: unknown;
};
const policy = botMod["policy"] as
  | null
  | ((obs: unknown, opts: Array<Record<string, unknown>>) => string);
if (
  typeof observe !== "function" ||
  typeof listOptions !== "function" ||
  typeof readStatus !== "function"
) {
  console.log(
    "bot file must export goal, observe, options, status (and optionally policy, stallSeconds)",
  );
  process.exit(2);
}

await execPlay(["stop"]).catch(() => undefined);
const boot = await execPlay(["start"]);
if (!boot["ok"]) {
  console.log(JSON.stringify({ ok: false, error: "boot failed" }));
  process.exit(1);
}
// Persistent daemon connection for the tick loop: one TCP socket instead of
// one node process per tick (process spawn cost ~1s/tick; socket RTT ~0.1s,
// which is what makes ~10 Hz possible). Same protocol as play.ts callDaemon.
const NodeNet = await import("node:net");
const sessionFile = NodePath.join(GAME, "builds", "logs", "play", "session.json");
const session = JSON.parse(await NodeFSP.readFile(sessionFile, "utf8")) as {
  ipcPort: number;
  ipcToken: string;
};
const sock = NodeNet.createConnection({ host: "127.0.0.1", port: session.ipcPort });
await new Promise<void>((resolve, reject) => {
  sock.once("connect", resolve);
  sock.once("error", reject);
});
let sockBuf = "";
let sockWaiter: ((line: string) => void) | null = null;
sock.on("data", (chunk: Buffer) => {
  sockBuf += chunk.toString();
  const index = sockBuf.indexOf("\n");
  if (index >= 0 && sockWaiter !== null) {
    const line = sockBuf.slice(0, index);
    sockBuf = sockBuf.slice(index + 1);
    const waiter = sockWaiter;
    sockWaiter = null;
    waiter(line);
  }
});
const daemonAct = (steps: Array<Record<string, unknown>>): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon act timeout")), 60_000);
    sockWaiter = (line: string): void => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    sock.write(`${JSON.stringify({ op: "act", steps, token: session.ipcToken })}\n`);
  });
const jev = values.jev ? await jevFromFile() : null;
if (values.jev && !jev) console.log("bot: --jev set but no key file; using policy");

const api = {
  held: new Set<string>(),
  taps: [] as string[],
  clicks: [] as Array<{ id: string; action: string }>,
  press(key: string): void {
    api.taps.push(key);
  },
  hold(key: string): void {
    api.held.add(key);
  },
  release(key: string): void {
    api.held.delete(key);
  },
  click(id: string, action = "click"): void {
    api.clicks.push({ id, action });
  },
};
const trace: Array<Record<string, unknown>> = [];
const recent: Array<{ name: string; ok: boolean }> = [];
const t0 = Date.now();
let current: string | null = null;
let lastProgress = Date.now();
let lastSig = "";
let ticks = 0;
let decisions = 0;
let jevCalls = 0;
let jevFailures = 0;
let result = { state: "running", note: "budget", evidence: {} as unknown };

const stepsForTick = (): Array<Record<string, unknown>> => {
  const steps: Array<Record<string, unknown>> = [];
  for (const key of api.taps.splice(0)) steps.push({ press: key });
  for (const click of api.clicks.splice(0))
    steps.push({ ui: { id: click.id, action: click.action } });
  if (api.held.size > 0) steps.push({ keys: [...api.held], holdMs: TICK_MS });
  else steps.push({ waitMs: TICK_MS });
  steps.push({ sweepCheck: true });
  return steps;
};

let lastReply: Record<string, unknown> = boot;
let obs: unknown = null;
let lastDecisionAt = 0;
let lastOptSig = "";
try {
  while (Date.now() - t0 < BUDGET_MS) {
    const reply = await daemonAct(stepsForTick());
    ticks += 1;
    lastReply = reply;
    // Observe + decide when the executor ends, the option set changes, or at
    // the harness tempo (1.5 s); executors steer every tick in between.
    const nowMs = Date.now();
    let opts: Array<Record<string, unknown>> = [];
    let tickObs: unknown = null;
    let needDecide = current === null || nowMs - lastDecisionAt > 1500;
    try {
      tickObs = (observe as (api: unknown, last: unknown) => unknown)(api, reply);
      opts = listOptions(tickObs) ?? [];
    } catch {
      opts = [];
    }
    const optSig = opts.map((o) => String(o["name"])).join(",");
    if (optSig !== lastOptSig) {
      lastOptSig = optSig;
      needDecide = true;
    }
    if (needDecide) {
      lastDecisionAt = nowMs;
      try {
        obs = tickObs;
      } catch (error) {
        obs = { error: error instanceof Error ? error.message : String(error) };
      }
      const st = readStatus(obs) as { state: string; note?: string; evidence?: unknown };
      if (st.state !== "running") {
        result = st as typeof result;
        break;
      }
      const sig = JSON.stringify([st.note, st.evidence ?? null]);
      if (sig !== lastSig) {
        lastSig = sig;
        lastProgress = Date.now();
      }
      let opts: Array<Record<string, unknown>> = [];
      try {
        opts = listOptions(obs) ?? [];
      } catch {
        opts = [];
      }
      if (opts.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      const facts = (obs as Record<string, unknown>)?.["facts"] ?? obs;
      let pick: string | null = null;
      if (jev) {
        jevCalls += 1;
        pick = await jevPick(
          jev,
          goal,
          facts,
          opts.map((o) => ({
            name: String(o["name"]),
            description: String(o["description"] ?? ""),
            facts: o["facts"] ?? null,
          })),
          current,
          recent,
        );
        if (pick === null) jevFailures += 1;
      }
      if (pick === null) {
        try {
          pick =
            typeof policy === "function"
              ? (policy as (obs: unknown, opts: Array<Record<string, unknown>>) => string)(
                  obs,
                  opts,
                )
              : String(opts[0]!["name"]);
        } catch {
          pick = String(opts[0]!["name"]);
        }
      }
      if (!opts.some((o) => String(o["name"]) === pick)) pick = String(opts[0]!["name"]);
      decisions += 1;
      if (pick !== current) {
        recent.push({ name: current ?? "(none)", ok: false });
        current = pick;
        lastProgress = Date.now();
      }
      const opt = opts.find((o) => String(o["name"]) === pick)!;
      let outcome = "running";
      try {
        const run = opt["run"] as (api: unknown, obs: unknown) => unknown;
        outcome = typeof run === "function" ? String(await run(api, obs)) : "running";
      } catch {
        outcome = "failed";
      }
      trace.push({
        t: Number(((Date.now() - t0) / 1000).toFixed(1)),
        decision: pick,
        outcome,
        facts: typeof facts === "object" ? facts : { facts },
        status: st.note ?? "",
      });
      if (outcome === "done") {
        recent.push({ name: pick!, ok: true });
        current = null;
        lastProgress = Date.now();
      } else if (outcome === "failed") {
        recent.push({ name: pick!, ok: false });
        current = null;
      }
      if (Date.now() - lastProgress > stallSeconds * 1000) {
        result = { state: "stalled", note: `no progress for ${stallSeconds}s`, evidence: { obs } };
        break;
      }
    }
  }
} catch (error) {
  result = {
    state: "error",
    note: error instanceof Error ? error.message : String(error),
    evidence: {},
  };
}
const summary = {
  ok: true,
  result,
  goal,
  ticks,
  decisions,
  jev: values.jev ? { calls: jevCalls, failures: jevFailures } : null,
  seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
  trace,
};
if (values.out) {
  await NodeFSP.mkdir(NodePath.dirname(NodePath.resolve(values.out)), { recursive: true });
  await NodeFSP.writeFile(NodePath.resolve(values.out), JSON.stringify(summary, null, 2));
}
if (values.video) {
  await execPlay(["video", NodePath.resolve(values.video)]).catch(() => undefined);
}
await execPlay(["stop"]).catch(() => undefined);
console.log(JSON.stringify({ ...summary, trace: trace.slice(-20) }));
