/**
 * The bot child launcher: a Node ESM program the GameBot service writes
 * under the game's ignored `builds/logs/` tree and runs in its own child
 * process per run. It imports one model-written bot file under
 * `.studio/bot/*.mjs` and speaks newline-delimited JSON with the service:
 * stdin carries observations and Jev decisions, stdout carries inputs,
 * decision requests, picks and the final status.
 *
 * The child never sees the Jev key or any secret: with decider "jev" it
 * sends a decide request and the service answers asynchronously, while play
 * continues on the current option; a null pick means Jev failed or timed
 * out and the child falls back to the bot's own policy.
 *
 * Bot file shape (same as the frozen scripts/studio/bot.ts, plus the Jev
 * fields): goal (string), observe(api, last), options(obs), status(obs),
 * optional policy(obs, opts), optional stallSeconds, optional tempo
 * (decisions/second while an option runs; reflex play 4-8), optional
 * switchMargin (default 0.25), optional plan(obs) returning
 * {done, now, next} for Jev. Each option is {name, description, facts,
 * run(api, obs), interruptible (default true), urgent (default false)}
 * where run returns "running", "done" or "failed". A single legal option
 * runs without asking Jev and never counts as a Jev decision: a run counts
 * as a Jev run only when Jev made at least 3 decisions among 2+ options.
 */
