import { describe, expect, it } from "vite-plus/test";

import { resolveGameWorkspaceLayout } from "./gameWorkspaceLayout";

const WIDE = {
  compact: false,
  compactPane: "game",
  chatCollapsed: false,
  rightPanelMaximized: false,
} as const;

describe("game workspace layout", () => {
  it("docks the chat beside the stage in a wide workspace", () => {
    expect(resolveGameWorkspaceLayout(WIDE)).toEqual({
      compact: false,
      chatDocked: true,
      chatVisible: true,
      stageVisible: true,
    });
  });

  it("keeps the saved collapse preference in a wide workspace", () => {
    expect(resolveGameWorkspaceLayout({ ...WIDE, chatCollapsed: true })).toEqual({
      compact: false,
      chatDocked: false,
      chatVisible: false,
      stageVisible: true,
    });
    expect(resolveGameWorkspaceLayout({ ...WIDE, rightPanelMaximized: true })).toEqual({
      compact: false,
      chatDocked: false,
      chatVisible: false,
      stageVisible: true,
    });
  });

  it("shows one usable pane at a time in a compact workspace", () => {
    expect(resolveGameWorkspaceLayout({ ...WIDE, compact: true })).toEqual({
      compact: true,
      chatDocked: false,
      chatVisible: false,
      stageVisible: true,
    });
    expect(resolveGameWorkspaceLayout({ ...WIDE, compact: true, compactPane: "chat" })).toEqual({
      compact: true,
      chatDocked: false,
      chatVisible: true,
      stageVisible: false,
    });
  });

  it("lets the compact switch open chat without changing the saved collapse", () => {
    expect(
      resolveGameWorkspaceLayout({
        ...WIDE,
        compact: true,
        compactPane: "chat",
        chatCollapsed: true,
      }),
    ).toMatchObject({ chatVisible: true, stageVisible: false });

    // Widening falls back to the creator's saved dock preference, not the
    // temporary compact pane.
    expect(
      resolveGameWorkspaceLayout({
        ...WIDE,
        compactPane: "chat",
        chatCollapsed: true,
      }),
    ).toMatchObject({ chatDocked: false, chatVisible: false, stageVisible: true });
  });
});
