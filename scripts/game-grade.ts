#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off -- Maintainer CLI owns a browser, a static server, files and logging.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  ProviderInstanceId,
  type GamePlaytestStep,
  type GameWebPlaytestResult,
  type ModelSelection,
} from "../packages/contracts/src/index.ts";
import {
  loadGameBenchmarkBrief,
  type LoadedGameBenchmarkBrief,
} from "./game-benchmark/artifacts.ts";
import { playtest } from "../apps/server/src/game/GameWebPlaytest.ts";
import { makeCodexTextGeneration } from "../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as TextGeneration from "../apps/server/src/textGeneration/TextGeneration.ts";
import * as ServerConfig from "../apps/server/src/config.ts";

/**
 * An independent grader for any folder holding a Godot project. It judges what
 * a player can see: the served build, the console, and screenshots. It never
 * reads the game's probe, DESIGN.md, or the studio's qualification records, so
 * it cannot inherit the harness's own vocabulary — including obligations that
 * vocabulary calls unsupported.
 */

const REVIEWER: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};
/** The model the default codex grader asks for. */
export const CODEX_GRADER_MODEL = REVIEWER.model;
/**
 * The grader's own semantics: rubric, frame selection and prompt. A benchmark
 * resume key includes it, so another grader version cannot silently reuse a
 * verdict earned under the old one. Bump when a grade stops being comparable.
 *
 * 4: a failed call or an unreadable reply is recorded as no answer (null), not
 * as NO. Version 3 turned a dead Codex CLI call into a NO, so a v3 control
 * could claim calibration while its votes were never obtained; v3 documents
 * cannot be reused as v4 verdicts.
 */
export const GRADER_VERSION = 4;

const MAX_PLAYTESTER_STEPS = 15;
const MAX_ACTIONS_PER_STEP = 3;
/** Ten frames: boot, the frame before each reload, the last, then an even fill. */
const MAX_VERDICT_FRAMES = 10;
const VOTES_PER_ITEM = 2;
/** Independent YES/NO questions in flight at once; more only competes for quota. */
const VOTE_CONCURRENCY = 6;
const QUICK_BOOT_TIMEOUT_MS = 20_000;
/**
 * The longest a single key press or wait may last. A game that asks for a long
 * hold (the dialogue game needs three seconds of held L) never sees the action
 * when the cap is under the game's own threshold: the game accumulates frame
 * time while the key is down, so the wall-clock hold has to be comfortably
 * longer than the seconds the game counts.
 */
const MAX_HOLD_MS = 8_000;

/** The absurd item every brief gets: a yes here means the grader imagines things. */
export const CONTROL_DESCRIPTION =
  "A talking teapot sits in the corner of the screen and narrates every move out loud.";

/**
 * A fixed input burst: arrows, WASD, space and a centre click. It proves the
 * game takes player input at all before the model is asked to play it.
 */
const QUICK_STEPS: ReadonlyArray<GamePlaytestStep> = [
  { click: "left" },
  { key: "ArrowRight", holdMs: 500 },
  { key: "ArrowUp", holdMs: 500 },
  { key: "d", holdMs: 500 },
  { key: "w", holdMs: 500 },
  { key: "Space", holdMs: 300 },
  { click: "left" },
  { waitMs: 300 },
];

// Structured output cannot carry optional keys, so every field is always
// present and an empty array means "none".
const ActionReply = Schema.Struct({
  note: Schema.String,
  /** Restart from the boot screen; the only way to recover a finished run. */
  reload: Schema.Boolean,
  keys: Schema.Array(Schema.Struct({ key: Schema.String, holdMs: Schema.Number })),
  clicks: Schema.Array(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  drags: Schema.Array(
    Schema.Struct({
      x1: Schema.Number,
      y1: Schema.Number,
      x2: Schema.Number,
      y2: Schema.Number,
    }),
  ),
  waitMs: Schema.Number,
});
type ActionReply = typeof ActionReply.Type;
const decodeActionReply = Schema.decodeUnknownSync(ActionReply);

const VerdictReply = Schema.Struct({
  verdict: Schema.String,
  frame: Schema.String,
  reason: Schema.String,
});
type VerdictReply = typeof VerdictReply.Type;
const decodeVerdictReply = Schema.decodeUnknownSync(VerdictReply);

/** The model's own JSON, as an object to read fields out of. */
const asRecord = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

/** A number the model wrote, whether it wrote it as a number or as text. */
const asNumber = (raw: unknown, fallback: number): number => {
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

/** The list of objects a model wrote, dropping anything that is not one. */
const asEntries = (raw: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(raw)
    ? raw.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];

/**
 * Reads the model's action list. A reply that leaves a list out means "no such
 * action", not a broken answer: the model spells out only the fields it uses,
 * and a strict read used to end the whole playtest on a missing "drags" — the
 * game was then graded as if nothing had been shown.
 */
export const decodeActions = (raw: unknown): ActionReply => {
  const value = asRecord(raw);
  return decodeActionReply({
    note: typeof value.note === "string" ? value.note : "",
    reload: value.reload === true,
    keys: asEntries(value.keys).map((key) => ({
      key: typeof key.key === "string" ? key.key : "",
      holdMs: asNumber(key.holdMs, 300),
    })),
    clicks: asEntries(value.clicks).map((click) => ({
      x: asNumber(click.x, 0),
      y: asNumber(click.y, 0),
    })),
    drags: asEntries(value.drags).map((drag) => ({
      x1: asNumber(drag.x1, 0),
      y1: asNumber(drag.y1, 0),
      x2: asNumber(drag.x2, 0),
      y2: asNumber(drag.y2, 0),
    })),
    waitMs: asNumber(value.waitMs, 0),
  });
};

/**
 * Reads the model's verdict. A NO answer often leaves the frame out, and a
 * missing frame must not turn into a failed vote.
 */
export const decodeVerdict = (raw: unknown): VerdictReply => {
  const value = asRecord(raw);
  return decodeVerdictReply({
    verdict: typeof value.verdict === "string" ? value.verdict : "",
    frame: typeof value.frame === "string" ? value.frame : "",
    reason: typeof value.reason === "string" ? value.reason : "",
  });
};

/** Reads the model's YES/NO answer; anything else is no answer, not a NO. */
const answerOf = (verdict: string): boolean | null => {
  const normalized = verdict.trim().toUpperCase();
  return normalized === "YES" ? true : normalized === "NO" ? false : null;
};

export interface GradeFrame {
  /** `F1`…, the name the grader cites. */
  readonly id: string;
  /** Absolute path on disk. */
  readonly path: string;
  readonly label: string;
}

export interface GradeVote {
  /**
   * YES/NO when the model answered. Null when the call failed or the reply was
   * not a YES/NO: an unobserved answer is not a NO.
   */
  readonly yes: boolean | null;
  readonly frame: string | null;
  readonly reason: string;
}

export interface GradeObligation {
  readonly id: string;
  readonly description: string;
  /**
   * YES only when every vote answered YES; NO when an answered vote said NO;
   * null when the claim is unproven because a vote went unanswered.
   */
  readonly yes: boolean | null;
  readonly votes: ReadonlyArray<GradeVote>;
}

export interface GradeQuick {
  readonly booted: boolean;
  readonly bootMs: number | null;
  readonly consoleErrors: number;
  readonly consoleErrorLines: ReadonlyArray<string>;
  readonly responded: boolean;
  readonly changedPercent: number;
}

/**
 * What a grade actually served. `workspace` is the game folder's own
 * builds/web (the historical behavior); `artifact` is a saved candidate the
 * caller named, served read-only exactly as exported.
 */
export interface GradeTarget {
  readonly kind: "workspace" | "artifact";
  /** Absolute directory that was served. */
  readonly directory: string;
  /** The selected build id the caller declared for an artifact, when known. */
  readonly buildId: string | null;
}

export interface GradeBuild {
  /**
   * `existing`: the game already had builds/web; `artifact`: a saved candidate
   * was served; `exported`: this grader built it.
   */
  readonly kind: "existing" | "exported" | "artifact" | "no-build";
  readonly detail: string | null;
}

export interface GradeDocument {
  readonly schemaVersion: 1;
  readonly brief: { readonly id: string; readonly title: string; readonly checksum: string };
  readonly gameDir: string;
  /**
   * The directory actually served. Absent only on a vote-only re-grade of a
   * document written before this field existed; never guessed.
   */
  readonly target?: GradeTarget;
  readonly model: string;
  /** Which model family graded this document, and which model answered. */
  readonly grader: { readonly provider: string; readonly model: string };
  /** The grader semantics that produced this document; see GRADER_VERSION. */
  readonly graderVersion: number;
  readonly build: GradeBuild;
  readonly quick: GradeQuick | null;
  readonly frames: ReadonlyArray<string>;
  readonly actions: ReadonlyArray<{
    readonly step: number;
    readonly actions: ReadonlyArray<string>;
    readonly note: string;
  }>;
  readonly obligations: ReadonlyArray<GradeObligation>;
  readonly control: {
    readonly description: string;
    /** Any YES answer: the grader imagined the absurd item. */
    readonly yes: boolean;
    /**
     * Every attempted control vote returned a YES/NO. False when a call failed
     * or its reply was unreadable, which is no answer at all. Null when the
     * control was never put to the model, as with a failed build or no frames:
     * an unattempted control is not a measured NO.
     */
    readonly answered: boolean | null;
    readonly votes: ReadonlyArray<GradeVote>;
  };
  /** The control item passed, so every verdict in this grade is untrustworthy. */
  readonly void: boolean;
  /**
   * A control vote was attempted but produced no usable answer, so the
   * negative control is unread. The grade is not void (nothing was
   * hallucinated), but it cannot claim calibration.
   */
  readonly inconclusive: boolean;
  /** Model calls this grade spent. */
  readonly solCalls: number;
}

export interface ReviewRequest {
  readonly kind: "actions" | "verdict";
  readonly prompt: string;
  readonly imagePaths: ReadonlyArray<string>;
}
/** The grader's only seam to a model; tests pass a scripted fake here. */
export type ReviewFn = (request: ReviewRequest) => Promise<unknown>;

export interface PlaytestRequest {
  readonly url: string;
  readonly executable: string;
  readonly profileDirectory: string;
  readonly steps: ReadonlyArray<GamePlaytestStep>;
  readonly bootTimeoutMs: number;
}

export interface GradeDeps {
  readonly review: ReviewFn;
  readonly playtest: (input: PlaytestRequest) => Promise<GameWebPlaytestResult>;
  readonly exportBuild: (gameDir: string) => Promise<{ ok: boolean; detail: string | null }>;
}

// ---------------------------------------------------------------- model calls

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/**
 * The product's own image-review path (structured output over attached PNGs),
 * wired straight to the codex CLI so grading does not need a running server.
 */
export const makeReviewer = (): ReviewFn => {
  const textGenerationLayer = Layer.effect(
    TextGeneration.TextGeneration,
    Effect.gen(function* () {
      const textGeneration = yield* makeCodexTextGeneration(
        decodeCodexSettings({}),
        undefined,
        Effect.succeed([]),
      );
      return TextGeneration.TextGeneration.of(textGeneration);
    }),
  ).pipe(
    Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "game-grade-" })),
    Layer.provide(NodeServices.layer),
  );
  return async (request) => {
    const outputSchema = request.kind === "actions" ? ActionReply : VerdictReply;
    return Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration.TextGeneration;
        return yield* textGeneration.generateImageReview({
          cwd: process.cwd(),
          prompt: request.prompt,
          imagePaths: [...request.imagePaths],
          outputSchema,
          modelSelection: REVIEWER,
        });
      }).pipe(Effect.provide(textGenerationLayer)),
    );
  };
};

