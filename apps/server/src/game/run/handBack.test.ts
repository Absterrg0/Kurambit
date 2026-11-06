import * as Data from "effect/Data";
import { describe, expect, it } from "@effect/vitest";
import { failureText, toolFailed } from "./handBack.ts";

class Wrapped extends Data.TaggedError("Wrapped")<{ readonly cause: unknown }> {}
class Bare extends Data.TaggedError("Bare")<{ readonly at: number }> {}

// A pause shows the failure's words; it never reads as a failure without a cause.
describe("failureText", () => {
  it("keeps text passed as the cause", () => {
    expect(
      toolFailed("tester-3's turn", "the server restarted during this turn 3 times").reason,
    ).toBe("the server restarted during this turn 3 times");
  });
  it("reads a wrapper through its cause, and a bare tagged error by its tag and value", () => {
    expect(failureText(new Wrapped({ cause: new Error("disk full") }))).toBe("disk full");
    expect(failureText(new Bare({ at: 4 }))).toContain("Bare");
    expect(failureText(new Bare({ at: 4 }))).not.toBe("unrecognized failure");
  });
});
