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
  idle: tier("lost", 30),
  masher: tier("won", 8),
  skilled: {
    status: "measured",
    value: {
      ...tier("won", 40).value,
      bot: { file: ".studio/bot/win.mjs", hash: "x", decider: "policy" },
      botWord: null,
    },
  },
  winnableWithoutSkill: { status: "measured", value: true },
  liveness: { status: "not-measured", why: "ffmpeg failed", retry: true },
  firstResponse: { status: "pending" },
  assets: { status: "not-measured", why: "not built", retry: false },
  use: { status: "not-measured", why: "not built", retry: false },
  performance: { status: "not-measured", why: "not built", retry: false },
  message: "",
  ...patch,
});

const byId = (deltas: ReturnType<typeof diffBuildFacts>) =>
  Object.fromEntries(deltas.map((delta) => [delta.id, delta]));

describe("diffBuildFacts", () => {
  it("never calls an unmeasured or pending fact the same", () => {
    const deltas = byId(diffBuildFacts(facts(), facts()));
    expect(deltas["motion"]?.change).toBe("not-comparable");
    expect(deltas["motion"]?.why).toContain("ffmpeg failed");
    expect(deltas["first-response"]?.change).toBe("not-comparable");
    expect(deltas["boots"]?.change).toBe("same");
  });

  it("compares nothing across harness versions or different tester bots", () => {
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

  it("reads a masher that stops winning as better", () => {
    const fixed = facts({
      masher: tier("lost", 20),
      winnableWithoutSkill: { status: "measured", value: false },
    });
    const deltas = byId(diffBuildFacts(facts(), fixed));
    expect(deltas["masher"]).toMatchObject({ change: "changed", tone: "better" });
    expect(deltas["winnable-without-skill"]).toMatchObject({ change: "changed", tone: "better" });
  });

  it("has no reading for a build never measured", () => {
    expect(diffBuildFacts(null, facts()).every((d) => d.change === "not-comparable")).toBe(true);
  });
});

describe("gameFactsView", () => {
  it("says why a fact was not measured and shows no evidence for it", () => {
    const rows = Object.fromEntries(gameFactsView(facts()).map((row) => [row.id, row]));
    expect(rows["motion"]?.reading).toEqual({ _tag: "not-measured", why: "ffmpeg failed" });
    expect(rows["motion"]?.evidence).toEqual([]);
    expect(rows["first-response"]?.reading).toEqual({ _tag: "pending" });
  });
});

describe("assets", () => {
  const model = (status: "measured" | "not-measured") => ({
    path: "web/assets/blender/cat.glb",
    triangles: 1,
    bytes: 1,
    maxTextureSide: 64,
    skeleton: null,
    clips: 0,
    pipeline:
      status === "measured"
        ? {
            status,
            sidecar: "web/assets/blender/cat.asset.json",
            kind: "prop" as const,
            height: 1,
            reviewedAt: "2026-11-07T00:00:00.000Z",
            groundSpeeds: [],
            seamsBroken: [],
            drifting: [],
            source: {
              route: "blender" as const,
              parts: [
                { what: "parts" as const, from: "made", licence: "", ai: false, credits: null },
              ],
              standIn: null,
              concept: null,
            },
          }
        : { status, why: "no sidecar: not exported through the pipeline", retry: false },
  });
  const assets = (...models: ReturnType<typeof model>[]) =>
    facts({ assets: { status: "measured", value: { models, more: 0, libraryFiles: 3 } } });

  it("is never better or worse, and a row written before it decodes as not measured", () => {
    const row = Object.fromEntries(
      gameFactsView(assets(model("measured"), model("not-measured"))).map((r) => [r.id, r]),
    )["assets"];
    expect(row?.reading).toEqual({
      _tag: "measured",
      text: "1 made model measured, 1 not measured",
      value: 1,
      tone: "neutral",
    });
    const delta = byId(diffBuildFacts(assets(), assets(model("measured"))))["assets"];
    expect(delta).toMatchObject({ change: "changed", tone: "neutral" });

    const { assets: _, ...old } = Schema.encodeSync(GameBuildFacts)(facts());
    expect(Schema.decodeSync(GameBuildFacts)(old).assets).toEqual({
      status: "not-measured",
      why: "measured before asset facts existed",
      retry: false,
    });
  });
});
