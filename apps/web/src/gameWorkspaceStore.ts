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

export const clampGameChatWidth = (width: number, workspaceWidth = Number.POSITIVE_INFINITY) =>
  Math.min(
    GAME_CHAT_MAX_WIDTH,
    Math.floor(workspaceWidth * GAME_CHAT_MAX_WORKSPACE_SHARE),
    Math.max(GAME_CHAT_MIN_WIDTH, Math.round(width)),
  );

interface GameWorkspaceStoreState {
  /** Width of the docked chat column on game threads, in CSS pixels. */
  chatWidth: number;
  chatCollapsed: boolean;
  setChatWidth: (width: number) => void;
  /** Clamp a remembered width to what the current workspace can spare. */
  fitChatWidth: (workspaceWidth: number) => void;
  toggleChat: () => void;
  setChatCollapsed: (collapsed: boolean) => void;
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
          const fitted = clampGameChatWidth(state.chatWidth, workspaceWidth);
          return fitted === state.chatWidth ? {} : { chatWidth: fitted };
        }),
      toggleChat: () => set((state) => ({ chatCollapsed: !state.chatCollapsed })),
      setChatCollapsed: (collapsed) => set({ chatCollapsed: collapsed }),
    }),
    {
      name: "t3code:game-workspace:v1",
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
