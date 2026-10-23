// @effect-diagnostics nodeBuiltinImport:off -- The studio test writes real playtest evidence in a temporary game.
// @effect-diagnostics globalDate:off -- Fixed evidence timestamps make the newest-run read deterministic.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type GameManifest,
  type GamePlaytestProbe,
  type GameWebPlaytestInput,
  type GameWebPlaytestResult,
  type GameReviewFrozenInputs,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameRepairStudio from "./GameRepairStudio.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameService from "./GameService.ts";
import {
  readLastPlaytest,
  readPlaytestRunFacts,
  writePlaytestEvidence,
} from "./playtestEvidence.ts";
import { candidateBuildDirectory, hashWebBuildDirectory } from "./webBuild.ts";

const threadId = ThreadId.make("thread:studio-check");
const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Studio probe",
  brief: "Make a small platformer.",
  artDirection: "Warm paper colours.",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};

const probe = (hudText: string): GamePlaytestProbe => ({
  gameState: { score: 0, playing: true },
  player: { x: 12, y: 40, z: 0 },
  hudText,
});

/** Fixed evidence timestamps: reading the newest run must not depend on the clock. */
const FIRST_EVIDENCE_AT = new Date("2026-10-01T10:00:00.000Z");
const LATER_EVIDENCE_AT = new Date("2026-10-01T10:05:00.000Z");

const baseResult = (): GameWebPlaytestResult => ({
  success: true,
  booted: true,
  bootMs: 900,
  responded: true,
  changedPercent: 12,
  message: "played",
  consoleMessages: [],
  screenshots: [
    { label: "after-steps", mimeType: "image/png", data: "cG5n", width: 1152, height: 648 },
  ],
  state: null,
  baseViewport: { width: 1152, height: 648 },
});

interface Harness {
  readonly root: string;
  results: GameWebPlaytestResult;
  readonly calls: Array<GameWebPlaytestInput | undefined>;
  /** The raw stage records the qualification store would report. */
  exportStage: GameQualification.QualificationStageRecord | null;
  playtestStage: GameQualification.QualificationStageRecord | null;
}

/**
 * A real content-addressed build directory: the id is the hash of the files, so
 * the test can corrupt it afterwards and prove the byte check noticed.
 */
const makeBuild = async (root: string): Promise<string> => {
  const staging = NodePath.join(root, "builds/candidates/staging");
  await NodeFSP.mkdir(staging, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(staging, "index.html"), "<html>game</html>\n");
  await NodeFSP.writeFile(NodePath.join(staging, "index.pck"), "pck");
  const hashed = await hashWebBuildDirectory(staging);
  if (hashed === null) throw new Error("the fixture build did not hash");
  const final = NodePath.join(root, candidateBuildDirectory(hashed.buildId));
  await NodeFSP.rename(staging, final);
  return hashed.buildId;
};

const stage = (input: {
  readonly buildId: string;
  readonly evidenceDirectory?: string | null;
  readonly outcome?: "passed" | "failed";
}): GameQualification.QualificationStageRecord => ({
  outcome: input.outcome ?? "passed",
  sourceId: "fixture-source",
  buildId: input.buildId,
  finishedAt: "2026-10-01T10:05:00.000Z",
  evidenceDirectory: input.evidenceDirectory ?? null,
  runId: "run:builder",
});

