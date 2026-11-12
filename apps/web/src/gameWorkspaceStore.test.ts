import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  GAME_INSPECTOR_DEFAULT_WIDTH,
  isGameWorkspaceCompact,
  useGameWorkspaceStore,
} from "./gameWorkspaceStore";

beforeEach(() => {
  useGameWorkspaceStore.setState({
    inspectorWidth: GAME_INSPECTOR_DEFAULT_WIDTH,
    inspectorCollapsed: false,
  });
});

describe("game workspace width", () => {
  it("treats a workspace below the dock threshold as compact", () => {
    expect(isGameWorkspaceCompact(0)).toBe(false);
    expect(isGameWorkspaceCompact(799)).toBe(true);
    expect(isGameWorkspaceCompact(800)).toBe(false);
    expect(isGameWorkspaceCompact(1280)).toBe(false);
  });

  it("keeps the remembered dock width while the workspace is compact", () => {
    useGameWorkspaceStore.getState().setInspectorWidth(700);
    useGameWorkspaceStore.getState().fitInspectorWidth(760);

    // Fitting a single-pane layout would have rewritten this to 352.
    expect(useGameWorkspaceStore.getState().inspectorWidth).toBe(700);
  });

  it("fits the remembered width once both panes can dock again", () => {
    useGameWorkspaceStore.getState().setInspectorWidth(700);
    useGameWorkspaceStore.getState().fitInspectorWidth(960);
    expect(useGameWorkspaceStore.getState().inspectorWidth).toBe(432);

    useGameWorkspaceStore.getState().setInspectorWidth(420);
    useGameWorkspaceStore.getState().fitInspectorWidth(1000);
    expect(useGameWorkspaceStore.getState().inspectorWidth).toBe(420);
  });
});
