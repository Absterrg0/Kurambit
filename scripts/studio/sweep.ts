#!/usr/bin/env node
// studio-sweep: code-only bug sweep. Drives the real game at normal speed
// through real input with a seed: every InputMap action (held and tapped),
// common keys, and every visible UI control. Reports findings with seed,
// time and position: script/engine errors, crash, NaN, out of world,
// long fall, player overlapping solid geometry (physics-space shape query),
// movement input with no movement, frame hitches, frozen screen, impossible
// HUD values. Detector ideas and the player-search order are adapted from
// Aura Autopilot lib/detectors.gd and lib/world.gd (Apache-2.0); the code
// below is our own. Adds nothing to the game's project: the sweepCheck and
// actionHold steps run in the server-owned explore runner. Findings are
// facts for the builder, never a gate: always exits 0 with sweep.json.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const here = NodeURL.fileURLToPath(import.meta.url);
const PLAY = NodePath.join(NodePath.dirname(here), "play.ts");
const { values } = NodeUtil.parseArgs({
  options: {
    dir: { type: "string" },
    out: { type: "string" },
    seed: { type: "string", default: "1" },
    seconds: { type: "string", default: "75" },
  },
});
if (!values.dir || !values.out) {
  console.log("usage: node sweep.ts --dir <gameDir> --out <sweep.json> [--seed N] [--seconds 75]");
  process.exit(2);
}
const GAME = NodePath.resolve(values.dir);
const SEED = Number(values.seed) || 1;
const BUDGET_MS = Math.max(20, Number(values.seconds) || 75) * 1000;

