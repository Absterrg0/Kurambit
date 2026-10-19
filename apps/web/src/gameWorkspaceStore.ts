import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const GAME_CHAT_DEFAULT_WIDTH = 440;
export const GAME_CHAT_MIN_WIDTH = 320;
export const GAME_CHAT_MAX_WIDTH = 760;

export const clampGameChatWidth = (width: number) =>
  Math.min(GAME_CHAT_MAX_WIDTH, Math.max(GAME_CHAT_MIN_WIDTH, Math.round(width)));

interface GameWorkspaceStoreState {
  /** Width of the docked chat column on game threads, in CSS pixels. */
  chatWidth: number;
  chatCollapsed: boolean;
  setChatWidth: (width: number) => void;
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
      toggleChat: () => set((state) => ({ chatCollapsed: !state.chatCollapsed })),
      setChatCollapsed: (collapsed) => set({ chatCollapsed: collapsed }),
    }),
    {
      name: "t3code:game-workspace:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ chatWidth: state.chatWidth, chatCollapsed: state.chatCollapsed }),
    },
  ),
);
