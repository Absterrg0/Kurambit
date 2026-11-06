// Evidence honesty: a Unity CLI call the Pipeline never answered is never read
// as a clean answer (a console that did not answer is not an empty console).
import { describe, expect, it } from "@effect/vitest";
import { answerOf, type UnityCliResult } from "./GameUnity.ts";

const process = (timedOut = false, exitCode = 0) => ({
  pid: 1,
  exitCode,
  signal: null,
  timedOut,
  stdout: "",
  stderr: "",
  logPath: "/log",
});
const result = (fields: Partial<UnityCliResult>): UnityCliResult => ({
  data: null,
  ok: true,
  errorCode: null,
  errorMessage: null,
  process: process(),
  ...fields,
});

describe("answerOf", () => {
  it("reads an answered command's result", () => {
    expect(answerOf(result({ data: { result: { entries: [] } } }))).toEqual({
      kind: "answered",
      result: { entries: [] },
    });
  });
  it("reads the Pipeline's own refusal", () => {
    expect(
      answerOf(result({ ok: false, errorCode: "NOT_FOUND", errorMessage: "no scene" })),
    ).toEqual({ kind: "refused", code: "NOT_FOUND", message: "no scene" });
  });
  it("reads no envelope as silence, not an empty answer", () => {
    expect(answerOf(result({}))).toEqual({ kind: "silent", timedOut: false });
  });
  it("reads a call that hung past its bound as silence, whatever it printed", () => {
    expect(
      answerOf(result({ data: { result: { entries: [] } }, process: process(true, 1) })),
    ).toEqual({ kind: "silent", timedOut: true });
  });
});
