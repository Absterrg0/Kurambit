#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Maintainer CLI owns filesystem, subprocess and terminal output boundaries.
// Opt-in seeded quality evaluation over the production review path.
// Plan/calibrate/audio-fixtures modes are worker-safe (files and parsing
// only, no models, no servers). Live mode shells to scripts/game-e2e.ts with
// the exact real-model seam and requires QUALITY_EVAL_LIVE=1, so a worker
// never runs it by accident.
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  QUALITY_EVAL_CASES,
  aggregateQualityEval,
  applyQualityOverlay,
  assertNoGroundtruthInCopy,
  assertNoGroundtruthLeak,
  evaluateQualityCase,
  groundtruthOutsideCopy,
  copyQualityDesignRecords,
  firstQualityRound,
  type QualityCaseResult,
  type QualityEvalCase,
  type QualityVerdict,
} from "../apps/server/src/game/gameQualityEval.ts";
import { designIntentFile } from "../apps/server/src/game/GameDesignApproval.ts";
import { parseCriticAnswer } from "../apps/server/src/game/GameReviewSessions.ts";
import { criticPrompt, renderEvidenceFiles } from "../apps/server/src/game/gameReviewPrompts.ts";
import { readLastPlaytest } from "../apps/server/src/game/playtestEvidence.ts";
import { GAME_REVIEW_QUALITY_DIMENSIONS } from "../packages/contracts/src/index.ts";

const checkout = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const usage = `Usage:
  node scripts/game-quality-eval.ts plan --game <root> --source-home <dir> --case <id|all> --out <dir>
  node scripts/game-quality-eval.ts calibrate
  node scripts/game-quality-eval.ts audio-fixtures --out <dir>
  QUALITY_EVAL_LIVE=1 node scripts/game-quality-eval.ts live --copy <prepared-copy> --groundtruth <file> --source-home <dir> --home-dir <fresh-dir> --summary <file> --evidence <file> --provider opencode --model <id> --reasoning-effort xhigh [--timeout-ms N] [--result <file>]
  QUALITY_EVAL_LIVE=1 node scripts/game-quality-eval.ts live-batch --plan <plan-dir> --source-home <dir> --out <dir> --provider opencode --model <id> --reasoning-effort xhigh [--timeout-ms N] [--cases a,b]

plan copies a genre game per case, applies the seeded overlay to a disposable
copy, writes groundtruth beside the plan (never inside the copy), and prints
the exact live commands. Copies use opaque case-NN names so no fault label
leaks into the game directory; out/cases.json maps them back outside the
games. Playtest evidence (builds/playtests) is preserved so the live review
replays the recorded route; every other build output is omitted as
reproducible weight. plan requires --source-home and refuses to run unless
the source game has design intent records and a nonempty recorded route.
calibrate checks overlays against the bundled templates and the parser
against canned answers: no models, no servers. audio-fixtures writes
tone/silence/clipping/cancellation WAVs with the system ffmpeg for
game_audio_inspect baselines. live runs one prepared copy through
scripts/game-e2e.ts --existing-game with an explicit no-edit review request
(one bounded verify/submit turn, then the server's real critic with the
frozen quality rubric) and scores it. live-batch runs the plan serially,
persists an error result instead of aborting when a case fails, and writes an
honest aggregate: TP/FP/FN/TN plus separate policy counts, with error and
invalid runs kept in the target denominator.`;

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    game: { type: "string" },
    case: { type: "string" },
    cases: { type: "string" },
    out: { type: "string" },
    plan: { type: "string" },
    copy: { type: "string" },
    groundtruth: { type: "string" },
    "source-home": { type: "string" },
    "home-dir": { type: "string" },
    summary: { type: "string" },
    evidence: { type: "string" },
    provider: { type: "string", default: "opencode" },
    model: { type: "string" },
    "reasoning-effort": { type: "string", default: "xhigh" },
    "timeout-ms": { type: "string" },
    result: { type: "string" },
  },
});

const command = positionals[0];
if (command === undefined) throw new Error(usage);

