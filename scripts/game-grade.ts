#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off -- Maintainer CLI owns a browser, a static server, files and logging.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  ProviderInstanceId,
  type ModelSelection,
} from "../packages/contracts/src/index.ts";
import {
  loadGameBenchmarkBrief,
  type LoadedGameBenchmarkBrief,
} from "./game-benchmark/artifacts.ts";
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

/** Ten frames: boot, the frame before each reload, the last, then an even fill. */
const MAX_VERDICT_FRAMES = 10;
const VOTES_PER_ITEM = 2;
/** Independent YES/NO questions in flight at once; more only competes for quota. */
const VOTE_CONCURRENCY = 6;
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

export interface GradeDeps {
  readonly review: ReviewFn;
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

/**
 * Blind look/feel comparison through the opencode CLI. It reuses the same CLI
 * seam as the obligations grader (`runOpenCode`, `openCodeText`,
 * `parseJsonReply`) and the same free-limit fallback, but asks for the
 * comparison ruler's JSON shape instead of a verdict/actions shape. The
 * prompt itself (blind A/B cards, both orders, identical-pair control) lives
 * in `scripts/game-benchmark/compare.ts`; this only swaps the model route.
 */
export const OPENCODE_COMPARE_REPLY_SHAPE =
  '{"works":"A or B or tie","look":"A or B or tie","feel":"A or B or tie","play":"A or B or tie","overall":"A or B or tie","reason":"one short sentence"}';

export interface OpenCodeCompareReviewer {
  readonly review: (request: {
    readonly prompt: string;
    readonly imagePaths: ReadonlyArray<string>;
  }) => Promise<unknown>;
  /** The model that answered, after any free-limit fallback. */
  readonly usedModel: () => string;
}

export const makeOpenCodeCompareReviewer = (options: {
  readonly model?: string;
  readonly fallbackModel?: string;
  readonly run?: OpenCodeRunner;
}): OpenCodeCompareReviewer => {
  const model = options.model ?? OPENCODE_GRADER_MODEL;
  const fallbackModel = options.fallbackModel ?? OPENCODE_GRADER_FALLBACK_MODEL;
  const run = options.run ?? runOpenCode;
  let used = model;
  const review = async (request: {
    readonly prompt: string;
    readonly imagePaths: ReadonlyArray<string>;
  }): Promise<unknown> => {
    const prompt = `${request.prompt}\n\nAnswer with one JSON object and nothing else:\n${OPENCODE_COMPARE_REPLY_SHAPE}`;
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
  /** Votes in flight; the default is the cap. Lower it when the provider 429s. */
  readonly concurrency?: number;
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
  const answers = await mapLimit(questions, input.concurrency ?? VOTE_CONCURRENCY, (question) =>
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

// ----------------------------------------------------------------------- grader

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
  /**
   * Vote over a previous grade's saved frames and notes. Live capture was
   * removed with the old playtest driver; a grade without `reuseFrames` can
   * only record a failed build.
   */
  readonly reuseFrames?: string;
  /** Which model family grades: `codex` (Sol) or `opencode` (the CLI). */
  readonly grader?: GraderId;
  /** The model the opencode grader uses. */
  readonly graderModel?: string;
  /** Votes in flight (default and cap 6). Lower it for a provider that 429s. */
  readonly voteConcurrency?: number;
  readonly deps?: Partial<GradeDeps>;
}

const workspaceTarget = (gameDir: string): GradeTarget => ({
  kind: "workspace",
  directory: NodePath.join(gameDir, "builds/web"),
  buildId: null,
});

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
  // A vote-only re-grade preserves the old document's target. An old document
  // without one stays without one: frames cannot prove a new target.
  const target = saved === null ? workspaceTarget(gameDir) : saved.target;
  const exportBuild = options.deps?.exportBuild;
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
      ...(options.voteConcurrency === undefined ? {} : { concurrency: options.voteConcurrency }),
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

  // Live capture was removed with the old playtest driver. A game directory
  // without saved frames can only prove a failed build, never a grade.
  if (exportBuild === undefined)
    throw new Error(
      "Live capture was removed: pass --reuse-frames <gradeDir> to vote over saved frames.",
    );
  const exported = await exportBuild(gameDir);
  return noBuild(
    exported.ok ? "The export succeeded but live capture was removed." : exported.detail,
  );
}

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const main = async () => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      [
        "Usage: node scripts/game-grade.ts --brief <fixture.json> --reuse-frames <gradeDir> --out <dir>",
        "",
        "Votes over a previous grade's saved frames and notes with a fresh model.",
        "Live capture was removed with the old playtest driver, so a game directory",
        "without saved frames can only record a failed build, never a grade.",
        "--grader codex|opencode picks the model family: codex is Sol, opencode is the CLI",
        "model in --grader-model (default " + OPENCODE_GRADER_MODEL + ").",
        "--vote-concurrency <n> lowers how many votes run at once (default and cap 6).",
      ].join("\n"),
    );
    return;
  }
  const briefPath = flag("brief");
  const out = flag("out");
  const reuseFrames = flag("reuse-frames");
  if (briefPath === undefined || out === undefined || reuseFrames === undefined)
    throw new Error(
      "Usage: node scripts/game-grade.ts --brief <fixture.json> --reuse-frames <gradeDir> --out <dir>",
    );
  const brief = await loadGameBenchmarkBrief(NodePath.resolve(briefPath));
  const voteConcurrencyFlag = flag("vote-concurrency");
  const voteConcurrency =
    voteConcurrencyFlag === undefined ? undefined : Number(voteConcurrencyFlag);
  if (voteConcurrency !== undefined && (!Number.isInteger(voteConcurrency) || voteConcurrency <= 0))
    throw new Error("--vote-concurrency must be a positive integer.");
  const graderFlag = flag("grader") ?? "codex";
  if (graderFlag !== "codex" && graderFlag !== "opencode")
    throw new Error("--grader must be codex or opencode.");
  const grade = await gradeGame({
    brief,
    out,
    reuseFrames,
    grader: graderFlag,
    ...(flag("grader-model") === undefined ? {} : { graderModel: flag("grader-model")! }),
    ...(voteConcurrency === undefined ? {} : { voteConcurrency }),
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
