import type { GameBuild, GameBuildId, GameBuildRef } from "@kurambit/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/** The Inspector sits beside the game, so it starts narrow enough to leave the stage room. */
export const GAME_INSPECTOR_DEFAULT_WIDTH = 352;
const GAME_INSPECTOR_MIN_WIDTH = 300;
const GAME_INSPECTOR_MAX_WIDTH = 760;
/**
 * The stage is the product. However wide the Inspector was left in an old
 * session, it never gets more than this share of the workspace.
 */
const GAME_INSPECTOR_MAX_WORKSPACE_SHARE = 0.45;
/**
 * Below this workspace width (the row after the sidebar, not the window) the
 * Inspector and the stage cannot both stay usable, so the workbench shows one
 * pane at a time: the game takes the row, and the Inspector, one click away,
 * names the checks on its button. At a 1100px window with the sidebar open,
 * side by side would leave the game under 500px wide.
 */
const GAME_WORKSPACE_DOCK_MIN_WIDTH = 900;

export const isGameWorkspaceCompact = (workspaceWidth: number) =>
  workspaceWidth > 0 && workspaceWidth < GAME_WORKSPACE_DOCK_MIN_WIDTH;

export const clampGameInspectorWidth = (width: number, workspaceWidth = Number.POSITIVE_INFINITY) =>
  Math.min(
    GAME_INSPECTOR_MAX_WIDTH,
    Math.floor(workspaceWidth * GAME_INSPECTOR_MAX_WORKSPACE_SHARE),
    Math.max(GAME_INSPECTOR_MIN_WIDTH, Math.round(width)),
  );

/**
 * What another surface (the palette, a key, the timeline, a chat turn's strip)
 * asks the Stage to do. One channel, so every entry point shares the Stage's path.
 */
export type GameStageRequest =
  | { readonly kind: "live" }
  | { readonly kind: "play"; readonly build: GameBuildRef }
  | { readonly kind: "detail"; readonly build: GameBuildRef }
  | {
      readonly kind: "compare";
      readonly pair?: readonly [GameBuildRef, GameBuildRef];
      /** Start picking with this build already picked first. */
      readonly first?: GameBuildRef;
    }
  | { readonly kind: "step"; readonly by: -1 | 1 }
  | { readonly kind: "focus" }
  /** Freeze the game to point at things, or play on: Tab, the button, the palette and its key. */
  | { readonly kind: "freeze" }
  /** The playing game fills the screen, or leaves it: the Stage's menu, the palette and its key. */
  | { readonly kind: "fullscreen" }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" }
  | { readonly kind: "export" }
  | { readonly kind: "generated-art" };

/** The panel beside the chat: a build's checks and changes, or, while pointing, what is on screen. */
export type GameInspectorTab = "build" | "scene";

/** Where the game plays: on top of the chat, or in its own column beside it. */
export type GamePlacement = "above" | "right";

/** How much of the chat's column the game takes: hidden to its bar, shared, or all of it. */
export type GameView = "collapsed" | "split" | "expanded";

/** The game's share of the column's height while it shares it with the chat. */
const GAME_STAGE_SHARE_DEFAULT = 0.58;
export const clampGameStageShare = (share: number) => Math.min(0.85, Math.max(0.3, share));
/** The game's column beside the chat, when it plays there. */
export const GAME_COLUMN_DEFAULT_WIDTH = 640;
export const clampGameColumnWidth = (width: number, workspaceWidth = Number.POSITIVE_INFINITY) =>
  Math.min(Math.floor(workspaceWidth * 0.62), Math.max(360, Math.round(width)));

/** The build the Inspector shows, for one thread; null shows the one on the Stage. */
export interface GameInspectedBuild {
  readonly threadKey: string;
  readonly build: GameBuildId;
  /** The row as the strip had it, for a build on an older page than the Inspector reads. */
  readonly snapshot: GameBuild;
  /** Shown as a compare's side: the Inspector names it by its letter, and closing the compare hands it back. */
  readonly side?: "A" | "B";
}

