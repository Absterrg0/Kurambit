import { expect, it } from "vite-plus/test";
import {
  decodeScenarioEvidence,
  sanitizeScenarioSpatial,
  scenarioRequestJson,
} from "./gameScenarios.ts";
import type { GameScenarioEvidence, GameScenarioSpatial } from "@t3tools/contracts";

const evidence = (overrides: Partial<GameScenarioEvidence> = {}): GameScenarioEvidence => ({
  id: "full-run",
  frames: 120,
  durationMs: 2000,
  firstInputFrame: 30,
  baselineFrame: 36,
  playerMoved: true,
  error: null,
  invalidActions: [],
  observations: [],
  ...overrides,
});

const spatial2d = (): GameScenarioSpatial => ({
  snapshots: [
    {
      scenarioFrame: 30,
      step: null,
      player: {
        present: true,
        position: [100, 200],
        velocity: [0, 0],
        bodyKind: "CharacterBody2D",
      },
      areas: [
        {
          nodePath: "Main/Zone",
          type: "Area2D",
          monitoring: true,
          monitorable: true,
          visible: true,
          shapes: [
            {
              nodePath: "Main/Zone/Shape",
              shapeKind: "RectangleShape2D",
              disabled: false,
              bounds: { kind: "rect2", min: [90, 190], max: [210, 250] },
              conservative: false,
              containsPlayerOrigin: true,
            },
          ],
        },
      ],
    },
  ],
  coverage: {
    snapshots: 1,
    omittedSnapshots: 0,
    visitedNodes: 42,
    areas: 1,
    shapes: 1,
    skippedFreed: 0,
    truncated: false,
  },
});

const spatial3d = (): GameScenarioSpatial => ({
  snapshots: [
    {
      scenarioFrame: 66,
      step: 1,
      player: {
        present: true,
        position: [1, 2, 3],
        velocity: [0, 0, 0],
        bodyKind: "CharacterBody3D",
      },
      areas: [
        {
          nodePath: "Main/Nested/Zone3D",
          type: "Area3D",
          monitoring: true,
          monitorable: false,
          visible: true,
          shapes: [
            {
              nodePath: "Main/Nested/Zone3D/Box",
              shapeKind: "BoxShape3D",
              disabled: false,
              bounds: { kind: "aabb3", min: [0, 0, 0], max: [4, 4, 4] },
              conservative: false,
              containsPlayerOrigin: true,
            },
            {
              nodePath: "Main/Nested/Zone3D/Ball",
              shapeKind: "SphereShape3D",
              disabled: false,
              bounds: { kind: "aabb3", min: [-1, -1, -1], max: [1, 1, 1] },
              conservative: true,
              containsPlayerOrigin: false,
            },
          ],
        },
      ],
    },
  ],
  coverage: {
    snapshots: 1,
    omittedSnapshots: 0,
    visitedNodes: 80,
    areas: 1,
    shapes: 2,
    skippedFreed: 1,
    truncated: false,
  },
});

it("malformed optional spatial diagnostics never invalidate measured scenario results", () => {
  const result = decodeScenarioEvidence(
    JSON.stringify({
      ...evidence(),
      spatial: { snapshots: "unreadable", coverage: null },
    }),
  );
  expect(result).toEqual(evidence());
});

it("passes recordSpatial through the runner request only when asked", () => {
  const base = {
    scenarioPath: "/tmp/scenario.json",
    observations: [],
    sampleEvery: 6,
    bootFrames: 30,
  };
  expect(JSON.parse(scenarioRequestJson(base))).not.toHaveProperty("recordSpatial");
  expect(JSON.parse(scenarioRequestJson({ ...base, recordSpatial: true }))).toMatchObject({
    recordSpatial: true,
  });
  // Off stays byte-compatible for calibration/capture/test users.
  expect(JSON.parse(scenarioRequestJson({ ...base, recordLayout: true }))).not.toHaveProperty(
    "recordSpatial",
  );
});

it("decodes evidence written before spatial snapshots existed", () => {
  const decoded = decodeScenarioEvidence(
    JSON.stringify({
      id: "full-run",
      frames: 120,
      durationMs: 2000,
      firstInputFrame: 30,
      baselineFrame: 36,
      playerMoved: true,
      error: null,
      invalidActions: [],
      observations: [],
    }),
  );
  expect(decoded).not.toBeNull();
  expect(decoded?.spatial).toBeUndefined();
});

