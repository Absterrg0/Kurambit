// @effect-diagnostics nodeBuiltinImport:off -- Root-only fixture prep: real Godot, templates and headless Chrome against games created from the real starters, behind QUALITY_FIXTURES_LIVE=1. Import and collection only discover executables; no engine launches until a test runs.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  type GameAcceptanceCriterion,
  type GamePlaytestStep,
  type GameTemplateId,
} from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { designSkeleton } from "./scaffold.ts";
import { readLastPlaytest } from "./playtestEvidence.ts";
import {
  copyQualityDesignRecords,
  applyQualityOverlay,
  QUALITY_EVAL_CASES,
} from "./gameQualityEval.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  roundStoreTestLayer,
  qualificationTestLayer,
} from "./gameTestLayers.ts";

const enabled = process.env.QUALITY_FIXTURES_LIVE === "1";
// Root supplies the destination: one <style>/ directory per fixture holding
// the game and its private home. Never defaults into a live install.
const OUT = process.env.QUALITY_FIXTURES_OUT ?? "";
const workspaceRoot = (() => {
  let directory = process.cwd();
  for (
    let hops = 0;
    hops < 5 && !NodeFS.existsSync(NodePath.join(directory, "apps/server/package.json"));
    hops++
  ) {
    directory = NodePath.resolve(directory, "..");
  }
  return directory;
})();
const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);
// Mirrors PreviewBrowser's install layout; whatever release is already on this
// machine is used, with no duplicate platform segment in the path.
const browserExecutable = (() => {
  const installRoot = NodePath.join(workspaceRoot, ".t3", "tools", "chrome-headless-shell");
  if (!NodeFS.existsSync(installRoot)) return null;
  for (const platform of NodeFS.readdirSync(installRoot)) {
    const platformPath = NodePath.join(installRoot, platform);
    for (const version of NodeFS.readdirSync(platformPath)) {
      for (const name of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
        const candidate = NodePath.join(platformPath, version, name);
        if (NodeFS.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
})();
const templatesInstalled = (() => {
  const dataRoot = process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local/share");
  const roots = [
    NodePath.join(dataRoot, "godot/export_templates"),
    NodePath.join(
      GameToolchain.toolsDirectory(),
      `godot-${GameToolchain.GODOT_VERSION}`,
      "editor_data/export_templates",
    ),
  ];
  try {
    for (const root of roots) {
      if (!NodeFS.existsSync(root)) continue;
      for (const version of NodeFS.readdirSync(root))
        for (const name of ["web_nothreads_release.zip", "linux_release.x86_64"])
          if (
            NodeFS.existsSync(NodePath.join(root, version, version, name)) ||
            NodeFS.existsSync(NodePath.join(root, version, name))
          )
            return true;
    }
  } catch {
    // Unreadable template roots count as missing.
  }
  return false;
})();
const available =
  enabled && NodeFS.existsSync(godotExecutable) && browserExecutable !== null && templatesInstalled;

interface FixtureSpec {
  readonly style: "2d-platformer" | "2d-screen" | "3d-explorer";
  readonly template: GameTemplateId;
  readonly name: string;
  readonly brief: string;
  readonly planFirst: boolean;
  /** Approved observations the playtest must prove; absent means legacy state. */
  readonly acceptance?: readonly GameAcceptanceCriterion[];
  /** The exact route game_verify records; the eval replays it live. */
  readonly steps: readonly GamePlaytestStep[];
}

// Routes match the proven template journeys: they boot, respond to input and
// leave a recorded playtest behind. The 2d-screen route plays the full shift
// so its win/lose acceptance can qualify.
const FIXTURES: readonly FixtureSpec[] = [
  {
    style: "2d-platformer",
    template: "2d-platformer",
    name: "Quality Fixture Ridge",
    brief: "Run the ridge and bank every coin before the door.",
    planFirst: false,
    steps: [
      { click: "left" },
      { waitMs: 600 },
      { key: "Enter", holdMs: 80 },
      { waitMs: 1200 },
      { key: "ArrowRight", holdMs: 1000 },
      { key: "Space", holdMs: 200 },
      { key: "ArrowRight", holdMs: 1300 },
      { waitMs: 1500 },
    ],
  },
  {
    style: "2d-screen",
    template: "2d-screen",
    name: "Quality Fixture Desk",
    brief: "Five callers, a trust budget and a desk that has to stay open.",
    planFirst: true,
    acceptance: [
      {
        id: "choose-reply",
        kind: "control",
        text: "Keys 1 to 3 choose a reply",
        observe: { key: "choices", expect: ">=1" },
      },
      {
        id: "hear-them-out",
        kind: "control",
        text: "Holding L hears the caller out",
        observe: { key: "listened", expect: ">=1" },
      },
      {
        id: "warm-trust",
        kind: "mechanic",
        text: "A warm reply raises trust",
        observe: { key: "trust", expect: ">=3" },
      },
      {
        id: "answer-all",
        kind: "content",
        text: "All five callers are answered",
        observe: { key: "calls", expect: ">=5" },
      },
      {
        id: "hold-the-shift",
        kind: "win",
        text: "The shift ends with trust intact",
        observe: { key: "won", expect: "==1" },
      },
      {
        id: "three-colds",
        kind: "lose",
        text: "Three cold replies end the shift",
        observe: { key: "state", expect: "==4" },
      },
    ],
    steps: [
      { x: 940, y: 500, click: "left" },
      { waitMs: 300 },
      { key: "Enter", holdMs: 80 },
      { waitMs: 600 },
      { key: "l", holdMs: 900 },
      { waitMs: 100 },
      { key: "1", holdMs: 80 },
      { waitMs: 100 },
      { key: "Enter", holdMs: 80 },
      { waitMs: 200 },
      { key: "1", holdMs: 80 },
      { waitMs: 100 },
      { key: "Enter", holdMs: 80 },
      { waitMs: 200 },
      { key: "1", holdMs: 80 },
      { waitMs: 100 },
      { key: "Enter", holdMs: 80 },
      { waitMs: 200 },
      { key: "1", holdMs: 80 },
      { waitMs: 100 },
      { key: "Enter", holdMs: 80 },
      { waitMs: 200 },
      { key: "1", holdMs: 80 },
      { waitMs: 100 },
      { key: "Enter", holdMs: 80 },
      { waitMs: 400 },
    ],
  },
  {
    style: "3d-explorer",
    template: "3d-explorer",
    name: "Quality Fixture Relics",
    brief: "Explore the courtyard of floating ruins and collect every relic.",
    planFirst: false,
    steps: [
      { click: "left" },
      { waitMs: 500 },
      { key: "Enter", holdMs: 80 },
      { waitMs: 3000 },
      { click: "left" },
      { waitMs: 300 },
      { keys: ["Shift", "a"], holdMs: 2100 },
      { waitMs: 100 },
      { keys: ["Shift", "w"], holdMs: 800 },
      { waitMs: 100 },
      { key: "Space", holdMs: 100 },
      { waitMs: 900 },
      { keys: ["Shift", "w"], holdMs: 750 },
      { waitMs: 500 },
      { screenshot: "mid-run" },
    ],
  },
];

const fixtureTest = (spec: FixtureSpec) =>
  Effect.gen(function* () {
    if (OUT.trim() === "")
      throw new Error("QUALITY_FIXTURES_OUT is required: the fixtures' destination directory.");
    const out = NodePath.resolve(OUT);
    const base = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(process.env.TMPDIR ?? NodeOS.tmpdir(), "quality-fixture-")),
    );
    const stateDir = NodePath.join(base, "state");
    const dependencies = GameService.layer.pipe(
      Layer.provideMerge(GameProjectService.layer),
      Layer.provideMerge(GameOperations.layer),
      Layer.provideMerge(GameToolchain.layer),
      Layer.provideMerge(GamePreview.layer),
      Layer.provideMerge(GameProcesses.layer),
      Layer.provide(projectTestLayer()),
      Layer.provide(previewBrowserTestLayer(browserExecutable!)),
      Layer.provideMerge(qualificationTestLayer(stateDir)),
      Layer.provideMerge(designApprovalTestLayer(stateDir)),
      Layer.provideMerge(roundStoreTestLayer(stateDir)),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provideMerge(admissionTestLayer),
      Layer.provide(NodeServices.layer),
    );
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projects = yield* GameProjectService.GameProjectService;
          const game = yield* GameService.GameService;
          const approvals = yield* GameDesignApproval.GameDesignApproval;
          const created = yield* projects.create({
            name: spec.name,
            parentDirectory: base,
            template: spec.template,
            brief: spec.brief,
            planFirst: spec.planFirst,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-6.1-sol",
            },
          });
          if (spec.acceptance !== undefined) {
            // The same record a creator approval would write: this game's own
            // design text, hashed, with its own acceptance. Nothing is forged.
            const criteria = JSON.stringify(spec.acceptance, null, 2);
            const design = designSkeleton(spec.name).replace(
              /```acceptance[\s\S]*?```/,
              `\`\`\`acceptance\n${criteria}\n\`\`\``,
            );
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(created.root, "DESIGN.md"), design),
            );
            yield* approvals.write(created.root, {
              schemaVersion: 1,
              game: created.root,
              approvalId: "quality-fixture-approval",
              designHash: GameDesignApproval.designDocumentHash(design),
              approvedAt: "2026-10-29T00:00:00.000Z",
              acceptance: spec.acceptance,
            });
          }
          const status = yield* game.status(created.threadId);
          if (process.env.QUALITY_FIXTURE_FAULT === "1") {
            const fault = QUALITY_EVAL_CASES.find(
              (entry) => entry.style === spec.style && entry.kind === "fault",
            )!;
            yield* Effect.promise(() => applyQualityOverlay(created.root, fault.overlay));
          }
          if (spec.acceptance !== undefined)
            expect(status.design.state, "the screen fixture opens approved").toBe("approved");
          else expect(status.design.state, "the template fixture opens legacy").toBe("legacy");
          const imported = yield* game.import(created.threadId);
          expect(imported.success, imported.message).toBe(true);
          const tested = yield* game.test(created.threadId, "tests/smoke_test.gd", 300_000);
          expect(tested.success, tested.message).toBe(true);
          // The full production iteration: check, canonical test, scenario
          // exam, Web export and a recorded playtest of those exact bytes.
          const verified = yield* game.verify(created.threadId, {
            steps: [...spec.steps],
            bootTimeoutMs: 45_000,
          });
          expect(verified.success, verified.message).toBe(true);
          const last = yield* Effect.promise(() => readLastPlaytest(created.root, []));
          const routeSteps = last?.steps ?? [];
          expect(routeSteps.length, "the fixture keeps a recorded route").toBeGreaterThan(0);
          if (spec.style === "3d-explorer") {
            expect(
              last?.frames.some((frame) => Number(frame.probe?.gameState.collected ?? 0) > 0),
              "the counter fault requires a real collected relic",
            ).toBe(true);
          }
          // Persist the fixture: the game (with its builds/playtests evidence)
          // and the private home carrying its design records. Both are fresh,
          // so no live userdata is touched and nothing is fabricated.
          const destination = NodePath.join(out, spec.style);
          const gameDestination = NodePath.join(destination, "game");
          const homeDestination = NodePath.join(destination, "home");
          yield* Effect.promise(async () => {
            if (NodeFS.existsSync(destination))
              throw new Error(`Fixture already exists: ${destination}`);
            await NodeFSP.mkdir(destination, { recursive: true });
            await NodeFSP.cp(created.root, gameDestination, { recursive: true });
            await copyQualityDesignRecords({
              sourceStateDir: stateDir,
              targetStateDir: NodePath.join(homeDestination, "userdata"),
              sourceRoot: created.root,
              targetRoot: gameDestination,
            });
            await NodeFSP.writeFile(
              NodePath.join(destination, "fixture.json"),
              `${JSON.stringify(
                {
                  style: spec.style,
                  template: spec.template,
                  name: spec.name,
                  game: gameDestination,
                  home: homeDestination,
                  designState: status.design.state,
                  verifyBuildId: verified.build?.buildId ?? null,
                  completed: verified.completed,
                  routeSteps: routeSteps.length,
                  viewport: last?.viewport ?? null,
                },
                null,
                2,
              )}\n`,
            );
          });
          yield* Effect.log(
            `quality fixture ${spec.style}: verify ${verified.message}, route ${routeSteps.length} step(s) -> ${destination}`,
          );
        }).pipe(Effect.provide(dependencies)),
      );
    } finally {
      if (process.env.GAME_STUDIO_KEEP_TEST !== "1")
        yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
    }
  });

for (const spec of FIXTURES) {
  it.live.skipIf(!available)(
    `prepares a verifiable ${spec.style} fixture base for the quality eval`,
    () => fixtureTest(spec),
    900_000,
  );
}
