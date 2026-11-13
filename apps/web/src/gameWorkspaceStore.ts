import type { GameBuild, GameBuildId, GameBuildRef } from "@kurambit/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

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

/** How much of the game's column the chat under it keeps, as a share of the column's height. */
const GAME_CHAT_SHARE_DEFAULT = 0.38;
const clampGameChatShare = (share: number) =>
  Number.isFinite(share) ? Math.min(0.7, Math.max(0.22, share)) : GAME_CHAT_SHARE_DEFAULT;

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
  inspectedBuild: GameInspectedBuild | null;
  /** Shows a build in the Build tab; null follows the Stage again. */
  inspectBuild: (inspected: GameInspectedBuild | null) => void;
  /** The latest Stage request; `n` makes a repeat of the same request news. Not persisted. */
  stageRequest: { readonly request: GameStageRequest; readonly n: number } | null;
  requestStage: (request: GameStageRequest) => void;
  /** The chat's share of the game's column; the game takes the rest. */
  chatShare: number;
  setChatShare: (share: number) => void;
  /** The game folded away: the chat takes the column, and the game pauses and mutes. */
  gameHidden: boolean;
  setGameHidden: (hidden: boolean) => void;
}

/** The game screen's layout preferences, one set for every game. */
export const useGameWorkspaceStore = create<GameWorkspaceStoreState>()(
  persist(
    (set) => ({
      inspectedBuild: null,
      inspectBuild: (inspected) => set({ inspectedBuild: inspected }),
      stageRequest: null,
      requestStage: (stageRequest) =>
        set((state) => ({
          stageRequest: { request: stageRequest, n: (state.stageRequest?.n ?? 0) + 1 },
        })),
      chatShare: GAME_CHAT_SHARE_DEFAULT,
      setChatShare: (share) => set({ chatShare: clampGameChatShare(share) }),
      gameHidden: false,
      setGameHidden: (hidden) => set({ gameHidden: hidden }),
    }),
    {
      name: "kurambit:game-workspace:v7",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ chatShare: state.chatShare, gameHidden: state.gameHidden }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<GameWorkspaceStoreState> | null;
        return {
          ...current,
          chatShare: clampGameChatShare(saved?.chatShare ?? current.chatShare),
          gameHidden: saved?.gameHidden === true,
        };
      },
    },
  ),
);
