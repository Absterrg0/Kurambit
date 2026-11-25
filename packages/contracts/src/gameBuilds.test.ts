import { describe, expect, it } from "@effect/vitest";

import * as Schema from "effect/Schema";

import { diffBuildFacts, GameBuildFacts, GameBuildId, gameFactsView } from "./gameBuilds.ts";

const tier = (ending: "won" | "lost" | "no-ending", at: number | null) => ({
  status: "measured" as const,
  value: { ending, at, played: 60, note: "", evidence: null },
});

const facts = (patch: Partial<GameBuildFacts> = {}): GameBuildFacts => ({
  build: GameBuildId.make("a".repeat(40)),
  key: "godot:" + "b".repeat(40),
  harness: "h1",
  state: "measured",
  measuredAt: null,
  renderer: null,
  boots: { status: "measured", value: { ok: true, detail: "boot clean" } },
  masher: tier("won", 8),
  use: { status: "not-measured", why: "not built", retry: false },
  performance: { status: "not-measured", why: "ffmpeg failed", retry: true },
  qa: { status: "pending" },
  screens: { status: "not-measured", why: "not built", retry: false },
  player: { status: "not-measured", why: "not built", retry: false },
  savedPlays: {
    status: "not-measured",
    why: "no saved play was replayed on this build",
    cause: "no-saved-plays",
    retry: false,
  },
  message: "",
  ...patch,
});

const encodeFacts = Schema.encodeSync(GameBuildFacts);
const decodeFacts = Schema.decodeUnknownSync(GameBuildFacts);

const byId = (deltas: ReturnType<typeof diffBuildFacts>) =>
  Object.fromEntries(deltas.map((delta) => [delta.id, delta]));

describe("diffBuildFacts", () => {
  it("never calls an unmeasured or pending fact the same", () => {
    const deltas = byId(diffBuildFacts(facts(), facts()));
    expect(deltas["performance"]?.change).toBe("not-comparable");
    expect(deltas["performance"]?.why).toContain("ffmpeg failed");
    expect(deltas["controls"]?.change).toBe("not-comparable");
    expect(deltas["boots"]?.change).toBe("same");
  });

  it("compares nothing across harness versions", () => {
    const other = facts({ harness: "h2" });
    expect(diffBuildFacts(facts(), other).every((d) => d.change === "not-comparable")).toBe(true);
  });

  it("has no reading for a build never measured", () => {
    expect(diffBuildFacts(null, facts()).every((d) => d.change === "not-comparable")).toBe(true);
  });
});

describe("gameFactsView", () => {
  it("says why a fact was not measured and shows no evidence for it", () => {
    const rows = Object.fromEntries(gameFactsView(facts()).map((row) => [row.id, row]));
    expect(rows["performance"]?.reading).toEqual({ _tag: "not-measured", why: "ffmpeg failed" });
    expect(rows["performance"]?.evidence).toEqual([]);
    expect(rows["controls"]?.reading).toEqual({ _tag: "pending" });
  });

  it("reads a row stored with the facts no longer measured", () => {
    const { player: _notYet, ...stored } = encodeFacts(facts());
    const old = {
      ...stored,
      idle: tier("lost", 30),
      liveness: { status: "pending" },
      scene: { status: "not-measured", why: "old", retry: false },
    };
    const decoded = decodeFacts(old);
    expect(gameFactsView(decoded).map((row) => row.id)).toEqual([
      "boots",
      "errors",
      "controls",
      "retry",
      "hud",
      "performance",
      "screens",
      "first-minute",
    ]);
    // Stored before the first minute was measured: it says so, never a pass.
    expect(gameFactsView(decoded).find((row) => row.id === "first-minute")?.reading).toEqual({
      _tag: "not-measured",
      why: "measured before the first minute was measured",
    });
  });

  it("reads a performance row from before draw counts as it read then", () => {
    const value = { fps: 58.2, low1: 41, gpuMs: 9.04, scale: 0.8, width: 1280, height: 720 };
    const old = decodeFacts({
      ...encodeFacts(facts()),
      performance: { status: "measured", value: { ...value, frames: 3400 } },
    });
    const text = (decoded: GameBuildFacts) => {
      const row = gameFactsView(decoded).find((each) => each.id === "performance");
      return row?.reading._tag === "measured" ? row.reading.text : null;
    };
    expect(text(old)).toBe("58 fps · 1% low 41 · GPU 9.0 ms at 0.8× of 1280×720");
    const counted = facts({
      performance: {
        status: "measured",
        value: { ...value, frames: 3400, drawCalls: 1900, triangles: 2_140_000 },
      },
    });
    expect(text(counted)).toBe(
      "58 fps · 1% low 41 · GPU 9.0 ms at 0.8× of 1280×720 · 1,900 draw calls · 2.1M triangles",
    );
    const software = facts({
      performance: {
        status: "measured",
        value: {
          ...value,
          fps: null,
          low1: null,
          gpuMs: null,
          scale: null,
          frames: 300,
          drawCalls: 41,
          triangles: 52_000,
        },
      },
    });
    expect(text(software)).toBe(
      "Frame rate not measured (drawn in software) · 41 draw calls · 52k triangles",
    );
  });
});