const withStudio = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, GameRepairStudio.GameRepairStudio>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-check-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(root, "game.json"),
          `${JSON.stringify({ name: "Studio probe", brief: "Make a platformer." })}\n`,
        );
      });
      const harness: Harness = {
        root,
        results: baseResult(),
        calls: [],
        exportStage: null,
        playtestStage: null,
      };
      const game = Layer.mock(GameService.GameService)({
        webPlaytestBuild: (_thread, _buildId, input) => {
          harness.calls.push(input);
          return Effect.succeed(harness.results);
        },
      });
      const projects = Layer.mock(GameProjectService.GameProjectService)({
        resolve: () => Effect.succeed(root),
        read: () => Effect.succeed(manifest),
      });
      const qualification = Layer.mock(GameQualification.GameQualification)({
        stageRecord: (_root, stage) =>
          Effect.succeed(stage === "export" ? harness.exportStage : harness.playtestStage),
      });
      const rounds = Layer.mock(GameRoundStore.GameRoundStore)({
        exported: (_root, buildId) =>
          Effect.gen(function* () {
            const played = harness.playtestStage;
            const facts =
              played?.buildId === buildId && played.evidenceDirectory !== null
                ? yield* Effect.promise(() => readPlaytestRunFacts(root, played.evidenceDirectory!))
                : null;
            const last = yield* Effect.promise(() => readLastPlaytest(root, [], null));
            return {
              artifact: {
                buildId,
                directory: candidateBuildDirectory(buildId),
                sourceId: "fixture",
                engine: "godot" as const,
                target: "Web" as const,
                entry: "index.html",
              },
              sourceDirectory: root,
              playtest:
                facts === null
                  ? null
                  : { ...facts, steps: last?.steps ?? [], viewport: last?.viewport ?? null },
            };
          }),
      });
      const layer = GameRepairStudio.layer({ stateDir: NodePath.join(base, "state") }).pipe(
        Layer.provide(game),
        Layer.provide(projects),
        Layer.provide(qualification),
        Layer.provide(rounds),
        Layer.provide(NodeServices.layer),
      );
      return yield* body(harness).pipe(Effect.provide(layer));
    }),
  );

it.live("captures the builder's route once and replays it for every later check", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ key: "ArrowRight", holdMs: 120 }],
          result: baseResult(),
          at: FIRST_EVIDENCE_AT,
        }),
      );
      const inputs = yield* studio.frozenInputs(harness.root);
      expect(inputs.steps).toEqual([{ key: "ArrowRight", holdMs: 120 }]);
      expect(inputs.viewport).toEqual({ width: 1152, height: 648 });
      // The playtest records no seed; it says so rather than inventing one.
      expect(inputs.seed).toBe("unknown");

      yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs,
      });
      expect(harness.calls.at(-1)).toEqual({
        steps: [{ key: "ArrowRight", holdMs: 120 }],
        width: 1152,
        height: 648,
      });

      // A repair child writes its own, easier demo route. The loop's frozen
      // inputs are what every later check replays, never the newest playtest.
      yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ key: "ArrowLeft", holdMs: 20 }],
          result: baseResult(),
          at: LATER_EVIDENCE_AT,
        }),
      );
      const newer = yield* studio.frozenInputs(harness.root);
      expect(newer.steps).toEqual([{ key: "ArrowLeft", holdMs: 20 }]);
      yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId: "a".repeat(64),
        inputs,
      });
      expect(harness.calls.at(-1)?.steps).toEqual([{ key: "ArrowRight", holdMs: 120 }]);
    }),
  ),
);

it.live("a frozen player with animated scenery fails the input and state checks", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const inputs: GameReviewFrozenInputs = {
        steps: [{ key: "ArrowRight", holdMs: 120 }],
        viewport: { width: 1152, height: 648 },
        seed: null,
      };
      // Pixels change (animated scenery) and the browser saw a visible
      // response, but the probe measured no player movement and the run did
      // not qualify as gameplay.
      harness.results = {
        ...baseResult(),
        responded: true,
        changedPercent: 35,
        state: {
          before: probe("score 0"),
          after: probe("score 0"),
          playerMoved: 0,
          changes: [],
        },
        qualifies: false,
        blockers: ["the player did not move from the gameplay baseline"],
      };
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId: "a".repeat(64),
        inputs,
      });
      const byId = new Map(checked.checks.map((check) => [check.id, check]));
      expect(byId.get("boot")?.status).toBe("passed");
      expect(byId.get("input")?.status).toBe("failed");
      expect(byId.get("input")?.detail).toContain("did not move");
      expect(byId.get("state")?.status).toBe("failed");
      expect(byId.get("state")?.detail).toContain("did not move");
      expect(byId.get("hud")?.status).toBe("passed");
    }),
  ),
);

