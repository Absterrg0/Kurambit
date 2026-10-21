// @effect-diagnostics nodeBuiltinImport:off -- the fixture builds a real no-build folder on disk.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { LoadedGameBenchmarkBrief } from "./game-benchmark/artifacts.ts";
import { CONTROL_DESCRIPTION, gradeGame, judgeObligations, type ReviewFn } from "./game-grade.ts";

const brief: LoadedGameBenchmarkBrief = {
  id: "fixture",
  title: "Fixture",
  template: "blank",
  brief: "A tiny platformer: run right and reach the flag.",
  artDirection: "Warm dawn, one bright flag.",
  obligations: [
    { id: "reach-flag", kind: "win", description: "The player reaches the flag." },
    { id: "jump", kind: "control", description: "Pressing space makes the player jump." },
  ],
  path: "/fixtures/fixture.json",
  checksum: "checksum",
};

const frames = [{ id: "F1", path: "/frames/f1.png", label: "after step 1" }];

const reply = (verdict: "YES" | "NO") => ({
  verdict,
  frame: verdict === "YES" ? "F1" : "",
  reason: "because",
});

/** Answers in the exact order the grader asks: obligation A (2), B (2), control (2). */
const scripted = (replies: ReadonlyArray<"YES" | "NO">) => {
  let calls = 0;
  const review: ReviewFn = async () => {
    const answer = replies[calls];
    calls += 1;
    if (answer === undefined)
      throw new Error("The grader asked more questions than the fixture scripted.");
    return reply(answer);
  };
  return { review, calls: () => calls };
};

describe("judgeObligations", () => {
  it("requires both votes: one NO is a NO", async () => {
    const fake = scripted(["YES", "NO", "YES", "YES", "NO", "NO"]);
    const judged = await judgeObligations({ brief, frames, notes: ["note"], review: fake.review });
    assert.equal(fake.calls(), 6);
    assert.deepStrictEqual(
      judged.obligations.map((obligation) => [obligation.id, obligation.yes]),
      [
        ["reach-flag", false],
        ["jump", true],
      ],
    );
    assert.equal(judged.void, false);
  });

  it("voids the grade when the absurd control item gets a YES", async () => {
    const fake = scripted(["YES", "YES", "NO", "NO", "YES", "NO"]);
    const judged = await judgeObligations({ brief, frames, notes: [], review: fake.review });
    assert.equal(judged.control.description, CONTROL_DESCRIPTION);
    assert.equal(judged.control.yes, true);
    assert.equal(judged.void, true);
  });

  it("answers NO without a model call when no frames were captured", async () => {
    let called = false;
    const review: ReviewFn = async () => {
      called = true;
      return reply("YES");
    };
    const judged = await judgeObligations({ brief, frames: [], notes: [], review });
    assert.equal(called, false);
    assert.equal(judged.solCalls, 0);
    assert.equal(
      judged.obligations.every((obligation) => !obligation.yes),
      true,
    );
    assert.equal(judged.void, false);
  });

  it("drops a cited frame the grader did not send", async () => {
    const review: ReviewFn = async () => ({ verdict: "YES", frame: "F9", reason: "no idea" });
    const judged = await judgeObligations({ brief, frames, notes: [], review });
    assert.equal(judged.obligations[0]?.votes[0]?.frame, null);
  });
});

describe("gradeGame", () => {
  it("writes a typed no-build without spending a model call", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-grade-test-"));
    try {
      const gameDir = NodePath.join(directory, "game");
      await NodeFSP.mkdir(gameDir, { recursive: true });
      const out = NodePath.join(directory, "out");
      let reviewed = false;
      const grade = await gradeGame({
        gameDir,
        brief,
        out,
        deps: {
          exportBuild: async () => ({ ok: false, detail: "no godot project" }),
          review: async () => {
            reviewed = true;
            return reply("YES");
          },
          playtest: async () => {
            throw new Error("a no-build must not playtest");
          },
        },
      });
      assert.equal(grade.build.kind, "no-build");
      assert.equal(grade.build.detail, "no godot project");
      assert.equal(grade.quick, null);
      assert.equal(grade.solCalls, 0);
      assert.equal(reviewed, false);
      assert.equal(
        grade.obligations.every((obligation) => !obligation.yes),
        true,
      );
      const written = JSON.parse(
        await NodeFSP.readFile(NodePath.join(out, "grade.json"), "utf8"),
      ) as { build: { kind: string } };
      assert.equal(written.build.kind, "no-build");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
