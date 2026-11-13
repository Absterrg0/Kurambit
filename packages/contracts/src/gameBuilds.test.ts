import { describe, expect, it } from "@effect/vitest";

import * as Schema from "effect/Schema";

import { diffBuildFacts, GameBuildFacts, GameBuildId, gameFactsView } from "./gameBuilds.ts";
import type { GameSceneFinding } from "./gameScene.ts";

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
      bot: { file: ".studio/bot/win.mjs", hash: "x" },
      botWord: null,
    },
  },
  winnableWithoutSkill: { status: "measured", value: true },
  liveness: { status: "not-measured", why: "ffmpeg failed", retry: true },
  firstResponse: { status: "pending" },
  assets: { status: "not-measured", why: "not built", retry: false },
  use: { status: "not-measured", why: "not built", retry: false },
  performance: { status: "not-measured", why: "not built", retry: false },
  scene: { status: "not-measured", why: "not built", retry: false },
  message: "",
  ...patch,
});

const encodeFacts = Schema.encodeSync(GameBuildFacts);
const decodeFacts = Schema.decodeSync(GameBuildFacts);

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

    const { assets: _, ...old } = encodeFacts(facts());
    expect(decodeFacts(old).assets).toEqual({
      status: "not-measured",
      why: "measured before asset facts existed",
      retry: false,
    });
  });
});

describe("scene", () => {
  const scene = (findings: ReadonlyArray<GameSceneFinding>) =>
    facts({
      scene: {
        status: "measured",
        value: {
          seconds: 58,
          findings,
          player: {
            kind: "body",
            name: "Fox",
            hidden: 0.96,
            offscreen: 0,
            blocker: "Ground",
            heightPx: 98,
            canvasHeight: 720,
            notVisible: true,
            small: false,
            frame: "builds/logs/x/scene-1.png",
            smallFrame: null,
          },
          unseen: [],
          unseenMore: 0,
          cost: { meanMs: 1, worstMs: 3 },
        },
      },
    });
  const buried: GameSceneFinding = {
    kind: "buried",
    thing: "Fox",
    other: "Ground",
    at: 0.3,
    seconds: 58,
    share: 1,
    amount: 1.03,
    frame: "builds/logs/x/scene-2.png",
  };

  it("words each problem with its frame, worse than clean, and reads old rows as not measured", () => {
    const rows = Object.fromEntries(gameFactsView(scene([buried])).map((r) => [r.id, r]));
    expect(rows["buried"]?.reading).toMatchObject({
      text: "Fox is buried 1.0 m in Ground for 100% of play",
      tone: "bad",
    });
    expect(rows["buried"]?.evidence).toEqual([
      {
        kind: "frame",
        label: "Fox is buried 1.0 m in Ground for 100% of play",
        path: buried.frame,
      },
    ]);
    expect(rows["player-view"]?.reading).toMatchObject({
      text: "Fox is hidden behind Ground for 96% of play",
      tone: "bad",
    });
    expect(rows["clipping"]?.reading).toMatchObject({ tone: "good" });
    expect(byId(diffBuildFacts(scene([]), scene([buried])))["buried"]).toMatchObject({
      change: "changed",
      tone: "worse",
    });

    const { scene: _, ...old } = encodeFacts(facts());
    expect(decodeFacts(old).scene).toEqual({
      status: "not-measured",
      why: "measured before scene reports existed",
      retry: false,
    });
  });
});