const casesOf = (selector: string | undefined): QualityEvalCase[] => {
  if (selector === undefined || selector === "all") return [...QUALITY_EVAL_CASES];
  const wanted = new Set(selector.split(",").map((entry) => entry.trim()));
  const found = QUALITY_EVAL_CASES.filter((entry) => wanted.has(entry.id));
  if (found.length !== wanted.size) throw new Error(`Unknown case(s): ${selector}`);
  return found;
};

const copyGame = async (source: string, dest: string): Promise<void> => {
  // A plan copy must never touch the source: resolve both sides, refuse an
  // existing destination, refuse ancestor/descendant collisions and symlink
  // escapes, and dereference links so a copied path cannot write back.
  const resolvedSource = await NodeFSP.realpath(source).catch(() => NodePath.resolve(source));
  const parent = NodePath.dirname(NodePath.resolve(dest));
  await NodeFSP.mkdir(parent, { recursive: true });
  const destination = NodePath.join(
    await NodeFSP.realpath(parent),
    NodePath.basename(NodePath.resolve(dest)),
  );
  if (destination === resolvedSource || destination.startsWith(`${resolvedSource}${NodePath.sep}`))
    throw new Error(`Refusing: the copy would land inside the source game (${resolvedSource}).`);
  if (resolvedSource.startsWith(`${destination}${NodePath.sep}`))
    throw new Error(`Refusing: the copy would contain the source game (${resolvedSource}).`);
  if (
    await NodeFSP.lstat(destination).then(
      () => true,
      () => false,
    )
  )
    throw new Error(
      `Refusing: ${destination} already exists; use a fresh --out so a previous plan is never overwritten.`,
    );
  await NodeFSP.cp(resolvedSource, destination, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
    filter: (entry) => {
      const relative = NodePath.relative(resolvedSource, entry);
      if (relative === "") return true;
      if (relative.split(NodePath.sep).includes(".godot")) return false;
      const top = relative.split(NodePath.sep)[0]!;
      if (top === ".git" || top === "node_modules") return false;
      if (top === "builds") {
        // The recorded playtest route lives under builds/playtests and the
        // live review replays it; every other build output is reproducible
        // weight the plan omits.
        const playtests = `builds${NodePath.sep}playtests`;
        return (
          relative === "builds" ||
          relative === playtests ||
          relative.startsWith(`${playtests}${NodePath.sep}`)
        );
      }
      return true;
    },
  });
};

const findDesignStateDir = async (sourceHome: string): Promise<string | null> => {
  // Mirrors scripts/game-e2e.ts copyDesignRecords: the records may live under
  // the home or under its benchmark-server child. Read-only here.
  for (const candidate of [
    NodePath.resolve(sourceHome),
    NodePath.join(NodePath.resolve(sourceHome), "benchmark-server"),
  ]) {
    const directory = NodePath.join(candidate, "userdata", "game-design");
    if ((await NodeFSP.stat(directory).catch(() => null))?.isDirectory() === true) return directory;
  }
  return null;
};

