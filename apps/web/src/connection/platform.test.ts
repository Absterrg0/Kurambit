import { describe, expect, it } from "@effect/vitest";

import {
  primaryToRetainAfterTopologyRead,
  readPrimaryEnvironmentTargetResult,
} from "./platform.ts";

describe("primary topology cache", () => {
  const cached = {
    signature: "http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    target: {} as never,
  };

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");

    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryToRetainAfterTopologyRead(cached, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryToRetainAfterTopologyRead(cached, {
        _tag: "Success",
        target: null,
      }),
    ).toBeUndefined();
  });
});