/** Which model family grades: the product's Sol reviewer, or the opencode CLI. */
export type GraderId = "codex" | "opencode";

/** The model the opencode grader uses, and the free route it falls back to. */
export const OPENCODE_GRADER_MODEL = "opencode-go/minimax-m3.1-flash-free";
export const OPENCODE_GRADER_FALLBACK_MODEL = "openrouter/minimax/minimax-m3.1-flash:free";
/** What the free route says when the model is out of quota. */
const FREE_LIMIT = "Free usage limit reached";
const OPENCODE_TIMEOUT_MS = 300_000;

/**
 * The reply shape each kind of call must have. The CLI has no structured
 * output of its own, so the shape travels with the prompt.
 */
const REPLY_SHAPE: Record<ReviewRequest["kind"], string> = {
  verdict:
    '{"verdict":"YES or NO","frame":"the id of the frame that shows it, or an empty string","reason":"one short sentence"}',
  actions:
    '{"note":"one sentence","reload":false,"keys":[{"key":"w","holdMs":300}],"clicks":[{"x":480,"y":270}],"drags":[{"x1":10,"y1":10,"x2":200,"y2":200}],"waitMs":0}',
};

/** One CLI call: the model answers the prompt with the attached frames. */
export interface OpenCodeRun {
  readonly model: string;
  readonly prompt: string;
  readonly imagePaths: ReadonlyArray<string>;
}

/** What the CLI said: its output and how it ended. */
export interface OpenCodeResult {
  readonly output: string;
  readonly exitCode: number | null;
}

/** The grader's only seam to the CLI; tests pass a scripted fake here. */
export type OpenCodeRunner = (run: OpenCodeRun) => Promise<OpenCodeResult>;

/**
 * The CLI must not inherit the operator's session (it would resume this
 * conversation), their terminal or their display.
 */
const openCodeEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const name of [
    "AI_AGENT",
    "DISPLAY",
    "OPENCODE",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_SESSION_ID",
    "OPENCODE_TERMINAL",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
  ])
    delete environment[name];
  return environment;
};

export const runOpenCode: OpenCodeRunner = async (run) => {
  const args = ["run", "--format", "json", "--model", run.model];
  for (const path of run.imagePaths) args.push("--file", path);
  args.push(run.prompt);
  // A neutral folder: the grader must not read the checkout's own instructions.
  const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-grade-opencode-"));
  try {
    return await new Promise<OpenCodeResult>((resolve, reject) => {
      const child = NodeChildProcess.spawn("opencode", args, {
        cwd,
        env: openCodeEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        output += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), OPENCODE_TIMEOUT_MS);
      child.once("error", (cause) => {
        clearTimeout(timer);
        reject(new Error(`The opencode CLI failed to start: ${String(cause)}`));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ output, exitCode: code });
      });
    });
  } finally {
    await NodeFSP.rm(cwd, { recursive: true, force: true });
  }
};

/** The model's own words, from the CLI's newline-delimited JSON events. */
export const openCodeText = (output: string): string => {
  const parts: string[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    let event: { type?: string; part?: { type?: string; text?: string } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "text" && typeof event.part?.text === "string") parts.push(event.part.text);
  }
  return parts.join("");
};

/** The first balanced JSON object in the model's text. */
export const parseJsonReply = (text: string): unknown => {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(text.slice(start, index + 1));
      }
    }
  }
  throw new Error("The grader model returned no JSON object.");
};

export interface OpenCodeReviewer {
  readonly review: ReviewFn;
  /** The model that answered, after any free-limit fallback. */
  readonly usedModel: () => string;
}

