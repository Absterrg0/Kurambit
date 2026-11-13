import type { GameBuild, GameBuildId, GameBuildRef } from "@kurambit/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * Below this workspace width (the row after the sidebar, not the window) the
 * game and the chat cannot both stay usable side by side, so the game stacks
 * above the chat whatever the person chose.
 */
const GAME_WORKSPACE_DOCK_MIN_WIDTH = 900;

export const isGameWorkspaceCompact = (workspaceWidth: number) =>
  workspaceWidth > 0 && workspaceWidth < GAME_WORKSPACE_DOCK_MIN_WIDTH;

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

/** The dock under the game: the agent's chat, the build's checks, its recordings. */
export type GameDockTab = "agent" | "checks" | "recordings";

/** The dock's height in CSS pixels, never so tall the game disappears or so short it says nothing. */
const GAME_DOCK_DEFAULT_HEIGHT = 240;
export const clampGameDockHeight = (height: number, column = Number.POSITIVE_INFINITY) =>
  Math.round(Math.min(Math.max(160, column - 240), Math.max(160, height)));

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
  /** Shows or hides the game's Tune tab in the right panel. */
  toggleInspector: () => void;
  /**
   * Asks the open game's screen for a right-panel tab: Tune shown, Tune toggled, or Look shown;
   * `n` makes a repeat news. The panel is T3's, kept per thread, so the screen acts on it.
   */
  buildsRequest: {
    readonly kind: "show" | "toggle" | "look";
    readonly n: number;
  } | null;
  /** What a pointed thing opens: its values in Tune ("scene"), or a build's checks ("build"). */
  inspectorTab: GameInspectorTab;
  /** A build's checks in the dock, or the Tune tab for what is on screen. */
  showInspectorTab: (tab: GameInspectorTab) => void;
  inspectedBuild: GameInspectedBuild | null;
  /** Shows a build in the Inspector's Build tab; null follows the Stage again. */
  inspectBuild: (inspected: GameInspectedBuild | null) => void;
  /** The latest Stage request; `n` makes a repeat of the same request news. Not persisted. */
  stageRequest: { readonly request: GameStageRequest; readonly n: number } | null;
  requestStage: (request: GameStageRequest) => void;
  dockHeight: number;
  setDockHeight: (height: number) => void;
  /** The dock folded to its tabs, the game taking the column. */
  dockCollapsed: boolean;
  setDockCollapsed: (collapsed: boolean) => void;
  /** The dock's open tab. Not persisted: a new session opens on the agent. */
  dockTab: GameDockTab;
  /** Opens a tab, unfolding the dock. */
  showDockTab: (tab: GameDockTab) => void;
  /** Asks for the Look tab in the right panel (lookOpen stays false: the request is the news). */
  lookOpen: boolean;
  setLookOpen: (open: boolean) => void;
}

/** The game screen's layout preferences, one set for every game. */
export const useGameWorkspaceStore = create<GameWorkspaceStoreState>()(
  persist(
    (set) => ({
      toggleInspector: () =>
        set((state) => ({
          buildsRequest: { kind: "toggle", n: (state.buildsRequest?.n ?? 0) + 1 },
        })),
      buildsRequest: null,
      inspectorTab: "build",
      showInspectorTab: (tab) =>
        set((state) =>
          tab === "build"
            ? { inspectorTab: tab, dockTab: "checks", dockCollapsed: false }
            : {
                inspectorTab: tab,
                buildsRequest: { kind: "show", n: (state.buildsRequest?.n ?? 0) + 1 },
              },
        ),
      inspectedBuild: null,
      inspectBuild: (inspected) => set({ inspectedBuild: inspected }),
      stageRequest: null,
      requestStage: (request) =>
        set((state) => ({ stageRequest: { request, n: (state.stageRequest?.n ?? 0) + 1 } })),
      dockHeight: GAME_DOCK_DEFAULT_HEIGHT,
      setDockHeight: (height) => set({ dockHeight: clampGameDockHeight(height) }),
      dockCollapsed: false,
      setDockCollapsed: (collapsed) => set({ dockCollapsed: collapsed }),
      dockTab: "agent",
      showDockTab: (tab) => set({ dockTab: tab, dockCollapsed: false }),
      lookOpen: false,
      setLookOpen: (open) =>
        set((state) =>
          open
            ? { buildsRequest: { kind: "look", n: (state.buildsRequest?.n ?? 0) + 1 } }
            : { lookOpen: false },
        ),
    }),
    {
      name: "kurambit:game-workspace:v6",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        dockHeight: state.dockHeight,
        dockCollapsed: state.dockCollapsed,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<GameWorkspaceStoreState> | null;
        return {
          ...current,
          ...saved,
          dockHeight: clampGameDockHeight(saved?.dockHeight ?? current.dockHeight),
        };
      },
    },
  ),
);
