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
