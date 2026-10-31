#!/usr/bin/env node
// Studio loop: brief in, game out. Vision, prototypes, blind pick, plan,
// art, full build, then rounds (builder, boot check, sweep, tester, blind
// compare, reviewer) until the budget ends, then ship review and exports.
// Each role is one fresh `opencode run` session with a clean room: display
// routes and inherited session vars stripped. Boot check fails only when
// the game cannot start or run (script/parse error, crash, timeout);
// engine shutdown noise is not failure. Failed work is saved on
// rejected/<stage>, never thrown away. Round records append to
// .studio/rounds.jsonl in the game, so a crashed run resumes from the folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const checkout = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    brief: { type: "string" },
    game: { type: "string", default: "game" },
    "budget-min": { type: "string" },
    budget: { type: "string" },
    model: { type: "string", default: "opencode-go/muse-spark-1.3-contributor" },
    variant: { type: "string", default: "xhigh" },
    "continue-game": { type: "boolean", default: false },
  },
});
if (!values.out || !values.brief) {
  console.log(
    "usage: node scripts/studio/run.ts --out E --brief brief.json [--game game] [--budget 30] [--model m] [--variant v] [--continue-game]",
  );
  process.exit(2);
}
const CONTINUE_GAME = values["continue-game"] === true;
const OUT = NodePath.resolve(values.out!);
const GAME = NodePath.join(OUT, values.game!);
const budgetRaw = values.budget ?? values["budget-min"];
const HAS_BUDGET = budgetRaw !== undefined && String(budgetRaw).trim() !== "";
const BUDGET_MS = HAS_BUDGET ? Number(budgetRaw) * 60_000 : Infinity;
const RESERVE_MS = 4 * 60_000;
const TAIL_ROUND_MS = 18 * 60_000;
// Builders get the bulk. One continuing session per build block: the block
// starts one session (--session id) and keeps turning it until time runs
// out; a new session starts only at the block start or if it dies. Tester,
// judge, reviewer and ship run play then write on one session: a play turn
// with its cap, then a ~2min write turn on the same session.
const BLOCK_BUILDER_MS = 25 * 60_000;
const FULL_BUILD_MS = 40 * 60_000;
const TESTER_CAP_MS = 4 * 60_000;
const JUDGE_CAP_MS = 6 * 60_000;
const REVIEWER_CAP_MS = 5 * 60_000;
const WRITE_CAP_MS = 2 * 60_000;
// Post-builder pipeline per round: sweep ~2 + tester 4 + video ~1 +
// two judges (typical ~10 together, hard caps 6 each) + reviewer ~5 ≈ 22m
// typical, 27m worst. The reservation covers the typical case; overruns consume the
// reserve (post-loop stages are guarded) and are logged per round in SPLIT.
const MODEL = `${values.model}#${values.variant}`;
const GODOT = NodePath.join(
  process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local/share"),
  "game-studio/tools/godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64",
);
const BLENDER = NodePath.join(
  process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local/share"),
  "game-studio/tools/blender-4.5.14/blender",
);
const PLAY = NodePath.join(checkout, "scripts/studio", "play.ts");
const SWEEP = NodePath.join(checkout, "scripts/studio/sweep.ts");
const VIDEO = NodePath.join(checkout, "scripts/studio/video.ts");
const SKILLS = NodePath.join(checkout, "apps/server/templates/studio");
const LOG = NodePath.join(OUT, "run.log");
const STATE = NodePath.join(OUT, "state.json");
const DISPLAY_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"];
// Nothing may open on the user's desktop: strip the routes from the harness
// itself first, so every spawned process inherits a clean room by default.
for (const name of DISPLAY_VARS) delete process.env[name];
const FRESH_VARS = [
  "OPENCODE_SESSION_ID",
  "OPENCODE",
  "OPENCODE_TERMINAL",
  "OPENCODE_PASSWORD",
  "OPENCODE_CONFIG_CONTENT",
  "AI_AGENT",
  "T3CODE_CLI_PATH",
];

const log = async (line: string): Promise<void> => {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(stamped);
  await NodeFSP.appendFile(LOG, stamped);
};
const tail = (text: string, n = 30): string => text.split("\n").slice(-n).join("\n");

/** Clean room: no display routes, no inherited session, no user config/plugin. */
const studioEnv = (cwd: string): NodeJS.ProcessEnv => {
  const home = NodeOS.homedir();
  const configHome = NodePath.join(OUT, "config-home");
  const runtime = NodePath.join(OUT, "runtime");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [...DISPLAY_VARS, ...FRESH_VARS]) delete env[name];
  env.PWD = cwd;
  env.XDG_CONFIG_HOME = configHome;
  env.XDG_RUNTIME_DIR = runtime;
  // Verified 2026-10-31 (t20): opencode ignores XDG_CONFIG_HOME for its own
  // config and always merges ~/.config/opencode (user plugins included) plus
  // the project file; "plugins":[] in a project file does not remove the
  // global plugin (server log still says "loading plugin ... ponytail"), and
  // neither does OPENCODE_CONFIG_CONTENT. OPENCODE_CONFIG_DIR=<clean dir> is
  // the only switch that works: zero plugin lines in --print-logs output and
  // MCP servers load from <dir>/opencode.json instead (verified: "mcp
  // connected server=blender tools=9"). So every spawned session gets the
  // harness config dir, never the user's.
  env.OPENCODE_CONFIG_DIR = configHome;
  env.NODE_OPTIONS = "--max-old-space-size=1536";
  env.TMPDIR = NodePath.join(home, ".gs-tmp");
  env.PATH = `${NodePath.join(home, ".gs-tmp/xvfb-local/usr/bin")}${NodePath.delimiter}${env.PATH ?? ""}`;
  const lib = NodePath.join(home, ".gs-tmp/xvfb-local/usr/lib/x86_64-linux-gnu");
  env.LD_LIBRARY_PATH = `${lib}${NodePath.delimiter}${process.env.LD_LIBRARY_PATH ?? ""}`;
  return { ...env, STUDIO_CONFIG_HOME: configHome, STUDIO_RUNTIME: runtime };
};

/** One command in its own process group; only this spawn's PID is signalled. */
let proofDone = false;
/** Watchdog: a session with no log output for STALL_MS is hung. Kill only the
 *  recorded PID (its own group), then let the caller continue the same
 *  session with a short "continue" message. */
const STALL_MS = 4 * 60_000;
const MAX_RESTARTS = 3;
const runCmdWatched = async (
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logPath: string,
  timeoutMs: number,
): Promise<{ timedOut: boolean; exitCode: number | null; stdout: string; stalled: boolean }> => {
  const logFd = await NodeFSP.open(logPath, "w");
  // Seed the log so mtime polling never sees a missing file as progress.
  await logFd.write(`[watchdog] start ${new Date().toISOString()}\n`);
  const child = NodeChildProcess.spawn(executable, [...args], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
  });
  // Proof once: the harness never leaks the desktop into children. Only a
  // stripped spawn counts (raw-env helpers like git are fixed below, never
  // sampled here).
  if (
    !proofDone &&
    child.pid !== undefined &&
    !("DISPLAY" in env) &&
    !("WAYLAND_DISPLAY" in env) &&
    !("XAUTHORITY" in env)
  ) {
    proofDone = true;
    try {
      const raw = await NodeFSP.readFile(`/proc/${child.pid}/environ`, "utf8");
      const names = new Set(raw.split("\0").map((e) => e.split("=")[0]));
      const tmpdir = raw.split("\0").find((e) => e.startsWith("TMPDIR=")) ?? "TMPDIR=?";
      await NodeFSP.appendFile(
        LOG,
        `[${new Date().toISOString()}] PROOF pid=${child.pid} DISPLAY=${names.has("DISPLAY")} WAYLAND_DISPLAY=${names.has("WAYLAND_DISPLAY")} XAUTHORITY=${names.has("XAUTHORITY")} ${tmpdir}\n`,
      );
    } catch {
      try {
        await NodeFSP.appendFile(LOG, `[${new Date().toISOString()}] PROOF unreadable\n`);
      } catch {
        /* log not ready yet */
      }
    }
  }
  let lastSize = 0;
  let lastGrowth = Date.now();
  try {
    lastSize = (await NodeFSP.stat(logPath)).size;
  } catch {
    /* keep 0 */
  }
  let stalled = false;
  let timedOut = false;
  const kill = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* group already gone */
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    setTimeout(() => kill("SIGKILL"), 20_000).unref();
  }, timeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => {
    const probe = setInterval(async () => {
      if (child.exitCode !== null) {
        clearInterval(probe);
        return;
      }
      let size = -1;
      try {
        size = (await NodeFSP.stat(logPath)).size;
      } catch {
        /* gone */
      }
      if (size > lastSize) {
        lastSize = size;
        lastGrowth = Date.now();
      } else if (Date.now() - lastGrowth > STALL_MS) {
        stalled = true;
        clearInterval(probe);
        kill("SIGTERM");
        setTimeout(() => kill("SIGKILL"), 20_000).unref();
      }
    }, 15_000);
    probe.unref();
    child.on("close", (code) => {
      clearInterval(probe);
      resolve(code);
    });
  });
  clearTimeout(timer);
  await logFd.close();
  const stdout = await NodeFSP.readFile(logPath, "utf8").catch(() => "");
  return { timedOut, exitCode, stdout, stalled };
};
const runCmd = async (
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logPath: string,
  timeoutMs: number,
): Promise<{ timedOut: boolean; exitCode: number | null; stdout: string }> => {
  const r = await runCmdWatched(executable, args, cwd, env, logPath, timeoutMs);
  return { timedOut: r.timedOut || r.stalled, exitCode: r.exitCode, stdout: r.stdout };
};

const memOk = async (): Promise<boolean> => {
  const match = (await NodeFSP.readFile("/proc/meminfo", "utf8").catch(() => "")).match(
    /^MemAvailable:\s+(\d+)\s+kB/m,
  );
  return match === null || Number(match[1]!) * 1024 >= 2.5 * 1024 ** 3;
};

