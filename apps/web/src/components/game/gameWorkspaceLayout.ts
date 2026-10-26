export type GameWorkspacePane = "game" | "chat";

export interface GameWorkspaceLayout {
  readonly compact: boolean;
  /** The chat takes its remembered width beside the stage. */
  readonly chatDocked: boolean;
  readonly chatVisible: boolean;
  readonly stageVisible: boolean;
}

/**
 * Which game workspace panes are on screen. Both panes stay mounted; this only
 * decides what is visible and inert.
 */
export function resolveGameWorkspaceLayout(input: {
  readonly compact: boolean;
  readonly compactPane: GameWorkspacePane;
  readonly chatCollapsed: boolean;
  readonly rightPanelMaximized: boolean;
}): GameWorkspaceLayout {
  if (input.compact) {
    return {
      compact: true,
      chatDocked: false,
      chatVisible: input.compactPane === "chat" && !input.rightPanelMaximized,
      stageVisible: input.compactPane === "game",
    };
  }
  const chatVisible = !input.chatCollapsed && !input.rightPanelMaximized;
  return {
    compact: false,
    chatDocked: chatVisible,
    chatVisible,
    stageVisible: true,
  };
}
