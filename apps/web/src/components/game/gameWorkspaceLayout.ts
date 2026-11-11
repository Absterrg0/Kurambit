export type GameWorkspacePane = "game" | "inspector";

export interface GameWorkspaceLayout {
  readonly compact: boolean;
  /** The Inspector takes its remembered width beside the centre. */
  readonly inspectorDocked: boolean;
  readonly inspectorVisible: boolean;
  readonly stageVisible: boolean;
}

/**
 * Which game workspace panes are on screen. Both panes stay mounted; this only
 * decides what is visible and inert.
 */
export function resolveGameWorkspaceLayout(input: {
  readonly compact: boolean;
  readonly compactPane: GameWorkspacePane;
  readonly inspectorCollapsed: boolean;
  readonly rightPanelMaximized: boolean;
}): GameWorkspaceLayout {
  if (input.compact) {
    return {
      compact: true,
      inspectorDocked: false,
      inspectorVisible: input.compactPane === "inspector" && !input.rightPanelMaximized,
      stageVisible: input.compactPane === "game",
    };
  }
  const inspectorVisible = !input.inspectorCollapsed && !input.rightPanelMaximized;
  return {
    compact: false,
    inspectorDocked: inspectorVisible,
    inspectorVisible,
    stageVisible: true,
  };
}