/** Boot fails only if the game cannot start or run. Shutdown noise is not failure. */
const bootCheck = async (
  env: NodeJS.ProcessEnv,
  cwd = GAME,
): Promise<{ ok: boolean; detail: string }> => {
  const proj = NodePath.join(cwd, "godot");
  const imp = await runCmd(
    GODOT,
    ["--headless", "--path", proj, "--editor", "--import"],
    cwd,
    env,
    NodePath.join(OUT, "import.log"),
    180_000,
  );
  if (imp.exitCode !== 0) return { ok: false, detail: `import exit ${imp.exitCode}` };
  const run = await runCmd(
    GODOT,
    ["--headless", "--path", proj, "--quit-after", "180"],
    cwd,
    env,
    NodePath.join(OUT, "boot.log"),
    120_000,
  );
  if (run.timedOut) return { ok: false, detail: "boot timeout: game did not run 180 frames" };
  const bad = run.stdout
    .split("\n")
    .filter(
      (line) =>
        /SCRIPT ERROR|Parse Error|Failed to load|main scene|Segmentation fault|Assertion/i.test(
          line,
        ) && !/resources still in use at exit/i.test(line),
    );
  if (run.exitCode !== 0 && bad.length === 0)
    return { ok: false, detail: `boot exit ${run.exitCode}` };
  if (bad.length > 0) return { ok: false, detail: bad.slice(0, 4).join(" | ").slice(0, 600) };
  if (run.exitCode !== 0) return { ok: false, detail: `boot exit ${run.exitCode}` };
  return { ok: true, detail: "boot clean" };
};

// ------------------------------------------------------------------ state ---
type RoundRecord = {
  round: number;
  move: string;
  branch: string;
  sweepFindings: number;
  verdicts: Array<{ order: string; verdict: string; reason: string }>;
  kept: boolean;
  unjudged?: boolean;
  durationMs: number;
  note?: string;
  linesChanged: number;
  testerNote?: string;
};
const stateFromDisk = async (): Promise<{
  done: string[];
  best: string;
  lastGood: string;
  rounds: RoundRecord[];
  times: Record<string, number>;
}> => {
  try {
    return JSON.parse(await NodeFSP.readFile(STATE, "utf8")) as ReturnType<
      typeof stateFromDisk
    > extends Promise<infer T>
      ? T
      : never;
  } catch {
    return { done: [], best: "", lastGood: "", rounds: [], times: {} };
  }
};
const saveState = async (s: {
  done: string[];
  best: string;
  lastGood: string;
  rounds: RoundRecord[];
  times: Record<string, number>;
}): Promise<void> => {
  await NodeFSP.writeFile(STATE, JSON.stringify(s, null, 2));
};

const brief = JSON.parse(await NodeFSP.readFile(NodePath.resolve(values.brief!), "utf8")) as {
  title: string;
  brief: string;
  artDirection: string;
};
const deadline = HAS_BUDGET ? Date.now() + BUDGET_MS : Infinity;
const STARTED_AT = Date.now();
const remaining = (): number => (HAS_BUDGET ? deadline - Date.now() : Infinity);
const elapsedMin = (): number => (Date.now() - STARTED_AT) / 60000;
await NodeFSP.mkdir(OUT, { recursive: true });
await NodeFSP.mkdir(GAME, { recursive: true });
await NodeFSP.mkdir(NodePath.join(OUT, "config-home"), { recursive: true });
// The harness config dir is the whole opencode config (see studioEnv):
// an empty object keeps user plugins and MCP servers out of every session.
await NodeFSP.writeFile(
  NodePath.join(OUT, "config-home", "opencode.json"),
  `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`,
);
await NodeFSP.mkdir(NodePath.join(OUT, "runtime"), { recursive: true, mode: 0o700 });
await NodeFSP.writeFile(
  LOG,
  `studio run: ${brief.title} model=${MODEL} budget=${HAS_BUDGET ? `${budgetRaw}m` : "none"}\n`,
);
let usageStopped = false;
let stallStreak = 0;
let readyDone = false;
let shipNoReasons = "";
const stopRequested = async (): Promise<boolean> =>
  await NodeFSP.access(NodePath.join(GAME, ".studio", "stop"))
    .then(() => true)
    .catch(() => false);
const readStatus = async (): Promise<string | null> => {
  const t = await NodeFSP.readFile(NodePath.join(GAME, ".studio", "next.md"), "utf8").catch(
    () => "",
  );
  const m = [...t.matchAll(/^STATUS:\s*(continue|ready)\s*$/gim)];
  return m.length > 0 ? m[m.length - 1]![1]!.toLowerCase() : null;
};
const isUsageLimit = (s: string): boolean =>
  /usage limit|rate limit|quota exceeded|exceeded.*quota|\b429\b|capacity exceeded|overloaded/i.test(
    s,
  );
let S = await stateFromDisk();
/** Every process the harness spawns loses the desktop routes, including git. */
const strippedEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of DISPLAY_VARS) delete env[name];
  env.TMPDIR = NodePath.join(NodeOS.homedir(), ".gs-tmp");
  return env;
};
const git = (args: readonly string[], cwd = GAME): Promise<{ exitCode: number | null }> =>
  runCmd("git", args, cwd, strippedEnv(), NodePath.join(OUT, "git.log"), 60_000);
const gitOut = (args: readonly string[], cwd = GAME): string =>
  NodeChildProcess.execFileSync("git", args, { cwd, env: strippedEnv() }).toString().trim();

const commitAll = (message: string): string | null => {
  NodeChildProcess.execFileSync("git", ["add", "-A"], { cwd: GAME });
  try {
    NodeChildProcess.execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: GAME });
    return gitOut(["rev-parse", "HEAD"]);
  } catch {
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.email=studio@local", "-c", "user.name=studio", "commit", "-qm", message],
      { cwd: GAME },
    );
    return gitOut(["rev-parse", "HEAD"]);
  }
};
const changedSince = (sha: string): boolean => {
  try {
    NodeChildProcess.execFileSync(
      "git",
      ["diff", "--quiet", `${sha}..HEAD`, "--", ".", ":(exclude)builds"],
      { cwd: GAME },
    );
    return false;
  } catch {
    return true;
  }
};

/** One model turn; pass sessionId to continue one session (--session). */
const session = async (
  name: string,
  prompt: string,
  cwd: string,
  capMs: number,
  logName: string,
  extraEnv?: NodeJS.ProcessEnv,
  sessionId?: string,
): Promise<{ exit: number | null; timedOut: boolean; stdout: string }> => {
  while (!(await memOk())) {
    await log("low memory; waiting 30s");
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    if (remaining() < RESERVE_MS + 120_000) return { exit: null, timedOut: true, stdout: "" };
  }
  if (usageStopped) return { exit: null, timedOut: true, stdout: "" };
  await log(`PROMPT ${logName}: ${prompt}`);
  const args = ["run", "--standalone", "--auto", "--model", MODEL, "--title", `studio-${name}`];
  if (sessionId) args.push("--session", sessionId);
  args.push(prompt);
  // Watchdog: a turn with no log output for 4 min is hung. runCmdWatched
  // kills only the recorded PID; continue the same session (same --session
  // id) with a short continue message. After 3 restarts, end it and log it.
  let restarts = 0;
  let turnArgs = args;
  let tag = logName;
  let last: { exit: number | null; timedOut: boolean; stdout: string } = {
    exit: null,
    timedOut: true,
    stdout: "",
  };
  for (;;) {
    const left = Math.max(60_000, Math.min(capMs, remaining() - 60_000));
    const run = await runCmdWatched(
      "opencode",
      turnArgs,
      cwd,
      { ...studioEnv(cwd), ...extraEnv },
      NodePath.join(OUT, `${tag}.log`),
      left,
    );
    last = { exit: run.exitCode, timedOut: run.timedOut || run.stalled, stdout: run.stdout };
    await log(`END ${tag} exit=${run.exitCode} timedOut=${run.timedOut} stalled=${run.stalled}`);
    await log(`LAST ${tag}:\n${tail(run.stdout)}`);
    if (!run.stalled || restarts >= MAX_RESTARTS) {
      if (run.stalled) {
        await log(`WATCHDOG ${tag}: still silent after ${MAX_RESTARTS} restarts; ending it`);
        await NodeFSP.appendFile(
          NodePath.join(OUT, "watchdog.log"),
          `[${new Date().toISOString()}] ${tag}: ended after ${MAX_RESTARTS} silent restarts\n`,
        );
      }
      if (!isUsageLimit(run.stdout)) return last;
      break;
    }
    restarts += 1;
    await log(
      `WATCHDOG ${tag}: no output for 4m, restart ${restarts}/${MAX_RESTARTS} on the same session`,
    );
    await NodeFSP.appendFile(
      NodePath.join(OUT, "watchdog.log"),
      `[${new Date().toISOString()}] ${tag}: silent 4m, restart ${restarts}/${MAX_RESTARTS}\n`,
    );
    turnArgs = [
      "run",
      "--standalone",
      "--auto",
      "--model",
      MODEL,
      "--title",
      `studio-${name}`,
      ...(sessionId ? ["--session", sessionId] : []),
      "Continue where you left off. Reply briefly, then keep working.",
    ];
    tag = `${logName}-w${restarts}`;
  }
  if (!isUsageLimit(last.stdout)) return last;
  await log(`USAGE-LIMIT ${logName}: pausing, retry every 30m up to 6h; resume from folder`);
  for (let i = 1; i <= 12; i++) {
    await new Promise((r) => setTimeout(r, 30 * 60_000));
    if (await stopRequested()) return last;
    const retry = await runCmd(
      "opencode",
      args,
      cwd,
      { ...studioEnv(cwd), ...extraEnv },
      NodePath.join(OUT, `${logName}-retry${i}.log`),
      capMs,
    );
    if (!isUsageLimit(retry.stdout))
      return { exit: retry.exitCode, timedOut: retry.timedOut, stdout: retry.stdout };
    await log(`USAGE-LIMIT ${logName}: still limited after ${i * 30}m`);
  }
  usageStopped = true;
  await NodeFSP.writeFile(
    NodePath.join(OUT, "usage-limit.txt"),
    `usage limit hit at ${new Date().toISOString()}, stopped after 6h wait\n`,
  );
  await log("USAGE-LIMIT: stopped after 6h, report it");
  return last;
};
/** Plain code facts for reviewers. States numbers, never interprets them. */
const codeFacts = async (gameDir: string): Promise<string> => {
  const gd: Array<{ f: string; n: number }> = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await NodeFSP.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = NodePath.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".godot" && e.name !== "builds") await walk(p);
      } else if (/\.gd$/.test(e.name)) {
        const n = (await NodeFSP.readFile(p, "utf8").catch(() => "")).split("\n").length;
        gd.push({ f: NodePath.relative(gameDir, p), n });
      }
    }
  };
  await walk(NodePath.join(gameDir, "godot"));
  gd.sort((a, b) => b.n - a.n);
  const list = async (re: RegExp): Promise<number> => {
    let c = 0;
    const w = async (d: string): Promise<void> => {
      for (const e of await NodeFSP.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = NodePath.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== ".godot") await w(p);
        } else if (re.test(e.name) && !/\.import$/.test(e.name)) c += 1;
      }
    };
    await w(NodePath.join(gameDir, "godot"));
    return c;
  };
  const imgs = await list(/\.(png|jpg|jpeg|webp|svg)$/i);
  const aud = await list(/\.(wav|ogg|mp3|mid|midi)$/i);
  const mdl = await list(/\.(glb|gltf|fbx|obj|blend)$/i);
  let refs = 0;
  try {
    const out = NodeChildProcess.execFileSync(
      "grep",
      [
        "-rho",
        "res://[^\"' )]*",
        NodePath.join(gameDir, "godot", "scripts"),
        NodePath.join(gameDir, "godot", "scenes"),
      ],
      { encoding: "utf8" },
    );
    refs = out.split("\n").filter(Boolean).length;
  } catch {
    refs = 0;
  }
  const top =
    gd
      .slice(0, 5)
      .map((g) => `${g.f} ${g.n} lines`)
      .join("; ") || "no gd files";
  return `Largest sources: ${top}. Files: ${imgs} images, ${aud} audio, ${mdl} 3D models. Code has ${refs} res:// references.`;
};
/** Play then write on one session. Write turn has its own ~2min cap. */
const newSid = (): string =>
  `ses_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")}`;
