// @effect-diagnostics nodeBuiltinImport:off -- the fixture builds a real no-build folder on disk.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { LoadedGameBenchmarkBrief } from "./game-benchmark/artifacts.ts";
import {
  chooseFrames,
  clampHoldMs,
  CONTROL_DESCRIPTION,
  decodeActions,
  decodeVerdict,
  gradeGame,
  judgeObligations,
  makeOpenCodeReviewer,
  OPENCODE_GRADER_FALLBACK_MODEL,
  OPENCODE_GRADER_MODEL,
  type OpenCodeRun,
  type ReviewFn,
} from "./game-grade.ts";

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

describe("clampHoldMs", () => {
  it("keeps a long hold long enough for a game that counts three seconds", () => {
    // The dialogue game needs LISTEN_SECONDS := 3.0 of held L, and it counts
    // the frames it saw the key down, so the wall-clock hold has to be longer.
    assert.equal(clampHoldMs(3_000), 3_000);
    assert.equal(clampHoldMs(5_000), 5_000);
  });

  it("caps a hold at eight seconds and never sends a tap", () => {
    assert.equal(clampHoldMs(20_000), 8_000);
    assert.equal(clampHoldMs(0), 50);
  });
});

describe("chooseFrames", () => {
  const boot = { id: "F1", path: "/frames/boot.png", label: "boot, no input" };
  const steps = (count: number, reloadAfter: ReadonlyArray<number> = []) =>
    Array.from({ length: count }, (_, index) => ({
      path: `/frames/step-${String(index + 1).padStart(2, "0")}.png`,
      note: `note ${index + 1}`,
      actions: reloadAfter.includes(index + 1) ? ["reload"] : [`hold d ${100 + index}ms`],
    }));

  it("keeps the frame before every reload, as in the card-tactics run", () => {
    // The card run reloaded after steps 5 and 11; the win screen is step 5.
    const frames = chooseFrames(boot, steps(15, [6, 12]));
    const paths = frames.map((frame) => frame.path);
    assert.equal(frames.length, 10);
    assert.equal(paths[0], "/frames/boot.png");
    assert.include(paths, "/frames/step-05.png");
    assert.include(paths, "/frames/step-11.png");
    assert.include(paths, "/frames/step-15.png");
    assert.equal(new Set(paths).size, paths.length);
    assert.deepStrictEqual(
      frames.map((frame) => frame.id),
      frames.map((_, index) => `F${index + 1}`),
    );
    assert.match(frames[3]!.label, /^after step 5: hold d 104ms — note 5$/);
  });

  it("uses every frame when the run is short", () => {
    const frames = chooseFrames(boot, steps(3));
    assert.deepStrictEqual(
      frames.map((frame) => frame.path),
      ["/frames/boot.png", "/frames/step-01.png", "/frames/step-02.png", "/frames/step-03.png"],
    );
  });

  it("stays at ten frames and ends on the last one", () => {
    const frames = chooseFrames(boot, steps(15));
    assert.equal(frames.length, 10);
    assert.equal(frames.at(-1)!.path, "/frames/step-15.png");
  });

  it("does not repeat the boot frame when the first action is a reload", () => {
    const frames = chooseFrames(boot, steps(2, [1]));
    assert.deepStrictEqual(
      frames.map((frame) => frame.path),
      ["/frames/boot.png", "/frames/step-01.png", "/frames/step-02.png"],
    );
  });
});

