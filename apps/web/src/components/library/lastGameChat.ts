import type { ScopedThreadRef } from "@kurambit/contracts";
import { create } from "zustand";

/**
 * The game chat the person was last on, so the Library (a page of its own) knows the current
 * game: Add to game lists it first, and Ask about this puts its chip in that chat's composer.
 */
export const useLastGameChat = create<{
  chat: ScopedThreadRef | null;
  projectId: string | null;
  set: (chat: ScopedThreadRef, projectId: string) => void;
}>((set) => ({
  chat: null,
  projectId: null,
  set: (chat, projectId) => set({ chat, projectId }),
}));
