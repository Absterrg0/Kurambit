import { expect, it } from "vite-plus/test";
import {
  NATIVE_DIAGNOSTICS_MAX_CHARS,
  NATIVE_DIAGNOSTICS_MAX_FINDINGS,
  formatNativeDiagnostics,
  selectNativeLayout,
} from "./scenarioLayoutDiagnostics.ts";
import type { GameScenarioEvidence, GameScenarioLayout } from "@t3tools/contracts";

const run = (id: string, layout: GameScenarioLayout): GameScenarioEvidence =>
  ({
    id,
    frames: 120,
    durationMs: 2000,
    firstInputFrame: 30,
    baselineFrame: 36,
    playerMoved: true,
    error: null,
    invalidActions: [],
    observations: [],
    layout,
  }) as GameScenarioEvidence;

const finding = (subject: string, step: number) => ({
  kind: "overlap-risk" as const,
  subject: `Button "${subject}"`,
  detail:
    "may be obscured by later sibling Panel (overlap risk: 40% overlaps; visual occlusion not proven from geometry).",
  nodePath: `Main/${subject}`,
  scenarioFrame: 60 + step,
  step,
  viewport: { width: 1152, height: 648 },
});

const layoutOf = (subjects: readonly string[]) => ({
  findings: subjects.map((subject, index) => finding(subject, index)),
  coverage: {
    probes: 2,
    omittedProbes: 0,
    inspectedControls: 3,
    pairs: 4,
    truncated: false,
    viewport: { width: 1152, height: 648 },
  },
});

it("ignores scenario evidence from other sources", () => {
  expect(
    selectNativeLayout({
      stateSourceId: "new-sources",
      stateEvidenceDirectory: "builds/logs/scenarios-1",
      exportInputSourceId: "old-sources",
      scenarios: [run("full-run", layoutOf(["Cook"]))],
    }),
  ).toBeNull();
});

it("ignores missing scenario evidence honestly", () => {
  expect(
    selectNativeLayout({
      stateSourceId: "sources",
      stateEvidenceDirectory: null,
      exportInputSourceId: "sources",
      scenarios: [run("full-run", layoutOf(["Cook"]))],
    }),
  ).toBeNull();
  expect(
    selectNativeLayout({
      stateSourceId: null,
      stateEvidenceDirectory: "builds/logs/scenarios-1",
      exportInputSourceId: "sources",
      scenarios: [run("full-run", layoutOf(["Cook"]))],
    }),
  ).toBeNull();
});

it("formats same-source findings as hints with native-geometry uncertainty", () => {
  const selected = selectNativeLayout({
    stateSourceId: "sources",
    stateEvidenceDirectory: "builds/logs/scenarios-1",
    exportInputSourceId: "sources",
    scenarios: [run("full-run", layoutOf(["Cook"]))],
  });
  expect(selected).not.toBeNull();
  const text = formatNativeDiagnostics(selected!);
  expect(text).toContain('"Cook"');
  expect(text).toContain("full-run");
  expect(text).toContain("step 1");
  expect(text).toContain("visual occlusion not proven");
  expect(text).toContain("game_try_input");
  // Hints name where to look on Web frames; they never claim a Web defect.
  expect(text).not.toMatch(/web defect|proven.*web/i);
});

it("bounds the critic file when many scenarios report", () => {
  const scenarios = Array.from({ length: 8 }, (_, index) =>
    run(
      `route-${index}`,
      layoutOf(Array.from({ length: 8 }, (_, inner) => `Button${index}-${inner}`)),
    ),
  );
  const selected = selectNativeLayout({
    stateSourceId: "sources",
    stateEvidenceDirectory: "builds/logs/scenarios-1",
    exportInputSourceId: "sources",
    scenarios,
  });
  expect(selected).not.toBeNull();
  expect(selected!.findings.length).toBeLessThanOrEqual(NATIVE_DIAGNOSTICS_MAX_FINDINGS);
  const text = formatNativeDiagnostics(selected!);
  expect(text.length).toBeLessThanOrEqual(NATIVE_DIAGNOSTICS_MAX_CHARS);
  expect(text).toContain("omitted");
});
