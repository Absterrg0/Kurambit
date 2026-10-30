import { expect, it } from "vite-plus/test";
import {
  NATIVE_WORLD_MAX_CHARS,
  formatNativeWorld,
  selectNativeSpatial,
} from "./scenarioSpatialDiagnostics.ts";
import type { GameScenarioEvidence, GameScenarioSpatial } from "@t3tools/contracts";

const spatialOf = (areas: number, shapes: number): GameScenarioSpatial => ({
  snapshots: [
    {
      scenarioFrame: 30,
      step: null,
      player: { present: true, position: [4, 5], velocity: null, bodyKind: "Node2D" },
      areas: Array.from({ length: areas }, (_, index) => ({
        nodePath: `Main/Zone${index}`,
        type: "Area2D",
        monitoring: true,
        monitorable: true,
        visible: true,
        shapes: Array.from({ length: shapes }, (_, inner) => ({
          nodePath: `Main/Zone${index}/S${inner}`,
          shapeKind: "RectangleShape2D",
          disabled: false,
          bounds: { kind: "rect2" as const, min: [0, 0], max: [10, 10] },
          conservative: false,
          containsPlayerOrigin: false,
        })),
      })),
    },
  ],
  coverage: {
    snapshots: 1,
    omittedSnapshots: 0,
    visitedNodes: 50,
    areas,
    shapes: areas * shapes,
    skippedFreed: 0,
    truncated: false,
  },
});

const run = (id: string, spatial?: GameScenarioSpatial): GameScenarioEvidence =>
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
    ...(spatial === undefined ? {} : { spatial }),
  }) as GameScenarioEvidence;

it("omits spatial on source mismatch, stale or missing evidence", () => {
  const scenarios = [run("full-run", spatialOf(1, 1))];
  expect(
    selectNativeSpatial({
      stateSourceId: "new-sources",
      stateEvidenceDirectory: "builds/logs/scenarios-1",
      exportInputSourceId: "old-sources",
      scenarios,
    }),
  ).toBeNull();
  expect(
    selectNativeSpatial({
      stateSourceId: null,
      stateEvidenceDirectory: "builds/logs/scenarios-1",
      exportInputSourceId: "sources",
      scenarios,
    }),
  ).toBeNull();
  expect(
    selectNativeSpatial({
      stateSourceId: "sources",
      stateEvidenceDirectory: null,
      exportInputSourceId: "sources",
      scenarios,
    }),
  ).toBeNull();
});

it("ignores legacy runs with no spatial snapshots", () => {
  expect(
    selectNativeSpatial({
      stateSourceId: "sources",
      stateEvidenceDirectory: "builds/logs/scenarios-1",
      exportInputSourceId: "sources",
      scenarios: [run("full-run")],
    }),
  ).toBeNull();
});

it("still delivers spatial when layout findings are absent", () => {
  // The run carries spatial but no layout key at all: zero layout findings
  // must not suppress the world packet.
  const selected = selectNativeSpatial({
    stateSourceId: "sources",
    stateEvidenceDirectory: "builds/logs/scenarios-1",
    exportInputSourceId: "sources",
    scenarios: [run("full-run", spatialOf(1, 1))],
  });
  expect(selected).not.toBeNull();
  expect(selected!.scenarios).toHaveLength(1);
  const text = formatNativeWorld(selected!);
  expect(text).toContain("full-run");
  expect(text).toContain("headless world measurements");
  expect(text).toContain("containsPlayerOrigin");
  expect(text.length).toBeLessThanOrEqual(NATIVE_WORLD_MAX_CHARS);
});

it("bounds the critic file and never ships code", () => {
  const scenarios = Array.from({ length: 8 }, (_, index) => run(`route-${index}`, spatialOf(2, 4)));
  const selected = selectNativeSpatial({
    stateSourceId: "sources",
    stateEvidenceDirectory: "builds/logs/scenarios-1",
    exportInputSourceId: "sources",
    scenarios,
  });
  expect(selected).not.toBeNull();
  const text = formatNativeWorld(selected!);
  expect(text.length).toBeLessThanOrEqual(NATIVE_WORLD_MAX_CHARS);
  // Measurements only: no runner script, no game code, no verdict engine.
  expect(text).not.toMatch(/extends SceneTree|func _probe|won|parking/i);
  expect(text).toContain("never cite as proof");
  expect(text).toContain("never means an entire body is inside");
});

