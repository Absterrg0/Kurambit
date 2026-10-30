import { assert, describe, it } from "@effect/vitest";
import {
  LIFECYCLE_STALE_EDIT,
  LIFECYCLE_SYNTAX_DEFECT,
  parseSubmitToolOutput,
  parseVerifyToolOutput,
  pickLifecycleScript,
} from "./lifecycle.ts";

describe("pickLifecycleScript", () => {
  it("picks the sorted-first game script and skips the probe autoload", () => {
    assert.equal(
      pickLifecycleScript([
        "godot/scripts/studio_probe.gd",
        "godot/scripts/player.gd",
        "godot/scripts/game.gd",
        "game.json",
        "godot/project.godot",
      ]),
      "godot/scripts/game.gd",
    );
  });

  it("throws when no engine script exists", () => {
    assert.throws(
      () => pickLifecycleScript(["game.json", "godot/project.godot"]),
      /need a godot\/\*\*\/\*\.gd script/,
    );
  });

  it("treats the markers as plain text the harness can find and remove", () => {
    assert.isTrue(LIFECYCLE_STALE_EDIT.endsWith("\n"));
    assert.isTrue(LIFECYCLE_SYNTAX_DEFECT.endsWith("\n"));
  });
});

describe("parseSubmitToolOutput", () => {
  it("reads the JSON text stored by the OpenCode adapter", () => {
    const value = {
      accepted: false,
      message: "Submission refused: sources changed",
      buildId: "a".repeat(64),
      checks: [{ id: "sources-current", status: "failed" }],
    };
    assert.deepEqual(parseSubmitToolOutput(JSON.stringify(value)), value);
  });
  it("reads a refusal with its failed check", () => {
    assert.deepEqual(
      parseSubmitToolOutput({
        accepted: false,
        message: "Submission refused: bytes: the build's files changed after export",
        buildId: "a".repeat(64),
        checks: [
          { id: "build", status: "passed" },
          { id: "bytes", status: "failed" },
        ],
      }),
      {
        accepted: false,
        message: "Submission refused: bytes: the build's files changed after export",
        buildId: "a".repeat(64),
        checks: [
          { id: "build", status: "passed" },
          { id: "bytes", status: "failed" },
        ],
      },
    );
  });

  it("reads an acceptance without coercing it into a refusal", () => {
    const facts = parseSubmitToolOutput({
      accepted: true,
      message: "Submitted deadbeef: Play shows this build now.",
      buildId: "b".repeat(64),
      checks: [{ id: "build", status: "passed" }],
      firstPlayable: false,
    });
    assert.equal(facts?.accepted, true);
    assert.equal(facts?.buildId, "b".repeat(64));
  });

  it("rejects prose-shaped or partial results instead of grading them", () => {
    assert.isNull(parseSubmitToolOutput("The submit was refused because reasons"));
    assert.isNull(parseSubmitToolOutput(null));
    assert.isNull(parseSubmitToolOutput({ accepted: false, message: "refused", buildId: null }));
    assert.isNull(
      parseSubmitToolOutput({
        accepted: "no",
        message: "refused",
        buildId: null,
        checks: [],
      }),
    );
    assert.isNull(
      parseSubmitToolOutput({
        accepted: false,
        message: "refused",
        buildId: null,
        checks: [{ id: "build" }],
      }),
    );
  });
});

describe("parseVerifyToolOutput", () => {
  it("reads the JSON text stored by the OpenCode adapter", () => {
    const value = {
      success: false,
      failedStage: "check",
      check: { ok: false, errors: [{ file: "game.gd", line: 3, message: "Parse error" }] },
    };
    assert.deepEqual(parseVerifyToolOutput(JSON.stringify(value)), parseVerifyToolOutput(value));
    assert.isNotNull(parseVerifyToolOutput(JSON.stringify(value)));
  });
  it("reads a check-stage failure with its named error", () => {
    assert.deepEqual(
      parseVerifyToolOutput({
        success: false,
        message: "Stopped at the check stage",
        completed: [],
        failedStage: "check",
        check: {
          ok: false,
          errors: [{ file: "godot/scripts/player.gd", line: 42, message: "Unexpected token" }],
          warnings: [],
          entries: ["main"],
          durationMs: 3,
        },
        screenshots: [],
      }),
      {
        success: false,
        failedStage: "check",
        checkOk: false,
        checkErrors: [{ file: "godot/scripts/player.gd", line: 42, message: "Unexpected token" }],
        hasBuild: false,
        hasPlaytest: false,
      },
    );
  });

  it("reports a claimed success with a build as-is for the caller to judge", () => {
    const facts = parseVerifyToolOutput({
      success: true,
      completed: ["check", "test", "export", "playtest"],
      check: { ok: true, errors: [], warnings: [], entries: ["main"], durationMs: 3 },
      build: { buildId: "c".repeat(64), directory: "builds/x", path: "/x/index.html" },
      playtest: { success: true },
      screenshots: [],
    });
    assert.equal(facts?.success, true);
    assert.isTrue(facts?.hasBuild === true && facts?.hasPlaytest === true);
    assert.equal(facts?.failedStage, null);
  });

  it("rejects non-result shapes instead of treating them as a pass", () => {
    assert.isNull(parseVerifyToolOutput("check failed"));
    assert.isNull(parseVerifyToolOutput({ success: "false" }));
    assert.isNull(parseVerifyToolOutput({ success: false, check: { ok: "no" } }));
  });
});
