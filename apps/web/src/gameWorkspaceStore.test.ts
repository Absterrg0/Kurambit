import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  GAME_CHAT_DEFAULT_WIDTH,
  isGameWorkspaceCompact,
  useGameWorkspaceStore,
} from "./gameWorkspaceStore";

beforeEach(() => {
  useGameWorkspaceStore.setState({
    chatWidth: GAME_CHAT_DEFAULT_WIDTH,
    chatCollapsed: false,
  });
});

describe("game workspace width", () => {
  it("treats a workspace below the dock threshold as compact", () => {
    expect(isGameWorkspaceCompact(0)).toBe(false);
    expect(isGameWorkspaceCompact(959)).toBe(true);
    expect(isGameWorkspaceCompact(960)).toBe(false);
    expect(isGameWorkspaceCompact(1280)).toBe(false);
  });

  it("keeps the remembered dock width while the workspace is compact", () => {
    useGameWorkspaceStore.getState().setChatWidth(700);
    useGameWorkspaceStore.getState().fitChatWidth(800);

    // Fitting a single-pane layout would have rewritten this to 360.
    expect(useGameWorkspaceStore.getState().chatWidth).toBe(700);
  });

  it("fits the remembered width once both panes can dock again", () => {
    useGameWorkspaceStore.getState().setChatWidth(700);
    useGameWorkspaceStore.getState().fitChatWidth(960);
    expect(useGameWorkspaceStore.getState().chatWidth).toBe(432);

    useGameWorkspaceStore.getState().setChatWidth(420);
    useGameWorkspaceStore.getState().fitChatWidth(1000);
    expect(useGameWorkspaceStore.getState().chatWidth).toBe(420);
  });
});
