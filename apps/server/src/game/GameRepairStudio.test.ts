// @effect-diagnostics nodeBuiltinImport:off -- The studio test writes real playtest evidence in a temporary game.
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
import * as GameService from "./GameService.ts";
import { writePlaytestEvidence } from "./playtestEvidence.ts";

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
}

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
      const harness: Harness = { root, results: baseResult(), calls: [] };
      const game = Layer.mock(GameService.GameService)({
        webPlaytest: (_thread, input) => {
          harness.calls.push(input);
          return Effect.succeed(harness.results);
        },
      });
      const projects = Layer.mock(GameProjectService.GameProjectService)({
        resolve: () => Effect.succeed(root),
        read: () => Effect.succeed(manifest),
      });
      const layer = GameRepairStudio.layer({ stateDir: NodePath.join(base, "state") }).pipe(
        Layer.provide(game),
        Layer.provide(projects),
        Layer.provide(Layer.mock(GameQualification.GameQualification)({})),
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
          at: new Date("2026-10-01T10:00:00.000Z"),
        }),
      );
      const inputs = yield* studio.frozenInputs(harness.root);
      expect(inputs.steps).toEqual([{ key: "ArrowRight", holdMs: 120 }]);
      expect(inputs.viewport).toEqual({ width: 1152, height: 648 });
      expect(inputs.seed).toBeNull();

      yield* studio.check({ threadId, root: harness.root, target: "incumbent", inputs });
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
          at: new Date("2026-10-01T10:05:00.000Z"),
        }),
      );
      const newer = yield* studio.frozenInputs(harness.root);
      expect(newer.steps).toEqual([{ key: "ArrowLeft", holdMs: 20 }]);
      yield* studio.check({ threadId, root: harness.root, target: "candidate", inputs });
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

it.live("a probe-less run leaves movement and state unmeasured instead of passing", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      harness.results = { ...baseResult(), state: null };
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
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