if (command === "plan") {
  if (!values.game || !values.out) throw new Error(usage);
  if (!values["source-home"])
    throw new Error(
      `plan requires --source-home <the source game's --home-dir> so the copy replays a real recorded route.`,
    );
  const gameRoot = NodePath.resolve(values.game);
  const sourceHome = NodePath.resolve(values["source-home"]);
  const out = NodePath.resolve(values.out);
  const cases = casesOf(values.case);
  const styleOf = async (): Promise<string> => {
    try {
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(gameRoot, "game.json"), "utf8"),
      ) as { readonly template?: unknown };
      return typeof manifest.template === "string" ? manifest.template : "unknown-template";
    } catch {
      return "unreadable-manifest";
    }
  };
  const gameStyle = await styleOf();
  const mismatched = cases.filter((entry) => entry.template !== gameStyle);
  if (mismatched.length > 0)
    throw new Error(
      `--game is a ${gameStyle} game but cases need ${mismatched.map((entry) => `${entry.id}(${entry.template})`).join(", ")}. Pass one genre game per style, or --case for its style.`,
    );
  // The live review replays the source game's recorded route and re-keys its
  // design intent at live time (see game-e2e copyDesignRecords), so the plan
  // must prove both exist before writing a single copy. The source stays
  // read-only throughout.
  const stateDir = await findDesignStateDir(sourceHome);
  if (stateDir === null)
    throw new Error(
      `No game-design records under --source-home ${sourceHome} (looked for userdata/game-design and benchmark-server/userdata/game-design).`,
    );
  const intentFile = designIntentFile(NodePath.dirname(stateDir), await NodeFSP.realpath(gameRoot));
  if ((await NodeFSP.stat(intentFile).catch(() => null))?.isFile() !== true)
    throw new Error(
      `The source game has no design intent record (${intentFile}); its copies would open as design-draft and refuse verify.`,
    );
  const last = await readLastPlaytest(gameRoot, []);
  const routeSteps = last?.steps ?? [];
  if (routeSteps.length === 0)
    throw new Error(
      `The source game has no recorded playtest route; run its playtest first so the live review has a route to replay.`,
    );
  const viewport = last?.viewport ?? null;
  const planHome = NodePath.join(out, "source-home");
  const commands: string[] = [];
  const caseMap: Array<{ readonly caseId: string; readonly copy: string }> = [];
  for (const [index, entry] of cases.entries()) {
    // Opaque directory names: no fault label may leak into the game copy.
    // out/cases.json below maps them back, outside every game.
    const copy = NodePath.join(out, "copies", `case-${String(index + 1).padStart(2, "0")}`);
    await copyGame(gameRoot, copy);
    await copyQualityDesignRecords({
      sourceStateDir: NodePath.dirname(stateDir),
      targetStateDir: NodePath.join(planHome, "userdata"),
      sourceRoot: gameRoot,
      targetRoot: copy,
    });
    const applied = await applyQualityOverlay(copy, entry.overlay);
    const copyClean = await assertNoGroundtruthInCopy(copy);
    if (!copyClean) throw new Error(`Prepared copy for ${entry.id} carries groundtruth sidecars.`);
    const groundtruthFile = NodePath.join(out, "groundtruth", `${entry.id}.json`);
    if (!groundtruthOutsideCopy(copy, groundtruthFile))
      throw new Error(`Groundtruth for ${entry.id} would land inside its game copy.`);
    const groundtruth = {
      caseId: entry.id,
      style: entry.style,
      kind: entry.kind,
      fault: entry.fault,
      expected: entry.expected,
      routeNote: entry.routeNote,
      overlay: entry.overlay,
      copy,
      sourceGame: gameRoot,
      sourceHome: planHome,
      routeSteps: routeSteps.length,
      viewport,
    };
    await NodeFSP.mkdir(NodePath.join(out, "groundtruth"), { recursive: true });
    await NodeFSP.writeFile(groundtruthFile, `${JSON.stringify(groundtruth, null, 2)}\n`);
    caseMap.push({ caseId: entry.id, copy });
    const homeDir = NodePath.join(out, "homes", `case-${String(index + 1).padStart(2, "0")}`);
    const summary = NodePath.join(out, "summaries", `${entry.id}.json`);
    const evidence = NodePath.join(out, "evidence", `${entry.id}.json`);
    const result = NodePath.join(out, "results", `${entry.id}.json`);
    commands.push(
      [
        `QUALITY_EVAL_LIVE=1 node scripts/game-quality-eval.ts live --copy ${copy}`,
        `--groundtruth ${groundtruthFile}`,
        `--source-home ${planHome} --home-dir ${homeDir}`,
        `--summary ${summary} --evidence ${evidence}`,
        `--provider ${values.provider} --model <provider-model-id> --reasoning-effort ${values["reasoning-effort"]}`,
        `--result ${result}`,
      ].join(" "),
    );
    console.log(
      `Prepared ${entry.id} (${entry.kind}${applied.applied ? `, overlay in ${applied.file}` : ", clean control"}) as ${copy} with the source route (${routeSteps.length} steps).`,
    );
  }
  await NodeFSP.writeFile(
    NodePath.join(out, "cases.json"),
    `${JSON.stringify(caseMap, null, 2)}\n`,
  );
  console.log("\nLive commands (one heavy operation each; run serially):");
  for (const line of commands) console.log(`  ${line}`);
  console.log(
    "Live runs pass the eval's no-edit review request to game-e2e automatically: verify once with the recorded route, submit, or stop honestly.",
  );
} else if (command === "calibrate") {
  // Parser-only calibration with canned answers: validates the evidence
  // rules without models. Real-model proof comes only from live runs.
  const frames = new Set(["f1", "f2", "f3"]);
  const base = {
    fundamentals: {
      boots: { verdict: "yes", frameIds: ["f1"], note: "boots" },
      respondsToInput: { verdict: "yes", frameIds: ["f1", "f2"], note: "responds" },
      coreActionVisible: { verdict: "yes", frameIds: ["f1", "f2"], note: "visible" },
      stateReadable: { verdict: "yes", frameIds: ["f2"], note: "readable" },
    },
    defects: [],
    doNotRegress: [],
  } as const;
  const quality = (overrides: Record<string, unknown>) => ({
    artConsistency: { verdict: "yes", frameIds: ["f1", "f2"], note: "holds" },
    animation: { verdict: "cannot-tell", frameIds: [], note: "one pose" },
    audio: { verdict: "cannot-tell", frameIds: [], note: "no audio evidence" },
    readability: { verdict: "yes", frameIds: ["f2"], note: "legible" },
    progression: { verdict: "cannot-tell", frameIds: [], note: "short route" },
    agency: { verdict: "cannot-tell", frameIds: [], note: "no choice" },
    playability: { verdict: "yes", frameIds: ["f1", "f2"], note: "acts" },
    ...overrides,
  });
  const answer = (q: unknown) => JSON.stringify({ ...base, quality: q });
  const knownBase = {
    frameIds: frames,
    checkIds: new Set<string>(),
    recipeIds: new Set<string>(),
    requireQuality: true as const,
  };
  const checks: Array<[string, boolean]> = [];
  const modern = parseCriticAnswer(answer(quality({})), knownBase);
  checks.push(["modern full coverage parses", modern.kind === "valid"]);
  const missing = parseCriticAnswer(JSON.stringify(base), knownBase);
  checks.push(["missing quality rejected on new session", missing.kind === "invalid"]);
  const legacy = parseCriticAnswer(JSON.stringify(base), {
    frameIds: frames,
    checkIds: new Set<string>(),
    recipeIds: new Set<string>(),
  });
  checks.push(["legacy answer without quality stays readable", legacy.kind === "valid"]);
  const audioYes = parseCriticAnswer(
    answer(quality({ audio: { verdict: "yes", frameIds: ["f1"], note: "music" } })),
    knownBase,
  );
  checks.push(["audio yes without evidence rejected", audioYes.kind === "invalid"]);
  const audioYesBound = parseCriticAnswer(
    answer(quality({ audio: { verdict: "yes", frameIds: ["f1"], note: "heard cue" } })),
    { ...knownBase, hasAudioEvidence: true as const },
  );
  checks.push(["audio yes with frozen evidence parses", audioYesBound.kind === "valid"]);
  const animationOne = parseCriticAnswer(
    answer(quality({ animation: { verdict: "yes", frameIds: ["f2"], note: "moves" } })),
    knownBase,
  );
  checks.push(["animation yes from one pose rejected", animationOne.kind === "invalid"]);
  const agencyOne = parseCriticAnswer(
    answer(quality({ agency: { verdict: "yes", frameIds: ["f2"], note: "choice" } })),
    knownBase,
  );
  checks.push(["agency yes from one frame rejected", agencyOne.kind === "invalid"]);
  const unknownFrame = parseCriticAnswer(
    answer(quality({ readability: { verdict: "no", frameIds: ["f9"], note: "clipped" } })),
    knownBase,
  );
  checks.push(["unknown frame rejected", unknownFrame.kind === "invalid"]);
  // A real reviewer packet: the manifest the prompt reads, the rendered
  // prompt, anonymous frames and checks. Groundtruth labels must not ride it.
  const leakFiles = [
    { path: "BRIEF.md", label: "brief" },
    { path: "frames/f1.png", label: "frame f1" },
  ];
  const leakPacket = {
    brief: "fixture",
    frames: [{ id: "f1" }, { id: "f2" }],
    checks: [],
    manifest: renderEvidenceFiles(leakFiles),
    prompt: criticPrompt(leakFiles),
  };
  checks.push(["real reviewer packet carries no groundtruth", assertNoGroundtruthLeak(leakPacket)]);
  checks.push([
    "groundtruth path outside the copy it describes",
    groundtruthOutsideCopy(
      "out/copies/case-01",
      "out/groundtruth/screen-meaningless-consequence.json",
    ) && !groundtruthOutsideCopy("out/copies/case-01", "out/copies/case-01/game.json"),
  ]);
  // Overlays apply exactly once to the bundled templates they target.
  for (const entry of QUALITY_EVAL_CASES) {
    if (entry.overlay === null) continue;
    const target = NodePath.join(
      checkout,
      "apps/server/templates",
      entry.template,
      entry.overlay.file,
    );
    const text = await NodeFSP.readFile(target, "utf8");
    const occurrences = text.split(entry.overlay.find).length - 1;
    checks.push([`overlay ${entry.id} hits exactly once`, occurrences === 1]);
  }
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "ok" : "FAIL"} ${name}`);
    if (!ok) failed += 1;
  }
  // Aggregation honesty: detection and policy stay separate, error runs
  // stay in the target denominator, and unknown never passes or fails.
  const aggregated = aggregateQualityEval([
    evaluateQualityCase({
      case: QUALITY_EVAL_CASES[0]!,
      actual: { readability: "no" },
      coverage: { assessed: 7, total: 7, unknowns: 5 },
    }),
    evaluateQualityCase({
      case: QUALITY_EVAL_CASES[1]!,
      actual: { readability: "cannot-tell" },
      coverage: { assessed: 7, total: 7, unknowns: 7 },
    }),
    evaluateQualityCase({
      case: QUALITY_EVAL_CASES[2]!,
      actual: { readability: "no" },
      coverage: { assessed: 7, total: 7, unknowns: 5 },
    }),
    evaluateQualityCase({
      case: QUALITY_EVAL_CASES[4]!,
      actual: { readability: "no", audio: "cannot-tell" },
      coverage: { assessed: 7, total: 7, unknowns: 6 },
    }),
    evaluateQualityCase({
      case: QUALITY_EVAL_CASES[0]!,
      actual: null,
      coverage: null,
      error: "timeout",
    }),
  ]);
  const honest =
    aggregated.hits === 3 &&
    aggregated.truePositives === 3 &&
    aggregated.trueNegatives === 0 &&
    aggregated.misses === 0 &&
    aggregated.unknowns === 1 &&
    aggregated.policyTargets === 1 &&
    aggregated.policyPass === 1 &&
    aggregated.policyFail === 0 &&
    aggregated.keyDimensions === 6 &&
    aggregated.errors === 1;
  console.log(`${honest ? "ok" : "FAIL"} aggregation keeps detection, policy and errors separate`);
  if (!honest) failed += 1;
  if (failed > 0) throw new Error(`${failed} calibration check(s) failed.`);
  console.log(`Calibrated: ${checks.length + 1} checks, no models, no servers.`);
} else if (command === "audio-fixtures") {
  if (!values.out) throw new Error(usage);
  const out = NodePath.resolve(values.out);
  await NodeFSP.mkdir(out, { recursive: true });
  const run = (args: ReadonlyArray<string>) =>
    new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn("ffmpeg", [...args], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
      );
    });
  const tone = NodePath.join(out, "tone.wav");
  const silence = NodePath.join(out, "silence.wav");
  const clipping = NodePath.join(out, "clipping.wav");
  const cancelled = NodePath.join(out, "cancelled.wav");
  await run([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-ar",
    "44100",
    "-ac",
    "2",
    tone,
  ]);
  await run(["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo:d=2", silence]);
  await run([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2,volume=40dB",
    "-ar",
    "44100",
    "-ac",
    "2",
    clipping,
  ]);
  await run([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-filter_complex",
    "[0:a]pan=stereo|c0=c0|c1=-1*c0[a]",
    "-map",
    "[a]",
    "-ar",
    "44100",
    cancelled,
  ]);
  console.log(`Wrote ${tone}\nWrote ${silence}\nWrote ${clipping}\nWrote ${cancelled}`);
  console.log(
    "Copy each into a game (e.g. godot/assets/audio/<name>) and run game_audio_inspect on the game-relative path: tone peaks near -20 dBFS, silence means <= -60 dBFS, clipping shows 0 dBFS samples, cancellation warns opposite-phase collapse.",
  );
} else if (command === "live" || command === "live-batch") {
  if (process.env.QUALITY_EVAL_LIVE !== "1")
    throw new Error("Refusing: live runs a real model. Re-run with QUALITY_EVAL_LIVE=1.");
  // The eval never invents its own review path: it passes one explicit
  // request that forbids the builder from editing anything. A gate failure
  // ends the run honestly instead of becoming a source fix.
  const QUALITY_EVAL_REVIEW_REQUEST = `This is an isolated copy of an already generated game. Do not generate a new game, redesign it, or change its verification policy. Preserve its mechanics, art direction and approved DESIGN.md. Exercise the production review path on the existing implementation: read AGENTS.md and game_status, run game_verify once with exactly the recorded input route below (it checks, runs the canonical test, exports Web and records a playtest of those exact bytes), inspect the returned frames, then call game_submit with one line naming what the build is. If the playtest qualifies, submit; if any gate fails, make no source fix and stop after reporting the failure honestly. Do not edit sources, design, brief, manifest, tests, scenarios, checks, evidence or review records, and do not change the route. The server decides review outcomes; do not claim them. Stop after the submit or the honest stop.`;

  const TIMEOUT_MIN_MS = 60_000;
  const TIMEOUT_MAX_MS = 14_400_000;
  const parseTimeoutMs = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw))
      throw new Error(`--timeout-ms must be an integer number of milliseconds, got ${raw}.`);
    const ms = Number(raw);
    if (!Number.isSafeInteger(ms) || ms < TIMEOUT_MIN_MS || ms > TIMEOUT_MAX_MS)
      throw new Error(
        `--timeout-ms must be between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS} ms, got ${raw}.`,
      );
    return ms;
  };
  const timeoutMs = parseTimeoutMs(values["timeout-ms"]);

  const persistResult = async (path: string | undefined, result: QualityCaseResult) => {
    if (path === undefined) return;
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
  };

  const runOne = async (input: {
    readonly copy: string;
    readonly groundtruthFile: string;
    readonly sourceHome: string;
    readonly homeDir: string;
    readonly summary: string;
    readonly evidence: string;
    readonly result?: string | undefined;
  }): Promise<QualityCaseResult> => {
    if (!values.model) throw new Error("live requires --model <provider-model-id>.");
    const groundtruth = JSON.parse(await NodeFSP.readFile(input.groundtruthFile, "utf8")) as {
      readonly caseId: string;
      readonly expected: Partial<Record<string, QualityVerdict>>;
    };
    const entry = QUALITY_EVAL_CASES.find((candidate) => candidate.id === groundtruth.caseId);
    if (entry === undefined) throw new Error(`Unknown case ${groundtruth.caseId}.`);
    const fail = async (result: QualityCaseResult): Promise<QualityCaseResult> => {
      console.log(JSON.stringify({ caseId: entry.id, result }, null, 2));
      await persistResult(input.result, result);
      return result;
    };
    const gameCopy = NodePath.join(
      NodePath.dirname(input.copy),
      `${NodePath.basename(input.copy)}-run`,
    );
    if (
      await NodeFSP.lstat(gameCopy).then(
        () => true,
        () => false,
      )
    )
      return fail(
        evaluateQualityCase({
          case: entry,
          actual: null,
          coverage: null,
          error: `Refusing: the live copy ${gameCopy} already exists from a previous run.`,
        }),
      );
    const args = [
      "scripts/game-e2e.ts",
      "--existing-game",
      input.copy,
      "--game-copy",
      gameCopy,
      "--source-home",
      input.sourceHome,
      "--home-dir",
      input.homeDir,
      "--summary",
      input.summary,
      "--evidence",
      input.evidence,
      "--provider",
      values.provider!,
      "--model",
      values.model,
      "--reasoning-effort",
      values["reasoning-effort"]!,
      "--review-request",
      QUALITY_EVAL_REVIEW_REQUEST,
    ];
    if (timeoutMs !== undefined) args.push("--timeout-ms", String(timeoutMs));
    console.log(
      `Running ${groundtruth.caseId}: node ${args
        .map((part) => (part === QUALITY_EVAL_REVIEW_REQUEST ? "<no-edit-review-request>" : part))
        .join(" ")}`,
    );
    const exitCode = await new Promise<number>((resolve) => {
      const child = NodeChildProcess.spawn(process.execPath, args, {
        cwd: checkout,
        stdio: "inherit",
      });
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", (cause) => {
        console.error(`game-e2e spawn failed: ${cause.message}`);
        resolve(1);
      });
    });
    // The evidence file is the only record that matters; a missing or
    // unreadable file is a case error, never a reason to abort the batch.
    let evidence: {
      readonly builder?:
        | { readonly sourceChanged?: boolean | null; readonly sourceBytesChanged?: boolean }
        | undefined;
      readonly review?: {
        readonly rounds?: ReadonlyArray<{
          readonly id: string;
          readonly startedAt: string;
          readonly quality?: Record<string, { readonly verdict: string }> | undefined;
          readonly qualityCoverage?: {
            readonly assessed: number;
            readonly total: number;
            readonly unknowns: number;
          } | null;
        }>;
      } | null;
      readonly error?: string | null;
    };
    try {
      evidence = JSON.parse(await NodeFSP.readFile(input.evidence, "utf8"));
    } catch (cause) {
      return fail(
        evaluateQualityCase({
          case: entry,
          actual: null,
          coverage: null,
          error: `game-e2e exited ${exitCode} with no readable evidence: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
    }
    if (evidence.error != null)
      return fail(
        evaluateQualityCase({ case: entry, actual: null, coverage: null, error: evidence.error }),
      );
    // The no-edit review request is load-bearing: a builder that changed
    // sources invalidates the verdict, because the critic may have judged a
    // repaired game instead of the seeded copy.
    if (evidence.builder?.sourceBytesChanged !== false)
      return fail(
        evaluateQualityCase({
          case: entry,
          actual: null,
          coverage: null,
          invalidReason: `The review builder edited sources despite the no-edit review request (exit ${exitCode}); the verdict would not describe the seeded copy.`,
        }),
      );
    const rounds = evidence.review?.rounds ?? [];
    // The earliest judged round scores the seeded build; later rounds reflect
    // the repair loop's fixes, never the seed.
    const judged = firstQualityRound(rounds);
    if (judged === undefined)
      return fail(
        evaluateQualityCase({
          case: entry,
          actual: null,
          coverage: null,
          invalidReason: `game-e2e exited ${exitCode} with no quality round in evidence.`,
        }),
      );
    const result = evaluateQualityCase({
      case: entry,
      actual: Object.fromEntries(
        GAME_REVIEW_QUALITY_DIMENSIONS.filter(
          (dimension) => judged.quality?.[dimension] !== undefined,
        ).map((dimension) => [dimension, judged.quality![dimension]!.verdict as QualityVerdict]),
      ),
      coverage: judged.qualityCoverage ?? null,
    });
    console.log(JSON.stringify({ caseId: entry.id, exitCode, result }, null, 2));
    await persistResult(input.result, result);
    return result;
  };
  if (command === "live") {
    if (
      !values.copy ||
      !values.groundtruth ||
      !values["source-home"] ||
      !values["home-dir"] ||
      !values.summary ||
      !values.evidence
    )
      throw new Error(usage);
    const result = await runOne({
      copy: NodePath.resolve(values.copy),
      groundtruthFile: NodePath.resolve(values.groundtruth),
      sourceHome: NodePath.resolve(values["source-home"]),
      homeDir: NodePath.resolve(values["home-dir"]),
      summary: NodePath.resolve(values.summary),
      evidence: NodePath.resolve(values.evidence),
      ...(values.result === undefined ? {} : { result: NodePath.resolve(values.result) }),
    });
    if (result.error !== null || result.invalidReason !== null)
      throw new Error(`live run for ${result.caseId} did not produce a verdict.`);
  } else {
    if (!values.plan || !values["source-home"] || !values.out) throw new Error(usage);
    const planDir = NodePath.resolve(values.plan);
    const out = NodePath.resolve(values.out);
    const selected =
      values.cases
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? null;
    if (selected !== null) {
      const unknown = selected.filter((id) => !QUALITY_EVAL_CASES.some((entry) => entry.id === id));
      if (unknown.length > 0) throw new Error(`Unknown case(s): ${unknown.join(", ")}`);
      if (selected.length === 0) throw new Error("--cases must name at least one case.");
    }
    const truthFiles = (await NodeFSP.readdir(NodePath.join(planDir, "groundtruth"))).filter(
      (name) => name.endsWith(".json"),
    );
    const results: QualityCaseResult[] = [];
    for (const name of truthFiles.sort()) {
      const truth = JSON.parse(
        await NodeFSP.readFile(NodePath.join(planDir, "groundtruth", name), "utf8"),
      ) as { readonly caseId: string; readonly copy: string; readonly sourceHome?: string };
      if (selected !== null && !selected.includes(truth.caseId)) continue;
      const resultFile = NodePath.join(out, "results", `${truth.caseId}.json`);
      try {
        results.push(
          await runOne({
            copy: truth.copy,
            groundtruthFile: NodePath.join(planDir, "groundtruth", name),
            sourceHome: NodePath.resolve(truth.sourceHome ?? values["source-home"]),
            homeDir: NodePath.join(out, "homes", `${truth.caseId}`),
            summary: NodePath.join(out, "summaries", `${truth.caseId}.json`),
            evidence: NodePath.join(out, "evidence", `${truth.caseId}.json`),
            result: resultFile,
          }),
        );
      } catch (cause) {
        // Serial and bounded: a case that throws outside runOne still records
        // an error result and the batch continues with the next case.
        const entry = QUALITY_EVAL_CASES.find((candidate) => candidate.id === truth.caseId);
        const result =
          entry === undefined
            ? null
            : evaluateQualityCase({
                case: entry,
                actual: null,
                coverage: null,
                error: cause instanceof Error ? cause.message : String(cause),
              });
        if (result !== null) {
          console.log(JSON.stringify({ caseId: entry!.id, result }, null, 2));
          await persistResult(resultFile, result);
          results.push(result);
        }
      }
    }
    const aggregated = aggregateQualityEval(results);
    await NodeFSP.mkdir(out, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(out, "aggregate.json"),
      `${JSON.stringify(aggregated, null, 2)}\n`,
    );
    console.log(JSON.stringify(aggregated, null, 2));
    if (aggregated.invalid > 0 || aggregated.errors > 0)
      throw new Error(
        `live-batch finished with ${aggregated.errors} error(s) and ${aggregated.invalid} invalid result(s); see ${NodePath.join(out, "aggregate.json")}.`,
      );
  }
} else {
  throw new Error(usage);
}