/**
 * Grades through the opencode CLI: the frames go in as attached files, the
 * model answers with the JSON the caller asked for. When the free route runs
 * out of quota the call moves to the fallback route — never to DeepSeek, which
 * builds these games.
 */
export const makeOpenCodeReviewer = (options: {
  readonly model?: string;
  readonly fallbackModel?: string;
  readonly run?: OpenCodeRunner;
}): OpenCodeReviewer => {
  const model = options.model ?? OPENCODE_GRADER_MODEL;
  const fallbackModel = options.fallbackModel ?? OPENCODE_GRADER_FALLBACK_MODEL;
  const run = options.run ?? runOpenCode;
  let used = model;
  const review: ReviewFn = async (request) => {
    const prompt = `${request.prompt}\n\nAnswer with one JSON object and nothing else:\n${REPLY_SHAPE[request.kind]}`;
    const answer = (route: string) => run({ model: route, prompt, imagePaths: request.imagePaths });
    let result = await answer(model);
    if (result.output.includes(FREE_LIMIT) && fallbackModel !== model) {
      used = fallbackModel;
      result = await answer(fallbackModel);
    }
    const text = openCodeText(result.output);
    if (text.trim() === "")
      throw new Error(
        `The opencode grader said nothing (exit ${result.exitCode ?? "none"}): ${result.output.slice(0, 400)}`,
      );
    return parseJsonReply(text);
  };
  return { review, usedModel: () => used };
};

// --------------------------------------------------------------------- frames

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Writes one screenshot next to the grade and names it in order. */
const writeFrame = async (
  directory: string,
  name: string,
  data: string | undefined,
): Promise<string> => {
  const path = NodePath.join(directory, `${name}.png`);
  await NodeFSP.writeFile(path, data === undefined ? tinyPng : Buffer.from(data, "base64"));
  return path;
};

/**
 * At most ten frames for the verdict: the boot frame, the frame before every
 * reload, the last frame, then an even spread over what is left. The reload
 * rule exists because the frame before a restart is the only picture of what
 * the run achieved — a win screen is the claim most grades ask about, and the
 * reload that follows erases it. More frames only dilute attention.
 */
export function chooseFrames(
  boot: GradeFrame | null,
  steps: ReadonlyArray<{
    readonly path: string;
    readonly note: string;
    readonly actions: ReadonlyArray<string>;
    /** The step number, when the frames come from a saved run. */
    readonly step?: number;
  }>,
): ReadonlyArray<GradeFrame> {
  const budget = MAX_VERDICT_FRAMES - (boot === null ? 0 : 1);
  const required = new Set<number>();
  for (const [index, step] of steps.entries())
    if (index > 0 && step.actions.some((action) => action.startsWith("reload")))
      required.add(index - 1);
  if (steps.length > 0) required.add(steps.length - 1);
  const chosen = new Set(
    spreadIndices(
      [...required].sort((left, right) => left - right),
      budget,
    ),
  );
  const remaining = steps.map((_, index) => index).filter((index) => !chosen.has(index));
  for (const index of spreadIndices(remaining, budget - chosen.size)) chosen.add(index);
  const frames: Array<{ path: string; label: string }> = [];
  if (boot !== null) frames.push({ path: boot.path, label: "boot, no input" });
  for (const index of [...chosen].sort((left, right) => left - right)) {
    const step = steps[index]!;
    frames.push({
      path: step.path,
      label: `after step ${step.step ?? index + 1}: ${step.actions.join(", ")}${
        step.note === "" ? "" : ` — ${step.note}`
      }`,
    });
  }
  return frames.map((frame, index) => ({ id: `F${index + 1}`, ...frame }));
}

/** `count` indices spread evenly over `indices`, or all of them when they fit. */
const spreadIndices = (indices: ReadonlyArray<number>, count: number): ReadonlyArray<number> => {
  if (count <= 0) return [];
  if (indices.length <= count) return indices;
  return [
    ...new Set(
      Array.from(
        { length: count },
        (_, slot) => indices[Math.round((slot * (indices.length - 1)) / Math.max(1, count - 1))]!,
      ),
    ),
  ];
};

// -------------------------------------------------------------------- verdicts

const obligationPrompt = (input: {
  readonly brief: LoadedGameBenchmarkBrief;
  readonly description: string;
  readonly frames: ReadonlyArray<GradeFrame>;
  readonly notes: ReadonlyArray<string>;
}): string =>
  `You are an independent grader for a finished game. You did not build it, and you must not trust the playtester's notes or the order of the frames beyond what the pixels show.

## The game was asked to be
${input.brief.brief}

## Art direction
${input.brief.artDirection}

## The single claim to judge
${input.description}

## The frames
${input.frames.map((frame) => `${frame.id}: ${frame.label}.`).join("\n")}

Playtester notes, in order: ${input.notes.length === 0 ? "none." : input.notes.join(" | ")}

## Rules
- The frames are attached in the listed order. Answer YES only if the attached frames plainly show the claim happening.
- A win, a loss, a count, a score, a pickup or a state change must be visible in the frames: a HUD counter, a result panel, or the world itself. "Not shown" is NO.
- Do not assume a promise was kept because the game was asked for it, because its theme implies it, or because a note says so.
- frame must name the one attached frame that shows the claim, or be "" when the answer is NO. reason is one short sentence.
- Answer with the requested JSON only.`;