it("marks truncation honestly instead of silently shrinking", () => {
  const selected = selectNativeSpatial({
    stateSourceId: "sources",
    stateEvidenceDirectory: "builds/logs/scenarios-1",
    exportInputSourceId: "sources",
    scenarios: [
      run(
        "truncated",
        (() => {
          const base = spatialOf(1, 1);
          return { ...base, coverage: { ...base.coverage, truncated: true } };
        })(),
      ),
    ],
  });
  expect(selected!.truncated).toBe(true);
  expect(formatNativeWorld(selected!)).toContain("truncated");
});

it("keeps oversized and Unicode world packets valid JSON within the byte limit", () => {
  const base = spatialOf(16, 2);
  // Compact lines still bound pathological scans: repeat a wide snapshot so
  // one scenario alone exceeds the file cap and is honestly omitted.
  const wideSnapshot = {
    ...base.snapshots[0]!,
    areas: base.snapshots[0]!.areas.map((area) => ({
      ...area,
      nodePath: "霜".repeat(300),
      shapes: area.shapes.map((shape) => ({ ...shape, nodePath: "霜".repeat(300) })),
    })),
  };
  const spatial = {
    ...base,
    snapshots: Array.from({ length: 40 }, (_, index) => ({
      ...wideSnapshot,
      scenarioFrame: 30 + index,
    })),
  };
  const selected = selectNativeSpatial({
    stateSourceId: "sources",
    stateEvidenceDirectory: "builds/logs/scenarios-1",
    exportInputSourceId: "sources",
    scenarios: [run("large", spatial)],
  });
  expect(selected).not.toBeNull();
  const text = formatNativeWorld(selected!);
  expect(() => JSON.parse(text)).not.toThrow();
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(NATIVE_WORLD_MAX_CHARS);
  expect(JSON.parse(text)).toMatchObject({ truncated: true, omitted: 1, scenarios: [] });
});

it("writes one compact line per snapshot with area-level origin tests", () => {
  const spatial: GameScenarioSpatial = {
    snapshots: [
      {
        scenarioFrame: 152,
        step: 3,
        player: {
          present: true,
          position: [0, -0.0990583673119545, 3.63832926750183],
          velocity: [0, 0, -5.76666688919067],
          bodyKind: "CharacterBody3D",
        },
        areas: [
          {
            nodePath: "Game/Level/Goal",
            type: "Area3D",
            monitoring: true,
            monitorable: true,
            visible: true,
            shapes: [
              {
                nodePath: "Game/Level/Goal/Collision",
                shapeKind: "BoxShape3D",
                disabled: false,
                bounds: { kind: "aabb3" as const, min: [-3, 0, -18.5], max: [3, 2, -12.5] },
                conservative: false,
                containsPlayerOrigin: false,
              },
            ],
          },
        ],
      },
      {
        scenarioFrame: 534,
        step: 6,
        player: {
          present: true,
          position: [0, -0.0990595147013664, -11.8450021743774],
          velocity: [0, 0, 0],
          bodyKind: "CharacterBody3D",
        },
        areas: [
          {
            nodePath: "Game/Level/Goal",
            type: "Area3D",
            monitoring: true,
            monitorable: true,
            visible: true,
            shapes: [
              {
                nodePath: "Game/Level/Goal/Collision",
                shapeKind: "BoxShape3D",
                disabled: false,
                bounds: { kind: "aabb3" as const, min: [-3, 0, -18.5], max: [3, 2, -12.5] },
                conservative: false,
                // Player z=-11.845 sits outside the goal bound starting at z=-12.5.
                containsPlayerOrigin: false,
              },
            ],
          },
        ],
      },
    ],
    coverage: {
      snapshots: 2,
      omittedSnapshots: 0,
      visitedNodes: 50,
      areas: 1,
      shapes: 1,
      skippedFreed: 0,
      truncated: false,
    },
  };
  const selected = selectNativeSpatial({
    stateSourceId: "sources",
    stateEvidenceDirectory: "builds/logs/scenarios-1",
    exportInputSourceId: "sources",
    scenarios: [run("full-run", spatial)],
  });
  expect(selected).not.toBeNull();
  const text = formatNativeWorld(selected!);
  const parsed = JSON.parse(text) as {
    scenarios: Array<{ id: string; snapshots: string[] }>;
    omitted: number;
    truncated: boolean;
  };
  expect(parsed.scenarios).toHaveLength(1);
  expect(parsed.scenarios[0]!.snapshots).toHaveLength(2);
  const [first, second] = parsed.scenarios[0]!.snapshots;
  expect(first).toContain("full-run");
  expect(first).toContain("frame=152");
  expect(second).toContain("frame=534");
  expect(second).toContain("player=[0,");
  expect(second).toContain("-11.8450021743774");
  expect(second).toContain("Game/Level/Goal");
  expect(second).toContain("min=[-3,0,-18.5]");
  expect(second).toContain("max=[3,2,-12.5]");
  expect(second).toContain("containsPlayerOrigin=false");
  expect(text).toContain("containsPlayerOrigin");
  expect(text).not.toMatch(/Collision/);
});

