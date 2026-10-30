// @effect-diagnostics nodeBuiltinImport:off -- Eval fixtures copy template trees on the native filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
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
} from "./gameQualityEval.ts";
import { approvalRecordFile, designIntentFile } from "./GameDesignApproval.ts";
import { criticPrompt, renderEvidenceFiles } from "./gameReviewPrompts.ts";

const checkout = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

it("scores the original seeded review when newest-first history includes a repaired game", () => {
  const seed = { startedAt: "2026-10-29T10:00:00.000Z", quality: { readability: "no" } };
  const repaired = { startedAt: "2026-10-29T10:01:00.000Z", quality: { readability: "yes" } };
  expect(firstQualityRound([repaired, seed])).toBe(seed);
  expect(firstQualityRound([seed, repaired])).toBe(seed);
  expect(firstQualityRound([{ startedAt: "2026-10-29T09:00:00.000Z" }])).toBeUndefined();
});

it("rekeys copied design intent and approval without changing their source", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "quality-records-"));
  try {
    const source = NodePath.join(base, "source");
    const target = NodePath.join(base, "target");
    const state = NodePath.join(base, "state");
    const copiedState = NodePath.join(base, "copied-state");
    await NodeFSP.mkdir(source);
    await NodeFSP.mkdir(target);
    for (const file of [designIntentFile, approvalRecordFile]) {
      const path = file(state, source);
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSP.writeFile(
        path,
        JSON.stringify({ game: source, intent: "skipped", buildDispatch: {} }),
      );
    }
    await copyQualityDesignRecords({
      sourceRoot: source,
      targetRoot: target,
      sourceStateDir: state,
      targetStateDir: copiedState,
    });
    for (const file of [designIntentFile, approvalRecordFile]) {
      expect(JSON.parse(await NodeFSP.readFile(file(copiedState, target), "utf8"))).toEqual({
        game: target,
        intent: "skipped",
      });
      expect(JSON.parse(await NodeFSP.readFile(file(state, source), "utf8"))).toHaveProperty(
        "game",
        source,
      );
    }
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});

it("covers three styles with a fault and a clean control each", () => {
  const styles = new Set(QUALITY_EVAL_CASES.map((entry) => entry.style));
  expect([...styles].sort()).toEqual(["2d-platformer", "2d-screen", "3d-explorer"]);
  for (const style of ["2d-platformer", "2d-screen", "3d-explorer"] as const) {
    const cases = QUALITY_EVAL_CASES.filter((entry) => entry.style === style);
    expect(cases.some((entry) => entry.kind === "fault")).toBe(true);
    expect(cases.some((entry) => entry.kind === "clean")).toBe(true);
  }
  for (const entry of QUALITY_EVAL_CASES.filter((candidate) => candidate.kind === "fault")) {
    expect(entry.overlay).not.toBeNull();
    expect(Object.keys(entry.expected).length).toBeGreaterThan(0);
  }
});

it("every fault overlay applies exactly once to its template", async () => {
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
    expect(occurrences, entry.id).toBe(1);
  }
});