it("keeps generic 2D and 3D translated-nesting shapes", () => {
  expect(sanitizeScenarioSpatial(spatial2d()))?.toMatchObject({
    snapshots: [{ player: { present: true }, areas: [{ type: "Area2D" }] }],
  });
  const kept3d = sanitizeScenarioSpatial(spatial3d());
  expect(kept3d?.snapshots[0]?.areas[0]?.type).toBe("Area3D");
  expect(kept3d?.snapshots[0]?.areas[0]?.shapes).toHaveLength(2);
  expect(kept3d?.coverage.shapes).toBe(2);
});

it("bounds counts, truncates overflow, and requires finite coords", () => {
  const many = (count: number) => ({
    nodePath: "Main/Zone",
    type: "Area2D" as const,
    monitoring: true,
    monitorable: true,
    visible: true,
    shapes: Array.from({ length: count }, (_, index) => ({
      nodePath: `Main/Zone/S${index}`,
      shapeKind: "RectangleShape2D",
      disabled: false,
      bounds: { kind: "rect2" as const, min: [0, 0], max: [10, 10] },
      conservative: false,
      containsPlayerOrigin: false,
    })),
  });
  const oversized: unknown = {
    snapshots: Array.from({ length: 9 }, (_, index) => ({
      scenarioFrame: index,
      step: null,
      player: { present: false, position: null, velocity: null, bodyKind: null },
      areas: [many(9)],
    })),
    coverage: {
      snapshots: 9,
      omittedSnapshots: 0,
      visitedNodes: 9_999,
      areas: 81,
      shapes: 81,
      skippedFreed: 0,
      truncated: false,
    },
  };
  const kept = sanitizeScenarioSpatial(oversized);
  expect(kept).toBeDefined();
  expect(kept!.snapshots.length).toBeLessThanOrEqual(4);
  const totalShapes = kept!.snapshots.flatMap((snapshot) =>
    snapshot.areas.flatMap((area) => area.shapes),
  ).length;
  expect(totalShapes).toBeLessThanOrEqual(32);
  expect(kept!.coverage.truncated).toBe(true);
  // Non-finite coordinates never persist: the shape is dropped as unknown.
  const nonFinite: unknown = {
    snapshots: [
      {
        scenarioFrame: 1,
        step: null,
        player: { present: true, position: [Number.NaN, 0], velocity: null, bodyKind: "Node2D" },
        areas: [],
      },
    ],
    coverage: {
      snapshots: 1,
      omittedSnapshots: 0,
      visitedNodes: 10,
      areas: 0,
      shapes: 0,
      skippedFreed: 0,
      truncated: false,
    },
  };
  expect(sanitizeScenarioSpatial(nonFinite)).toBeUndefined();
});

it("drops malformed or oversized spatial instead of persisting it", () => {
  expect(sanitizeScenarioSpatial(null)).toBeUndefined();
  expect(sanitizeScenarioSpatial({ snapshots: "nope" })).toBeUndefined();
  expect(sanitizeScenarioSpatial({ snapshots: [], coverage: { snapshots: 1 } })).toBeUndefined();
  // Unsupported shape kinds persist as explicit unknown, not as dropped areas.
  const unknownKind: unknown = {
    snapshots: [
      {
        scenarioFrame: 5,
        step: 0,
        player: { present: false, position: null, velocity: null, bodyKind: null },
        areas: [
          {
            nodePath: "Main/Zone",
            type: "Area2D",
            monitoring: true,
            monitorable: true,
            visible: true,
            shapes: [
              {
                nodePath: "Main/Zone/Poly",
                shapeKind: "ConcavePolygonShape2D",
                disabled: false,
                bounds: { kind: "unknown", min: null, max: null },
                conservative: true,
                containsPlayerOrigin: null,
              },
            ],
          },
        ],
      },
    ],
    coverage: {
      snapshots: 1,
      omittedSnapshots: 0,
      visitedNodes: 20,
      areas: 1,
      shapes: 1,
      skippedFreed: 0,
      truncated: false,
    },
  };
  expect(sanitizeScenarioSpatial(unknownKind)?.snapshots[0]?.areas[0]?.shapes[0]?.bounds.kind).toBe(
    "unknown",
  );
});

it("leaves observations and error bytes untouched when spatial rides along", () => {
  const run = evidence({
    observations: [
      {
        key: "ticks",
        min: 0,
        max: 4,
        first: 0,
        last: 4,
        firstChangeFrame: 40,
        baseline: 0,
        matches: [{ id: "move", frame: 72 }],
      },
    ],
    spatial: spatial2d(),
  });
  const decoded = decodeScenarioEvidence(JSON.stringify(JSON.parse(JSON.stringify(run))));
  expect(decoded?.observations).toHaveLength(1);
  expect(decoded?.spatial?.snapshots).toHaveLength(1);
  expect(sanitizeScenarioSpatial(decoded?.spatial)?.coverage.snapshots).toBe(1);
});
