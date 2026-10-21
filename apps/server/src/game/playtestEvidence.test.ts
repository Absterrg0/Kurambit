// @effect-diagnostics globalDate:off globalDateInEffect:off -- Fixed timestamps make retention order deterministic.
// @effect-diagnostics nodeBuiltinImport:off -- Real temporary folders prove the evidence layout and retention rule.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type { GameWebPlaytestResult } from "@t3tools/contracts";
import { readLastPlaytest, writePlaytestEvidence } from "./playtestEvidence.ts";

const result = (label: string): GameWebPlaytestResult => ({
  success: true,
  booted: true,
  bootMs: 1200,
  responded: true,
  changedPercent: 12.5,
  message: "Playtest succeeded",
  consoleMessages: [{ level: "error", text: "boom" }],
  screenshots: [
    { label: "booted", mimeType: "image/png", data: "cG5n", width: 960, height: 540 },
    { label, mimeType: "image/png", data: "cG5n", width: 960, height: 540 },
  ],
  state: null,
});

it.live("keeps the newest five playtest runs and reads the last verdict", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "playtest-evidence-")),
    );
    try {
      for (let run = 0; run < 6; run++) {
        const at = new Date(Date.UTC(2026, 9, 20, 12, run, 0));
        const written = yield* Effect.promise(() =>
          writePlaytestEvidence({
            root,
            steps: [{ key: "w", holdMs: 100 }],
            result: result("after-steps"),
            at,
          }),
        );
        expect(written.directory).toMatch(/^builds\/playtests\//);
      }
      const runs = (yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.join(root, "builds/playtests")),
      )).sort();
      expect(runs).toHaveLength(5);
      expect(runs[0]).toContain("T12-01-00");
      expect(runs.at(-1)).toContain("T12-05-00");

      const last = yield* Effect.promise(() =>
        readLastPlaytest(root, [{ target: "Web", updatedAt: "2026-10-20T12:04:30.000Z" }]),
      );
      expect(last).toMatchObject({
        success: true,
        responded: true,
        changedPercent: 12.5,
        consoleErrorCount: 1,
        stale: false,
      });
      expect(last?.frames.map((frame) => frame.label)).toEqual(["booted", "after-steps"]);
      for (const frame of last?.frames ?? [])
        expect(
          yield* Effect.promise(() => NodeFSP.stat(NodePath.join(root, frame.path))),
        ).toBeDefined();

      const stale = yield* Effect.promise(() =>
        readLastPlaytest(root, [{ target: "Web", updatedAt: "2026-10-20T12:05:30.000Z" }]),
      );
      expect(stale?.stale).toBe(true);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
    }
  }),
);

it.live("picks last run's cover from the per-frame probe state it persisted", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "playtest-cover-")),
    );
    const acceptance = [
      {
        id: "pickup",
        kind: "content" as const,
        text: "collect a pearl",
        observe: { key: "collected", expect: ">=1" },
      },
    ];
    try {
      const written = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root,
          steps: [{ click: "left" }, { key: "Enter", holdMs: 80 }, { waitMs: 800 }],
          result: {
            ...result("pose"),
            qualifies: true,
            blockers: [],
            interaction: "collected 0→1, player moved 24",
            baseViewport: { width: 640, height: 360 },
            captureScale: 2,
            state: {
              before: { gameState: { state: 1, collected: 0 }, player: { x: 0, y: 2, z: 4 } },
              after: { gameState: { state: 1, collected: 1 }, player: { x: 4, y: 6, z: 8 } },
              playerMoved: 24,
              changes: [
                { key: "collected", before: 0, after: 1 },
                { key: "run_seconds", before: 0.2, after: 6.4 },
              ],
            },
            screenshots: [
              {
                label: "booted",
                mimeType: "image/png",
                data: "cG5n",
                width: 1280,
                height: 720,
              },
              {
                label: "menu",
                mimeType: "image/png",
                data: "cG5n",
                width: 1280,
                height: 720,
                probe: { gameState: { state: 1, collected: 0 }, player: { x: 0, y: 2, z: 4 } },
              },
              {
                label: "pose",
                mimeType: "image/png",
                data: "cG5n",
                width: 1280,
                height: 720,
                probe: { gameState: { state: 1, collected: 1 }, player: { x: 4, y: 6, z: 8 } },
              },
            ],
          },
        }),
      );
      const last = yield* Effect.promise(() => readLastPlaytest(root, [], acceptance));
      // The persisted per-frame probe decides: the frame whose own state shows
      // the approved criterion progressing, not a caption.
      expect(last?.coverFrame).toMatchObject({
        label: "pose",
        path: `${written.directory}/03-pose.png`,
        probe: { gameState: { collected: 1 } },
      });
      // Without the exam, the same run still proves movement on screen.
      const noAcceptance = yield* Effect.promise(() => readLastPlaytest(root, [], null));
      expect(noAcceptance?.coverFrame?.label).toBe("pose");

      const raw = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, written.directory, "result.json"), "utf8"),
        ),
      );
      expect(raw).toMatchObject({
        qualifies: true,
        interaction: "collected 0→1, player moved 24",
        baseWidth: 640,
        baseHeight: 360,
        captureScale: 2,
      });
      expect(raw.frames[2]).toMatchObject({
        label: "pose",
        probe: { gameState: { collected: 1 } },
      });
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
    }
  }),
);