describe("the model's own replies", () => {
  it("reads an action list that leaves the unused lists out", () => {
    // The model spells out only the fields it uses; a missing "drags" used to
    // end the whole playtest and the game was graded as if nothing was shown.
    const reply = decodeActions({
      note: "I will click the reply.",
      clicks: [{ x: 480, y: 270 }],
    });
    assert.deepStrictEqual(reply.drags, []);
    assert.deepStrictEqual(reply.keys, []);
    assert.equal(reply.reload, false);
    assert.equal(reply.waitMs, 0);
    assert.equal(reply.note, "I will click the reply.");
  });

  it("reads the numbers the model wrote as text", () => {
    const reply = decodeActions({
      note: "",
      reload: false,
      keys: [{ key: "l", holdMs: "3500" }],
      clicks: [{ x: "480", y: "270" }],
      drags: [],
      waitMs: "800",
    });
    assert.deepStrictEqual(reply.keys, [{ key: "l", holdMs: 3500 }]);
    assert.deepStrictEqual(reply.clicks, [{ x: 480, y: 270 }]);
    assert.equal(reply.waitMs, 800);
  });

  it("reads a verdict that leaves the frame out", () => {
    const reply = decodeVerdict({ verdict: "NO" });
    assert.equal(reply.verdict, "NO");
    assert.equal(reply.frame, "");
    assert.equal(reply.reason, "");
  });

  it("counts a verdict that cited no frame instead of failing the vote", async () => {
    const review: ReviewFn = async () => ({ verdict: "YES" });
    const judged = await judgeObligations({ brief, frames, notes: [], review });
    assert.equal(judged.obligations[0]?.votes[0]?.yes, true);
    assert.equal(judged.obligations[0]?.votes[0]?.frame, null);
    assert.equal(judged.obligations[0]?.votes[0]?.reason, "");
  });
});

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

  it("asks every vote at once, six at most, and keeps each item's votes", async () => {
    const wide: LoadedGameBenchmarkBrief = {
      ...brief,
      obligations: [1, 2, 3, 4].map((n) => ({
        id: `claim-${n}`,
        kind: "win" as const,
        description: `Claim number ${n}.`,
      })),
    };
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const review: ReviewFn = async (request) => {
      calls += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Six questions start before any can finish, so the first six release
      // the gate; the rest then run immediately.
      if (calls === 6) release();
      await gate;
      inFlight -= 1;
      return {
        verdict: request.prompt.includes("Claim number 3.") ? "YES" : "NO",
        frame: "F1",
        reason: "because",
      };
    };
    const judged = await judgeObligations({ brief: wide, frames, notes: [], review });
    assert.equal(calls, 10);
    assert.equal(peak, 6);
    assert.deepStrictEqual(
      judged.obligations.map((obligation) => obligation.yes),
      [false, false, true, false],
    );
    assert.equal(judged.control.yes, false);
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

describe("makeOpenCodeReviewer", () => {
  /** One CLI event line, the way `opencode run --format json` writes it. */
  const cliText = (text: string) =>
    `${JSON.stringify({ type: "text", part: { type: "text", text } })}\n`;

  it("sends the frames, asks for JSON and decodes the reply", async () => {
    const runs: OpenCodeRun[] = [];
    const reviewer = makeOpenCodeReviewer({
      run: async (run) => {
        runs.push(run);
        return {
          output: cliText('{"verdict":"YES","frame":"F1","reason":"because"}'),
          exitCode: 0,
        };
      },
    });
    const answer = await reviewer.review({
      kind: "verdict",
      prompt: "The single claim to judge",
      imagePaths: ["/frames/f1.png"],
    });
    assert.deepStrictEqual(answer, { verdict: "YES", frame: "F1", reason: "because" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.model, OPENCODE_GRADER_MODEL);
    assert.deepStrictEqual(runs[0]!.imagePaths, ["/frames/f1.png"]);
    assert.match(runs[0]!.prompt, /Answer with one JSON object and nothing else/);
    assert.match(runs[0]!.prompt, /"verdict":"YES or NO"/);
  });

  it("moves to the free fallback route when the model is out of quota", async () => {
    const models: string[] = [];
    const reviewer = makeOpenCodeReviewer({
      run: async (run) => {
        models.push(run.model);
        return run.model === OPENCODE_GRADER_MODEL
          ? { output: "Free usage limit reached", exitCode: 1 }
          : {
              output: cliText(
                '{"note":"hi","reload":false,"keys":[],"clicks":[],"drags":[],"waitMs":0}',
              ),
              exitCode: 0,
            };
      },
    });
    const answer = await reviewer.review({
      kind: "actions",
      prompt: "Play the game",
      imagePaths: [],
    });
    assert.deepStrictEqual(answer, {
      note: "hi",
      reload: false,
      keys: [],
      clicks: [],
      drags: [],
      waitMs: 0,
    });
    assert.deepStrictEqual(models, [OPENCODE_GRADER_MODEL, OPENCODE_GRADER_FALLBACK_MODEL]);
    assert.equal(reviewer.usedModel(), OPENCODE_GRADER_FALLBACK_MODEL);
    // DeepSeek builds these games; it must never grade them.
    assert.equal(
      models.some((model) => model.includes("deepseek")),
      false,
    );
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

  it("records which model family graded the document", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-grade-test-"));
    try {
      const gameDir = NodePath.join(directory, "game");
      await NodeFSP.mkdir(gameDir, { recursive: true });
      const out = NodePath.join(directory, "out");
      const grade = await gradeGame({
        gameDir,
        brief,
        out,
        grader: "opencode",
        graderModel: OPENCODE_GRADER_MODEL,
        deps: {
          exportBuild: async () => ({ ok: false, detail: "no godot project" }),
          review: async () => reply("YES"),
          playtest: async () => {
            throw new Error("a no-build must not playtest");
          },
        },
      });
      assert.deepStrictEqual(grade.grader, {
        provider: "opencode",
        model: OPENCODE_GRADER_MODEL,
      });
      const written = JSON.parse(
        await NodeFSP.readFile(NodePath.join(out, "grade.json"), "utf8"),
      ) as { grader: { provider: string; model: string }; model: string };
      assert.deepStrictEqual(written.grader, {
        provider: "opencode",
        model: OPENCODE_GRADER_MODEL,
      });
      assert.equal(written.model, `opencode/${OPENCODE_GRADER_MODEL}`);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("votes over a saved grade's frames without building or playing", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-grade-test-"));
    try {
      const savedDir = NodePath.join(directory, "saved");
      await NodeFSP.mkdir(NodePath.join(savedDir, "frames"), { recursive: true });
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      for (const name of ["boot.png", "step-01.png"])
        await NodeFSP.writeFile(NodePath.join(savedDir, "frames", name), png);
      await NodeFSP.writeFile(
        NodePath.join(savedDir, "grade.json"),
        JSON.stringify({
          schemaVersion: 1,
          brief: { id: brief.id, title: brief.title, checksum: brief.checksum },
          gameDir: "/games/fixture",
          model: "codex/gpt-6.1-sol",
          build: { kind: "existing", detail: null },
          quick: {
            booted: true,
            bootMs: 500,
            consoleErrors: 0,
            consoleErrorLines: [],
            responded: true,
            changedPercent: 10,
          },
          frames: ["frames/boot.png", "frames/step-01.png"],
          actions: [{ step: 1, actions: ["hold Space 100ms"], note: "a note" }],
          obligations: [],
          control: { description: CONTROL_DESCRIPTION, yes: false, votes: [] },
          void: false,
          solCalls: 0,
        }),
      );
      const prompts: string[] = [];
      const out = NodePath.join(directory, "out");
      const grade = await gradeGame({
        brief,
        out,
        reuseFrames: savedDir,
        deps: {
          review: async (request) => {
            prompts.push(request.prompt);
            return reply("NO");
          },
          playtest: async () => {
            throw new Error("a vote-only re-grade must not playtest");
          },
          exportBuild: async () => {
            throw new Error("a vote-only re-grade must not build");
          },
        },
      });
      assert.equal(grade.build.kind, "existing");
      assert.equal(grade.gameDir, "/games/fixture");
      assert.equal(grade.actions.length, 1);
      assert.equal(grade.solCalls, 6);
      assert.equal(prompts.length, 6);
      assert.match(prompts[0]!, /after step 1: hold Space 100ms — a note/);
      assert.match(prompts[0]!, /boot, no input/);
      assert.deepStrictEqual((await NodeFSP.readdir(NodePath.join(out, "frames"))).sort(), [
        "boot.png",
        "step-01.png",
      ]);
      const written = JSON.parse(
        await NodeFSP.readFile(NodePath.join(out, "grade.json"), "utf8"),
      ) as {
        frames: ReadonlyArray<string>;
        obligations: ReadonlyArray<{ yes: boolean }>;
      };
      assert.deepStrictEqual(written.frames, ["frames/boot.png", "frames/step-01.png"]);
      assert.equal(
        written.obligations.every((obligation) => !obligation.yes),
        true,
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("re-chooses the frames over every screenshot the saved grade kept", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-grade-test-"));
    try {
      const savedDir = NodePath.join(directory, "saved");
      await NodeFSP.mkdir(NodePath.join(savedDir, "frames"), { recursive: true });
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      const actions = Array.from({ length: 15 }, (_, index) => ({
        step: index + 1,
        actions: index + 1 === 6 || index + 1 === 12 ? ["reload"] : ["drag (10,10)→(20,20)"],
        note: `note ${index + 1}`,
      }));
      for (const name of [
        "boot.png",
        ...actions.map((action) => `step-${String(action.step).padStart(2, "0")}.png`),
      ])
        await NodeFSP.writeFile(NodePath.join(savedDir, "frames", name), png);
      await NodeFSP.writeFile(
        NodePath.join(savedDir, "grade.json"),
        JSON.stringify({
          schemaVersion: 1,
          brief: { id: brief.id, title: brief.title, checksum: brief.checksum },
          gameDir: "/games/fixture",
          model: "codex/gpt-6.1-sol",
          build: { kind: "existing", detail: null },
          quick: {
            booted: true,
            bootMs: 500,
            consoleErrors: 0,
            consoleErrorLines: [],
            responded: true,
            changedPercent: 10,
          },
          // The old grade voted over eight frames and never saw the win screen
          // that sits right before a reload.
          frames: ["frames/boot.png", "frames/step-01.png", "frames/step-03.png"],
          actions,
          obligations: [],
          control: { description: CONTROL_DESCRIPTION, yes: false, votes: [] },
          void: false,
          solCalls: 0,
        }),
      );
      const prompts: string[] = [];
      const out = NodePath.join(directory, "out");
      const grade = await gradeGame({
        brief,
        out,
        reuseFrames: savedDir,
        deps: {
          review: async (request) => {
            prompts.push(request.prompt);
            return reply("NO");
          },
          playtest: async () => {
            throw new Error("a vote-only re-grade must not playtest");
          },
          exportBuild: async () => {
            throw new Error("a vote-only re-grade must not build");
          },
        },
      });
      // The frame before each reload is the only picture of the win.
      assert.include(grade.frames, "frames/step-05.png");
      assert.include(grade.frames, "frames/step-11.png");
      assert.isAtMost(grade.frames.length, 10);
      assert.match(prompts[0]!, /after step 5: drag \(10,10\)→\(20,20\) — note 5/);
      assert.match(prompts[0]!, /after step 11: drag \(10,10\)→\(20,20\) — note 11/);
      // Every screenshot comes along as evidence.
      assert.equal((await NodeFSP.readdir(NodePath.join(out, "frames"))).length, 16);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