const playThenWrite = async (o: {
  role: string;
  cwd: string;
  playPrompt: string;
  writePrompt: string;
  playCap: number;
  notesPath: string | null;
  logTag: string;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<{ notes: string; wrote: boolean }> => {
  const sid = newSid();
  await session(o.role, o.playPrompt, o.cwd, o.playCap, o.logTag, o.extraEnv, sid);
  try {
    await stopPlay(`${o.logTag}-play`, o.cwd);
  } catch {
    /* keep going */
  }
  let writeCap = Math.min(WRITE_CAP_MS, remaining() - 60_000);
  if (writeCap < 90_000 && remaining() > 100_000)
    writeCap = Math.min(WRITE_CAP_MS, remaining() - 60_000);
  if (writeCap < 60_000)
    await log(`WRITE ${o.logTag}: only ${Math.round(writeCap / 1000)}s left, trying anyway`);
  const w1 = await session(
    `${o.role}-write`,
    `Stop playing, now write it. ${o.writePrompt}`,
    o.cwd,
    Math.max(60_000, writeCap),
    `${o.logTag}-write`,
    o.extraEnv,
    sid,
  );
  let notes = o.notesPath ? await readNotesFile(o.notesPath) : w1.stdout;
  if (notes.trim().length > 20) return { notes, wrote: true };
  await log(
    `WRITE-FAIL ${o.logTag}: same-session write empty, one fresh session from notes+screenshots`,
  );
  const shots = (
    await NodeFSP.readdir(NodePath.join(o.cwd, "builds", "logs", "play")).catch(
      () => [] as string[],
    )
  )
    .filter((n) => /^act-\d+\.png$/.test(n) || n === "boot.png")
    .slice(-6)
    .join(", ");
  const fromNotes =
    (o.notesPath ? await readNotesFile(o.notesPath) : "").slice(-3000) || w1.stdout.slice(-3000);
  const w2 = await session(
    `${o.role}-write2`,
    `Write from these notes and screenshots only, no more play. Notes:\n${fromNotes}\nScreenshots: ${shots}\n${o.writePrompt}`,
    o.cwd,
    Math.max(60_000, writeCap),
    `${o.logTag}-write2`,
    o.extraEnv,
  );
  void w2;
  notes = o.notesPath ? await readNotesFile(o.notesPath) : w2.stdout;
  if (notes.trim().length > 20) return { notes, wrote: true };
  await log(`WRITE-FAIL2 ${o.logTag}: still empty after retry`);
  return { notes, wrote: false };
};

/** Save failed work on rejected/<label> and return to best. Never throws work away. */
const rejectWork = async (label: string, why: string): Promise<void> => {
  const tip = gitOut(["rev-parse", "HEAD"]);
  NodeChildProcess.execFileSync("git", ["checkout", "-qb", `rejected/${label}`], { cwd: GAME });
  const saved = commitAll(`rejected ${label}: ${why.slice(0, 120)}`);
  await log(
    `REJECT ${label}: ${why}; work saved on rejected/${label} @ ${saved?.slice(0, 8) ?? tip.slice(0, 8)}`,
  );
  NodeChildProcess.execFileSync("git", ["checkout", "-q", "main"], { cwd: GAME });
  NodeChildProcess.execFileSync("git", ["reset", "--hard", "-q", S.lastGood], { cwd: GAME });
};

// ------------------------------------------------------------------ setup ---
if (CONTINUE_GAME) {
  try {
    NodeChildProcess.execFileSync("git", ["checkout", "-q", "main"], { cwd: GAME });
  } catch {
    await log(`CONTINUE-GAME: ${GAME} is not a git checkout; copy the game there first`);
    process.exit(2);
  }
  const tip = gitOut(["rev-parse", "HEAD"]);
  S.best = tip;
  S.lastGood = tip;
  for (const k of ["init", "vision", "proto-0", "proto-1", "pick", "plan", "art", "build"])
    if (!S.done.includes(k)) S.done.push(k);
  try {
    await NodeFSP.cp(SKILLS, NodePath.join(GAME, "studio-skills"), { recursive: true });
  } catch {
    /* keep old skills */
  }
  await NodeFSP.mkdir(NodePath.join(GAME, ".studio"), { recursive: true });
  await saveState(S);
  await log(`CONTINUE-GAME from main ${tip.slice(0, 8)}, history kept`);
}
if (!S.done.includes("init")) {
  await NodeFSP.writeFile(
    NodePath.join(GAME, ".gitignore"),
    `# harness noise, not the game\nbuilds/\n.godot/\n**/.godot/\n*cache*/\nscreenshots/\n**/screenshots/\n*.log\n`,
  );
  const template = NodePath.join(checkout, "apps/server/templates/blank/godot");
  await NodeFSP.rm(NodePath.join(GAME, "godot"), { recursive: true, force: true });
  await NodeFSP.mkdir(NodePath.join(GAME, "godot"), { recursive: true });
  const project = await NodeFSP.readFile(NodePath.join(template, "project.godot"), "utf8");
  await NodeFSP.writeFile(
    NodePath.join(GAME, "godot/project.godot"),
    project.replaceAll(
      "{{GAME_NAME_ESCAPED}}",
      brief.title.replaceAll("\\", "\\\\").replaceAll('"', '\\"'),
    ),
  );
  await NodeFSP.copyFile(
    NodePath.join(template, "export_presets.cfg"),
    NodePath.join(GAME, "godot/export_presets.cfg"),
  );
  for (const sub of ["scenes", "scripts", "tests"])
    await NodeFSP.cp(NodePath.join(template, sub), NodePath.join(GAME, "godot", sub), {
      recursive: true,
    });
  await NodeFSP.cp(SKILLS, NodePath.join(GAME, "studio-skills"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(GAME, "PROJECT.md"),
    `# ${brief.title} — studio build\n\n` +
      `Godot 4.7.2: \`${GODOT}\`. Sources live in ./godot. Skill pack in ./studio-skills (planning, game-foundations, godot-game, playtest, art-pipeline, audio, art-director, stranger).\n\n` +
      `Exports (run from this folder):\n` +
      `\`${GODOT} --headless --path ./godot --export-release Web ./builds/web/index.html\`\n` +
      `\`${GODOT} --headless --path ./godot --export-release Linux ./builds/linux/game.x86_64\`\n\n` +
      `Play the running game (JSON + screenshot path on stdout; the game waits paused between calls):\n` +
      `\`node ${PLAY} start\` then \`node ${PLAY} act '[{"waitMs":500}]'\`, ` +
      `\`node ${PLAY} inspect /root/GameState mana,turn\`, \`node ${PLAY} video round.mp4\`, \`node ${PLAY} stop\`.\n` +
      `List controls with the ui array from any reply and click them by id. Shelf: \`node ${NodePath.join(checkout, "scripts/studio/studio-assets.ts")} --game . <list|kits|search|fetch|probe-audio>\`; ` +
      `image seam: \`node ${NodePath.join(checkout, "scripts/studio/studio-image.ts")} --prompt TEXT --out file.png\`.\n\n` +
      `Blender headless: \`${BLENDER} --background --python script.py\`. A 3D game needs real 3D models scripted in headless Blender and exported as GLB (rigged characters where they move), then imported and checked in the engine. Code-built primitives are placeholders, same as 2D.\n\n` +
      `Budget: ${HAS_BUDGET ? `work until ${new Date(deadline).toISOString()}. ` : `no time budget; the project has been running, and prompts state the elapsed minutes. `}Spend it changing the game, not planning or playtesting: ` +
      `the harness plays and judges your build after you finish, so run the game only for brief checks of new work.\n\n` +
      `The bar: a stranger would pay a little for this and keep playing past the first minute. A prototype is not enough, and passing a test is not the goal.\n\n` +
      `In-game visuals come from image files and sound from audio files; code-drawn shapes, flat color rectangles and default UI are placeholders. When something is missing or weak, make a better file and use it.\n\n` +
      `Renderer: the harness boots and plays the game with Godot's Compatibility renderer (software GL on a private display). Keep the game working in that renderer; do not require Forward+ or Godot 4.x-only 3D features.\n\n` +
      `Rules: work in ./godot plus VISION.md, PLAN.md, NOTES.md and ASSETS.md only. Do not use subagents. Never commit, never reset git. Never run Godot yourself with a display; only the play CLI above may launch it.\n\n` +
      `Brief: ${brief.brief}\n\nArt direction: ${brief.artDirection}\n`,
  );
  await git(["init", "-q"]);
  await git(["branch", "-M", "main"]);
  await git(["add", "-A"]);
  await git([
    "-c",
    "user.email=studio@local",
    "-c",
    "user.name=studio",
    "commit",
    "-qm",
    "bare start",
  ]);
  S.lastGood = gitOut(["rev-parse", "HEAD"]);
  S.best = S.lastGood;
  S.done.push("init");
  await saveState(S);
} else {
  await log("RESUME from state.json");
}

// ------------------------------------------------------------------ roles ---
const SKILL = "Read the skill files in ./studio-skills first and follow them. ";
const doStage = async (
  key: string,
  name: string,
  prompt: string,
  capMs: number,
  tailReserveMs: number,
): Promise<{ exit: number | null; timedOut: boolean; stdout: string } | null> => {
  if (S.done.includes(key)) {
    await log(`SKIP ${key} (resume)`);
    return null;
  }
  const timeoutMs = Math.min(capMs, remaining() - tailReserveMs);
  if (timeoutMs < 120_000) {
    await log(`SKIP ${key}: not enough budget left`);
    return null;
  }
  const started = Date.now();
  const run = await session(name, prompt, GAME, timeoutMs, key);
  S.times[key] = (S.times[key] ?? 0) + (Date.now() - started);
  return run;
};
const verdictOf = (stdout: string): { verdict: string; reason: string } => {
  const matches = [...stdout.matchAll(/^VERDICT:\s*(A|B|TIE)\s*$/gim)];
  const verdict = matches.length > 0 ? matches[matches.length - 1]![1]!.toUpperCase() : "NONE";
  const lines = stdout.split("\n");
  const at = lines.findLastIndex((line) => /^VERDICT:\s*(A|B|TIE)\s*$/i.test(line));
  const reason =
    at >= 0
      ? lines
          .slice(at + 1)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500)
      : "";
  return { verdict, reason };
};
const PLAYBOOK = `Play first with the play CLI in PROJECT.md and study every screenshot. The code says what should happen, playing shows what does, and playing wins. Use long holds (holdMs 300+) for movement; quick taps are unreliable. `;
const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
/** Builders write; the harness plays. About 150 words, names no game, genre or mechanic. */
const BUILD_RULE = (minutes: number): string =>
  HAS_BUDGET
    ? `Write the game; the harness plays and judges it after you finish. ` +
      `Check new work only briefly, never playtest through the slot. ` +
      `You have up to ${minutes} minutes. Keep it bootable and changes small, so an early stop loses nothing. `
    : `Write the game; the harness plays and judges it after you finish. ` +
      `Check new work only briefly, never playtest through the slot. ` +
      `This project has been running ${elapsedMin().toFixed(0)} minutes; there is no deadline, work the direction. ` +
      `Keep it bootable and changes small, so an early stop loses nothing. `;
// Timeout base for post-builder stages: share what is left, no double reserve.
const postCap = (capMs: number): number =>
  Math.max(90_000, Math.min(capMs, remaining() - RESERVE_MS - 60_000));
// The model picks the next move; code never parses prose. The reviewer writes
// .studio/next.md (play weakness first, then missing plan content, look,
// DO NOT REGRESS); the harness passes it to the next block's builders
// verbatim. No milestone parsing, no pattern matching on reviews.
const readNextMd = async (): Promise<string> => {
  for (const p of [NodePath.join(GAME, ".studio", "next.md")]) {
    const text = (await NodeFSP.readFile(p, "utf8").catch(() => "")).trim();
    if (text) return text.slice(0, 4000);
  }
  const outs = (await NodeFSP.readdir(OUT).catch(() => [] as string[]))
    .filter((n) => /^next-\d+\.md$/.test(n))
    .sort();
  if (outs.length > 0)
    return (
      await NodeFSP.readFile(NodePath.join(OUT, outs[outs.length - 1]!), "utf8").catch(() => "")
    )
      .trim()
      .slice(0, 4000);
  return "";
};
// Notes survive caps: players append to a file as they play; the harness
// reads the file even when the session is killed at its cap.
const readNotesFile = async (p: string): Promise<string> =>
  (await NodeFSP.readFile(p, "utf8").catch(() => "")).trim();
const saveNotes = async (
  tag: string,
  stdout: string,
  notesPath: string | null,
): Promise<string> => {
  const notes = notesPath ? await readNotesFile(notesPath) : "";
  const combined = `${stdout}\n--- notes file ${notesPath ?? "(none)"} ---\n${notes}`.trim();
  await NodeFSP.writeFile(NodePath.join(OUT, `${tag}.txt`), combined.slice(-20000));
  return combined;
};
// Realtime segments one session added, for gap-free video (concat later).
const segList = async (gameDir: string): Promise<string[]> =>
  (
    await NodeFSP.readdir(NodePath.join(gameDir, "builds", "logs", "play", "segments")).catch(
      () => [] as string[],
    )
  )
    .filter((n) => /^seg-.*\.mp4$/.test(n))
    .sort();
// Copy the segments one session added into OUT/vsegs-<tag> right away, so a
// later daemon can never overwrite or remove this session's motion.
const snapshotSegs = async (
  tag: string,
  gameDir: string,
  before: Set<string>,
): Promise<string[]> => {
  const added = (await segList(gameDir)).filter((n) => !before.has(n));
  const dir = NodePath.join(OUT, `vsegs-${tag}`);
  await NodeFSP.rm(dir, { recursive: true, force: true });
  await NodeFSP.mkdir(dir, { recursive: true });
  const kept: string[] = [];
  for (const [i, name] of added.entries()) {
    const next = `seg-${String(i + 1).padStart(3, "0")}.mp4`;
    const ok = await NodeFSP.copyFile(
      NodePath.join(gameDir, "builds", "logs", "play", "segments", name),
      NodePath.join(dir, next),
    )
      .then(() => true)
      .catch(() => false);
    if (ok) kept.push(NodePath.join(dir, next));
  }
  return kept;
};
// Tester frames, starting at the menu: hashes of boot.png + act shots in a play dir.
const shotList = async (gameDir: string): Promise<Map<string, string>> => {
  const dir = NodePath.join(gameDir, "builds", "logs", "play");
  const out = new Map<string, string>();
  for (const name of await NodeFSP.readdir(dir).catch(() => [] as string[])) {
    if (!/^act-\d+\.png$/.test(name) && name !== "boot.png") continue;
    try {
      const bytes = await NodeFSP.readFile(NodePath.join(dir, name));
      out.set(name, NodeCrypto.createHash("sha1").update(bytes).digest("hex"));
    } catch {
      /* disappearing mid-write */
    }
  }
  return out;
};
// Copy only the frames one session added (its own played run) into OUT/shots-<tag>.
const snapshotTesterFrames = async (
  tag: string,
  gameDir: string,
  before: Map<string, string>,
): Promise<string[]> => {
  const after = await shotList(gameDir);
  const changed = [...after.entries()]
    .filter(([name, hash]) => before.get(name) !== hash)
    .map(([name]) => name);
  changed.sort((a, b) => (a === "boot.png" ? -1 : b === "boot.png" ? 1 : a.localeCompare(b)));
  const dir = NodePath.join(OUT, `shots-${tag}`);
  await NodeFSP.rm(dir, { recursive: true, force: true });
  await NodeFSP.mkdir(dir, { recursive: true });
  const kept: string[] = [];
  for (const name of changed) {
    const next = `act-${String(kept.length + 1).padStart(2, "0")}.png`;
    const ok = await NodeFSP.copyFile(
      NodePath.join(gameDir, "builds", "logs", "play", name),
      NodePath.join(dir, next),
    )
      .then(() => true)
      .catch(() => false);
    if (ok) kept.push(next);
  }
  return kept;
};
// Stop a stale play daemon in a game dir. Only recorded PIDs are signalled, never names.
const stopPlay = async (tag: string, gameDir: string): Promise<void> => {
  await runCmd(
    process.execPath,
    [PLAY, "--dir", gameDir, "stop"],
    OUT,
    studioEnv(OUT),
    NodePath.join(OUT, `stop-${tag}.log`),
    30_000,
  ).catch(() => undefined);
  try {
    const sess = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(gameDir, "builds", "logs", "play", "session.json"),
        "utf8",
      ),
    ) as { gamePid?: number; pid?: number; xvfbPid?: number };
    for (const pid of [sess.gamePid, sess.pid, sess.xvfbPid]) {
      if (typeof pid !== "number" || pid <= 0) continue;
      try {
        process.kill(pid, 0);
      } catch {
        continue;
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        process.kill(pid, 0);
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  } catch {
    /* no session file */
  }
};

// ------------------------------------------------------------------ vision ---
await doStage(
  "vision",
  "vision",
  `${PLAYBOOK}Read the brief in PROJECT.md and make it yours. Write VISION.md in this folder in your own words: the player's fantasy, the 30-second loop, what makes this one special. Then create one key-art PNG the finished game must live up to (write it with code or your own image tools) and name it in VISION.md. Do not write game code yet. Work only in this folder. Do not use subagents.`,
  6 * 60_000,
  60 * 60_000,
);
{
  const sha = commitAll("vision");
  if (sha) {
    const boot = await bootCheck(studioEnv(GAME));
    if (!boot.ok) {
      await rejectWork("vision", boot.detail);
    } else {
      S.lastGood = sha;
      S.best = sha;
      await log(`COMMIT vision ${sha.slice(0, 8)} boot=${boot.detail}`);
    }
  }
  if (!S.done.includes("vision")) {
    S.done.push("vision");
    await saveState(S);
  }
}

// -------------------------------------------------------------- prototypes ---
const PROTO_COUNT = 2;
const protos: string[] = [];
for (let i = 0; i < PROTO_COUNT; i++) {
  const key = `proto-${i}`;
  const run = await doStage(
    key,
    `proto-${i}`,
    `${BUILD_RULE(8)}${SKILL}Read the brief in PROJECT.md first. Build the smallest playable core loop in ./godot on this branch with placeholder art only: something winnable and losable. Keep the boot clean. Do not use subagents. Do not commit.`,
    8 * 60_000,
    50 * 60_000,
  );
  // Timeout is not failure: the session used its budget building. Commit the
  // work and let the boot check decide, exactly like a clean exit.
  if (!S.done.includes(key)) {
    if (run) {
      try {
        NodeChildProcess.execFileSync("git", ["checkout", "-qb", key], { cwd: GAME });
      } catch {
        NodeChildProcess.execFileSync("git", ["checkout", "-q", key], { cwd: GAME });
      }
      const sha = commitAll(key);
      if (sha) {
        const boot = await bootCheck(studioEnv(GAME));
        if (!boot.ok) {
          await rejectWork(key, boot.detail);
        } else {
          protos.push(key);
          await log(`COMMIT ${key} ${sha.slice(0, 8)}`);
        }
      }
      NodeChildProcess.execFileSync("git", ["checkout", "-q", "main"], { cwd: GAME });
      NodeChildProcess.execFileSync("git", ["reset", "--hard", "-q", S.best], { cwd: GAME });
      await stopPlay(key, GAME);
    }
    S.done.push(key);
    await saveState(S);
  }
}

// --------------------------------------------------------------- blind pick ---
if (!S.done.includes("pick")) {
  let usable: string[] = [];
  try {
    // Prototypes saved on rejected/proto-* after a boot failure count too:
    // never throw work away before the blind pick.
    usable = gitOut(["branch", "--list", "--format=%(refname:short)"])
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean)
      .filter((name) => /^(rejected\/)?proto-\d+$/.test(name));
  } catch {
    usable = [];
  }
  const pickMs = Math.min(8 * 60_000, remaining() - 40 * 60_000);
  if (usable.length >= 2 && pickMs >= 120_000) {
    const pickDir = NodePath.join(OUT, "pick");
    await NodeFSP.rm(pickDir, { recursive: true, force: true });
    await NodeFSP.mkdir(pickDir, { recursive: true });
    const labels = ["A", "B"];
    for (let i = 0; i < 2; i++) {
      const dir = NodePath.join(pickDir, labels[i]!);
      await NodeFSP.mkdir(dir, { recursive: true });
      NodeChildProcess.execFileSync(
        "git",
        ["--work-tree", dir, "checkout", usable[i]!, "--", "."],
        { cwd: GAME },
      );
    }
    // Pathspec checkout rewrites this repo's index; restore it so the later
    // merge sees a clean tree. Never touches the working tree.
    NodeChildProcess.execFileSync("git", ["reset", "-q"], { cwd: GAME });
    const run = await session(
      "pick",
      `${PLAYBOOK}Two quick versions of the same idea wait in ./A and ./B (run with --dir). Play both with the play CLI (start, act, inspect, stop per game), about two minutes per build. Then report what you did and felt in each: decisions, whether choices mattered, whether you could fail, what you learned, where it got boring, whether you wanted another go. End with exactly one line VERDICT: A or VERDICT: B for the one you would keep playing, then one line of reason. You played both; judge only from play. Do not use subagents.`,
      pickDir,
      pickMs,
      "pick",
    );
    const { verdict, reason } = verdictOf(run.stdout);
    const winner = verdict === "B" ? usable[1]! : usable[0]!;
    await log(`PICK verdict=${verdict} reason=${reason.slice(0, 200)} winner=${winner}`);
    await NodeFSP.writeFile(
      NodePath.join(OUT, "pick-verdict.txt"),
      `VERDICT: ${verdict}\nREASON: ${reason}\nSTDOUT:\n${run.stdout}`,
    );
    NodeChildProcess.execFileSync("git", ["checkout", "-q", "main"], { cwd: GAME });
    try {
      NodeChildProcess.execFileSync("git", ["merge", "--ff-only", "-q", winner], { cwd: GAME });
      S.lastGood = gitOut(["rev-parse", "HEAD"]);
      S.best = S.lastGood;
      await log(`BASE ${winner} -> main ${S.best.slice(0, 8)}`);
    } catch {
      await log(`PICK merge of ${winner} failed; keeping current best ${S.best.slice(0, 8)}`);
    }
    await stopPlay("pick-A", NodePath.join(pickDir, "A"));
    await stopPlay("pick-B", NodePath.join(pickDir, "B"));
  } else {
    await log(
      `PICK skipped: usable=${usable.length} pickMs=${Math.round(pickMs / 1000)}s; keeping ${usable[0] ?? "none"}`,
    );
    if (usable[0]) {
      NodeChildProcess.execFileSync("git", ["checkout", "-q", "main"], { cwd: GAME });
      NodeChildProcess.execFileSync("git", ["merge", "--ff-only", "-q", usable[0]], { cwd: GAME });
      S.lastGood = gitOut(["rev-parse", "HEAD"]);
      S.best = S.lastGood;
    }
  }
  S.done.push("pick");
  await saveState(S);
}

// -------------------------------------------------------------------- plan ---
await doStage(
  "plan",
  "plan",
  `${SKILL}Play the base build with the play CLI first. Then write PLAN.md: the game's structure, with rules and state separate from presentation so later passes can change it safely; the full content list for a demo shape (menu to ending, several levels or systems, progression); the asset list; milestones; and what done means. Concrete and short. Do not write game code. Do not use subagents. Do not commit.`,
  5 * 60_000,
  40 * 60_000,
);
{
  const sha = commitAll("plan");
  if (sha && sha !== S.lastGood) {
    S.lastGood = sha;
    S.best = sha;
    await log(`COMMIT plan ${sha.slice(0, 8)}`);
  }
  if (!S.done.includes("plan")) {
    S.done.push("plan");
    await saveState(S);
  }
}

// --------------------------------------------------------------------- art ---
await doStage(
  "art",
  "art",
  `${SKILL}Read VISION.md and look at the key art named there. Render the game's asset set as files in godot/assets (every character, object, tile, background, UI piece and effect the plan needs, with animation frames where things move), plus sound effects and a music loop as audio files, all held to the look of the key art. A 3D game needs real 3D models scripted in headless Blender at the path in PROJECT.md and exported as GLB (rigged characters where they move), then imported and checked in the engine; code-built primitives are placeholders, same as 2D. You may use the shelf (see PROJECT.md) and record sources in ASSETS.md. Lay what you made into one contact-sheet image, look at it, and redo whatever looks weak until the set hangs together. Do not write game code yet. Do not use subagents. Do not commit.`,
  8 * 60_000,
  32 * 60_000,
);
{
  const sha = commitAll("art");
  if (sha && sha !== S.lastGood) {
    const boot = await bootCheck(studioEnv(GAME));
    if (!boot.ok) await rejectWork("art", boot.detail);
    else {
      S.lastGood = sha;
      S.best = sha;
      await log(`COMMIT art ${sha.slice(0, 8)} boot=${boot.detail}`);
    }
  }
  if (!S.done.includes("art")) {
    S.done.push("art");
    await saveState(S);
  }
}

// --------------------------------------------------------------- full build ---
// One continuing session per block: start one session, keep turning it with
// --session until the block ends. A new session starts only here or if it dies.
const FIRST_DIRECTION = `Read VISION.md and PLAN.md first. Build the most important playable part: the full loop, a way to win and lose, sound from the start, using the files in godot/assets for every visual and sound.`;
const runBuilderBlock = async (
  tag: string,
  direction: string,
  blockMs: number,
  context: string,
): Promise<void> => {
  const end = Date.now() + blockMs;
  let sid = newSid();
  let turn = 0;
  await log(`BLOCK ${tag} session ${sid} direction:\n${direction.slice(0, 800)}`);
  for (;;) {
    const left = Math.min(end - Date.now(), remaining() - RESERVE_MS - 60_000);
    if (left < 120_000) break;
    turn += 1;
    const mins = Math.max(1, Math.round(left / 60_000));
    const prompt =
      turn === 1
        ? `${BUILD_RULE(mins)}${SKILL}This block's direction (follow it exactly; play weakness first):\n${direction}\n${context}Note learnings in NOTES.md. No subagents. No commits.`
        : `${mins} minutes left in this block. Last boot: ${lastBoot}. Keep going with what's still undone from this block's direction:\n${direction}\nDo not redo what works. No subagents. No commits.`;
    await log(`WORDS builder-${tag}-${turn}: ${words(prompt)}`);
    const started = Date.now();
    let run = await session(
      `builder-${tag}`,
      prompt,
      GAME,
      left,
      `builder-${tag}-${turn}`,
      undefined,
      sid,
    );
    if (run.exit !== 0 && !run.timedOut && run.stdout.trim().length < 50) {
      await log(`BLOCK ${tag}: session died on turn ${turn}, starting a new session`);
      sid = `${newSid()}`;
      run = await session(
        `builder-${tag}`,
        prompt,
        GAME,
        left,
        `builder-${tag}-${turn}b`,
        undefined,
        sid,
      );
    }
    S.times[`builder-${tag}`] = (S.times[`builder-${tag}`] ?? 0) + (Date.now() - started);
    await stopPlay(`${tag}-${turn}`, GAME);
    const sha = commitAll(`${tag}-${turn}`);
    if (sha) await log(`COMMIT builder-${tag}-${turn} ${sha.slice(0, 8)}`);
    lastBoot = (await bootCheck(studioEnv(GAME))).detail;
    await log(`TURN ${tag}-${turn} boot=${lastBoot}`);
    if (run.timedOut || Date.now() >= end - 60_000) {
      await log(`BLOCK ${tag}: ${turn} turn(s) on session ${sid}; block ends on time`);
      break;
    }
    await log(`BLOCK ${tag}: turn ${turn} ended early (exit ${run.exit}); continuing same session`);
  }
  try {
    const st = NodeChildProcess.execFileSync(
      "git",
      ["diff", "--shortstat", `${S.best}..HEAD`, "--", ".", ":(exclude)builds"],
      { cwd: GAME },
    )
      .toString()
      .trim();
    await log(`BLOCK ${tag} done: ${turn} turn(s), ${st || "no diff"}`);
  } catch {
    await log(`BLOCK ${tag} done: ${turn} turn(s)`);
  }
};
let lastBoot = "no boot yet";
if (!S.done.includes("build")) {
  const blockMs = Math.min(FULL_BUILD_MS, remaining() - 24 * 60_000);
  if (blockMs >= 120_000) {
    await runBuilderBlock("build", FIRST_DIRECTION, blockMs, "");
  } else {
    await log(`SKIP build: only ${Math.round(remaining() / 60000)}m left`);
  }
}
{
  const sha = commitAll("build");
  if (sha && sha !== S.lastGood) {
    const boot = await bootCheck(studioEnv(GAME));
    if (!boot.ok) await rejectWork("build", boot.detail);
    else {
      S.lastGood = sha;
      S.best = sha;
      await log(`COMMIT build ${sha.slice(0, 8)} boot=${boot.detail}`);
    }
  }
  if (!S.done.includes("build")) {
    S.done.push("build");
    await saveState(S);
  }
  await stopPlay("post-build", GAME);
}

// ------------------------------------------------------------------- rounds ---
// Each round is one continuing-session builder block, then sweep, tester,
// blind compare (both orders) and reviewer (play then write).
const readLastSweep = async (): Promise<string> => {
  const files = (await NodeFSP.readdir(OUT).catch(() => [] as string[]))
    .filter((name) => /^sweep-\d+\.json$/.test(name))
    .sort();
  if (files.length === 0) return "no sweep yet";
  try {
    const sweep = JSON.parse(
      await NodeFSP.readFile(NodePath.join(OUT, files[files.length - 1]!), "utf8"),
    ) as {
      findings: Array<{ detector: string; severity: string; summary: string }>;
    };
    const counts: Record<string, number> = {};
    for (const finding of sweep.findings)
      counts[finding.detector] = (counts[finding.detector] ?? 0) + 1;
    return (
      `${sweep.findings.length} findings (${
        Object.entries(counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ") || "none"
      }): ` +
      sweep.findings
        .slice(0, 8)
        .map((finding) => finding.summary)
        .join(" | ")
    );
  } catch {
    return "sweep unreadable";
  }
};
if (CONTINUE_GAME && !S.done.includes("reviewer-0")) {
  await stopPlay("reviewer-0-pre", GAME);
  const facts = await codeFacts(GAME);
  await log(`FACTS reviewer-0: ${facts}`);
  const r0 = await playThenWrite({
    role: "reviewer-0",
    cwd: GAME,
    playPrompt: `${PLAYBOOK}${SKILL}Play the game in this folder briefly (a few minutes at most). It is the kept build at main. Read PLAN.md and code facts: ${facts}. After every couple of plays, append what you did and felt to .studio/reviewer-0.md. Do not change game files. Do not use subagents.`,
    writePrompt: `Write .studio/next.md with: the biggest weakness in how the game plays, what's still missing from the plan, how to raise the look, the one big move for the next block, a DO NOT REGRESS list, and as the very last line STATUS: continue or STATUS: ready (ready only if a stranger could pay for this demo today). Facts given: ${facts}. Play weakness first. You may only write .studio/reviewer-0.md and .studio/next.md.`,
    playCap: postCap(REVIEWER_CAP_MS),
    notesPath: NodePath.join(GAME, ".studio", "reviewer-0.md"),
    logTag: "reviewer-0",
  });
  await saveNotes("reviewer-0", r0.notes, NodePath.join(GAME, ".studio", "reviewer-0.md"));
  const next0 = await readNotesFile(NodePath.join(GAME, ".studio", "next.md"));
  if (next0) {
    await NodeFSP.writeFile(NodePath.join(OUT, "next-0.md"), next0);
    await log(`REVIEWER-0 next.md ${next0.length} chars`);
  } else await log("REVIEWER-0: no .studio/next.md written (failure)");
  commitAll("reviewer-0");
  S.done.push("reviewer-0");
  await saveState(S);
  await stopPlay("reviewer-0-post", GAME);
}
let round = S.rounds.length;
for (;;) {
  if (usageStopped) {
    await log("ROUNDS end: usage limit stopped");
    break;
  }
  if (await stopRequested()) {
    await log("ROUNDS end: .studio/stop requested");
    break;
  }
  round += 1;
  const tailNeed = TAIL_ROUND_MS;
  if (remaining() < RESERVE_MS + tailNeed) {
    await log(`ROUNDS end: ${Math.round(remaining() / 60000)}m left, reserve reached`);
    round -= 1;
    break;
  }
  const key = `round-${round}`;
  const roundStart = Date.now();
  const late = remaining() < BUDGET_MS * 0.3;
  const direction =
    (await readNextMd()) ||
    "Read PLAN.md and build the most important part still missing from the game. Play weakness first.";
  await log(`DIRECTION ${key} received verbatim:\n${direction.slice(0, 800)}`);
  const move = direction.slice(0, 300);
  const sweepNote = await readLastSweep();
  const context =
    (late ? "Finish stage: no new systems, only defects, polish and missing content. " : "") +
    (shipNoReasons
      ? `Ship said NO last time: ${shipNoReasons.slice(0, 300)}. Fix that first. `
      : "") +
    (HAS_BUDGET
      ? ""
      : `Project has been running ${elapsedMin().toFixed(0)} minutes; no deadline. `) +
    `Sweep facts: ${sweepNote.slice(0, 200)}. Fix play-blockers first. `;
  const blockMs = Math.min(BLOCK_BUILDER_MS, remaining() - tailNeed);
  if (blockMs < 120_000) {
    await log(`ROUND ${round} skipped: no budget`);
    round -= 1;
    break;
  }
  NodeChildProcess.execFileSync("git", ["checkout", "-q", "main"], { cwd: GAME });
  try {
    NodeChildProcess.execFileSync("git", ["checkout", "-qb", key], { cwd: GAME });
  } catch {
    NodeChildProcess.execFileSync("git", ["checkout", "-q", key], { cwd: GAME });
  }
  await stopPlay(`${key}-pre`, GAME);
  await runBuilderBlock(`${round}`, direction, blockMs, context);
  await stopPlay(`${key}-builder`, GAME);
  const record: RoundRecord = {
    round,
    move,
    branch: key,
    sweepFindings: 0,
    verdicts: [],
    kept: false,
    durationMs: 0,
    linesChanged: 0,
    note: late ? "finish stage" : undefined,
  };
  const persistRound = async (): Promise<void> => {
    record.durationMs = Date.now() - roundStart;
    S.rounds.push(record);
    await NodeFSP.mkdir(NodePath.join(GAME, ".studio"), { recursive: true });
    await NodeFSP.appendFile(
      NodePath.join(GAME, ".studio", "rounds.jsonl"),
      `${JSON.stringify(record)}\n`,
    );
    await NodeFSP.appendFile(NodePath.join(OUT, "rounds.jsonl"), `${JSON.stringify(record)}\n`);
    await saveState(S);
  };
  // Timeout is not failure: builders used their block; the boot check decides.
  if (!changedSince(S.best)) {
    await log(`STALL ${key}: no real file changes; one short replace attempt`);
    const retryPrompt = `${BUILD_RULE(6)}The last block changed no files. Make real changes now: read .studio/next.md, NOTES.md and PLAN.md, pick the most visible gap and fix it properly. Do not use subagents. Do not commit.`;
    await log(`WORDS builder-${round}b: ${words(retryPrompt)}`);
    const retryStart = Date.now();
    await session(
      `builder-${round}b`,
      retryPrompt,
      GAME,
      Math.min(6 * 60_000, remaining() - tailNeed),
      `builder-${round}b`,
    );
    S.times[`builder-${round}`] = (S.times[`builder-${round}`] ?? 0) + (Date.now() - retryStart);
    await stopPlay(`${key}-retry`, GAME);
    commitAll(`${key} retry`);
    if (!changedSince(S.best)) {
      NodeChildProcess.execFileSync("git", ["checkout", "-q", "main"], { cwd: GAME });
      record.note = `${record.note ?? ""} stalled (no file changes after replace)`.trim();
      await persistRound();
      stallStreak += 1;
      await log(`STALL-STREAK ${stallStreak}/3`);
      if (stallStreak >= 3) {
        await NodeFSP.writeFile(
          NodePath.join(OUT, "stalled.txt"),
          `stalled: 3 rounds in a row rejected or with no real file change (last: ${key} no changes)\n`,
        );
        await log("STALLED: 3 rounds rejected or no change; stopping");
        break;
      }
      continue;
    }
  }
  const candidate = gitOut(["rev-parse", "HEAD"]);
  const boot = await bootCheck(studioEnv(GAME));
  if (!boot.ok) {
    await rejectWork(key, `boot failed: ${boot.detail}`);
    record.note = `${record.note ?? ""} boot failed: ${boot.detail}`.trim();
    await persistRound();
    stallStreak += 1;
    await log(`STALL-STREAK ${stallStreak}/3`);
    if (stallStreak >= 3) {
      await NodeFSP.writeFile(
        NodePath.join(OUT, "stalled.txt"),
        `stalled: 3 rounds in a row rejected or with no real file change (last: ${key} boot failed)\n`,
      );
      await log("STALLED: 3 rounds rejected or no change; stopping");
      break;
    }
    continue;
  }
  try {
    const stat = NodeChildProcess.execFileSync(
      "git",
      ["diff", "--shortstat", `${S.best}..${candidate}`, "--", ".", ":(exclude)builds"],
      { cwd: GAME },
    ).toString();
    const ins = stat.match(/(\d+) insertions?/);
    const del = stat.match(/(\d+) deletions?/);
    record.linesChanged = (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
    await log(`LINES ${key}: ${stat.trim() || "no diff"} vs best`);
  } catch {
    /* lines stay 0 */
  }
  // Bug sweep (facts, never a gate).
  const sweepPath = NodePath.join(OUT, `sweep-${round}.json`);
  const sweepStart = Date.now();
  await stopPlay(`${key}-pre-sweep`, GAME);
  await runCmd(
    process.execPath,
    [SWEEP, "--dir", GAME, "--out", sweepPath, "--seed", String(round), "--seconds", "60"],
    OUT,
    studioEnv(OUT),
    NodePath.join(OUT, `sweep-${round}.log`),
    140_000,
  );
  S.times[`sweep-${round}`] = Date.now() - sweepStart;
  let sweepFindings = 0;
  try {
    sweepFindings = (
      (JSON.parse(await NodeFSP.readFile(sweepPath, "utf8")) as { findings: unknown[] }).findings ??
      []
    ).length;
  } catch {
    /* sweep crashed; findings stay 0 */
  }
  record.sweepFindings = sweepFindings;
  await log(`SWEEP ${key}: ${sweepFindings} finding(s)`);
  // Tester plays freely. Frames are snapshotted right away: later sessions
  // (judges use neutral dirs, reviewer reuses this one) must not pollute
  // the round video, which shows only this tester's played run from the menu.
  // Tester plays freely with notes that survive caps. Realtime segments give
  // the round its gap-free video; stills remain the fallback and the frames.
  const shotsBefore = await shotList(GAME);
  const segsBefore = new Set(await segList(GAME));
  await NodeFSP.mkdir(NodePath.join(GAME, ".studio"), { recursive: true });
  await stopPlay(`${key}-pre-tester`, GAME);
  const testerStart = Date.now();
  const tPlay = `${PLAYBOOK}Play the game in this folder freely: start it with the play CLI, get past the menu, push as far as you can, try to win and to lose. Use many small acts (each under 30s of game time) so frames save often. After every couple of plays, append what you did and felt to .studio/tester-${round}.md: decisions, whether choices mattered, whether you could fail, what you learned, where it got boring, whether you wanted another go. Report only what you reached. You may only write that notes file; do not change game files. Do not use subagents.`;
  const tWrite = `Read .studio/tester-${round}.md and the screenshots in builds/logs/play. Rewrite the notes file so it states what you did and felt in your own words: decisions, fail, boredom, wanting another go, and your main complaint first. You may only write that notes file.`;
  const tRes = await playThenWrite({
    role: `tester-${round}`,
    cwd: GAME,
    playPrompt: tPlay,
    writePrompt: tWrite,
    playCap: postCap(TESTER_CAP_MS),
    notesPath: NodePath.join(GAME, ".studio", `tester-${round}.md`),
    logTag: `tester-${round}`,
    extraEnv: { STUDIO_RECORD: "1" },
  });
  S.times[`tester-${round}`] = Date.now() - testerStart;
  const testerCombined = await saveNotes(
    `tester-${round}`,
    tRes.notes,
    NodePath.join(GAME, ".studio", `tester-${round}.md`),
  );
  record.testerNote = tail(tRes.notes, 20).slice(-600);
  if (!tRes.wrote) await log(`TESTER ${key}: write phase failed`);
  const testerFrames = await snapshotTesterFrames(`tester-${round}`, GAME, shotsBefore);
  const testerSegs = await snapshotSegs(`tester-${round}`, GAME, segsBefore);
  await log(
    `TESTER ${key}: ${testerFrames.length} frame(s), ${testerSegs.length} realtime segment(s), notes ${testerCombined.length} chars`,
  );
  await stopPlay(`${key}-post-tester`, GAME);
  // Blind play compare, both orders, in neutral folders A and B. Each judge
  // plays each build about 2-3 minutes (hard cap) and writes as it plays;
  // its verdict is a line in notes.md, written early and updated. No in-loop
  // identical-pair control (done by hand once at the end).
  const judgeOne = async (
    tag: string,
    aSha: string,
    bSha: string,
  ): Promise<{ verdict: string; reason: string }> => {
    const t0 = Date.now();
    const dir = NodePath.join(OUT, "cmp", tag);
    await NodeFSP.rm(dir, { recursive: true, force: true });
    await NodeFSP.mkdir(NodePath.join(dir, "A"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(dir, "B"), { recursive: true });
    NodeChildProcess.execFileSync(
      "git",
      ["--work-tree", NodePath.join(dir, "A"), "checkout", aSha, "--", "."],
      { cwd: GAME },
    );
    NodeChildProcess.execFileSync(
      "git",
      ["--work-tree", NodePath.join(dir, "B"), "checkout", bSha, "--", "."],
      { cwd: GAME },
    );
    NodeChildProcess.execFileSync("git", ["reset", "-q"], { cwd: GAME });
    const play = `${PLAYBOOK}Two builds of the same game wait in ./A and ./B (run with --dir A and --dir B). Sample both: play build A about 2-3 minutes, then build B about 2-3 minutes, then stop. After every couple of plays, append what you did and felt to ./notes.md: decisions, whether choices mattered, whether you could fail, where it got boring, whether you wanted another go. Write one line VERDICT: A or VERDICT: B (or VERDICT: TIE) in ./notes.md early and update it if play changes your mind. Judge only from play. You may only write ./notes.md. Do not use subagents.`;
    const write = `Read ./notes.md and the screenshots in A/builds/logs/play and B/builds/logs/play. Rewrite ./notes.md so it states what you did and felt in your own words and ends with VERDICT: A/B/TIE plus reasons on following lines. You may only write ./notes.md.`;
    const j = await playThenWrite({
      role: `judge-${tag}`,
      cwd: dir,
      playPrompt: play,
      writePrompt: write,
      playCap: postCap(JUDGE_CAP_MS),
      notesPath: NodePath.join(dir, "notes.md"),
      logTag: `judge-${tag}`,
    });
    S.times[`judge-${tag}`] = Date.now() - t0;
    const notesOnly = await readNotesFile(NodePath.join(dir, "notes.md"));
    await saveNotes(`judge-${tag}`, notesOnly, NodePath.join(dir, "notes.md"));
    await stopPlay(`${tag}-A`, NodePath.join(dir, "A"));
    await stopPlay(`${tag}-B`, NodePath.join(dir, "B"));
    if (!j.wrote) await log(`JUDGE ${tag}: write phase failed`);
    return verdictOf(notesOnly);
  };
  const order1 = await judgeOne(`${key}-1`, candidate, S.best);
  record.verdicts.push({
    order: "A=candidate,B=best",
    verdict: order1.verdict,
    reason: order1.reason,
  });
  const order2 = await judgeOne(`${key}-2`, S.best, candidate);
  record.verdicts.push({
    order: "A=best,B=candidate",
    verdict: order2.verdict,
    reason: order2.reason,
  });
  const bestWinsBoth = order1.verdict === "B" && order2.verdict === "A";
  if (order1.verdict === "NONE" || order2.verdict === "NONE") {
    record.unjudged = true;
    record.note = `${record.note ?? ""} judge failed; kept unjudged`.trim();
  }
  if (bestWinsBoth) {
    NodeChildProcess.execFileSync("git", ["checkout", "-q", "main"], { cwd: GAME });
    NodeChildProcess.execFileSync("git", ["reset", "--hard", "-q", S.best], { cwd: GAME });
    record.kept = false;
    record.note = `${record.note ?? ""} rejected: best won both orders`.trim();
    await log(
      `REJECT ${key}: best won both orders (${order1.reason.slice(0, 120)} / ${order2.reason.slice(0, 120)}); branch ${key} kept in history`,
    );
    stallStreak += 1;
  } else {
    NodeChildProcess.execFileSync("git", ["checkout", "-q", "main"], { cwd: GAME });
    NodeChildProcess.execFileSync("git", ["merge", "--ff-only", "-q", key], { cwd: GAME });
    S.lastGood = candidate;
    S.best = candidate;
    record.kept = true;
    stallStreak = 0;
    await log(
      `KEEP ${key} ${candidate.slice(0, 8)} (A/B verdicts ${order1.verdict}/${order2.verdict})`,
    );
    // Kept-round video: the tester's own realtime segments (menu onward,
    // gap-free), copied before any later daemon could touch them. Stills are
    // the fallback, and that is logged.
    const videoStart = Date.now();
    const concatOk = await (async (): Promise<boolean> => {
      if (testerSegs.length === 0) {
        await log(`VIDEO ${key}: no realtime segments (before=${segsBefore.size})`);
        return false;
      }
      await NodeFSP.mkdir(NodePath.join(OUT, "videos"), { recursive: true });
      const list = NodePath.join(OUT, `concat-${key}.txt`);
      await NodeFSP.writeFile(list, testerSegs.map((f) => `file '${f}'`).join("\n"));
      const r = await runCmd(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-c",
          "copy",
          NodePath.join(OUT, "videos", `${key}.mp4`),
        ],
        OUT,
        studioEnv(OUT),
        NodePath.join(OUT, `video-${round}.log`),
        150_000,
      );
      await NodeFSP.rm(list, { force: true });
      return r.exitCode === 0;
    })();
    if (concatOk) {
      await log(`VIDEO ${key}: ${testerSegs.length} realtime segment(s)`);
      record.note = `${record.note ?? ""} video=realtime(${testerSegs.length})`.trim();
    } else {
      await runCmd(
        process.execPath,
        [
          VIDEO,
          "--src",
          NodePath.join(OUT, `shots-tester-${round}`),
          "--out",
          NodePath.join(OUT, "videos", `${key}.mp4`),
          "--max",
          "600",
        ],
        OUT,
        studioEnv(OUT),
        NodePath.join(OUT, `video-${round}.log`),
        150_000,
      ).catch(() => undefined);
      await log(`VIDEO ${key}: REAL VIDEO FAILED, used stills`);
      record.note = `${record.note ?? ""} video=stills-fallback`.trim();
    }
    S.times[`video-${round}`] = Date.now() - videoStart;
  }
  // Reviewer plays the kept build, then writes .studio/next.md on the same
  // session. Facts come from code; the reviewer decides what matters.
  const reviewerStart = Date.now();
  const facts = await codeFacts(GAME);
  await log(`FACTS ${key}: ${facts} | ${(await readLastSweep()).slice(0, 200)}`);
  const testerTail = tail(tRes.notes, 40);
  const rPlay = `${PLAYBOOK}${SKILL}Play the game in this folder briefly (a few minutes at most): it is the kept build. Read PLAN.md and .studio/tester-${round}.md. Code facts: ${facts}. Sweep: ${(await readLastSweep()).slice(0, 200)}. Tester said: ${testerTail.slice(-600) || "nothing"}. After every couple of plays, append what you did and felt to .studio/reviewer-${round}.md. You may only write that notes file. Do not change game files. Do not use subagents.`;
  const rWrite = `Read .studio/reviewer-${round}.md and screenshots in builds/logs/play. Rewrite the notes file with what you did and felt, then write .studio/next.md with: the biggest weakness in how the game plays, what's still missing from the plan, how to raise the look, the one big move for the next block, a DO NOT REGRESS list, and as the very last line STATUS: continue or STATUS: ready (ready only if a stranger could pay for this demo today). Code facts: ${facts}. Play weakness first. You may only write .studio/reviewer-${round}.md and .studio/next.md.`;
  const rRes = await playThenWrite({
    role: `reviewer-${round}`,
    cwd: GAME,
    playPrompt: rPlay,
    writePrompt: rWrite,
    playCap: postCap(REVIEWER_CAP_MS),
    notesPath: NodePath.join(GAME, ".studio", `reviewer-${round}.md`),
    logTag: `reviewer-${round}`,
  });
  S.times[`reviewer-${round}`] = Date.now() - reviewerStart;
  await saveNotes(
    `reviewer-${round}`,
    rRes.notes,
    NodePath.join(GAME, ".studio", `reviewer-${round}.md`),
  );
  if (!rRes.wrote) await log(`REVIEWER ${key}: write phase failed`);
  const nextMd = await readNotesFile(NodePath.join(GAME, ".studio", "next.md"));
  if (nextMd) await NodeFSP.writeFile(NodePath.join(OUT, `next-${round}.md`), nextMd);
  else await log(`REVIEWER ${key}: no .studio/next.md written`);
  await stopPlay(`${key}-reviewer`, GAME);
  await persistRound();
  await saveState(S);
  await log(
    `SPLIT ${key}: builder=${((S.times[`builder-${round}`] ?? 0) / 60000).toFixed(1)}m sweep=${((S.times[`sweep-${round}`] ?? 0) / 60000).toFixed(1)}m tester=${((S.times[`tester-${round}`] ?? 0) / 60000).toFixed(1)}m judge1=${((S.times[`judge-${key}-1`] ?? 0) / 60000).toFixed(1)}m judge2=${((S.times[`judge-${key}-2`] ?? 0) / 60000).toFixed(1)}m reviewer=${((S.times[`reviewer-${round}`] ?? 0) / 60000).toFixed(1)}m`,
  );
  if (!record.kept) {
    await log(`STALL-STREAK ${stallStreak}/3`);
    if (stallStreak >= 3) {
      await NodeFSP.writeFile(
        NodePath.join(OUT, "stalled.txt"),
        `stalled: 3 rounds in a row rejected or with no real file change (last: ${key} rejected)\n`,
      );
      await log("STALLED: 3 rounds rejected or no change; stopping");
      break;
    }
  }
  const status = await readStatus();
  await log(`STATUS ${key}: ${status ?? "none"}`);
  if (status === "ready") {
    const sRes = await playThenWrite({
      role: `ship-${round}`,
      cwd: GAME,
      playPrompt: `${PLAYBOOK}Play the game in this folder to the end if you can. After every couple of plays, append what you did and felt to .studio/ship.md. Do not change files. Do not use subagents.`,
      writePrompt: `Read .studio/ship.md and screenshots in builds/logs/play. Rewrite the notes file, then end with exactly one line SHIP: YES or SHIP: NO and reasons. You may only write .studio/ship.md.`,
      playCap: Math.min(7 * 60_000, Math.max(120_000, remaining() - 60_000)),
      notesPath: NodePath.join(GAME, ".studio", "ship.md"),
      logTag: `ship-${round}`,
    });
    const shipText = (await readNotesFile(NodePath.join(GAME, ".studio", "ship.md"))) || sRes.notes;
    await NodeFSP.writeFile(NodePath.join(OUT, `ship-${round}.txt`), shipText.slice(-20000));
    const m = shipText.match(/SHIP:\s*(YES|NO)/i);
    await log(`SHIP-ON-READY ${key}: ${m?.[0] ?? "no SHIP line"}`);
    if (m && m[1]!.toUpperCase() === "YES") {
      readyDone = true;
      break;
    }
    shipNoReasons = (shipText.split(/SHIP:\s*(YES|NO)/i).pop() ?? "").trim().slice(0, 500);
  }
  if (await stopRequested()) {
    await log("ROUNDS end: .studio/stop requested");
    break;
  }
  if (usageStopped) {
    await log("ROUNDS end: usage limit stopped");
    break;
  }
}

// ------------------------------------------------------------------- ship ---
if (
  !readyDone &&
  !S.done.includes("ship") &&
  HAS_BUDGET &&
  remaining() > RESERVE_MS + 120_000 &&
  !usageStopped
) {
  const sPlay = `${PLAYBOOK}Play the game in this folder to the end if you can. After every couple of plays, append what you did and felt to .studio/ship.md. Do not change files. Do not use subagents.`;
  const sWrite = `Read .studio/ship.md and screenshots in builds/logs/play. Rewrite the notes file with what you did and felt, then answer: would you ship this as a demo today, and what is wrong? End with exactly one line SHIP: YES or SHIP: NO and the reasons. You may only write .studio/ship.md.`;
  const sRes = await playThenWrite({
    role: "ship",
    cwd: GAME,
    playPrompt: sPlay,
    writePrompt: sWrite,
    playCap: Math.min(7 * 60_000, remaining() - RESERVE_MS - 120_000),
    notesPath: NodePath.join(GAME, ".studio", "ship.md"),
    logTag: "ship",
  });
  const shipText =
    `${await readNotesFile(NodePath.join(GAME, ".studio", "ship.md"))}\n${sRes.notes}`.trim();
  await NodeFSP.writeFile(NodePath.join(OUT, "ship-review.txt"), shipText.slice(-20000));
  if (!/SHIP:\s*(YES|NO)/i.test(shipText)) await log("SHIP: no SHIP line written (failure)");
  else await log(`SHIP verdict: ${shipText.match(/SHIP:\s*(YES|NO)/i)?.[0]}`);
  S.done.push("ship");
  await saveState(S);
}
// ---------------------------------------------------------------- exports ---
if (!S.done.includes("exports")) {
  if (remaining() > 3 * 60_000) {
    await log(`EXPORTS with ${Math.round(remaining() / 60000)}m left`);
    const env = studioEnv(GAME);
    const proj = NodePath.join(GAME, "godot");
    await NodeFSP.mkdir(NodePath.join(GAME, "builds/web"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(GAME, "builds/linux"), { recursive: true });
    const web = await runCmd(
      GODOT,
      [
        "--headless",
        "--path",
        proj,
        "--export-release",
        "Web",
        NodePath.join(GAME, "builds/web/index.html"),
      ],
      GAME,
      env,
      NodePath.join(OUT, "export-web.log"),
      600_000,
    );
    await log(`EXPORT web exit=${web.exitCode} timedOut=${web.timedOut}`);
    const linux = await runCmd(
      GODOT,
      [
        "--headless",
        "--path",
        proj,
        "--export-release",
        "Linux",
        NodePath.join(GAME, "builds/linux/game.x86_64"),
      ],
      GAME,
      env,
      NodePath.join(OUT, "export-linux.log"),
      600_000,
    );
    await log(`EXPORT linux exit=${linux.exitCode} timedOut=${linux.timedOut}`);
    const boot = await bootCheck(env);
    await log(`FINAL boot ok=${boot.ok} ${boot.detail}`);
    S.done.push("exports");
    await saveState(S);
  } else {
    await log(`SKIP exports: only ${Math.round(remaining() / 60000)}m left`);
  }
}
// -------------------------------------------------------------- final video ---
// Real video: the final tester's own realtime display capture, starting at
// the menu, concatenated gap-free. At least 90 s if the play allows; a second
// session extends short plays. Stills are the fallback, logged as failure.
const probeSeconds = async (mp4: string): Promise<number> => {
  try {
    const out = NodeChildProcess.execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4],
      { timeout: 30_000 },
    )
      .toString()
      .trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
};
if (!S.done.includes("final")) {
  if (remaining() <= 2 * 60_000) {
    await log(`SKIP final video: only ${Math.round(remaining() / 60000)}m left`);
  } else {
    await stopPlay("final-pre", GAME);
    const finalShotsBefore = await shotList(GAME);
    const finalSegsBefore = new Set(await segList(GAME));
    await NodeFSP.mkdir(NodePath.join(GAME, ".studio"), { recursive: true });
    const finalCap = Math.max(120_000, Math.min(12 * 60_000, remaining() - 60_000));
    const fPlay = `${PLAYBOOK}Play the game in this folder from the menu onward for real, long enough to show its full range: start it, play through as much as you can in many small acts (keep each act under 30s of game time so capture stays live), try to reach the ending. After every couple of plays, append what you did and felt to .studio/final-tester.md. You may only write that notes file; do not change game files. Do not use subagents.`;
    const fWrite = `Read .studio/final-tester.md and screenshots in builds/logs/play. Rewrite the notes file with what you did and felt in your own words. You may only write that notes file.`;
    const fRes = await playThenWrite({
      role: "final-tester",
      cwd: GAME,
      playPrompt: fPlay,
      writePrompt: fWrite,
      playCap: finalCap,
      notesPath: NodePath.join(GAME, ".studio", "final-tester.md"),
      logTag: "final-tester",
      extraEnv: { STUDIO_RECORD: "1" },
    });
    await saveNotes("final-tester", fRes.notes, NodePath.join(GAME, ".studio", "final-tester.md"));
    await stopPlay("final-post", GAME);
    const newSegs = await snapshotSegs("final", GAME, finalSegsBefore);
    const concatList = async (files: string[], out: string): Promise<boolean> => {
      if (files.length === 0) return false;
      const list = NodePath.join(OUT, `concat-final-${Date.now()}.txt`);
      await NodeFSP.writeFile(list, files.map((f) => `file '${f}'`).join("\n"));
      const r = await runCmd(
        "ffmpeg",
        ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out],
        OUT,
        studioEnv(OUT),
        NodePath.join(OUT, "video-final.log"),
        300_000,
      );
      await NodeFSP.rm(list, { force: true });
      return r.exitCode === 0;
    };
    let realOk = await concatList(newSegs, NodePath.join(OUT, "final.mp4"));
    let realSecs = realOk ? await probeSeconds(NodePath.join(OUT, "final.mp4")) : 0;
    await log(`FINAL realtime: ${newSegs.length} segment(s), ${realSecs.toFixed(0)}s`);
    if (realSecs < 90 && remaining() > 2 * 60_000) {
      await log(`FINAL second session: only ${realSecs.toFixed(0)}s of motion; playing more`);
      const secondCap = Math.max(90_000, Math.min(8 * 60_000, remaining() - 60_000));
      const second = await session(
        "final-tester-b",
        `${PLAYBOOK}Play the game in this folder again from the menu and push further than the early game: get past what the first minutes show, reach later areas or endings, in many small acts (each under 30s of game time). After every couple of plays, append what you did and felt to .studio/final-tester.md. You may only write that notes file; do not change game files. Do not use subagents.`,
        GAME,
        secondCap,
        "final-tester-b",
        { STUDIO_RECORD: "1" },
      );
      void second;
      await saveNotes(
        "final-tester-b",
        second.stdout,
        NodePath.join(GAME, ".studio", "final-tester.md"),
      );
      await stopPlay("final-post-b", GAME);
      const moreSegs = [...newSegs, ...(await snapshotSegs("final-b", GAME, finalSegsBefore))];
      realOk = await concatList(moreSegs, NodePath.join(OUT, "final.mp4"));
      realSecs = realOk ? await probeSeconds(NodePath.join(OUT, "final.mp4")) : 0;
      await log(
        `FINAL realtime after second session: ${moreSegs.length} segment(s), ${realSecs.toFixed(0)}s`,
      );
    }
    if (realOk && realSecs >= 5) {
      await log(`FINAL VIDEO real motion ${realSecs.toFixed(0)}s`);
      await NodeFSP.writeFile(
        NodePath.join(OUT, "final-video.txt"),
        `real-motion ${realSecs.toFixed(1)}s from ${newSegs.length}+ realtime segment(s)\n`,
      );
    } else {
      await snapshotTesterFrames("final", GAME, finalShotsBefore);
      const finalNames = (
        await NodeFSP.readdir(NodePath.join(OUT, "shots-final")).catch(() => [] as string[])
      )
        .filter((name) => /^act-\d+\.png$/.test(name))
        .sort();
      await NodeFSP.writeFile(NodePath.join(OUT, "final-shots.txt"), finalNames.join("\n"));
      await log(
        `FINAL REAL VIDEO FAILED (${newSegs.length} segs, ${realSecs.toFixed(0)}s); used ${finalNames.length} stills`,
      );
      await runCmd(
        process.execPath,
        [
          VIDEO,
          "--src",
          NodePath.join(OUT, "shots-final"),
          "--out",
          NodePath.join(OUT, "final.mp4"),
          "--max",
          "3000",
        ],
        OUT,
        studioEnv(OUT),
        NodePath.join(OUT, "video-final.log"),
        300_000,
      ).catch(() => undefined);
      await NodeFSP.writeFile(NodePath.join(OUT, "final-video.txt"), `STILLS FALLBACK\n`);
    }
    const framesDir = NodePath.join(OUT, "frames");
    await NodeFSP.mkdir(framesDir, { recursive: true });
    const playDir = NodePath.join(GAME, "builds", "logs", "play");
    const stills = (await NodeFSP.readdir(playDir).catch(() => [] as string[]))
      .filter((n) => /^act-\d+\.png$/.test(n) || n === "boot.png")
      .sort();
    const picks =
      stills.length <= 8
        ? stills
        : Array.from({ length: 8 }, (_, i) => stills[Math.floor(((i + 0.5) * stills.length) / 8)]!);
    let frameIndex = 0;
    for (const shot of picks) {
      frameIndex += 1;
      await NodeFSP.copyFile(
        NodePath.join(playDir, shot),
        NodePath.join(framesDir, `frame-${String(frameIndex).padStart(2, "0")}.png`),
      ).catch(() => undefined);
    }
    await log(`FRAMES ${frameIndex} in ${framesDir}`);
    S.done.push("final");
    await saveState(S);
  }
}
await saveState(S);
await log(
  `TIME-SPLIT min: ${Object.entries(S.times)
    .map(([k, v]) => `${k}=${(v / 60000).toFixed(1)}`)
    .join(" ")}`,
);
await log("DONE");
