import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { GAME_SCENARIO_LIMITS, GameScenarioSummary, parseGameScenario } from "./gameScenario.ts";

const valid = () => ({
  id: "full-run",
  steps: [{ press: "ui_accept" }, { hold: ["move_right", "jump"], frames: 40 }, { wait: 10 }],
});
const decodeSummary = Schema.decodeUnknownSync(GameScenarioSummary);

describe("parseGameScenario", () => {
  it("accepts a small route and counts its frames", () => {
    const parsed = parseGameScenario(valid());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.frames).toBe(2 + 40 + 10);
  });

  it("rejects extra keys at the scenario and step level", () => {
    const scenario = { ...valid(), title: "Full run" };
    expect(parseGameScenario(scenario)).toMatchObject({ ok: false });
    const step = { id: "extra", steps: [{ hold: ["move_right"], frames: 10, speed: 2 }] };
    const parsed = parseGameScenario(step);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.join(" ")).toContain('unknown key "speed"');
  });

  it("rejects unknown step kinds and malformed actions", () => {
    expect(parseGameScenario({ id: "x", steps: [{ click: "left" }] }).ok).toBe(false);
    expect(parseGameScenario({ id: "x", steps: [{ press: "" }] }).ok).toBe(false);
    expect(parseGameScenario({ id: "x", steps: [{ hold: [], frames: 1 }] }).ok).toBe(false);
    expect(parseGameScenario({ id: "x", steps: [{ hold: ["move_right"], frames: 0 }] }).ok).toBe(
      false,
    );
    expect(parseGameScenario({ id: "x", steps: [{ wait: 1.5 }] }).ok).toBe(false);
  });

  it("rejects duplicate held actions and a repeated scenario id shape", () => {
    const duplicate = parseGameScenario({
      id: "x",
      steps: [{ hold: ["jump", "jump"], frames: 2 }],
    });
    expect(duplicate.ok).toBe(false);
    expect(parseGameScenario({ id: "Not A Slug", steps: [{ wait: 1 }] }).ok).toBe(false);
  });

  it("bounds frames, steps and actions per step", () => {
    const long = parseGameScenario({
      id: "x",
      steps: [{ hold: ["move_right"], frames: GAME_SCENARIO_LIMITS.maxFrames + 1 }],
    });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.issues.join(" ")).toContain("frames");

    const manySteps = Array.from({ length: GAME_SCENARIO_LIMITS.maxSteps + 1 }, () => ({
      wait: 1,
    }));
    expect(parseGameScenario({ id: "x", steps: manySteps }).ok).toBe(false);

    const manyActions = {
      id: "x",
      steps: [
        {
          hold: Array.from(
            { length: GAME_SCENARIO_LIMITS.maxActionsPerStep + 1 },
            (_, index) => `action_${index}`,
          ),
          frames: 1,
        },
      ],
    };
    expect(parseGameScenario(manyActions).ok).toBe(false);
  });
});

describe("GameScenarioSummary", () => {
  it("still decodes a historical win-criterion-failed record", () => {
    const summary = decodeSummary({
      mode: "criteria",
      passed: false,
      reason: "win-criterion-failed",
      detail: "A win was required by an older exam.",
      criteria: [],
    });
    expect(summary.reason).toBe("win-criterion-failed");
  });

  it("decodes both an old no-loss missing result and the not-applicable result", () => {
    const summary = (status: "missing" | "not-applicable") =>
      decodeSummary({
        mode: "criteria",
        passed: true,
        reason: "criteria-passed",
        detail: "Every applicable approved criterion was proven after play started.",
        criteria: [
          {
            id: "never-fails",
            kind: "lose",
            text: "The conversation never ends in failure",
            status,
            observed: "The design declares no losing state.",
            scenarios: [],
            provenBy: null,
          },
        ],
        coverage: [{ kind: "lose", proven: 0, failed: 0, missing: 0 }],
      });

    // Records written before this status existed keep decoding exactly as they
    // were stored; the stage remains a pass.
    expect(summary("missing").criteria[0]?.status).toBe("missing");
    expect(summary("not-applicable").criteria[0]?.status).toBe("not-applicable");
  });
});