it("rolls shape origin tests up to the area level", () => {
  const areaOf = (contains: ReadonlyArray<boolean | null>, disabled = false) => ({
    nodePath: "Main/Zone",
    type: "Area2D" as const,
    monitoring: true,
    monitorable: true,
    visible: true,
    shapes: contains.map((value, index) => ({
      nodePath: `Main/Zone/S${index}`,
      shapeKind: "RectangleShape2D",
      disabled,
      bounds: { kind: "rect2" as const, min: [0, 0], max: [10, 10] },
      conservative: false,
      containsPlayerOrigin: value,
    })),
  });
  const spatialWith = (areas: ReturnType<typeof areaOf>[]): GameScenarioSpatial => ({
    snapshots: [
      {
        scenarioFrame: 30,
        step: null,
        player: { present: true, position: [4, 5], velocity: null, bodyKind: "Node2D" },
        areas,
      },
    ],
    coverage: {
      snapshots: 1,
      omittedSnapshots: 0,
      visitedNodes: 10,
      areas: areas.length,
      shapes: areas.reduce((total, area) => total + area.shapes.length, 0),
      skippedFreed: 0,
      truncated: false,
    },
  });
  const lineFor = (areas: ReturnType<typeof areaOf>[]) => {
    const selected = selectNativeSpatial({
      stateSourceId: "sources",
      stateEvidenceDirectory: "builds/logs/scenarios-1",
      exportInputSourceId: "sources",
      scenarios: [run("full-run", spatialWith(areas))],
    })!;
    const parsed = JSON.parse(formatNativeWorld(selected)) as {
      scenarios: Array<{ snapshots: string[] }>;
    };
    return parsed.scenarios[0]!.snapshots[0]!;
  };
  expect(lineFor([areaOf([false, false])])).toContain("containsPlayerOrigin=false");
  expect(lineFor([areaOf([false, true])])).toContain("containsPlayerOrigin=true");
  expect(lineFor([areaOf([false, null])])).toContain("containsPlayerOrigin=unknown");
  expect(lineFor([areaOf([false], true)]).toLowerCase()).toContain("unknown");
});

it("keeps monitoring and conservative signals at the area level", () => {
  const shapeOf = (conservative: boolean) => ({
    nodePath: "Main/Zone/S0",
    shapeKind: "RectangleShape2D",
    disabled: false,
    bounds: { kind: "rect2" as const, min: [0, 0], max: [10, 10] },
    conservative,
    containsPlayerOrigin: false as const,
  });
  const areaOf = (
    monitoring: boolean,
    shapes: ReturnType<typeof shapeOf>[],
  ): GameScenarioSpatial["snapshots"][number]["areas"][number] => ({
    nodePath: "Main/Zone",
    type: "Area2D",
    monitoring,
    monitorable: true,
    visible: true,
    shapes,
  });
  const spatialWith = (areas: ReturnType<typeof areaOf>): GameScenarioSpatial => ({
    snapshots: [
      {
        scenarioFrame: 30,
        step: null,
        player: { present: true, position: [4, 5], velocity: null, bodyKind: "Node2D" },
        areas: [areas],
      },
    ],
    coverage: {
      snapshots: 1,
      omittedSnapshots: 0,
      visitedNodes: 10,
      areas: 1,
      shapes: areas.shapes.length,
      skippedFreed: 0,
      truncated: false,
    },
  });
  const lineFor = (area: ReturnType<typeof areaOf>) => {
    const selected = selectNativeSpatial({
      stateSourceId: "sources",
      stateEvidenceDirectory: "builds/logs/scenarios-1",
      exportInputSourceId: "sources",
      scenarios: [run("full-run", spatialWith(area))],
    })!;
    const parsed = JSON.parse(formatNativeWorld(selected)) as {
      scenarios: Array<{ snapshots: string[] }>;
    };
    return parsed.scenarios[0]!.snapshots[0]!;
  };
  expect(lineFor(areaOf(true, [shapeOf(false)]))).not.toContain("monitoring=false");
  expect(lineFor(areaOf(true, [shapeOf(false)]))).not.toContain("conservative");
  expect(lineFor(areaOf(false, [shapeOf(false)]))).toContain("monitoring=false");
  expect(lineFor(areaOf(true, [shapeOf(true)]))).toContain("conservative");
});
