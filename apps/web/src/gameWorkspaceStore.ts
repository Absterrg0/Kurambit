import type { GameBuild, GameBuildId, GameBuildRef, GameRunProfile } from "@kurambit/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { DEFAULT_STAGE_DEVICE, type GameStageDevice } from "./components/game/gameStageDevice";
import { openGameTool } from "./gameArrivalStore";
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
  /** The header's History popover opens. */
  | { readonly kind: "history" };

/** The Workbench's sections beside the game: its values, its art, and the build's checks. */
export const WORKBENCH_TABS = ["tune", "art", "checks"] as const;
export type WorkbenchTab = (typeof WORKBENCH_TABS)[number];
const isWorkbenchTab = (tab: unknown): tab is WorkbenchTab =>
  (WORKBENCH_TABS as ReadonlyArray<unknown>).includes(tab);

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
  /** Shows a build in the Workbench's Checks; null follows the Stage again. */
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
  /** The game pauses when the person clicks away from it (the chat, Tune) and plays on when they click back. */
  pauseWhenAway: boolean;
  setPauseWhenAway: (on: boolean) => void;
  /**
   * Chats whose Send starts Keep going, in the mode it starts in, by thread key. Absent: Send
   * sends the message once. Not persisted.
   */
  keepGoingPick: Readonly<Record<string, GameRunProfile>>;
  /** The composer's run picker: once, or Keep going in a mode. One excludes the other. */
  pickRun: (
    threadKey: string,
    pick:
      | { readonly kind: "once" }
      | { readonly kind: "keep-going"; readonly profile: GameRunProfile },
  ) => void;
  /** The Workbench beside the game is open, for every game. */
  workbenchOpen: boolean;
  setWorkbenchOpen: (open: boolean) => void;
  /** The Workbench section last shown, for every game. */
  workbenchTab: WorkbenchTab;
  setWorkbenchTab: (tab: WorkbenchTab) => void;
  /** The asset Art shows (a game-relative path, or `thing:<id>` for a model made in code); null lists them all. Not persisted. */
  artAsset: string | null;
  setArtAsset: (asset: string | null) => void;
  /** Opens the Workbench on Art at one asset: the Stage's way to its art. */
  openArtAsset: (asset: string) => void;
  /** The Stage's responsive view, by thread key; absent: the normal Stage. Not persisted. */
  stageDevice: Readonly<Record<string, GameStageDevice>>;
  /** Sets the view's device and size, or (null) leaves the view. */
  setStageDevice: (threadKey: string, device: GameStageDevice | null) => void;
  /** The bar's menu, its key and the palette: into the view as it was last left, or out. */
  toggleStageDevice: (threadKey: string) => void;
}

/** The view as it was last left, so toggling it back on returns to the same device. */
let lastStageDevice = DEFAULT_STAGE_DEVICE;

const without = <T>(record: Readonly<Record<string, T>>, key: string) => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

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
      pauseWhenAway: true,
      setPauseWhenAway: (on) => set({ pauseWhenAway: on }),
      workbenchOpen: false,
      setWorkbenchOpen: (open) => set({ workbenchOpen: open }),
      workbenchTab: "tune",
      setWorkbenchTab: (tab) => set({ workbenchTab: tab }),
      artAsset: null,
      setArtAsset: (asset) => set({ artAsset: asset }),
      openArtAsset: (asset) => set({ workbenchOpen: true, workbenchTab: "art", artAsset: asset }),
      stageDevice: {},
      setStageDevice: (threadKey, device) =>
        set((state) => {
          if (device === null) return { stageDevice: without(state.stageDevice, threadKey) };
          openGameTool("responsive");
          lastStageDevice = device;
          return { stageDevice: { ...state.stageDevice, [threadKey]: device } };
        }),
      toggleStageDevice: (threadKey) => {
        openGameTool("responsive");
        set((state) => ({
          stageDevice:
            state.stageDevice[threadKey] === undefined
              ? { ...state.stageDevice, [threadKey]: lastStageDevice }
              : without(state.stageDevice, threadKey),
        }));
      },

      keepGoingPick: {},
      pickRun: (threadKey, pick) => {
        if (pick.kind !== "once") openGameTool("keep-going");
        set((state) => ({
          keepGoingPick:
            pick.kind === "keep-going"
              ? { ...state.keepGoingPick, [threadKey]: pick.profile }
              : without(state.keepGoingPick, threadKey),
        }));
      },
    }),
    {
      name: "kurambit:game-workspace:v7",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        chatShare: state.chatShare,
        gameHidden: state.gameHidden,
        pauseWhenAway: state.pauseWhenAway,
        workbenchOpen: state.workbenchOpen,
        workbenchTab: state.workbenchTab,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<GameWorkspaceStoreState> | null;
        return {
          ...current,
          chatShare: clampGameChatShare(saved?.chatShare ?? current.chatShare),
          gameHidden: saved?.gameHidden === true,
          pauseWhenAway: saved?.pauseWhenAway !== false,
          workbenchOpen: saved?.workbenchOpen === true,
          workbenchTab: isWorkbenchTab(saved?.workbenchTab) ? saved.workbenchTab : "tune",
        };
      },
    },
  ),
);
