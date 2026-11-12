import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  clampGameInspectorWidth,
  GAME_INSPECTOR_DEFAULT_WIDTH,
  isGameWorkspaceCompact,
  useGameWorkspaceStore,
} from "./gameWorkspaceStore";

beforeEach(() => {
  useGameWorkspaceStore.setState({
    inspectorWidth: GAME_INSPECTOR_DEFAULT_WIDTH,
    inspectorCollapsed: false,
    workspaceWidth: Number.POSITIVE_INFINITY,
  });
});

describe("game workspace width", () => {
  it("treats a workspace below the dock threshold as compact", () => {
    expect(isGameWorkspaceCompact(0)).toBe(false);
    expect(isGameWorkspaceCompact(899)).toBe(true);
    expect(isGameWorkspaceCompact(900)).toBe(false);
    expect(isGameWorkspaceCompact(1280)).toBe(false);
  });

  it("keeps the remembered dock width while the workspace is compact", () => {
    useGameWorkspaceStore.getState().setInspectorWidth(700);
    useGameWorkspaceStore.getState().fitInspectorWidth(760);

    // Fitting a single-pane layout would have rewritten this to 352.
    expect(useGameWorkspaceStore.getState().inspectorWidth).toBe(700);
  });

  it("draws the remembered width fitted to the workspace, and keeps it as chosen", () => {
    const drawn = () => {
      const state = useGameWorkspaceStore.getState();
      return clampGameInspectorWidth(state.inspectorWidth, state.workspaceWidth);
    };
    useGameWorkspaceStore.getState().setInspectorWidth(700);
    useGameWorkspaceStore.getState().fitInspectorWidth(960);
    expect(drawn()).toBe(432);
    // A narrow window never shrinks the width chosen for a wide one.
    useGameWorkspaceStore.getState().fitInspectorWidth(2000);
    expect(drawn()).toBe(700);
    expect(useGameWorkspaceStore.getState().inspectorWidth).toBe(700);
  });
});
