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
  skilled: {
    status: "measured",
    value: {
      ...tier("won", 40).value,
      bot: { file: ".studio/bot/win.mjs", hash: "x" },
      botWord: null,
    },
  },
  use: { status: "not-measured", why: "not built", retry: false },
  performance: { status: "not-measured", why: "ffmpeg failed", retry: true },
  qa: { status: "pending" },
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

  it("compares nothing across harness versions or different play bots", () => {
    const other = facts({ harness: "h2" });
    expect(diffBuildFacts(facts(), other).every((d) => d.change === "not-comparable")).toBe(true);
    const skilled = facts().skilled;
    if (skilled.status !== "measured") throw new Error("fixture");
    const newBot = facts({
      skilled: {
        status: "measured",
        value: { ...skilled.value, bot: { ...skilled.value.bot, hash: "y" } },
      },
    });
    expect(byId(diffBuildFacts(facts(), newBot))["skilled"]?.change).toBe("not-comparable");
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
    const old = {
      ...encodeFacts(facts()),
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
      "skilled",
    ]);
  });
});