const env = (): NodeJS.ProcessEnv => {
  const home = NodeOS.homedir();
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]) delete clean[name];
  clean.NODE_OPTIONS = "--max-old-space-size=1536";
  clean.TMPDIR = NodePath.join(home, ".gs-tmp");
  clean.PATH = `${NodePath.join(home, ".gs-tmp/xvfb-local/usr/bin")}${NodePath.delimiter}${clean.PATH ?? ""}`;
  return clean;
};
const execPlay = (args: readonly string[], timeoutMs: number): Promise<unknown> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      process.execPath,
      [PLAY, "--dir", GAME, ...args],
      {
        env: env(),
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(`play ${args[0]} failed: ${error.message.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch {
          reject(new Error(`play ${args[0]} returned non-JSON.`));
        }
      },
    );
  });
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const hashFile = async (path: string): Promise<string> => {
  try {
    const bytes = await NodeFSP.readFile(path);
    return NodeCrypto.createHash("sha1").update(bytes).digest("hex").slice(0, 12);
  } catch {
    return "";
  }
};
type Finding = {
  detector: string;
  severity: string;
  summary: string;
  t: number;
  pos: [number, number, number] | null;
  detail: string;
};
const findings: Finding[] = [];
const seen = new Set<string>();
const add = (
  detector: string,
  severity: string,
  summary: string,
  t: number,
  pos: [number, number, number] | null,
  detail: string,
): void => {
  const sig = `${detector}:${summary.slice(0, 120)}`;
  if (seen.has(sig)) return;
  seen.add(sig);
  findings.push({ detector, severity, summary, t, pos, detail: detail.slice(0, 400) });
};
const posOf = (reply: unknown): [number, number, number] | null => {
  const probe = (reply as Record<string, Record<string, unknown>>).probe;
  const player = probe?.player as { x?: unknown; y?: unknown; z?: unknown } | null;
  if (
    player &&
    typeof player.x === "number" &&
    typeof player.y === "number" &&
    typeof player.z === "number"
  )
    return [player.x, player.y, player.z];
  return null;
};

// Every InputMap action in project.godot, plus the built-in ui_* actions.
const readActions = async (): Promise<string[]> => {
  const text = await NodeFSP.readFile(NodePath.join(GAME, "godot", "project.godot"), "utf8").catch(
    () => "",
  );
  const section = text.split("[input]")[1]?.split("\n[")[0] ?? "";
  const names = [...section.matchAll(/^([A-Za-z0-9_]+)=\{$/gm)].map((m) => m[1]!);
  const actions = new Set([
    ...names,
    "ui_accept",
    "ui_select",
    "ui_cancel",
    "ui_left",
    "ui_right",
    "ui_up",
    "ui_down",
  ]);
  return [...actions];
};

const startedAt = Date.now();
const elapsed = (): number => (Date.now() - startedAt) / 1000;
const boot = (await execPlay(["start"], 240000).catch((error: unknown) => ({
  ok: false,
  error: String(error),
}))) as Record<string, unknown>;
if (boot.ok !== true) {
  add(
    "crash",
    "error",
    `Game did not boot: ${String(boot.error ?? boot).slice(0, 200)}`,
    0,
    null,
    JSON.stringify(boot).slice(0, 400),
  );
  await NodeFSP.writeFile(
    NodePath.resolve(values.out!),
    JSON.stringify({ seed: SEED, seconds: 0, actions: [], findings, crashed: true }, null, 2),
  );
  process.exit(0);
}
const actions = await readActions();
const uiControls = Array.isArray(boot.ui)
  ? (boot.ui as Array<{ id: string; enabled: boolean }>)
  : [];
let pos: [number, number, number] | null = posOf(boot);
let sawPlayer = pos !== null;
let lastHash = await hashFile((boot.screenshot as string) ?? "");
let frozenStreak = 0;
let fallingMs = 0;
let overlapStreak = 0;
let acts = 0;
let uiClicked = 0;
let uiIndex = 0;
const rand = mulberry32(SEED);
const keys = [
  "Space",
  "Enter",
  "Escape",
  "W",
  "A",
  "S",
  "D",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];
const fractionRe = /(\d+)\s*\/\s*(\d+)/;

const noteReply = async (
  reply: Record<string, unknown>,
  nominalMs: number,
  wallMs: number,
): Promise<void> => {
  acts += 1;
  pos = posOf(reply) ?? pos;
  if (pos !== null) sawPlayer = true;
  for (const entry of (reply.errors as Array<{ message: string; where: string }>) ?? []) {
    const category = /script|parse/i.test(`${entry.message} ${entry.where}`) ? "script" : "engine";
    add(
      "log_error",
      "error",
      `${category} error: ${entry.message.slice(0, 160)}`,
      elapsed(),
      pos,
      entry.where,
    );
  }
  if (wallMs > nominalMs + 2500)
    add(
      "hitch",
      "warning",
      `An act took ${(wallMs / 1000).toFixed(1)}s wall for ${nominalMs}ms nominal`,
      elapsed(),
      pos,
      "",
    );
  const shot = reply.screenshot as string | null;
  const hash = shot ? await hashFile(shot) : "";
  if (hash && hash === lastHash) {
    frozenStreak += 1;
    if (frozenStreak === 8 && sawPlayer)
      add(
        "frozen",
        "error",
        "Screen unchanged across 8 acts with inputs",
        elapsed(),
        pos,
        shot ?? "",
      );
  } else frozenStreak = 0;
  if (hash) lastHash = hash;
  for (const [key, text] of Object.entries((reply.screenText as Record<string, string>) ?? {})) {
    for (const match of text.matchAll(new RegExp(fractionRe, "g"))) {
      const a = Number(match[1]);
      const b = Number(match[2]);
      if (b > 0 && a > b)
        add(
          "hud_fraction",
          "error",
          `HUD ${key} shows ${a}/${b}`,
          elapsed(),
          pos,
          text.slice(0, 200),
        );
    }
  }
  for (const inspection of (reply.inspections as Array<{
    path: string;
    values: Record<string, unknown>;
    error?: string;
  }>) ?? []) {
    const v = inspection.values ?? {};
    if (!inspection.path) continue;
    if (
      typeof v.x !== "number" ||
      (v.z !== undefined && typeof v.z !== "number" && typeof v.y === "number")
    ) {
      if (!inspection.error)
        add(
          "nan",
          "error",
          `Sweep probe at ${inspection.path} has no position`,
          elapsed(),
          pos,
          JSON.stringify(v).slice(0, 200),
        );
      continue;
    }
    const x = v.x as number;
    const y = v.y as number;
    const z = (v.z as number) ?? 0;
    const dim = v.dim as string;
    if (
      (dim === "2d" && (Math.abs(x) > 20000 || Math.abs(y) > 20000)) ||
      (dim === "3d" && (Math.abs(x) > 2000 || Math.abs(y) > 2000 || Math.abs(z) > 2000))
    )
      add(
        "out_of_world",
        "error",
        `Player out of world at (${x.toFixed(0)}, ${y.toFixed(0)})`,
        elapsed(),
        [x, y, z],
        inspection.path,
      );
    const falling =
      v.onFloor === false &&
      ((dim === "2d" && typeof v.vy === "number" && v.vy > 20) ||
        (dim !== "2d" && typeof v.vy === "number" && v.vy < -1));
    if (falling) {
      fallingMs += nominalMs;
      if (fallingMs >= 6000) {
        add(
          "long_fall",
          "error",
          "Player kept falling for 6s",
          elapsed(),
          [x, y, z],
          inspection.path,
        );
        fallingMs = -1e9;
      }
    } else if (fallingMs >= 0) fallingMs = 0;
    if (typeof v.overlaps === "number" && v.overlaps > 0) {
      overlapStreak += 1;
      if (overlapStreak === 2)
        add(
          "overlap",
          "error",
          `Player overlapping solid geometry (${v.overlaps} at ${String(v.overlapNames).slice(0, 120)})`,
          elapsed(),
          [x, y, z],
          inspection.path,
        );
    } else overlapStreak = 0;
  }
};

// Movement response: hold each movement-like action 1s, require displacement.
const movers = actions.filter((a) => /left|right|up|down|move|forward|back|strafe/i.test(a));
for (const action of movers) {
  if (elapsed() * 1000 > BUDGET_MS - 15000) break;
  const before = pos;
  const wallStart = Date.now();
  try {
    const reply = (await execPlay(
      ["act", JSON.stringify([{ actionHold: { action, holdMs: 1000 } }, { sweepCheck: true }])],
      60000,
    )) as Record<string, unknown>;
    if (reply.ok === true) {
      await noteReply(reply, 1000, Date.now() - wallStart);
      const after = posOf(reply);
      if (before && after) {
        const dist = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
        if (dist < 2)
          add(
            "no_move",
            "warning",
            `Holding ${action} 1s moved nobody (${dist.toFixed(1)})`,
            elapsed(),
            after,
            "menu or blocked?",
          );
      }
    }
  } catch {
    break;
  }
}
// Random seeded play: every action held and tapped, keys, UI controls.
let crashed: string | null = null;
while (elapsed() * 1000 < BUDGET_MS) {
  const steps: unknown[] = [];
  const roll = rand();
  if (uiIndex < uiControls.length && roll < 0.25) {
    const control = uiControls[uiIndex++]!;
    if (control.enabled) {
      steps.push({ ui: { id: control.id, action: "click" } });
      uiClicked += 1;
    } else steps.push({ waitMs: 150 });
  } else if (roll < 0.55) {
    const action = actions[Math.floor(rand() * actions.length)]!;
    steps.push(
      rand() < 0.5
        ? { actionHold: { action, holdMs: 150 } }
        : { actionHold: { action, holdMs: 400 + Math.floor(rand() * 500) } },
    );
  } else if (roll < 0.75) {
    const key = keys[Math.floor(rand() * keys.length)]!;
    steps.push(rand() < 0.5 ? { press: key } : { holdMs: 300 + Math.floor(rand() * 500), key });
  } else {
    steps.push({ waitMs: 150 + Math.floor(rand() * 350) });
  }
  steps.push({ sweepCheck: true });
  const wallStart = Date.now();
  try {
    const reply = (await execPlay(["act", JSON.stringify(steps)], 60000)) as Record<
      string,
      unknown
    >;
    if (reply.ok !== true) {
      crashed = String((reply as { error?: unknown }).error ?? "act not ok");
      add("crash", "error", `Game stopped answering: ${crashed.slice(0, 200)}`, elapsed(), pos, "");
      break;
    }
    await noteReply(reply, 500, Date.now() - wallStart);
    for (const result of (reply.uiResults as Array<{ received: boolean }>) ?? [])
      if (!result.received)
        add(
          "ui_missed",
          "warning",
          "A visible control did not receive its click",
          elapsed(),
          pos,
          "",
        );
  } catch (error) {
    crashed = error instanceof Error ? error.message : String(error);
    add("crash", "error", `Game stopped answering: ${crashed.slice(0, 200)}`, elapsed(), pos, "");
    break;
  }
}
await execPlay(["stop"], 30000).catch(() => undefined);
await NodeFSP.writeFile(
  NodePath.resolve(values.out!),
  JSON.stringify(
    {
      seed: SEED,
      seconds: Math.round(elapsed()),
      actions,
      movers,
      acts,
      uiControls: uiControls.length,
      uiClicked,
      findings,
      crashed,
    },
    null,
    2,
  ),
);
console.log(`sweep: ${findings.length} finding(s), ${acts} acts, seed ${SEED}`);
