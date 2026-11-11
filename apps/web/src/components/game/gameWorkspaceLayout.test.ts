import { describe, expect, it } from "vite-plus/test";

import { resolveGameWorkspaceLayout } from "./gameWorkspaceLayout";

const WIDE = {
  compact: false,
  compactPane: "game",
  inspectorCollapsed: false,
  rightPanelMaximized: false,
} as const;

describe("game workspace layout", () => {
  it("docks the Inspector beside the stage in a wide workspace", () => {
    expect(resolveGameWorkspaceLayout(WIDE)).toEqual({
      compact: false,
      inspectorDocked: true,
      inspectorVisible: true,
      stageVisible: true,
    });
  });

  it("keeps the saved collapse preference in a wide workspace", () => {
    expect(resolveGameWorkspaceLayout({ ...WIDE, inspectorCollapsed: true })).toEqual({
      compact: false,
      inspectorDocked: false,
      inspectorVisible: false,
      stageVisible: true,
    });
    expect(resolveGameWorkspaceLayout({ ...WIDE, rightPanelMaximized: true })).toEqual({
      compact: false,
      inspectorDocked: false,
      inspectorVisible: false,
      stageVisible: true,
    });
  });

  it("shows one usable pane at a time in a compact workspace", () => {
    expect(resolveGameWorkspaceLayout({ ...WIDE, compact: true })).toEqual({
      compact: true,
      inspectorDocked: false,
      inspectorVisible: false,
      stageVisible: true,
    });
    expect(
      resolveGameWorkspaceLayout({ ...WIDE, compact: true, compactPane: "inspector" }),
    ).toEqual({
      compact: true,
      inspectorDocked: false,
      inspectorVisible: true,
      stageVisible: false,
    });
  });

  it("lets the compact switch open the Inspector without changing the saved collapse", () => {
    expect(
      resolveGameWorkspaceLayout({
        ...WIDE,
        compact: true,
        compactPane: "inspector",
        inspectorCollapsed: true,
      }),
    ).toMatchObject({ inspectorVisible: true, stageVisible: false });

    // Widening falls back to the creator's saved dock preference, not the
    // temporary compact pane.
    expect(
      resolveGameWorkspaceLayout({
        ...WIDE,
        compactPane: "inspector",
        inspectorCollapsed: true,
      }),
    ).toMatchObject({ inspectorDocked: false, inspectorVisible: false, stageVisible: true });
  });
});