it("overlay application edits a copy and refuses ambiguity", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "quality-overlay-"));
  try {
    await NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "godot/file.txt"), "before\n");
    const clean = await applyQualityOverlay(root, null);
    expect(clean).toEqual({ applied: false, file: null });
    const applied = await applyQualityOverlay(root, {
      file: "godot/file.txt",
      find: "before",
      replace: "after",
    });
    expect(applied).toEqual({ applied: true, file: "godot/file.txt" });
    expect(await NodeFSP.readFile(NodePath.join(root, "godot/file.txt"), "utf8")).toBe("after\n");
    await expect(
      applyQualityOverlay(root, { file: "godot/file.txt", find: "missing", replace: "x" }),
    ).rejects.toThrow(/exactly once/);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("fault overlays preserve the mechanics they do not target", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "quality-mechanics-"));
  try {
    for (const entry of QUALITY_EVAL_CASES) {
      if (entry.overlay === null) continue;
      const templateFile = NodePath.join(
        checkout,
        "apps/server/templates",
        entry.template,
        entry.overlay.file,
      );
      const target = NodePath.join(root, entry.id, entry.overlay.file);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.copyFile(templateFile, target);
      const applied = await applyQualityOverlay(NodePath.join(root, entry.id), entry.overlay);
      expect(applied.applied, entry.id).toBe(true);
      const text = await NodeFSP.readFile(target, "utf8");
      if (entry.id === "platformer-clipped-hud") {
        expect(text, entry.id).toContain('name="Coins" type="PanelContainer" parent="."');
        expect(text, entry.id).toContain("offset_left = -40.0");
      } else if (entry.id === "screen-meaningless-consequence") {
        // The state update must survive so gates pass and the builder has no
        // failure to repair before the critic: only the feedback lies.
        expect(text, entry.id).toContain("GameState.answer(trust_delta, cold_delta)");
        expect(text, entry.id).toContain("Steady reply · trust unchanged");
        expect(text, entry.id).not.toContain("Warm reply");
      } else if (entry.id === "explorer-missing-feedback") {
        // The counter freeze is the whole fault: no HUD refresh, mechanics intact.
        expect(text, entry.id).toContain("pass  # SEEDED FAULT: relic counter never refreshes");
        expect(text, entry.id).not.toContain("relic_value.text");
        const collectible = await NodeFSP.readFile(
          NodePath.join(
            checkout,
            "apps/server/templates",
            entry.template,
            "godot/scripts/collectible.gd",
          ),
          "utf8",
        );
        expect(collectible, "collect mechanics untouched").toContain("GameState.collect(label)");
        expect(collectible, "pickup audio untouched").toContain('Audio.play("pickup")');
        expect(collectible, "pickup burst untouched").toContain("_spawn_burst()");
      }
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("groundtruth never rides with critic input", async () => {
  const files = [
    { path: "BRIEF.md", label: "brief" },
    { path: "frames/f1.png", label: "frame f1" },
    { path: "frames/f2.png", label: "frame f2" },
  ];
  for (const entry of QUALITY_EVAL_CASES) {
    // A real reviewer packet: the manifest the prompt reads, the rendered
    // prompt, the route text and anonymous frames. No sources, no labels.
    const packet = {
      brief: entry.routeNote,
      frames: [{ id: "f1" }, { id: "f2" }],
      checks: [],
      manifest: renderEvidenceFiles(files),
      prompt: criticPrompt(files),
    };
    expect(assertNoGroundtruthLeak(packet), entry.id).toBe(true);
  }
  expect(assertNoGroundtruthLeak({ expected: { readability: "no" } })).toBe(false);
  expect(assertNoGroundtruthLeak({ brief: "case platformer-clipped-hud notes" })).toBe(false);
  expect(assertNoGroundtruthLeak({ note: "quality:readability fails" })).toBe(false);
  expect(assertNoGroundtruthLeak({ note: "SEEDED FAULT: counter frozen" })).toBe(false);
});

it("groundtruth sidecars stay outside the prepared game copy", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "quality-sidecar-"));
  try {
    const copy = NodePath.join(root, "copies", "case-01");
    await NodeFSP.mkdir(NodePath.join(copy, "godot"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(copy, "game.json"), '{ "name": "fixture" }\n');
    await NodeFSP.writeFile(
      NodePath.join(copy, "godot/overlay.gd"),
      "# SEEDED FAULT: label frozen\npass\n",
    );
    const truth = NodePath.join(root, "groundtruth", "screen-meaningless-consequence.json");
    await NodeFSP.mkdir(NodePath.dirname(truth), { recursive: true });
    await NodeFSP.writeFile(truth, '{ "caseId": "screen-meaningless-consequence" }\n');
    // Overlay comments ride in sources the critic never reads; reviewer-facing
    // labels must not.
    expect(await assertNoGroundtruthInCopy(copy)).toBe(true);
    expect(groundtruthOutsideCopy(copy, truth)).toBe(true);
    expect(groundtruthOutsideCopy(copy, NodePath.join(copy, "game.json"))).toBe(false);
    await NodeFSP.writeFile(
      NodePath.join(copy, "leak.groundtruth.json"),
      '{ "expected": { "agency": "no" } }\n',
    );
    expect(await assertNoGroundtruthInCopy(copy)).toBe(false);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("scores policy targets separately from fault detection", () => {
  const screen = QUALITY_EVAL_CASES.find((entry) => entry.id === "screen-meaningless-consequence")!;
  const explorer = QUALITY_EVAL_CASES.find((entry) => entry.id === "explorer-missing-feedback")!;
  // An abstention on a cannot-tell target is the honest pass, never a hit.
  const policyPass = evaluateQualityCase({
    case: explorer,
    actual: { readability: "cannot-tell", audio: "cannot-tell" },
    coverage: { assessed: 7, total: 7, unknowns: 7 },
  });
  expect(policyPass.dimensions.map((dimension) => dimension.outcome)).toEqual([
    "unknown",
    "unknown",
  ]);
  // A yes/no verdict with no evidence is an overclaim, not a detection miss.
  const policyFail = evaluateQualityCase({
    case: explorer,
    actual: { readability: "no", audio: "yes" },
    coverage: { assessed: 7, total: 7, unknowns: 5 },
  });
  expect(policyFail.dimensions.map((dimension) => dimension.outcome)).toEqual(["hit", "miss"]);
  expect(screen).toBeDefined();
});

it("aggregates hits, misses and unknowns honestly", () => {
  const fault = QUALITY_EVAL_CASES.find((entry) => entry.id === "platformer-clipped-hud")!;
  const clean = QUALITY_EVAL_CASES.find((entry) => entry.id === "platformer-clean")!;
  const explorer = QUALITY_EVAL_CASES.find((entry) => entry.id === "explorer-missing-feedback")!;
  const aggregated = aggregateQualityEval([
    evaluateQualityCase({
      case: fault,
      actual: { readability: "no" },
      coverage: { assessed: 7, total: 7, unknowns: 5 },
    }),
    evaluateQualityCase({
      case: clean,
      actual: { readability: "cannot-tell" },
      coverage: { assessed: 7, total: 7, unknowns: 7 },
    }),
    evaluateQualityCase({
      case: explorer,
      actual: { readability: "no", audio: "yes" },
      coverage: { assessed: 7, total: 7, unknowns: 5 },
    }),
    evaluateQualityCase({ case: fault, actual: null, coverage: null, error: "timeout" }),
  ]);
  // Fault found (TP), clean abstained (unknown), explorer detected (TP) but
  // its audio overclaimed (policy fail), errored run kept in the denominator.
  expect(aggregated.cases).toBe(4);
  expect(aggregated.keyDimensions).toBe(5);
  expect(aggregated.hits).toBe(2);
  expect(aggregated.truePositives).toBe(2);
  expect(aggregated.trueNegatives).toBe(0);
  expect(aggregated.misses).toBe(0);
  expect(aggregated.falseNegatives).toBe(0);
  expect(aggregated.falsePositives).toBe(0);
  expect(aggregated.unknowns).toBe(1);
  expect(aggregated.policyTargets).toBe(1);
  expect(aggregated.policyPass).toBe(0);
  expect(aggregated.policyFail).toBe(1);
  expect(aggregated.errors).toBe(1);
  expect(aggregated.invalid).toBe(0);
});

it("counts clean false alarms and fault misses on their own", () => {
  const fault = QUALITY_EVAL_CASES.find((entry) => entry.id === "platformer-clipped-hud")!;
  const clean = QUALITY_EVAL_CASES.find((entry) => entry.id === "platformer-clean")!;
  const aggregated = aggregateQualityEval([
    evaluateQualityCase({
      case: fault,
      actual: { readability: "yes" },
      coverage: { assessed: 7, total: 7, unknowns: 5 },
    }),
    evaluateQualityCase({
      case: clean,
      actual: { readability: "no" },
      coverage: { assessed: 7, total: 7, unknowns: 5 },
    }),
  ]);
  expect(aggregated.hits).toBe(0);
  expect(aggregated.misses).toBe(2);
  expect(aggregated.falseNegatives).toBe(1);
  expect(aggregated.falsePositives).toBe(1);
  expect(aggregated.keyDimensions).toBe(2);
});
