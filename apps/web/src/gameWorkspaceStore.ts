import type { GameBuildRef } from "@kurambit/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/** The chat is docked beside the game, so it starts narrow enough to leave the stage room. */
export const GAME_CHAT_DEFAULT_WIDTH = 360;
export const GAME_CHAT_MIN_WIDTH = 300;
export const GAME_CHAT_MAX_WIDTH = 760;
/**
 * The stage is the product. However wide the chat was left in an old session,
 * it never gets more than this share of the workspace.
 */
export const GAME_CHAT_MAX_WORKSPACE_SHARE = 0.45;
/**
 * Below this workspace width (the row after the sidebar, not the window) the
 * chat and the stage cannot both stay usable, so the workbench shows one pane
 * at a time. The threshold leaves a docked stage at least 600px at the default
 * chat width.
 */
export const GAME_WORKSPACE_DOCK_MIN_WIDTH = 960;

export const isGameWorkspaceCompact = (workspaceWidth: number) =>
  workspaceWidth > 0 && workspaceWidth < GAME_WORKSPACE_DOCK_MIN_WIDTH;

export const clampGameChatWidth = (width: number, workspaceWidth = Number.POSITIVE_INFINITY) =>
  Math.min(
    GAME_CHAT_MAX_WIDTH,
    Math.floor(workspaceWidth * GAME_CHAT_MAX_WORKSPACE_SHARE),
    Math.max(GAME_CHAT_MIN_WIDTH, Math.round(width)),
  );

/**
 * What another surface (the palette, a key, the timeline, a chat turn's strip)
 * asks the Stage to do. One channel, so every entry point shares the Stage's path.
 */
export type GameStageRequest =
  | { readonly kind: "live" }
  | { readonly kind: "play"; readonly build: GameBuildRef }
  | { readonly kind: "detail"; readonly build: GameBuildRef }
  | { readonly kind: "compare"; readonly pair?: readonly [GameBuildRef, GameBuildRef] }
  | { readonly kind: "step"; readonly by: -1 | 1 }
  | { readonly kind: "focus" }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" }
  | { readonly kind: "export" }
  | { readonly kind: "generated-art" };

interface GameWorkspaceStoreState {
  /** Width of the docked chat column on game threads, in CSS pixels. */
  chatWidth: number;
  chatCollapsed: boolean;
  setChatWidth: (width: number) => void;
  /** Clamp a remembered width to what the current workspace can spare. */
  fitChatWidth: (workspaceWidth: number) => void;
  toggleChat: () => void;
  setChatCollapsed: (collapsed: boolean) => void;
  /** The latest Stage request; `n` makes a repeat of the same request news. Not persisted. */
  stageRequest: { readonly request: GameStageRequest; readonly n: number } | null;
  requestStage: (request: GameStageRequest) => void;
}

/**
 * The game stage's layout preferences. One width for every game: a person who
 * widens the chat once means it everywhere, the way an editor remembers a panel.
 */
export const useGameWorkspaceStore = create<GameWorkspaceStoreState>()(
  persist(
    (set) => ({
      chatWidth: GAME_CHAT_DEFAULT_WIDTH,
      chatCollapsed: false,
      setChatWidth: (width) => set({ chatWidth: clampGameChatWidth(width) }),
      fitChatWidth: (workspaceWidth) =>
        set((state) => {
          // A compact workspace shows one pane at a time, so its narrow width
          // says nothing about the docked width the creator chose. Fitting
          // there would quietly rewrite the remembered preference.
          if (isGameWorkspaceCompact(workspaceWidth)) return {};
          const fitted = clampGameChatWidth(state.chatWidth, workspaceWidth);
          return fitted === state.chatWidth ? {} : { chatWidth: fitted };
        }),
      toggleChat: () => set((state) => ({ chatCollapsed: !state.chatCollapsed })),
      setChatCollapsed: (collapsed) => set({ chatCollapsed: collapsed }),
      stageRequest: null,
      requestStage: (request) =>
        set((state) => ({ stageRequest: { request, n: (state.stageRequest?.n ?? 0) + 1 } })),
    }),
    {
      name: "kurambit:game-workspace:v2",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ chatWidth: state.chatWidth, chatCollapsed: state.chatCollapsed }),
      // An old session may hold a width that would starve the stage; the clamp
      // lives here so loading the store cannot reintroduce it.
      merge: (persisted, current) => {
        const saved = persisted as Partial<GameWorkspaceStoreState> | null;
        return {
          ...current,
          ...saved,
          chatWidth: clampGameChatWidth(saved?.chatWidth ?? current.chatWidth),
        };
      },
    },
  ),
);
