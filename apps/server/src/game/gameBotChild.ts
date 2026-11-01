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
 * Bot file shape (goal, observe, options, status, optional policy, optional stallSeconds, optional tempo
 * (decisions/second while an option runs; reflex play 4-8), optional
 * switchMargin (default 0.25), optional plan(obs) returning
 * {done, now, next} for Jev. Each option is {name, description, facts,
 * run(api, obs), interruptible (default true), urgent (default false)}
 * where run returns "running", "done" or "failed". Return "done" when the
 * option arrived or has nothing left to do: the child then stops offering
 * it until the option set changes (a "failed" option rests 30 s first), so
 * exploration cannot re-pick an arrived option hundreds of times.
 * A single legal option runs without asking Jev and never counts as a Jev
 * decision: a run counts as a Jev run only when Jev made at least 3
 * decisions among 2+ options. The service sends runContext with every
 * observation ({runIndex, runTotal, seed, priorRuns} so runs of one call
 * can differ); decide requests also carry the child's tried counts.
 * Argv after the bot file: decider, mode ("play" or "explore"), and whether
 * the service is actually asking Jev ("jev-live": an exploration without
 * the key picks uniformly at random and says so in its picked lines).
 */
export const GAME_BOT_CHILD_JS = `import * as NodeReadline from "node:readline";

const botPath = process.argv[2];
const decider = process.argv[3] === "jev" ? "jev" : "policy";
// Exploration mode (Aura's "an exploration"): broad options, no win goal.
// jevLive is true only when the service actually has the key: without it a
// jev-decider exploration must say so and fall back to randomised policy.
const explore = process.argv[4] === "explore";
const jevLive = process.argv[5] === "jev-live";
const exploreRandom = explore && decider === "jev" && !jevLive;
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
// Exploration memory (Aura's rule: an option that arrived or has nothing
// left is not offered again until something changes; a failed option rests
// briefly). doneOpts maps option -> option-set signature at completion;
// failedAt maps option -> wall ms of the failure (30 s cooldown). tried
// counts every pick and its outcome so Jev sees what was tried and what
// happened, even from bots that track nothing themselves.
let optSig = "";
const doneOpts = new Map();
const failedAt = new Map();
const tried = new Map();
const FAIL_COOLDOWN_MS = 30_000;
let runContext = null;

const noteTried = (name, outcome) => {
  const entry = tried.get(name) ?? { picks: 0, ok: 0, fail: 0 };
  entry.picks += 1;
  if (outcome === "ok") entry.ok += 1;
  else if (outcome === "fail") entry.fail += 1;
  tried.set(name, entry);
};

const triedJson = () => {
  const out = {};
  for (const [name, entry] of tried) out[name] = { ...entry };
  return out;
};

// Options on offer now: drop completed ones while the set is unchanged and
// failed ones inside the cooldown. When everything is filtered, offer the
// full set rather than deadlocking (the bot's status still ends the run).
const offerable = (options, sig) => {
  for (const [name, atSig] of [...doneOpts]) if (atSig !== sig) doneOpts.delete(name);
  const now = Date.now();
  const kept = options.filter((o) => {
    const name = String(o.name);
    if (doneOpts.has(name)) return false;
    const failed = failedAt.get(name);
    if (failed !== undefined && now - failed < FAIL_COOLDOWN_MS) return false;
    return true;
  });
  return kept.length > 0 ? kept : options;
};

const policyPick = (options, observer) => {
  try {
    if (typeof policy === "function") return String(policy(observer, options));
  } catch { /* fall through to first option */ }
  return String(options[0].name);
};

const pickValid = (name, options) => options.some((o) => String(o.name) === name);

const randomOption = (options) => String(options[Math.floor(Math.random() * options.length)].name);

const sendPicked = (name, via, t, twoPlus, randomized) => send({ op: "picked", name, via, t, twoPlus: twoPlus === true, randomized: randomized === true });

const switchTo = (name, via, t, twoPlus, randomized) => {
  if (current !== null) recent.push({ name: current, ok: false });
  current = name;
  currentSince = Date.now();
  lastProgress = Date.now();
  noteTried(name, null);
  sendPicked(current, via, t, twoPlus, randomized);
};

const handleObs = async (msg) => {
  tick += 1;
  const observation = msg.observation;
  const t = typeof msg.t === "number" ? msg.t : 0;
  // The service tells each run where it stands among its siblings (index,
  // total, seed, what earlier runs covered) so runs differ from each other.
  // Bots that ignore it play exactly as before.
  if (msg.runContext !== undefined && msg.runContext !== null) runContext = msg.runContext;
  if (observation !== null && typeof observation === "object") observation.runContext = runContext;
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
    const setSig = opts.map((o) => String(o.name)).join(",");
    optSig = setSig;
    const prevSig = handleObs._lastSig ?? "";
    handleObs._lastSig = setSig;
    const due = Date.now() - lastDecisionAt > 1000 / tempo;
    const needDecide = current === null || setSig !== prevSig || due || lastOutcome === "done" || lastOutcome === "failed";
    if (needDecide && opts.length > 0) {
      lastDecisionAt = Date.now();
      const offered = offerable(opts, setSig);
      // Without the key there is no Jev to ask: an exploration then picks
      // uniformly at random (the report states it isn't Jev), otherwise
      // the bot's own policy.
      const fallback = exploreRandom
        ? randomOption(offered)
        : pickValid(policyPick(offered, obs), offered) ? policyPick(offered, obs) : String(offered[0].name);
      if (offered.length === 1 && opts.length === 1) {
        // A single legal option runs without asking Jev (Aura): there is
        // nothing to choose between, and it must not count as a decision.
        if (current === null) switchTo(String(offered[0].name), "policy", t, false, false);
      } else if (decider === "jev" && pending === null) {
        decideId += 1;
        pending = { id: decideId, fallback, options: offered.length };
        const facts = obs && typeof obs === "object" && obs.facts !== undefined ? obs.facts : obs;
        let plan = null;
        try {
          if (typeof readPlan === "function") plan = await readPlan(obs);
          else if (obs && typeof obs === "object" && obs.plan !== undefined) plan = obs.plan;
        } catch { plan = null; }
        send({ op: "decide", id: decideId, goal, facts: facts ?? null, tried: triedJson(),
          options: offered.map((o) => ({ name: String(o.name), description: String(o.description ?? ""), facts: o.facts ?? null,
            interruptible: o.interruptible !== false, urgent: o.urgent === true })),
          nowDoing: current, nowDoingFor: current === null ? null : (Date.now() - currentSince) / 1000,
          recent: recent.slice(-6), plan });
      }
      const immediate = decider === "policy" || current === null ? fallback : null;
      if (immediate !== null && immediate !== current) switchTo(immediate, "policy", t, offered.length >= 2, exploreRandom);
    }
    if (current !== null) {
      const opt = opts.find((o) => String(o.name) === current);
      if (opt === undefined) {
        recent.push({ name: current, ok: false });
        noteTried(current, "fail");
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
          // Arrived or nothing left to do: not offered again until the
          // option set changes. Bots must return "done" for this to work;
          // options that always return "running" stay on offer.
          recent.push({ name: current, ok: true });
          noteTried(current, "ok");
          doneOpts.set(current, optSig);
          current = null;
          lastProgress = Date.now();
        } else if (outcome === "failed") {
          // A failed option rests 30 s before it is offered again.
          recent.push({ name: current, ok: false });
          noteTried(current, "fail");
          failedAt.set(current, Date.now());
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
  let randomized = false;
  if (pick === null || !pickValid(pick, opts)) {
    pick = pickValid(fallback, opts) ? fallback : (opts.length > 0 ? String(opts[0].name) : null);
    via = "policy";
    // The fallback is random only when the key is missing on exploration;
    // otherwise it is the bot's own policy. The trace keeps them apart.
    randomized = exploreRandom;
  }
  if (pick === null) return;
  if (pick === current) {
    // A kept option still counts as a decision among the options offered
    // (Aura counts kept answers too); otherwise the margin would hide
    // steady Jev play and no run could ever be valid.
    sendPicked(current, via, null, twoPlus, randomized);
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
      sendPicked(current, "jev", null, twoPlus, false);
      return;
    }
  }
  switchTo(pick, via, null, twoPlus, randomized);
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
