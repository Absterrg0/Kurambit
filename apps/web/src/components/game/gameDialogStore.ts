import { create } from "zustand";

/** What the home screen's brief box hands the New game dialog. */
export type GameDraft = { readonly brief: string; readonly engine: "godot" | "three" };

export const useGameDialogStore = create<{
  dialog: "create" | "open" | null;
  draft: GameDraft | null;
  show: (dialog: "create" | "open" | null) => void;
  startCreate: (draft: GameDraft) => void;
}>((set) => ({
  dialog: null,
  draft: null,
  show: (dialog) => set({ dialog, draft: null }),
  startCreate: (draft) => set({ dialog: "create", draft }),
}));
