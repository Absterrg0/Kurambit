// The bounds every game tool answer keeps (TOOLS.md): what an agent reads first fits its cap,
// says what it cut, and a refusal names its cause in at most REFUSAL_MOST characters.
import { describe, expect, it } from "@effect/vitest";
import { GameOperationError } from "@kurambit/contracts";
import { foldFindings, present, refusal, REFUSAL_MOST, resultCap, resultText } from "./results.ts";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("game tool results", () => {
  it("fold findings that differ only in their numbers", () => {
    const lines = Array.from(
      { length: 16 },
      (_, i) => `Player out of world at (3, -0, ${2000 + i})`,
    );
    expect(foldFindings([...lines, "Stalled for 120 s"])).toEqual([
      "Player out of world at (3, -0, 2000) ×16",
      "Stalled for 120 s",
    ]);
  });

  it("keep each op's text within its cap and name what was cut", () => {
    const details = {
      frames: Array.from({ length: 400 }, (_, i) => `builds/logs/run/frame-${i}.png`),
      message: "x".repeat(9_000),
      screenshots: [{ mimeType: "image/png", width: 1280, height: 720 }],
    };
    for (const [tool, op] of [
      ["game_check", "look"],
      ["game_check", "final"],
      ["game_play", "bot"],
    ] as const) {
      const shown = present(tool, op, { line: "ok", next: "none." }, details);
      const text = resultText(shown);
      expect(bytes(text)).toBeLessThanOrEqual(resultCap(tool, op) + 400);
      expect(text.startsWith(`${tool} ${op}: ok\nnext: none.`)).toBe(true);
      expect(shown.omitted).toEqual(expect.arrayContaining([expect.stringContaining("frames")]));
      expect(shown.screenshots).toEqual(details.screenshots);
    }
  });

  it("refuse in at most REFUSAL_MOST characters with the real cause, never a generic preamble", () => {
    const closed = refusal(
      new GameOperationError({
        operation: "explore-close",
        path: "",
        reason: "invalid-input",
        detail:
          "That exploration session is closed or expired; start a new one with game_play op act. " +
          "Y".repeat(3_000),
      }),
    );
    expect(closed.refused).toBe(
      "That exploration session is closed or expired; start a new one with game_play op act.",
    );
    expect(closed.refused).not.toContain("shrink");
    expect(bytes(JSON.stringify(closed))).toBeLessThanOrEqual(REFUSAL_MOST);
    const busy = refusal(new GameOperationError({ operation: "x", path: "", reason: "busy" }));
    expect(`${busy.refused} ${busy.next}`).toMatch(/wait/i);
  });
});