it.live("an honest run passes movement, qualification and HUD from the real verdicts", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      harness.results = {
        ...baseResult(),
        state: {
          before: probe("score 0"),
          after: probe("score 10"),
          playerMoved: 48,
          changes: [{ key: "score", before: 0, after: 10 }],
        },
        qualifies: true,
        blockers: [],
        pauseConfirmed: true,
      };
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs: {
          steps: [{ key: "ArrowRight", holdMs: 120 }],
          viewport: null,
          seed: null,
        },
      });
      const byId = new Map(checked.checks.map((check) => [check.id, check]));
      expect(byId.get("input")?.status).toBe("passed");
      expect(byId.get("state")?.status).toBe("passed");
      expect(byId.get("hud")?.status).toBe("passed");
      expect(byId.get("bridge")?.status).toBe("passed");
    }),
  ),
);

it.live("a candidate that keeps a title but hides its score fails state-on-screen", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const check = (notOnScreen: ReadonlyArray<string> | undefined) =>
        Effect.gen(function* () {
          harness.results = {
            ...baseResult(),
            state: {
              before: probe("Lantern Run"),
              after: probe("Lantern Run"),
              playerMoved: 48,
              changes: [{ key: "score", before: 0, after: 10 }],
              ...(notOnScreen === undefined ? {} : { notOnScreen: [...notOnScreen] }),
            },
            qualifies: true,
            blockers: [],
            pauseConfirmed: true,
          };
          const checked = yield* studio.check({
            threadId,
            root: harness.root,
            target: "candidate",
            buildId: "a".repeat(64),
            inputs: { steps: [{ key: "ArrowRight", holdMs: 120 }], viewport: null, seed: null },
          });
          return new Map(checked.checks.map((entry) => [entry.id, entry]));
        });
      const hiding = yield* check(["score"]);
      // Any HUD text still passes `hud`; the state check is independent of it.
      expect(hiding.get("hud")?.status).toBe("passed");
      expect(hiding.get("state-on-screen")?.status).toBe("failed");
      expect(hiding.get("state-on-screen")?.detail).toContain("score");
      expect((yield* check([])).get("state-on-screen")?.status).toBe("passed");
      expect((yield* check(undefined)).get("state-on-screen")?.status).toBe("unmeasured");
    }),
  ),
);

it.live("a probe-less run leaves movement and state unmeasured instead of passing", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      harness.results = { ...baseResult(), state: null };
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId: "a".repeat(64),
        inputs: {
          steps: [{ key: "ArrowRight", holdMs: 120 }],
          viewport: null,
          seed: null,
        },
      });
      const byId = new Map(checked.checks.map((check) => [check.id, check]));
      expect(byId.get("input")?.status).toBe("unmeasured");
      expect(byId.get("state")?.status).toBe("unmeasured");
      expect(byId.get("hud")?.status).toBe("unmeasured");
      expect(byId.get("boot")?.status).toBe("passed");
    }),
  ),
);

/** The passed playtest a submission needs, written as real evidence. */
const passedPlaytest = (root: string, at = FIRST_EVIDENCE_AT) =>
  writePlaytestEvidence({
    root,
    steps: [{ key: "ArrowRight", holdMs: 120 }],
    result: baseResult(),
    at,
  });

it.live("submission facts pass on the bytes, the current export and a clean playtest", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() => passedPlaytest(harness.root));
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const facts = yield* studio.submissionFacts(harness.root);
      expect(facts.passed, facts.reason ?? "").toBe(true);
      expect(facts.buildId).toBe(buildId);
      expect(facts.reason).toBeNull();
      const byId = new Map(facts.checks.map((entry) => [entry.id, entry]));
      for (const id of ["build", "bytes", "sources", "playtest", "boot", "console", "input"]) {
        expect(byId.get(id)?.status, id).toBe("passed");
      }
    }),
  ),
);

