// The bot child: the GameBot service runs this file from the server's
// templates in a child process of its own per run. It imports one
// model-written bot file under `.studio/bot/*.mjs` (argv[2], a file URL) and
// speaks newline-delimited JSON with the service: stdin carries observations,
// stdout carries inputs, offered options, picks and the final status.
//
// Bot file shape: goal, observe, options, status, optional policy, optional
// stallSeconds, optional tempo (decisions/second while an option runs; reflex
// play 4-8). Each option is {name, description, facts, run(api, obs)} where
// run returns "running", "done" or "failed". Return "done" when the option
// arrived or has nothing left to do: the child then stops offering it until
// the option set changes (a "failed" option rests 30 s first), so a policy
// cannot re-pick an arrived option hundreds of times. The service sends
// runContext with every observation ({runIndex, runTotal, seed, priorRuns})
// so runs of one call can differ.
import * as NodeReadline from "node:readline";

const FAIL_COOLDOWN_MS = 30_000;

// The protocol runs over stdout, so a chatty bot cannot corrupt it.
const toStderr = (...args) => process.stderr.write(`${args.map(String).join(" ")}\n`);
console.log = toStderr;
console.warn = toStderr;
console.error = toStderr;

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const errorText = (error, max) => String(error?.message ?? error).slice(0, max);

let bot;
try {
  bot = await import(process.argv[2]);
} catch (error) {
  send({
    op: "status",
    state: "error",
    note: `bot file does not load: ${errorText(error, 300)}`,
    evidence: {},
  });
  process.exit(0);
}
const goal = typeof bot.goal === "string" ? bot.goal : "play the game";
const stallSeconds =
  typeof bot.stallSeconds === "number" && bot.stallSeconds > 0 ? bot.stallSeconds : 45;
const tempo = typeof bot.tempo === "number" && bot.tempo > 0 ? Math.min(10, bot.tempo) : 2;
const { observe, options: listOptions, status: readStatus, policy } = bot;
if (
  typeof observe !== "function" ||
  typeof listOptions !== "function" ||
  typeof readStatus !== "function"
) {
  send({
    op: "status",
    state: "error",
    note: "bot file must export goal, observe, options, status (and optionally policy, stallSeconds)",
    evidence: {},
  });
  process.exit(0);
}

const held = new Set();
const taps = [];
const clicks = [];
const setStates = [];
const api = {
  press(key) {
    taps.push(String(key));
  },
  hold(key) {
    held.add(String(key));
  },
  release(key) {
    held.delete(String(key));
  },
  click(id, action = "click") {
    clicks.push({ id: String(id), action: String(action) });
  },
  clickAt(x, y) {
    clicks.push({ x: Number(x), y: Number(y) });
  },
  setState(target, values) {
    setStates.push({ target: String(target), values });
  },
};

let tick = 0;
let current = null;
let obs = null;
let opts = [];
let lastDecisionAt = 0;
let lastOutcome = "running";
let lastSetSig = "";
let lastStatusSig = "";
let lastProgress = Date.now();
let statusSent = false;
let status = { state: "running", note: "", evidence: {} };
let runContext = null;
// An option that arrived or has nothing left is not offered again until the
// option set changes; a failed option rests briefly. doneOpts maps option ->
// option-set signature at completion; failedAt maps option -> wall ms.
const doneOpts = new Map();
const failedAt = new Map();

// Options on offer now: drop completed ones while the set is unchanged and
// failed ones inside the cooldown. When everything is filtered, offer the
// full set rather than deadlocking (the bot's status still ends the run).
const offerable = (options, sig) => {
  for (const [name, atSig] of doneOpts) if (atSig !== sig) doneOpts.delete(name);
  const now = Date.now();
  const kept = options.filter((option) => {
    const name = String(option.name);
    if (doneOpts.has(name)) return false;
    const failed = failedAt.get(name);
    return failed === undefined || now - failed >= FAIL_COOLDOWN_MS;
  });
  return kept.length > 0 ? kept : options;
};

