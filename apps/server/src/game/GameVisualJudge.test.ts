// @effect-diagnostics nodeBuiltinImport:off -- The judge reads real evidence folders and writes its result beside them.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  GAME_VISUAL_DIMENSIONS,
  TextGenerationError,
  type GameAcceptanceCriterion,
  type GamePlaytestProbe,
  type GameVisualReview,
} from "@t3tools/contracts";
import * as GameVisualJudge from "./GameVisualJudge.ts";
import { textGenerationTestLayer } from "./gameTestLayers.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const acceptance: readonly GameAcceptanceCriterion[] = [
  {
    id: "collect",
    kind: "mechanic",
    text: "Collect a pearl",
    observe: { key: "collected", expect: ">=1" },
  },
  {
    id: "hurt",
    kind: "lose",
    text: "The tide hurts",
    observe: { key: "health", expect: "<=95" },
  },
];

const probe = (x: number, collected = 0, health = 100): GamePlaytestProbe => ({
  player: { x, y: 0, z: 0 },
  gameState: { collected, health, won: false },
});

const frames = [
  { label: "booted", file: "01-booted.png" },
  { label: "level-start", file: "02-level-start.png", probe: probe(0) },
  { label: "pearl", file: "03-pearl.png", probe: probe(10, 1) },
  { label: "water", file: "04-water.png", probe: probe(20, 1, 90) },
  { label: "after-steps", file: "05-after-steps.png", probe: probe(20, 1, 90) },
];

const review = (score: 2 | 4 = 4): GameVisualReview => ({
  dimensions: GAME_VISUAL_DIMENSIONS.map((dimension) => ({
    dimension,
    score,
    note: `${dimension} in this frame`,
  })),
  repairRequests:
    score === 4
      ? []
      : [
          { frame: "F3", fix: "Raise the hazard's value against the sand." },
          { frame: "F9", fix: "A frame the judge was never given must be dropped." },
        ],
});

const writeEvidence = async (root: string) => {
  const directory = NodePath.join(root, "builds/playtests/run-1");
  await NodeFSP.mkdir(directory, { recursive: true });
  for (const frame of frames)
    await NodeFSP.writeFile(NodePath.join(directory, frame.file), Buffer.from("png"));
  await NodeFSP.writeFile(
    NodePath.join(directory, "result.json"),
    JSON.stringify({
      at: "2026-10-21T00:00:00.000Z",
      success: true,
      booted: true,
      bootMs: 500,
      responded: true,
      changedPercent: 20,
      message: "Playtest succeeded",
      steps: [],
      consoleMessages: [],
      frames: frames.map((frame) => ({
        ...frame,
        width: 960,
        height: 540,
      })),
      state: {
        before: probe(0),
        after: probe(20, 1, 90),
        playerMoved: 20,
        changes: [
          { key: "collected", before: 0, after: 1 },
          { key: "health", before: 100, after: 90 },
        ],
      },
      qualifies: true,
    }),
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "DESIGN.md"),
    "# Game\n\n## Art direction\n\nBackground #101018, hazard #e04050, goal #ffe08a.\n",
  );
  return "builds/playtests/run-1";
};

const withJudge = <A, E>(
  run: (input: {
    readonly root: string;
    readonly judge: GameVisualJudge.GameVisualJudge["Service"];
  }) => Effect.Effect<A, E>,
  generateImageReview: TextGeneration.TextGeneration["Service"]["generateImageReview"] = () =>
    Effect.die("This test provides no image review."),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "visual-judge-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(() => NodeFSP.mkdir(root, { recursive: true }));
      return yield* Effect.gen(function* () {
        const judge = yield* GameVisualJudge.GameVisualJudge;
        return yield* run({ root, judge });
      }).pipe(
        Effect.provide(
          GameVisualJudge.layer({ stateDir }).pipe(
            Layer.provide(textGenerationTestLayer(generateImageReview)),
          ),
        ),
      );
    }),
  );

const input = (evidenceDirectory: string, designHash: string | null = "design-1") => ({
  sourceId: "source-1",
  buildId: "source-1:build-1",
  designHash,
  evidenceDirectory,
  acceptance,
});