it.live("submission facts refuse a build whose bytes changed and name the fact", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() => passedPlaytest(harness.root));
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      // A same-size rewrite changes the id the directory claims to name.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(harness.root, candidateBuildDirectory(buildId), "index.html"),
          "<html>hacked</html>\n",
        ),
      );
      const facts = yield* studio.submissionFacts(harness.root);
      expect(facts.passed).toBe(false);
      expect(facts.reason).toContain("bytes:");
      const bytes = facts.checks.find((entry) => entry.id === "bytes");
      expect(bytes?.status).toBe("failed");
      expect(bytes?.detail).toContain("changed after export");
      // The dirty build is never hashed as if it were the one it claims to be.
      expect(facts.checks.some((entry) => entry.id === "playtest")).toBe(false);
    }),
  ),
);

it.live("submission facts accept an older bound build when a newer export exists", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() => passedPlaytest(harness.root));
      harness.exportStage = stage({ buildId: "e".repeat(64) });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const facts = yield* studio.submissionFacts(harness.root, buildId);
      expect(facts.passed, facts.reason ?? "").toBe(true);
      expect(facts.checks.find((entry) => entry.id === "sources")?.status).toBe("passed");
    }),
  ),
);

it.live("submission facts refuse console errors and a playtest with no input", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [],
          result: {
            ...baseResult(),
            responded: false,
            consoleMessages: [
              { level: "error", text: "boom" },
              { level: "error", text: "bang" },
            ],
          },
          at: FIRST_EVIDENCE_AT,
        }),
      );
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const facts = yield* studio.submissionFacts(harness.root);
      expect(facts.passed).toBe(false);
      const byId = new Map(facts.checks.map((entry) => [entry.id, entry]));
      expect(byId.get("console")?.status).toBe("failed");
      expect(byId.get("console")?.detail).toContain("2 console error(s)");
      expect(byId.get("input")?.status).toBe("failed");
      expect(byId.get("input")?.detail).toContain("no input steps");
      expect(facts.reason).toContain("console:");
      expect(facts.reason).toContain("input:");
    }),
  ),
);

it.live.each([false, undefined])(
  "submission uses raw facts when gameplay qualification is %s",
  (qualifies) =>
    withStudio((harness) =>
      Effect.gen(function* () {
        const studio = yield* GameRepairStudio.GameRepairStudio;
        const buildId = yield* Effect.promise(() => makeBuild(harness.root));
        const evidence = yield* Effect.promise(() =>
          writePlaytestEvidence({
            root: harness.root,
            steps: [{ click: "left" }],
            result: {
              ...baseResult(),
              ...(qualifies === undefined ? {} : { qualifies }),
              blockers: ["no movement or design progress"],
            },
            at: FIRST_EVIDENCE_AT,
          }),
        );
        harness.exportStage = stage({ buildId });
        harness.playtestStage = {
          ...stage({ buildId, evidenceDirectory: evidence.directory, outcome: "failed" }),
          detail: "Interaction: none.",
        };
        expect((yield* studio.submissionFacts(harness.root)).passed).toBe(true);
        yield* Effect.promise(() =>
          writePlaytestEvidence({
            root: harness.root,
            steps: [{ click: "left" }],
            result: {
              ...baseResult(),
              booted: false,
              responded: false,
              qualifies: false,
              consoleMessages: [{ level: "error", text: "boom" }],
            },
            at: LATER_EVIDENCE_AT,
          }).then((bad) => {
            harness.playtestStage = stage({
              buildId,
              evidenceDirectory: bad.directory,
              outcome: "failed",
            });
          }),
        );
        const refused = yield* studio.submissionFacts(harness.root);
        expect(refused.reason).toContain("boot: The playtest recorded that the game did not boot.");
        expect(refused.reason).toContain("console: 1 console error(s)");
        expect(refused.reason).toContain("input: The game did not visibly respond");
        expect(refused.reason).not.toContain("qualification");
      }),
    ),
);

it.live("waits and screenshots cannot supply submission input, even with animated frames", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ waitMs: 500 }, { screenshot: "animated" }],
          result: baseResult(),
          at: FIRST_EVIDENCE_AT,
        }),
      );
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const facts = yield* studio.submissionFacts(harness.root);
      expect(facts.passed).toBe(false);
      expect(facts.reason).toBe(
        "input: The playtest executed no input steps; waits and screenshots do not count.",
      );
    }),
  ),
);
