import { describe, expect, it } from "@effect/vitest";

import { wasRecentlyInteracted } from "./backgroundActivityReporter.ts";

describe("wasRecentlyInteracted", () => {
  it("expires interaction independently of window focus", () => {
    expect(wasRecentlyInteracted(10_000, 55_000)).toBe(true);
    expect(wasRecentlyInteracted(10_000, 55_001)).toBe(false);
  });

  it("rejects future timestamps", () => {
    expect(wasRecentlyInteracted(10_001, 10_000)).toBe(false);
  });
});