export async function judgeObligations(input: {
  readonly brief: LoadedGameBenchmarkBrief;
  readonly frames: ReadonlyArray<GradeFrame>;
  readonly notes: ReadonlyArray<string>;
  readonly review: ReviewFn;
}): Promise<{
  readonly obligations: ReadonlyArray<GradeObligation>;
  readonly control: GradeDocument["control"];
  readonly void: boolean;
  readonly inconclusive: boolean;
  readonly solCalls: number;
}> {
  const items = [
    ...input.brief.obligations.map((obligation) => ({
      id: obligation.id,
      description: obligation.description,
    })),
    { id: "control", description: CONTROL_DESCRIPTION },
  ];
  let calls = 0;
  const vote = async (description: string): Promise<GradeVote> => {
    // Nothing to look at is NO, and it costs no model call.
    if (input.frames.length === 0)
      return { yes: false, frame: null, reason: "No frames were captured." };
    try {
      calls += 1;
      const raw = await input.review({
        kind: "verdict",
        prompt: obligationPrompt({
          brief: input.brief,
          description,
          frames: input.frames,
          notes: input.notes,
        }),
        imagePaths: input.frames.map((frame) => frame.path),
      });
      const reply = decodeVerdict(raw);
      const yes = answerOf(reply.verdict);
      const cited = input.frames.find((frame) => frame.id === reply.frame.trim().toUpperCase());
      return {
        yes,
        frame: yes === true ? (cited?.id ?? null) : null,
        reason: reply.reason.slice(0, 400),
      };
    } catch (cause) {
      return {
        yes: null,
        frame: null,
        reason:
          `The grader call failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(
            0,
            400,
          ),
      };
    }
  };
  // Every question is independent and each vote is one model call, so they run
  // together: a full grade was ~30 serial calls, and the answers do not depend
  // on each other. The cap keeps one grade from flooding the provider.
  const questions = items.flatMap((item, itemIndex) =>
    Array.from({ length: VOTES_PER_ITEM }, (_, voteIndex) => ({
      itemIndex,
      voteIndex,
      description: item.description,
    })),
  );
  const answers = await mapLimit(questions, VOTE_CONCURRENCY, (question) =>
    vote(question.description),
  );
  const votesFor = (itemIndex: number): GradeVote[] =>
    answers.filter((_, index) => questions[index]!.itemIndex === itemIndex);
  const verdicts: GradeObligation[] = items
    .filter((item) => item.id !== "control")
    .map((item, index) => {
      const votes = votesFor(index);
      // Conjunction: one answered NO is a NO. A YES needs both answers; an
      // unanswered vote leaves the claim unproven instead of inventing a NO.
      const yes = votes.some((entry) => entry.yes === false)
        ? false
        : votes.every((entry) => entry.yes === true)
          ? true
          : null;
      return { ...item, yes, votes };
    });
  const controlVotes = votesFor(items.length - 1);
  // The control is absurd by construction, so any YES is a hallucination and
  // voids the whole grade (stricter than the obligations' conjunction). A
  // failed call is not a NO: it leaves the control unread, not passed.
  const controlYes = controlVotes.some((entry) => entry.yes === true);
  // No frames means no control question was asked; the vote entries are
  // synthesized "No frames were captured." NOs, not model answers.
  const controlAnswered =
    input.frames.length === 0 ? null : controlVotes.every((entry) => entry.yes !== null);
  return {
    obligations: verdicts,
    control: {
      description: CONTROL_DESCRIPTION,
      yes: controlYes,
      answered: controlAnswered,
      votes: controlVotes,
    },
    void: controlYes,
    inconclusive: !controlYes && controlAnswered === false,
    solCalls: calls,
  };
}

/** Runs `run` over `items` with at most `limit` in flight; results keep the input order. */
const mapLimit = async <A, B>(
  items: ReadonlyArray<A>,
  limit: number,
  run: (item: A) => Promise<B>,
): Promise<ReadonlyArray<B>> => {
  const results: Array<B> = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

// -------------------------------------------------------------- playtester (model)

const playtesterPrompt = (input: {
  readonly brief: LoadedGameBenchmarkBrief;
  readonly history: ReadonlyArray<{ actions: ReadonlyArray<string>; note: string }>;
}): string =>
  `You are playing an unfinished Godot game to find out what it can actually show. You get one attached frame: the game as it looks right after the actions listed below. You cannot read the code or any game state, only the picture.

## The game was asked to be
${input.brief.brief}

## Art direction
${input.brief.artDirection}

## What the finished game is supposed to show
${input.brief.obligations.map((obligation) => `- ${obligation.description}`).join("\n")}

## What you can do
Reply with 1–3 actions and a one-sentence note.
- keys: hold a key for holdMs milliseconds, up to ${MAX_HOLD_MS} ms (8 seconds). Use the game's controls ("w", "ArrowUp", "Space", "Shift", "e", …). Some games only register a long hold — three seconds or more — so when the screen asks you to hold, hold it for the full time instead of tapping it.
- clicks: a left click at pixel (x,y) of the attached frame. The frame is the 960×540 game viewport, so (480,270) is its centre. Click the actual button or card you can see.
- drags: press at (x1,y1), move to (x2,y2) and release, in the same 960×540 pixels. Use it to drag cards or sliders and to turn a mouse-look camera.
- waitMs: wait that long after the actions.
- reload: restart the game from its first screen. This is the only way to reload the page; a game over ("WRECKED", "GAME OVER", a result panel) cannot be escaped any other way. Use it when the run is finished, then play again.
Choose actions that make a promise visible: move toward the goal, shoot, pick things up, open things, finish or lose. Do not repeat an action the last frame already showed changing nothing. If the frame is a menu, press a key or click it first. If the game is over, reload instead of trying keys.

## Action history
${input.history.length === 0 ? "Nothing yet; this is the boot frame." : input.history.map((entry, index) => `${index + 1}. ${entry.actions.join(", ")} — ${entry.note}`).join("\n")}

## Rules
- Judge fundamentals, not a playthrough. First try every visible control and on-screen option at least once; if an action shows no effect after two tries, move on to another.
- One frame, one short note: say what the frame shows and what you will try next.
- Answer with the requested JSON only.`;

/**
 * Godot's HTML shell keeps #status visible while loading and hides it once the
 * canvas takes over; the playtester waits for the same thing the quick rows do.
 */
const BOOT_CHECK = `(() => {
  const canvas = document.querySelector("canvas");
  const status = document.getElementById("status");
  const hidden =
    !status ||
    status.hidden ||
    status.style.display === "none" ||
    getComputedStyle(status).display === "none" ||
    getComputedStyle(status).visibility === "hidden";
  return Boolean(canvas && canvas.width > 0 && canvas.height > 0 && hidden);
})()`;

interface PlayKeyEvent {
  readonly type: "keyDown" | "keyUp";
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly text?: string;
}

/** The DevTools key names the playtest driver already uses. */
const keyEvent = (key: string, type: "keyDown" | "keyUp"): PlayKeyEvent => {
  const named: Record<string, PlayKeyEvent> = {
    ArrowUp: { type, key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowDown: { type, key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowLeft: { type, key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowRight: { type, key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    Space: { type, key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
    Enter: { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Backspace: { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Escape: { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Shift: { type, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
    Control: { type, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
    Alt: { type, key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
  };
  const held = named[key] ?? (key === " " ? named.Space : undefined);
  if (held) return held;
  if (key.length === 1 && /[a-z]/.test(key))
    return {
      type,
      key,
      code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      text: key,
    };
  if (key.length === 1 && /[A-Z]/.test(key))
    return { type, key, code: `Key${key}`, windowsVirtualKeyCode: key.charCodeAt(0), text: key };
  if (key.length === 1 && /[0-9]/.test(key))
    return { type, key, code: `Digit${key}`, windowsVirtualKeyCode: 48 + Number(key), text: key };
  return { type, key, code: key, windowsVirtualKeyCode: 0 };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * How long one key press really lasts. The cap has to clear the longest hold
 * any game asks for, because the game counts the frames it saw the key down.
 */
export const clampHoldMs = (ms: number): number =>
  Math.max(50, Math.min(MAX_HOLD_MS, Math.round(ms)));

interface BrowserHandle {
  readonly child: NodeChildProcess.ChildProcess;
  readonly wsUrl: Promise<string>;
}

interface CdpSocket {
  send: <T>(method: string, params?: object, sessionId?: string) => Promise<T>;
  onSession: (
    sessionId: string,
    handle: (message: { method: string; params: any }) => void,
  ) => void;
  close: () => void;
}

const launchBrowser = (executable: string, profileDirectory: string): BrowserHandle => {
  const flags = [
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--hide-scrollbars",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    `--user-data-dir=${profileDirectory}`,
    "--window-size=960,540",
    "about:blank",
  ];
  if (process.env.T3CODE_SERVER_BROWSER_SANDBOX === "0") flags.unshift("--no-sandbox");
  const child = NodeChildProcess.spawn(executable, flags, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  const wsUrl = new Promise<string>((resolve, reject) => {
    let pending = true;
    const settle = (ok: boolean, detail: string) => {
      if (!pending) return;
      pending = false;
      if (ok) resolve(detail);
      else reject(new Error(detail));
    };
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) settle(true, match[1]!);
    });
    child.once("exit", () =>
      settle(false, `Browser exited before opening DevTools: ${stderr.slice(-2_000)}`),
    );
    child.once("error", (cause) => settle(false, `Browser failed to launch: ${String(cause)}`));
  });
  return { child, wsUrl };
};

const closeBrowser = (handle: BrowserHandle) =>
  new Promise<void>((resolve) => {
    const { child } = handle;
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearEscalation();
      resolve();
    });
    const clearEscalation = () => clearTimeout(escalation);
    child.kill("SIGTERM");
  });

const connectCdp = (wsUrl: string): Promise<CdpSocket> => {
  const socket = new WebSocket(wsUrl);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: unknown) => void; method: string }
  >();
  const sessions = new Map<string, (message: { method: string; params: any }) => void>();
  const failAll = (cause: unknown) => {
    for (const entry of pending.values()) entry.reject(cause);
    pending.clear();
  };
  socket.addEventListener("close", () => failAll(new Error("DevTools socket closed")), {
    once: true,
  });
  socket.addEventListener("error", () => failAll(new Error("DevTools socket failed")), {
    once: true,
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: any;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error)
        entry.reject(new Error(`${entry.method}: ${message.error.message ?? "error"}`));
      else entry.resolve(message.result);
      return;
    }
    if (typeof message.method === "string" && typeof message.sessionId === "string")
      sessions.get(message.sessionId)?.({ method: message.method, params: message.params ?? {} });
  });
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => {
      reject(new Error("DevTools socket timed out"));
      socket.close();
    }, 30_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(guard);
        let nextId = 0;
        resolve({
          send: <T>(method: string, params?: object, sessionId?: string): Promise<T> =>
            new Promise((resolveSend, rejectSend) => {
              const id = ++nextId;
              const timer = setTimeout(() => {
                pending.delete(id);
                rejectSend(new Error(`${method} timed out`));
              }, 30_000);
              pending.set(id, {
                resolve: (value: unknown) => {
                  clearTimeout(timer);
                  resolveSend(value as T);
                },
                reject: (cause) => {
                  clearTimeout(timer);
                  rejectSend(cause);
                },
                method,
              });
              socket.send(
                JSON.stringify({
                  id,
                  method,
                  ...(sessionId ? { sessionId } : {}),
                  ...(params ? { params } : {}),
                }),
              );
            }),
          onSession: (sessionId, handle) => {
            sessions.set(sessionId, handle);
          },
          close: () => socket.close(),
        });
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(guard);
        reject(new Error("DevTools socket failed to open"));
      },
      { once: true },
    );
  });
};

/** One live page the model plays: real point clicks, real drags, real reloads. */
export interface PlaySession {
  screenshot: () => Promise<string>;
  key: (key: string, holdMs: number) => Promise<void>;
  click: (x: number, y: number) => Promise<void>;
  drag: (x1: number, y1: number, x2: number, y2: number) => Promise<void>;
  wait: (ms: number) => Promise<void>;
  reload: () => Promise<boolean>;
  close: () => Promise<void>;
}

const waitForBoot = async (cdp: CdpSocket, sessionId: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const check = await cdp
      .send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: BOOT_CHECK, returnByValue: true },
        sessionId,
      )
      .catch(() => null);
    if (check?.result?.value === true) return true;
    await sleep(500);
  }
  return false;
};

export const openSession = async (input: {
  readonly url: string;
  readonly executable: string;
  readonly profileDirectory: string;
  readonly bootTimeoutMs: number;
}): Promise<PlaySession | null> => {
  await NodeFSP.mkdir(input.profileDirectory, { recursive: true });
  const handle = launchBrowser(input.executable, input.profileDirectory);
  const wsUrl = await Promise.race([
    handle.wsUrl,
    sleep(30_000).then(() => {
      throw new Error("Browser did not report a DevTools endpoint");
    }),
  ]);
  const cdp = await connectCdp(wsUrl);
  const target = await cdp.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;
  await cdp.send("Page.enable", undefined, sessionId);
  await cdp.send("Runtime.enable", undefined, sessionId);
  await cdp.send("Page.navigate", { url: input.url }, sessionId);
  const booted = await waitForBoot(cdp, sessionId, input.bootTimeoutMs);
  if (!booted) {
    cdp.close();
    await closeBrowser(handle);
    await NodeFSP.rm(input.profileDirectory, { recursive: true, force: true });
    return null;
  }
  const mouse = (type: string, x: number, y: number, extra: object = {}) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, ...extra }, sessionId);
  return {
    screenshot: async () => {
      const shot = await cdp.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png" },
        sessionId,
      );
      return shot.data;
    },
    key: async (key, holdMs) => {
      await cdp.send(
        "Runtime.evaluate",
        { expression: `document.querySelector("canvas")?.focus()` },
        sessionId,
      );
      await cdp.send("Input.dispatchKeyEvent", keyEvent(key, "keyDown"), sessionId);
      await sleep(holdMs);
      await cdp.send("Input.dispatchKeyEvent", keyEvent(key, "keyUp"), sessionId);
    },
    click: async (x, y) => {
      await mouse("mouseMoved", x, y, { button: "none" });
      await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
      await sleep(60);
      await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
    },
    drag: async (x1, y1, x2, y2) => {
      await mouse("mouseMoved", x1, y1, { button: "none" });
      await mouse("mousePressed", x1, y1, { button: "left", clickCount: 1 });
      for (let point = 1; point <= 6; point += 1) {
        await sleep(16);
        await mouse("mouseMoved", x1 + ((x2 - x1) * point) / 6, y1 + ((y2 - y1) * point) / 6, {
          button: "left",
        });
      }
      await mouse("mouseReleased", x2, y2, { button: "left", clickCount: 1 });
    },
    wait: (ms) => sleep(ms),
    reload: async () => {
      await cdp.send("Page.reload", {}, sessionId);
      return waitForBoot(cdp, sessionId, input.bootTimeoutMs);
    },
    close: async () => {
      cdp.close();
      await closeBrowser(handle);
      await NodeFSP.rm(input.profileDirectory, { recursive: true, force: true });
    },
  };
};

/** Applies the model's next actions to the live page, in order. */
const applyActions = async (
  session: PlaySession,
  reply: ActionReply,
): Promise<ReadonlyArray<string>> => {
  if (reply.reload) return [(await session.reload()) ? "reload" : "reload (did not boot)"];
  const planned: Array<{ label: string; run: () => Promise<void> }> = [];
  for (const key of reply.keys) {
    const holdMs = clampHoldMs(key.holdMs);
    planned.push({ label: `hold ${key.key} ${holdMs}ms`, run: () => session.key(key.key, holdMs) });
  }
  for (const click of reply.clicks) {
    const x = Math.max(0, Math.min(959, Math.round(click.x)));
    const y = Math.max(0, Math.min(539, Math.round(click.y)));
    planned.push({ label: `click (${x},${y})`, run: () => session.click(x, y) });
  }
  for (const drag of reply.drags) {
    const points = [drag.x1, drag.y1, drag.x2, drag.y2].map((value) =>
      Math.max(0, Math.min(959, Math.round(value))),
    );
    planned.push({
      label: `drag (${points[0]},${points[1]})→(${points[2]},${points[3]})`,
      run: () => session.drag(points[0]!, points[1]!, points[2]!, points[3]!),
    });
  }
  const waitMs = Math.max(0, Math.min(MAX_HOLD_MS, Math.round(reply.waitMs)));
  if (waitMs > 0) planned.push({ label: `wait ${waitMs}ms`, run: () => session.wait(waitMs) });
  const labels: string[] = [];
  for (const action of planned.slice(0, MAX_ACTIONS_PER_STEP)) {
    await action.run();
    labels.push(action.label);
  }
  return labels;
};

// ------------------------------------------------------------------------ build

const fileExists = (path: string) =>
  NodeFSP.access(path)
    .then(() => true)
    .catch(() => false);

/** The pinned Godot the studio's toolchain installs. */
export const defaultGodotBinary = (): string => {
  const dataHome = process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local/share");
  return NodePath.join(dataHome, "game-studio/tools/godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64");
};

const runCommand = async (
  executable: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> => {
  const exec = NodeUtil.promisify(NodeChildProcess.execFile);
  try {
    const { stdout, stderr } = await exec(executable, [...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, detail: `${stdout}${stderr}`.slice(-2_000) };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      detail: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`.slice(-2_000),
    };
  }
};

/**
 * Exports the project once, in place, exactly like the studio's export stage.
 * A project that never imported, has no scene or fails the export is a typed
 * no-build, not a zero score.
 */
export const exportWebBuild = async (
  gameDir: string,
  godot: string,
): Promise<{ ok: boolean; detail: string | null }> => {
  const project = NodePath.join(gameDir, "godot");
  const output = NodePath.join(gameDir, "builds/web/index.html");
  if (!(await fileExists(NodePath.join(project, "project.godot"))))
    return { ok: false, detail: "No godot/project.godot." };
  await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
  const imported = await runCommand(
    godot,
    ["--headless", "--path", project, "--editor", "--import"],
    180_000,
  );
  if (!imported.ok) return { ok: false, detail: `Godot import failed.\n${imported.detail}` };
  const exported = await runCommand(
    godot,
    ["--headless", "--path", project, "--export-release", "Web", output],
    300_000,
  );
  if (!exported.ok) return { ok: false, detail: `Godot export failed.\n${exported.detail}` };
  for (const file of [
    output,
    output.replace(/\.html$/, ".wasm"),
    output.replace(/\.html$/, ".pck"),
  ]) {
    const stat = await NodeFSP.stat(file).catch(() => null);
    if (stat === null || stat.size === 0)
      return { ok: false, detail: `The export did not write a nonempty ${file}.` };
  }
  return { ok: true, detail: null };
};

// ----------------------------------------------------------------------- server

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

/** Serves the build on loopback only; Godot's single-threaded web export needs no COOP/COEP. */
const serveBuild = async (root: string): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = NodeHttp.createServer(async (request, response) => {
    const pathname = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = NodePath.resolve(root, relative);
    if (file !== root && !file.startsWith(`${root}${NodePath.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file).catch(() => null);
    if (body === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": MIME[NodePath.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The static server did not report a port.");
  return {
    url: `http://127.0.0.1:${address.port}/index.html`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

// ----------------------------------------------------------------------- grader

const defaultBrowser = async (): Promise<string> => {
  const checkout = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));
  const root = NodePath.join(checkout, ".t3/tools/chrome-headless-shell");
  const platforms = await NodeFSP.readdir(root).catch(() => []);
  for (const platform of platforms) {
    const versions = await NodeFSP.readdir(NodePath.join(root, platform)).catch(() => []);
    for (const version of versions) {
      const candidate = NodePath.join(root, platform, version, "chrome-headless-shell");
      if (await fileExists(candidate)) return candidate;
    }
  }
  throw new Error(`No chrome-headless-shell under ${root}; pass --browser <path>.`);
};

/** The parts of a previous grade a vote-only re-grade needs. */
interface SavedGrade {
  readonly gameDir: string;
  /** The served directory when that grade recorded one; old documents did not. */
  readonly target: GradeTarget | null;
  readonly brief: { readonly id: string; readonly checksum: string };
  readonly build: GradeBuild;
  readonly quick: GradeQuick | null;
  readonly actions: GradeDocument["actions"];
}

const parseSavedTarget = (gradeDir: string, value: unknown): GradeTarget | null => {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null)
    throw new Error(`${gradeDir}/grade.json has an unreadable target.`);
  const record = value as Record<string, unknown>;
  if (
    (record.kind !== "workspace" && record.kind !== "artifact") ||
    typeof record.directory !== "string"
  )
    throw new Error(`${gradeDir}/grade.json has an unreadable target.`);
  return {
    kind: record.kind,
    directory: record.directory,
    buildId: typeof record.buildId === "string" ? record.buildId : null,
  };
};

const readSavedGrade = async (gradeDir: string): Promise<SavedGrade> => {
  const text = await NodeFSP.readFile(NodePath.join(gradeDir, "grade.json"), "utf8").catch(
    () => null,
  );
  if (text === null) throw new Error(`No grade.json under ${gradeDir}.`);
  const parsed = JSON.parse(text) as Partial<GradeDocument>;
  if (typeof parsed.gameDir !== "string" || parsed.build === undefined)
    throw new Error(`${gradeDir}/grade.json is not a grade document.`);
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const stored = Array.isArray(parsed.frames)
    ? parsed.frames.filter((frame): frame is string => typeof frame === "string")
    : [];
  if (stored.length === 0) throw new Error(`${gradeDir}/grade.json has no frames to vote over.`);
  return {
    gameDir: parsed.gameDir,
    target: parseSavedTarget(gradeDir, parsed.target),
    brief: { id: parsed.brief?.id ?? "", checksum: parsed.brief?.checksum ?? "" },
    build: parsed.build,
    quick: parsed.quick ?? null,
    actions,
  };
};

/** Every screenshot a previous grade saved, with the actions that produced it. */
interface SavedFrames {
  readonly boot: GradeFrame | null;
  readonly steps: ReadonlyArray<{
    readonly step: number;
    readonly path: string;
    readonly actions: ReadonlyArray<string>;
    readonly note: string;
  }>;
}

/**
 * The frames a previous grade saved, read from its frames directory rather
 * than from its grade document: the document lists only the frames that grade
 * voted over, while the directory holds every screenshot of the run. The
 * choice is made again over the whole directory, because a claim is usually
 * about a screen the old choice skipped — the win screen right before a reload
 * is the picture of what the run achieved, and the reload erases it.
 */
const readSavedFrames = async (gradeDir: string, saved: SavedGrade): Promise<SavedFrames> => {
  const directory = NodePath.join(gradeDir, "frames");
  const names = await NodeFSP.readdir(directory).catch(() => [] as ReadonlyArray<string>);
  const actionByStep = new Map(saved.actions.map((action) => [action.step, action]));
  const steps: Array<SavedFrames["steps"][number]> = [];
  let boot: GradeFrame | null = null;
  for (const name of names) {
    if (name === "boot.png") {
      boot = { id: "F1", path: NodePath.join(directory, name), label: "boot, no input" };
      continue;
    }
    const match = /^step-(\d+)\.png$/.exec(name);
    if (match === null) continue;
    const step = Number(match[1]);
    const action = actionByStep.get(step);
    steps.push({
      step,
      path: NodePath.join(directory, name),
      actions: action?.actions ?? [],
      note: action?.note ?? "",
    });
  }
  if (boot === null && steps.length === 0)
    throw new Error(`No frames under ${directory} to vote over.`);
  steps.sort((left, right) => left.step - right.step);
  return { boot, steps };
};

/**
 * Copies the saved frames into the new grade so it stays readable on its own.
 * Every screenshot comes along as evidence; the returned frames are the ones
 * the votes were about.
 */
const copySavedFrames = async (
  saved: SavedFrames,
  chosen: ReadonlyArray<GradeFrame>,
  framesDirectory: string,
): Promise<ReadonlyArray<GradeFrame>> => {
  const evidence = [
    ...(saved.boot === null ? [] : [saved.boot.path]),
    ...saved.steps.map((step) => step.path),
  ];
  for (const path of evidence)
    await NodeFSP.copyFile(path, NodePath.join(framesDirectory, NodePath.basename(path)));
  return chosen.map((frame) => ({
    id: frame.id,
    path: NodePath.join(framesDirectory, NodePath.basename(frame.path)),
    label: frame.label,
  }));
};

export interface GradeOptions {
  readonly gameDir?: string;
  readonly brief: LoadedGameBenchmarkBrief;
  readonly out: string;
  readonly browser?: string;
  readonly godot?: string;
  readonly maxSteps?: number;
  /**
   * A saved web export to serve instead of `<gameDir>/builds/web`. It is never
   * exported or modified, and a missing index.html is an error rather than a
   * fall back to the workspace.
   */
  readonly artifact?: {
    readonly directory: string;
    /** The selected build id this artifact is claimed to be; recorded for verification. */
    readonly buildId?: string;
  };
  /**
   * Vote over a previous grade's saved frames and notes instead of building and
   * playing. `gameDir` then comes from that grade.
   */
  readonly reuseFrames?: string;
  /** Which model family grades: `codex` (Sol) or `opencode` (the CLI). */
  readonly grader?: GraderId;
  /** The model the opencode grader uses. */
  readonly graderModel?: string;
  readonly deps?: Partial<GradeDeps>;
}

const workspaceTarget = (gameDir: string): GradeTarget => ({
  kind: "workspace",
  directory: NodePath.join(gameDir, "builds/web"),
  buildId: null,
});

/**
 * Validates a caller-named artifact before any model call. Only a nonempty
 * index.html is gradeable, and the directory is served read-only: a missing
 * artifact must never turn into an export of the live sources.
 */
const resolveArtifactTarget = async (
  artifact: NonNullable<GradeOptions["artifact"]>,
): Promise<GradeTarget> => {
  const directory = NodePath.resolve(artifact.directory);
  const index = NodePath.join(directory, "index.html");
  const stat = await NodeFSP.stat(index).catch(() => null);
  if (stat === null || !stat.isFile() || stat.size === 0)
    throw new Error(`No nonempty index.html in the artifact directory: ${directory}.`);
  return { kind: "artifact", directory, buildId: artifact.buildId ?? null };
};

const sameArtifactTarget = (saved: GradeTarget | null, requested: GradeTarget): boolean =>
  saved !== null &&
  saved.kind === requested.kind &&
  NodePath.resolve(saved.directory) === requested.directory &&
  (requested.buildId === null || saved.buildId === requested.buildId);

/**
 * Grades one game folder and writes `<out>/grade.json` plus `<out>/frames/`.
 * `deps` exists for the fixture tests: they fake the model, nothing else.
 */
export async function gradeGame(options: GradeOptions): Promise<GradeDocument> {
  const out = NodePath.resolve(options.out);
  const framesDirectory = NodePath.join(out, "frames");
  await NodeFSP.mkdir(framesDirectory, { recursive: true });
  const reuseDirectory =
    options.reuseFrames === undefined ? null : NodePath.resolve(options.reuseFrames);
  const saved = reuseDirectory === null ? null : await readSavedGrade(reuseDirectory);
  const gameDir =
    options.gameDir !== undefined ? NodePath.resolve(options.gameDir) : (saved?.gameDir ?? null);
  if (gameDir === null)
    throw new Error(
      "Pass a game directory, or --reuse-frames <gradeDir> to vote over saved frames.",
    );
  const requestedArtifact =
    options.artifact === undefined ? null : await resolveArtifactTarget(options.artifact);
  if (
    saved !== null &&
    requestedArtifact !== null &&
    !sameArtifactTarget(saved.target, requestedArtifact)
  )
    throw new Error(
      `--reuse-frames keeps the target recorded in ${reuseDirectory}/grade.json; it cannot be relabelled as ${requestedArtifact.directory}.`,
    );
  // A vote-only re-grade preserves the old document's target. An old document
  // without one stays without one: frames cannot prove a new target.
  const target = saved === null ? (requestedArtifact ?? workspaceTarget(gameDir)) : saved.target;
  const maxSteps = options.maxSteps ?? MAX_PLAYTESTER_STEPS;
  const exportBuild =
    options.deps?.exportBuild ??
    ((directory: string) => exportWebBuild(directory, options.godot ?? defaultGodotBinary()));
  const openCode =
    options.grader === "opencode"
      ? makeOpenCodeReviewer(
          options.graderModel === undefined ? {} : { model: options.graderModel },
        )
      : null;
  const review = options.deps?.review ?? openCode?.review ?? makeReviewer();
  // The grader that answered may differ from the one that was asked for: the
  // opencode route falls back when the free model runs out of quota.
  const grader = () =>
    openCode === null
      ? { provider: "codex", model: REVIEWER.model }
      : { provider: "opencode", model: openCode.usedModel() };
  const base = () => ({
    schemaVersion: 1 as const,
    brief: { id: options.brief.id, title: options.brief.title, checksum: options.brief.checksum },
    gameDir,
    ...(target === null ? {} : { target }),
    model: `${grader().provider}/${grader().model}`,
    grader: grader(),
    graderVersion: GRADER_VERSION,
  });

  const write = async (grade: GradeDocument): Promise<GradeDocument> => {
    await NodeFSP.writeFile(
      NodePath.join(out, "grade.json"),
      `${JSON.stringify(grade, null, 2)}\n`,
    );
    return grade;
  };

  // Vote-only: the build and the playtest already happened, so only the
  // verdict votes run — the cheap half of a grade, and the only way to re-read
  // old frames under a new frame choice.
  if (saved !== null) {
    if (saved.brief.checksum !== options.brief.checksum)
      console.warn(
        `The brief fixture changed since ${reuseDirectory}/grade.json; voting the saved frames against the current claims.`,
      );
    const savedFrames = await readSavedFrames(reuseDirectory!, saved);
    // The choice is made again over every screenshot the old run saved, not
    // over the frames that run happened to vote on.
    const chosen = chooseFrames(savedFrames.boot, savedFrames.steps);
    const frames = await copySavedFrames(savedFrames, chosen, framesDirectory);
    const judged = await judgeObligations({
      brief: options.brief,
      frames,
      notes: saved.actions.map((action) => action.note),
      review,
    });
    return write({
      ...base(),
      build: saved.build,
      quick: saved.quick,
      frames: frames.map((frame) => NodePath.relative(out, frame.path)),
      actions: saved.actions,
      obligations: judged.obligations,
      control: judged.control,
      void: judged.void,
      inconclusive: judged.inconclusive,
      solCalls: judged.solCalls,
    });
  }

  const noBuild = (detail: string | null) =>
    write({
      ...base(),
      build: { kind: "no-build", detail },
      quick: null,
      frames: [],
      actions: [],
      obligations: options.brief.obligations.map((obligation) => ({
        id: obligation.id,
        description: obligation.description,
        yes: false,
        votes: [],
      })),
      // Nothing was graded, so the control was never attempted. `answered:
      // true` here would read as a measured negative calibration.
      control: { description: CONTROL_DESCRIPTION, yes: false, answered: null, votes: [] },
      void: false,
      inconclusive: false,
      solCalls: 0,
    });

  // 1. Build: a named saved artifact is served as it is; otherwise an existing
  // build is what the game already ships, and only then is one export attempted.
  const index = NodePath.join(gameDir, "builds/web/index.html");
  let build: GradeBuild;
  if (target?.kind === "artifact") build = { kind: "artifact", detail: null };
  else if (await fileExists(index)) build = { kind: "existing", detail: null };
  else {
    const exported = await exportBuild(gameDir);
    build = exported.ok
      ? { kind: "exported", detail: null }
      : { kind: "no-build", detail: exported.detail };
  }
  if (build.kind === "no-build") return noBuild(build.detail);
  if (target?.kind !== "artifact" && !(await fileExists(index)))
    return noBuild("The export wrote no index.html.");

  const executable = options.browser ?? (await defaultBrowser());
  const served = await serveBuild(
    target?.kind === "artifact" ? target.directory : NodePath.join(gameDir, "builds/web"),
  );
  try {
    const runPlaytest: GradeDeps["playtest"] =
      options.deps?.playtest ??
      ((request) =>
        Effect.runPromise(
          playtest({
            executable: request.executable,
            url: request.url,
            profileDirectory: request.profileDirectory,
            width: 960,
            height: 540,
            bootTimeoutMs: request.bootTimeoutMs,
            steps: [...request.steps],
            probeRequired: false,
            acceptance: null,
          }),
        ));

    // 2. Quick rows: boot, console, and input changing the picture.
    const quickProfile = NodePath.join(out, "profile-quick");
    const quickRun = await runPlaytest({
      url: served.url,
      executable,
      profileDirectory: quickProfile,
      steps: QUICK_STEPS,
      bootTimeoutMs: QUICK_BOOT_TIMEOUT_MS,
    });
    const consoleErrorLines = quickRun.consoleMessages
      .filter((message) => message.level === "error")
      .map((message) => message.text.slice(0, 300));
    const quick: GradeQuick = {
      booted: quickRun.booted,
      bootMs: quickRun.bootMs,
      consoleErrors: consoleErrorLines.length,
      consoleErrorLines,
      responded: quickRun.responded,
      changedPercent: quickRun.changedPercent,
    };
    const bootShot = quickRun.screenshots.find((shot) => shot.label === "booted");
    const bootPath = await writeFrame(framesDirectory, "boot", bootShot?.data);
    const bootFrame: GradeFrame = { id: "F1", path: bootPath, label: "boot, no input" };

    // 3. Playtester: at most 15 model steps on one live page, so the game
    // keeps its state between them and a card hand stays reachable.
    const actions: Array<{
      step: number;
      actions: ReadonlyArray<string>;
      note: string;
      path: string;
    }> = [];
    let calls = 0;
    if (quickRun.booted) {
      const session = await openSession({
        url: served.url,
        executable,
        profileDirectory: NodePath.join(out, "profile-play"),
        bootTimeoutMs: QUICK_BOOT_TIMEOUT_MS,
      });
      if (session !== null) {
        try {
          let current = bootFrame.path;
          for (let step = 1; step <= maxSteps; step += 1) {
            let reply: ActionReply;
            try {
              calls += 1;
              reply = decodeActions(
                await review({
                  kind: "actions",
                  prompt: playtesterPrompt({
                    brief: options.brief,
                    history: actions.map((entry) => ({ actions: entry.actions, note: entry.note })),
                  }),
                  imagePaths: [current],
                }),
              );
            } catch {
              break;
            }
            const labels = await applyActions(session, reply);
            if (labels.length === 0) break;
            // Give the frame after the action a beat to render before keeping it.
            await session.wait(250);
            const path = await writeFrame(
              framesDirectory,
              `step-${String(step).padStart(2, "0")}`,
              await session.screenshot(),
            );
            actions.push({ step, actions: labels, note: reply.note.slice(0, 300), path });
            current = path;
          }
        } finally {
          await session.close();
        }
      }
    }

    // 4. Verdicts over at most eight frames plus the playtester's notes.
    const frames = chooseFrames(bootFrame, actions);
    const judged = await judgeObligations({
      brief: options.brief,
      frames,
      notes: actions.map((entry) => entry.note),
      review,
    });
    const grade: GradeDocument = {
      ...base(),
      build,
      quick,
      frames: frames.map((frame) => NodePath.relative(out, frame.path)),
      actions: actions.map((entry) => ({
        step: entry.step,
        actions: entry.actions,
        note: entry.note,
      })),
      obligations: judged.obligations,
      control: judged.control,
      void: judged.void,
      inconclusive: judged.inconclusive,
      solCalls: calls + judged.solCalls,
    };
    return write(grade);
  } finally {
    await served.close();
  }
}

// -------------------------------------------------------------------------- cli

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const main = async () => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      [
        "Usage: node scripts/game-grade.ts <gameDir> --brief <fixture.json> --out <dir>",
        "       node scripts/game-grade.ts <gameDir> --brief <fixture.json> --out <dir> --artifact <saved-web-dir>",
        "       node scripts/game-grade.ts --brief <fixture.json> --reuse-frames <gradeDir> --out <dir>",
        "",
        "Grades any folder holding a Godot project from its served pixels and console only.",
        "--artifact serves a saved web export read-only instead of <gameDir>/builds/web,",
        "and records that directory and --artifact-build-id in grade.json. A missing",
        "artifact is an error; it never falls back to exporting the live sources.",
        "--reuse-frames skips the build and the playtest: it re-chooses the frames from",
        "every screenshot that grade saved and votes over them with that grade's notes,",
        "which is the cheap way to re-read an old run. It keeps the saved target and",
        "refuses a contradictory --artifact.",
        "--grader codex|opencode picks the model family: codex is Sol, opencode is the CLI",
        "model in --grader-model (default " + OPENCODE_GRADER_MODEL + ").",
        "Optional: --godot <godot-binary> --browser <chrome-headless-shell> --max-steps <n>",
      ].join("\n"),
    );
    return;
  }
  const first = process.argv[2];
  const gameDir = first === undefined || first.startsWith("--") ? undefined : first;
  const briefPath = flag("brief");
  const out = flag("out");
  const reuseFrames = flag("reuse-frames");
  const artifactDirectory = flag("artifact");
  const artifactBuildId = flag("artifact-build-id");
  if (artifactBuildId !== undefined && artifactDirectory === undefined)
    throw new Error("--artifact-build-id needs --artifact <saved-web-dir>.");
  if (
    briefPath === undefined ||
    out === undefined ||
    (gameDir === undefined && reuseFrames === undefined)
  )
    throw new Error(
      "Usage: node scripts/game-grade.ts <gameDir> --brief <fixture.json> --out <dir>\n       node scripts/game-grade.ts --brief <fixture.json> --reuse-frames <gradeDir> --out <dir>",
    );
  const brief = await loadGameBenchmarkBrief(NodePath.resolve(briefPath));
  const graderFlag = flag("grader") ?? "codex";
  if (graderFlag !== "codex" && graderFlag !== "opencode")
    throw new Error("--grader must be codex or opencode.");
  const grade = await gradeGame({
    ...(gameDir === undefined ? {} : { gameDir }),
    brief,
    out,
    ...(reuseFrames === undefined ? {} : { reuseFrames }),
    ...(artifactDirectory === undefined
      ? {}
      : {
          artifact: {
            directory: artifactDirectory,
            ...(artifactBuildId === undefined ? {} : { buildId: artifactBuildId }),
          },
        }),
    ...(flag("godot") === undefined ? {} : { godot: NodePath.resolve(flag("godot")!) }),
    ...(flag("browser") === undefined ? {} : { browser: NodePath.resolve(flag("browser")!) }),
    ...(flag("max-steps") === undefined ? {} : { maxSteps: Number(flag("max-steps")) }),
    grader: graderFlag,
    ...(flag("grader-model") === undefined ? {} : { graderModel: flag("grader-model")! }),
  });
  const yes = grade.obligations.filter((obligation) => obligation.yes).length;
  console.log(
    `${brief.id}: grader=${grade.grader.provider}/${grade.grader.model} build=${grade.build.kind} quick=${
      grade.quick === null
        ? "—"
        : `${grade.quick.booted ? "booted" : "no-boot"}/${grade.quick.consoleErrors} errors/${
            grade.quick.responded ? "responded" : "no-response"
          }`
    } obligations=${yes}/${grade.obligations.length} void=${grade.void} inconclusive=${
      grade.inconclusive
    } calls=${grade.solCalls}`,
  );
  console.log(`grade: ${NodePath.join(NodePath.resolve(out), "grade.json")}`);
};

const invoked = process.argv[1] === undefined ? "" : NodePath.resolve(process.argv[1]);
if (invoked === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) {
  await main();
}
