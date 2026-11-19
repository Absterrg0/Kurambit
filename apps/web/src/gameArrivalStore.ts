import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * The game screen's tools beyond the game, the chat and Undo. Each arrives when a game first has
 * something for it (useGameArrivals), and from then on stays where the person met it. The
 * Workbench's sections are always there; arriving only gives them their dot.
 */
const GAME_TOOLS = [
  "tune",
  "art",
  "checks",
  "test-plays",
  "try-ways",
  "keep-going",
  "library",
  "responsive",
  // A copy: met when a chat of a game first works in one (Run in a copy). It brings the
  // new-chat choice "in a copy", with no dot.
  "copies",
] as const;
export type GameTool = (typeof GAME_TOOLS)[number];

const isTool = (tool: unknown): tool is GameTool =>
  (GAME_TOOLS as ReadonlyArray<unknown>).includes(tool);

interface GameArrivalState {
  /** Tools the person has met: shown from then on, in every game. */
  met: ReadonlyArray<GameTool>;
  /** Tools whose one-time dot has cleared: opened at least once since they arrived. */
  opened: ReadonlyArray<GameTool>;
  meet: (tool: GameTool) => void;
  open: (tool: GameTool) => void;
}

const KEY = "kurambit:game-arrivals:v1";

/**
 * Someone who used the game screen before tools arrived has met them all: nothing they know
 * disappears or gains a dot. A new person's record is written at once, so this reads them as new
 * on every later start too.
 */
const metBefore = (() => {
  if (typeof window === "undefined") return false;
  try {
    const storage = window.localStorage;
    if (storage.getItem(KEY) !== null) return false;
    const before = storage.getItem("kurambit:game-workspace:v7") !== null;
    const all = before ? GAME_TOOLS : [];
    storage.setItem(KEY, JSON.stringify({ state: { met: all, opened: all }, version: 0 }));
    return before;
  } catch {
    return false;
  }
})();

/** Per person, not per game: a tool met in one game is where they left it in the next. */
export const useGameArrivalStore = create<GameArrivalState>()(
  persist(
    (set) => ({
      met: metBefore ? GAME_TOOLS : [],
      opened: metBefore ? GAME_TOOLS : [],
      meet: (tool) =>
        set((state) => (state.met.includes(tool) ? state : { met: [...state.met, tool] })),
      // Opening a tool meets it too: a key or the palette is a way in before its moment.
      open: (tool) =>
        set((state) =>
          state.opened.includes(tool) && state.met.includes(tool)
            ? state
            : {
                met: state.met.includes(tool) ? state.met : [...state.met, tool],
                opened: state.opened.includes(tool) ? state.opened : [...state.opened, tool],
              },
        ),
    }),
    {
      name: KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ met: state.met, opened: state.opened }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<GameArrivalState> | null;
        return {
          ...current,
          met: (saved?.met ?? []).filter(isTool),
          opened: (saved?.opened ?? []).filter(isTool),
        };
      },
    },
  ),
);

/** The tools that say hello with a dot. A copy arrives without one. */
const DOTTED: ReadonlySet<GameTool> = new Set([
  "tune",
  "art",
  "checks",
  "keep-going",
  "try-ways",
  "test-plays",
  "responsive",
  "library",
]);

/**
 * One dot at a time, on the newest thing: the tool met last that has not been opened. An older
 * arrival gets its turn once the newer one has been looked at, so dots never pile up. The
 * Workbench's toggle carries a section's dot while the Workbench is closed.
 */
export const useArrivalDot = (): GameTool | null =>
  useGameArrivalStore(
    (state) =>
      state.met.findLast((tool) => DOTTED.has(tool) && !state.opened.includes(tool)) ?? null,
  );

/** Marks a tool opened: its dot clears for good. Any way in counts: a click, a key, the palette. */
export const openGameTool = (tool: GameTool) => useGameArrivalStore.getState().open(tool);