interface GameWorkspaceStoreState {
  /** Width of the Inspector column the creator chose, in CSS pixels: remembered as chosen. */
  inspectorWidth: number;
  /** The docked workspace row's width now, which the drawn Inspector is fitted to. Not persisted. */
  workspaceWidth: number;
  inspectorCollapsed: boolean;
  setInspectorWidth: (width: number) => void;
  /** Records the workspace's width, which the drawn width is clamped to (useDockedInspectorWidth). */
  fitInspectorWidth: (workspaceWidth: number) => void;
  toggleInspector: () => void;
  setInspectorCollapsed: (collapsed: boolean) => void;
  /** The Inspector's open tab. Not persisted: a new session opens on the build. */
  inspectorTab: GameInspectorTab;
  /** Opens a tab, showing the Inspector if it was collapsed. */
  showInspectorTab: (tab: GameInspectorTab) => void;
  inspectedBuild: GameInspectedBuild | null;
  /** Shows a build in the Inspector's Build tab; null follows the Stage again. */
  inspectBuild: (inspected: GameInspectedBuild | null) => void;
  /** The latest Stage request; `n` makes a repeat of the same request news. Not persisted. */
  stageRequest: { readonly request: GameStageRequest; readonly n: number } | null;
  requestStage: (request: GameStageRequest) => void;
  gamePlacement: GamePlacement;
  setGamePlacement: (placement: GamePlacement) => void;
  gameView: GameView;
  setGameView: (view: GameView) => void;
  gameStageShare: number;
  setGameStageShare: (share: number) => void;
  gameColumnWidth: number;
  setGameColumnWidth: (width: number) => void;
  /** The game's Look (style, characters, generated art), as a dialog. Not persisted. */
  lookOpen: boolean;
  setLookOpen: (open: boolean) => void;
}

/**
 * The game stage's layout preferences. One width for every game: a person who
 * widens the Inspector once means it everywhere, the way an editor remembers a panel.
 */
export const useGameWorkspaceStore = create<GameWorkspaceStoreState>()(
  persist(
    (set) => ({
      inspectorWidth: GAME_INSPECTOR_DEFAULT_WIDTH,
      workspaceWidth: Number.POSITIVE_INFINITY,
      inspectorCollapsed: true,
      setInspectorWidth: (width) => set({ inspectorWidth: clampGameInspectorWidth(width) }),
      fitInspectorWidth: (workspaceWidth) =>
        set((state) => {
          // A compact workspace shows one pane at a time: there is no docked width to fit. The
          // chosen width is never rewritten, so a narrow window does not shrink a wide one later.
          if (isGameWorkspaceCompact(workspaceWidth) || workspaceWidth === state.workspaceWidth)
            return {};
          return { workspaceWidth };
        }),
      toggleInspector: () => set((state) => ({ inspectorCollapsed: !state.inspectorCollapsed })),
      setInspectorCollapsed: (collapsed) => set({ inspectorCollapsed: collapsed }),
      inspectorTab: "build",
      showInspectorTab: (tab) => set({ inspectorTab: tab, inspectorCollapsed: false }),
      inspectedBuild: null,
      inspectBuild: (inspected) => set({ inspectedBuild: inspected }),
      stageRequest: null,
      requestStage: (request) =>
        set((state) => ({ stageRequest: { request, n: (state.stageRequest?.n ?? 0) + 1 } })),
      gamePlacement: "above",
      setGamePlacement: (placement) => set({ gamePlacement: placement }),
      gameView: "split",
      setGameView: (view) => set({ gameView: view }),
      gameStageShare: GAME_STAGE_SHARE_DEFAULT,
      setGameStageShare: (share) => set({ gameStageShare: clampGameStageShare(share) }),
      gameColumnWidth: GAME_COLUMN_DEFAULT_WIDTH,
      setGameColumnWidth: (width) => set({ gameColumnWidth: clampGameColumnWidth(width) }),
      lookOpen: false,
      setLookOpen: (open) => set({ lookOpen: open }),
    }),
    {
      name: "kurambit:game-workspace:v4",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        inspectorWidth: state.inspectorWidth,
        inspectorCollapsed: state.inspectorCollapsed,
        gamePlacement: state.gamePlacement,
        // Filling the column is for this sitting; a new one opens with the chat in view.
        gameView: state.gameView === "expanded" ? "split" : state.gameView,
        gameStageShare: state.gameStageShare,
        gameColumnWidth: state.gameColumnWidth,
      }),
      // An old session may hold a width that would starve the stage; the clamp
      // lives here so loading the store cannot reintroduce it.
      merge: (persisted, current) => {
        const saved = persisted as Partial<GameWorkspaceStoreState> | null;
        return {
          ...current,
          ...saved,
          inspectorWidth: clampGameInspectorWidth(saved?.inspectorWidth ?? current.inspectorWidth),
          gameStageShare: clampGameStageShare(saved?.gameStageShare ?? current.gameStageShare),
        };
      },
    },
  ),
);

/** The Inspector's drawn width: the chosen width, fitted to what the workspace can spare. */
export const useDockedInspectorWidth = (): number =>
  useGameWorkspaceStore((state) =>
    clampGameInspectorWidth(state.inspectorWidth, state.workspaceWidth),
  );