describe("the visual judge", () => {
  it.effect("passes a strong review and persists it beside the playtest evidence", () =>
    withJudge(
      ({ root, judge }) =>
        Effect.gen(function* () {
          const evidenceDirectory = yield* Effect.promise(() => writeEvidence(root));
          const run = yield* judge.run(root, input(evidenceDirectory));
          expect(run.status).toBe("judged");
          if (run.status !== "judged") return;
          expect(run.judgement.status).toBe("passed");
          expect(run.judgement.frames.map((frame) => frame.role)).toEqual([
            "early",
            "interaction",
            "hazard",
            "finish",
          ]);
          expect(run.judgement.roundsLeft).toBe(1);
          const stored = JSON.parse(
            yield* Effect.promise(() =>
              NodeFSP.readFile(
                NodePath.join(root, evidenceDirectory, "visual-review.json"),
                "utf8",
              ),
            ),
          );
          expect(stored.status).toBe("passed");
          expect(stored.designHash).toBe("design-1");
        }),
      (input) => {
        if (input.prompt.includes("one large digit"))
          return Effect.succeed({ digit: "7", backgroundColor: "magenta" });
        expect(input.imagePaths).toHaveLength(4);
        return Effect.succeed(review(4));
      },
    ),
  );

  it.effect("fails a review with one score of two and keeps only real repair frames", () =>
    withJudge(
      ({ root, judge }) =>
        Effect.gen(function* () {
          const evidenceDirectory = yield* Effect.promise(() => writeEvidence(root));
          const run = yield* judge.run(root, input(evidenceDirectory));
          expect(run.status).toBe("judged");
          if (run.status !== "judged") return;
          expect(run.judgement.status).toBe("failed");
          expect(run.judgement.repairRequests).toEqual([
            { frame: "F3", fix: "Raise the hazard's value against the sand." },
          ]);
        }),
      (input) => {
        if (input.prompt.includes("one large digit"))
          return Effect.succeed({ digit: "7", backgroundColor: "magenta" });
        return Effect.succeed(review(2));
      },
    ),
  );

  it.effect("never passes when the image canary answers wrong", () =>
    withJudge(
      ({ root, judge }) =>
        Effect.gen(function* () {
          const evidenceDirectory = yield* Effect.promise(() => writeEvidence(root));
          const run = yield* judge.run(root, input(evidenceDirectory));
          expect(run.status).toBe("judged");
          if (run.status !== "judged") return;
          expect(run.judgement.status).toBe("unavailable");
          expect(run.judgement.detail).toContain("image delivery failed");
          // The provider never judged the game, so the repair budget is intact.
          expect(run.judgement.roundsLeft).toBe(2);
        }),
      (input) => {
        if (input.prompt.includes("one large digit"))
          return Effect.succeed({ digit: "3", backgroundColor: "green" });
        return Effect.succeed(review(4));
      },
    ),
  );

  it.effect("turns a malformed reply into a failure with a reason", () =>
    withJudge(
      ({ root, judge }) =>
        Effect.gen(function* () {
          const evidenceDirectory = yield* Effect.promise(() => writeEvidence(root));
          const run = yield* judge.run(root, input(evidenceDirectory));
          expect(run.status).toBe("judged");
          if (run.status !== "judged") return;
          expect(run.judgement.status).toBe("failed");
          expect(run.judgement.detail).toContain("not a usable review");
        }),
      (input) => {
        if (input.prompt.includes("one large digit"))
          return Effect.succeed({ digit: "7", backgroundColor: "magenta" });
        return Effect.succeed({ dimensions: "not an array", repairRequests: [] });
      },
    ),
  );

  it.effect("spends one repair round and refuses a third judgement", () =>
    withJudge(
      ({ root, judge }) =>
        Effect.gen(function* () {
          const evidenceDirectory = yield* Effect.promise(() => writeEvidence(root));
          expect((yield* judge.run(root, input(evidenceDirectory))).status).toBe("judged");
          const second = yield* judge.run(root, input(evidenceDirectory));
          expect(second.status).toBe("judged");
          if (second.status === "judged") expect(second.judgement.roundsLeft).toBe(0);
          expect((yield* judge.run(root, input(evidenceDirectory))).status).toBe("exhausted");
          // A new approved design revision starts a fresh pair of judgements.
          expect((yield* judge.run(root, input(evidenceDirectory, "design-2"))).status).toBe(
            "judged",
          );
        }),
      (input) => {
        if (input.prompt.includes("one large digit"))
          return Effect.succeed({ digit: "7", backgroundColor: "magenta" });
        return Effect.succeed(review(2));
      },
    ),
  );

  it.effect("accepts the rubric's own label spellings and drops extra notes", () =>
    withJudge(
      ({ root, judge }) =>
        Effect.gen(function* () {
          const evidenceDirectory = yield* Effect.promise(() => writeEvidence(root));
          const run = yield* judge.run(root, input(evidenceDirectory));
          expect(run.status).toBe("judged");
          if (run.status !== "judged") return;
          expect(run.judgement.status).toBe("passed");
          expect(run.judgement.dimensions.map((entry) => entry.dimension)).toEqual([
            ...GAME_VISUAL_DIMENSIONS,
          ]);
        }),
      (input) => {
        if (input.prompt.includes("one large digit"))
          return Effect.succeed({ digit: "7", backgroundColor: "magenta" });
        return Effect.succeed({
          dimensions: [
            { dimension: "Readability (player, hazards, goal)", score: 4, note: "clear" },
            { dimension: "Value separation", score: 4, note: "clear" },
            { dimension: "Camera and framing", score: 4, note: "clear" },
            { dimension: "Style consistency", score: 4, note: "clear" },
            { dimension: "Feedback", score: 4, note: "clear" },
            { dimension: "Design compliance", score: 4, note: "clear" },
            { dimension: "Limits", score: "missing", note: "audio was not judged" },
          ],
          repairRequests: [],
        });
      },
    ),
  );

  it.effect("reports a review provider failure as unavailable and refunds the round", () =>
    withJudge(
      ({ root, judge }) =>
        Effect.gen(function* () {
          const evidenceDirectory = yield* Effect.promise(() => writeEvidence(root));
          const run = yield* judge.run(root, input(evidenceDirectory));
          expect(run.status).toBe("judged");
          if (run.status !== "judged") return;
          expect(run.judgement.status).toBe("unavailable");
          expect(run.judgement.detail).toContain("provider call failed");
          expect(run.judgement.roundsLeft).toBe(2);
        }),
      (input) =>
        input.prompt.includes("one large digit")
          ? Effect.succeed({ digit: "7", backgroundColor: "magenta" })
          : Effect.fail(
              new TextGenerationError({
                operation: "generateImageReview",
                detail: "spawn failed",
              }),
            ),
    ),
  );
});