export const GAME_BOT_CHILD_JS = `import * as NodeReadline from "node:readline";

const botPath = process.argv[2];
const decider = process.argv[3] === "jev" ? "jev" : "policy";
// The protocol runs over stdout, so a chatty bot cannot corrupt it.
console.log = (...args) => process.stderr.write(args.map(String).join(" ") + "\\n");
console.warn = (...args) => process.stderr.write(args.map(String).join(" ") + "\\n");
console.error = (...args) => process.stderr.write(args.map(String).join(" ") + "\\n");

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");

let bot;
try {
  bot = await import(botPath);
} catch (error) {
  send({ op: "status", state: "error", note: \`bot file does not load: \${String(error && error.message || error).slice(0, 300)}\`, evidence: {} });
  process.exit(0);
}
const goal = typeof bot.goal === "string" ? bot.goal : "play the game";
const stallSeconds = typeof bot.stallSeconds === "number" && bot.stallSeconds > 0 ? bot.stallSeconds : 45;
// Decisions a second while an option runs (reflex play: 4-8; deliberate:
// 0.5-2). How much more Jev must prefer another option to interrupt the
// running one (Aura's switch margin against dithering).
const tempo = typeof bot.tempo === "number" && bot.tempo > 0 ? Math.min(10, bot.tempo) : 2;
const switchMargin = typeof bot.switchMargin === "number" && bot.switchMargin >= 0 ? bot.switchMargin : 0.25;
const readPlan = bot.plan;
const observe = bot.observe;
const listOptions = bot.options;
const readStatus = bot.status;
const policy = bot.policy;
if (typeof observe !== "function" || typeof listOptions !== "function" || typeof readStatus !== "function") {
  send({ op: "status", state: "error", note: "bot file must export goal, observe, options, status (and optionally policy, stallSeconds)", evidence: {} });
  process.exit(0);
}

const held = new Set();
let taps = [];
let clicks = [];
let setStates = [];
const api = {
  press(key) { taps.push(String(key)); },
  hold(key) { held.add(String(key)); },
  release(key) { held.delete(String(key)); },
  click(id, action = "click") { clicks.push({ id: String(id), action: String(action) }); },
  clickAt(x, y) { clicks.push({ x: Number(x), y: Number(y) }); },
  setState(target, values) { setStates.push({ target: String(target), values }); },
};

let tick = 0;
let current = null;
let currentSince = 0;
let recent = [];
let obs = null;
let opts = [];
let lastDecisionAt = 0;
let lastOutcome = "running";
let lastSig = "";
let lastProgress = Date.now();
let pending = null;
let decideId = 0;
let statusSent = false;
let status = { state: "running", note: "", evidence: {} };

const policyPick = (options, observer) => {
  try {
    if (typeof policy === "function") return String(policy(observer, options));
  } catch { /* fall through to first option */ }
  return String(options[0].name);
};

const pickValid = (name, options) => options.some((o) => String(o.name) === name);

const sendPicked = (name, via, t, twoPlus) => send({ op: "picked", name, via, t, twoPlus: twoPlus === true });

const switchTo = (name, via, t, twoPlus) => {
  if (current !== null) recent.push({ name: current, ok: false });
  current = name;
  currentSince = Date.now();
  lastProgress = Date.now();
  sendPicked(current, via, t, twoPlus);
};

const handleObs = async (msg) => {
  tick += 1;
  const observation = msg.observation;
  const t = typeof msg.t === "number" ? msg.t : 0;
  let tickObs = null;
  let nextOpts = [];
  try {
    tickObs = await observe(api, observation);
    nextOpts = (await listOptions(tickObs)) ?? [];
    if (!Array.isArray(nextOpts)) nextOpts = [];
  } catch { nextOpts = []; }
  if (tickObs !== null && tickObs !== undefined) {
    obs = tickObs;
    opts = nextOpts;
  }
  try {
    const st = await readStatus(obs);
    if (st && typeof st.state === "string") status = st;
  } catch { /* keep last status */ }
  if (!statusSent && status.state !== "running") {
    statusSent = true;
    send({ op: "status", state: String(status.state), note: String(status.note ?? ""), evidence: status.evidence ?? {} });
  }
  if (!statusSent) {
    const optSig = opts.map((o) => String(o.name)).join(",");
    const prevSig = handleObs._lastSig ?? "";
    handleObs._lastSig = optSig;
    const due = Date.now() - lastDecisionAt > 1000 / tempo;
    const needDecide = current === null || optSig !== prevSig || due || lastOutcome === "done" || lastOutcome === "failed";
    if (needDecide && opts.length > 0) {
      lastDecisionAt = Date.now();
      const fallback = pickValid(policyPick(opts, obs), opts) ? policyPick(opts, obs) : String(opts[0].name);
      if (opts.length === 1) {
        // A single legal option runs without asking Jev (Aura): there is
        // nothing to choose between, and it must not count as a decision.
        if (current === null) switchTo(String(opts[0].name), "policy", t, false);
      } else if (decider === "jev" && pending === null) {
        decideId += 1;
        pending = { id: decideId, fallback, options: opts.length };
        const facts = obs && typeof obs === "object" && obs.facts !== undefined ? obs.facts : obs;
        let plan = null;
        try {
          if (typeof readPlan === "function") plan = await readPlan(obs);
          else if (obs && typeof obs === "object" && obs.plan !== undefined) plan = obs.plan;
        } catch { plan = null; }
        send({ op: "decide", id: decideId, goal, facts: facts ?? null,
          options: opts.map((o) => ({ name: String(o.name), description: String(o.description ?? ""), facts: o.facts ?? null,
            interruptible: o.interruptible !== false, urgent: o.urgent === true })),
          nowDoing: current, nowDoingFor: current === null ? null : (Date.now() - currentSince) / 1000,
          recent: recent.slice(-6), plan });
      }
      const immediate = decider === "policy" || current === null ? fallback : null;
      if (immediate !== null && immediate !== current) switchTo(immediate, "policy", t, opts.length >= 2);
    }
    if (current !== null) {
      const opt = opts.find((o) => String(o.name) === current);
      if (opt === undefined) {
        recent.push({ name: current, ok: false });
        current = null;
        lastOutcome = "failed";
      } else {
        let outcome = "running";
        try {
          const run = opt.run;
          outcome = typeof run === "function" ? String(await run(api, obs)) : "running";
        } catch { outcome = "failed"; }
        lastOutcome = outcome;
        if (outcome === "done") {
          recent.push({ name: current, ok: true });
          current = null;
          lastProgress = Date.now();
        } else if (outcome === "failed") {
          recent.push({ name: current, ok: false });
          current = null;
        }
      }
    }
    recent = recent.slice(-6);
    const sig = JSON.stringify([status.note, status.evidence ?? null]);
    if (sig !== lastSig) {
      lastSig = sig;
      lastProgress = Date.now();
    }
    if (Date.now() - lastProgress > stallSeconds * 1000) {
      statusSent = true;
      send({ op: "status", state: "stalled", note: \`no progress for \${stallSeconds}s\`, evidence: { obs } });
    }
  }
  send({ op: "input", tick, held: [...held], taps: taps.splice(0), clicks: clicks.splice(0), setStates: setStates.splice(0) });
};

const handleDecision = (msg) => {
  if (pending === null || msg.id !== pending.id) return;
  const fallback = pending.fallback;
  const twoPlus = (pending.options ?? 0) >= 2;
  pending = null;
  if (statusSent) return;
  let pick = typeof msg.pick === "string" ? msg.pick : null;
  const probs = msg.probs !== null && typeof msg.probs === "object" ? msg.probs : {};
  let via = "jev";
  if (pick === null || !pickValid(pick, opts)) {
    pick = pickValid(fallback, opts) ? fallback : (opts.length > 0 ? String(opts[0].name) : null);
    via = "policy";
  }
  if (pick === null) return;
  if (pick === current) {
    // A kept option still counts as a decision among the options offered
    // (Aura counts kept answers too); otherwise the margin would hide
    // steady Jev play and no run could ever be valid.
    sendPicked(current, via, null, twoPlus);
    return;
  }
  if (via === "jev" && current !== null) {
    // The switch margin stops dithering: a different pick replaces the
    // running option only when it is interruptible and Jev prefers the new
    // one by the margin (or the new one is urgent).
    const cur = opts.find((o) => String(o.name) === current);
    const nxt = opts.find((o) => String(o.name) === pick);
    const interruptible = cur ? cur.interruptible !== false : true;
    const urgent = nxt ? nxt.urgent === true : false;
    const margin = (typeof probs[pick] === "number" ? probs[pick] : 1)
      - (typeof probs[current] === "number" ? probs[current] : 0);
    if ((!interruptible && !urgent) || (!urgent && margin < switchMargin)) {
      sendPicked(current, "jev", null, twoPlus);
      return;
    }
  }
  switchTo(pick, via, null, twoPlus);
};

const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
send({ op: "hello", decider, goal });
for await (const line of lines) {
  if (line.trim() === "") continue;
  let msg = null;
  try { msg = JSON.parse(line); } catch { continue; }
  if (msg === null || typeof msg !== "object") continue;
  try {
    if (msg.op === "obs") await handleObs(msg);
    else if (msg.op === "decision") handleDecision(msg);
    else if (msg.op === "bye") process.exit(0);
  } catch (error) {
    send({ op: "log", message: \`child error: \${String(error && error.message || error).slice(0, 200)}\` });
  }
}
`;
