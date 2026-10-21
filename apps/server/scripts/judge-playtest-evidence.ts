// @effect-diagnostics nodeBuiltinImport:off -- This maintainer script copies real playtest evidence into a scratch game root.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  StoredGameAcceptanceCriterion,
  normalizeAcceptance,
} from "@t3tools/contracts";
import { makeCodexTextGeneration } from "../src/textGeneration/CodexTextGeneration.ts";
import * as TextGeneration from "../src/textGeneration/TextGeneration.ts";
import * as ServerConfig from "../src/config.ts";
import * as GameVisualJudge from "../src/game/GameVisualJudge.ts";
import { designDocumentHash } from "../src/game/GameDesignApproval.ts";
import { formatVisualReport } from "../src/game/visualReport.ts";

/**
 * Runs the real visual judge over one persisted playtest evidence folder.
 * Maintainer tooling for task 34's proof: it copies the evidence into a scratch
 * game root, prints the canary result, and saves the typed judgement plus the
 * exact PNGs that were sent.
 */
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeAcceptance = Schema.decodeSync(
  Schema.fromJsonString(Schema.Array(StoredGameAcceptanceCriterion)),
);

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const required = (name: string): string => {
  const value = flag(name);
  if (value === undefined) throw new Error(`Missing --${name}`);
  return value;
};

const copyDirectory = async (from: string, to: string) => {
  await NodeFSP.mkdir(to, { recursive: true });
  for (const entry of await NodeFSP.readdir(from))
    await NodeFSP.copyFile(NodePath.join(from, entry), NodePath.join(to, entry));
};

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
);

class VisualJudgeScriptError extends Schema.TaggedError<VisualJudgeScriptError>()(
  "VisualJudgeScriptError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const encodeJudgement = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const main = Effect.gen(function* () {
  const evidence = NodePath.resolve(required("evidence"));
  const designPath = NodePath.resolve(required("design"));
  const acceptancePath = NodePath.resolve(required("acceptance"));
  const out = NodePath.resolve(required("out"));
  const label = flag("label") ?? NodePath.basename(NodePath.dirname(evidence));

  const design = yield* Effect.promise(() => NodeFSP.readFile(designPath, "utf8"));
  const acceptance = normalizeAcceptance(
    decodeAcceptance(yield* Effect.promise(() => NodeFSP.readFile(acceptancePath, "utf8"))),
  );
  const root = NodePath.join(out, `${label}-root`);
  const evidenceName = "run-1";
  const evidenceDirectory = `builds/playtests/${evidenceName}`;
  yield* Effect.promise(async () => {
    await NodeFSP.rm(root, { recursive: true, force: true });
    await NodeFSP.mkdir(root, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), design);
    await copyDirectory(evidence, NodePath.join(root, evidenceDirectory));
  });

  const textGeneration = yield* TextGeneration.TextGeneration;
  const canary = yield* GameVisualJudge.runVisualCanary(textGeneration);
  yield* Effect.log(
    canary.ok ? "canary: passed (digit 7 on magenta)" : `canary: FAILED — ${canary.reason}`,
  );
  if (!canary.ok)
    return yield* new VisualJudgeScriptError({ detail: "The image canary did not pass" });

  const judge = yield* GameVisualJudge.GameVisualJudge;
  const run = yield* judge.run(root, {
    sourceId: flag("source-id") ?? label,
    buildId: flag("build-id") ?? `${label}:build`,
    designHash: designDocumentHash(design),
    evidenceDirectory,
    acceptance,
  });
  if (run.status !== "judged")
    return yield* new VisualJudgeScriptError({ detail: "No judgements left" });
  const judgement = run.judgement;
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(out, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(out, `${label}-judgement.json`),
      `${encodeJudgement(judgement)}\n`,
    );
    const framesDirectory = NodePath.join(out, `${label}-frames`);
    await NodeFSP.rm(framesDirectory, { recursive: true, force: true });
    await NodeFSP.mkdir(framesDirectory, { recursive: true });
    for (const frame of judgement.frames) {
      const source = NodePath.join(root, frame.path);
      const extension = NodePath.extname(source);
      await NodeFSP.copyFile(source, NodePath.join(framesDirectory, `${frame.id}${extension}`));
    }
  });
  yield* Effect.log(`\n${formatVisualReport(judgement)}\n`);
  yield* Effect.log(encodeJudgement(judgement));
}).pipe(
  Effect.provide(
    GameVisualJudge.layer({
      stateDir: NodePath.join(NodePath.resolve(flag("out") ?? "."), "state"),
    }).pipe(
      Layer.provideMerge(textGenerationLayer),
      Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "game-visual-" })),
      Layer.provide(NodeServices.layer),
    ),
  ),
);

await Effect.runPromise(main);
