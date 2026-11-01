import { create } from "zustand";

export const useGameDialogStore = create<{
  dialog: "create" | "open" | null;
  show: (dialog: "create" | "open" | null) => void;
}>((set) => ({
  dialog: null,
  show: (dialog) => set({ dialog }),
}));