// The bot's own policy, held to what is on offer; without one (or when it
// throws or names something else) the first offered option.
const pickOf = (offered) => {
  try {
    if (typeof policy === "function") {
      const name = String(policy(obs, offered));
      if (offered.some((option) => String(option.name) === name)) return name;
    }
  } catch {
    /* the first option */
  }
  return String(offered[0].name);
};

const handleObs = async (msg) => {
  tick += 1;
  const observation = msg.observation;
  const t = typeof msg.t === "number" ? msg.t : 0;
  // Bots that ignore runContext play exactly as before.
  if (msg.runContext !== undefined && msg.runContext !== null) runContext = msg.runContext;
  if (observation !== null && typeof observation === "object") observation.runContext = runContext;
  let tickObs = null;
  let nextOpts = [];
  try {
    tickObs = await observe(api, observation);
    nextOpts = (await listOptions(tickObs)) ?? [];
    if (!Array.isArray(nextOpts)) nextOpts = [];
  } catch {
    nextOpts = [];
  }
  if (tickObs !== null && tickObs !== undefined) {
    obs = tickObs;
    opts = nextOpts;
  }
  try {
    const st = await readStatus(obs);
    if (st && typeof st.state === "string") status = st;
  } catch {
    /* keep the last status */
  }
  if (!statusSent && status.state !== "running") {
    statusSent = true;
    send({
      op: "status",
      state: String(status.state),
      note: String(status.note ?? ""),
      evidence: status.evidence ?? {},
    });
  }
  if (!statusSent) {
    const setSig = opts.map((option) => String(option.name)).join(",");
    const changed = setSig !== lastSetSig;
    lastSetSig = setSig;
    const due = Date.now() - lastDecisionAt > 1000 / tempo;
    const needDecide =
      current === null || changed || due || lastOutcome === "done" || lastOutcome === "failed";
    if (needDecide && opts.length > 0) {
      lastDecisionAt = Date.now();
      const offered = offerable(opts, setSig);
      // The player report lists offered options no run ever picked.
      send({ op: "offered", t, options: offered.map((option) => String(option.name)) });
      const pick = pickOf(offered);
      if (pick !== current) {
        current = pick;
        lastProgress = Date.now();
        send({ op: "picked", name: pick, t });
      }
    }
    if (current !== null) {
      const option = opts.find((entry) => String(entry.name) === current);
      if (option === undefined) {
        current = null;
        lastOutcome = "failed";
      } else {
        let outcome = "running";
        try {
          outcome = typeof option.run === "function" ? String(await option.run(api, obs)) : outcome;
        } catch {
          outcome = "failed";
        }
        lastOutcome = outcome;
        // Only an option that says "done" is held back; one that always
        // returns "running" stays on offer.
        if (outcome === "done") {
          doneOpts.set(current, setSig);
          current = null;
          lastProgress = Date.now();
        } else if (outcome === "failed") {
          failedAt.set(current, Date.now());
          current = null;
        }
      }
    }
    const statusSig = JSON.stringify([status.note, status.evidence ?? null]);
    if (statusSig !== lastStatusSig) {
      lastStatusSig = statusSig;
      lastProgress = Date.now();
    }
    if (Date.now() - lastProgress > stallSeconds * 1000) {
      statusSent = true;
      send({
        op: "status",
        state: "stalled",
        note: `no progress for ${stallSeconds}s`,
        evidence: { obs },
      });
    }
  }
  send({
    op: "input",
    tick,
    held: [...held],
    taps: taps.splice(0),
    clicks: clicks.splice(0),
    setStates: setStates.splice(0),
  });
};

const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
send({ op: "hello", goal });
for await (const line of lines) {
  if (line.trim() === "") continue;
  let msg = null;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (msg === null || typeof msg !== "object") continue;
  try {
    if (msg.op === "obs") await handleObs(msg);
    else if (msg.op === "bye") process.exit(0);
  } catch (error) {
    send({ op: "log", message: `child error: ${errorText(error, 200)}` });
  }
}
