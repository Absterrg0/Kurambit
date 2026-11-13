import { describe, expect, it } from "vite-plus/test";

import { isGameWorkspaceCompact } from "./gameWorkspaceStore";

describe("game workspace width", () => {
  it("treats a workspace below the dock threshold as compact", () => {
    expect(isGameWorkspaceCompact(0)).toBe(false);
    expect(isGameWorkspaceCompact(899)).toBe(true);
    expect(isGameWorkspaceCompact(900)).toBe(false);
    expect(isGameWorkspaceCompact(1280)).toBe(false);
  });
});
