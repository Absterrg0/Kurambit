import type { GameTemplateId } from "@t3tools/contracts";
import { create } from "zustand";

export const useGameDialogStore = create<{
  dialog: "create" | "open" | null;
  /** Starter picked by a card; null means the New game default. */
  template: GameTemplateId | null;
  show: (dialog: "create" | "open" | null, template?: GameTemplateId) => void;
}>((set) => ({
  dialog: null,
  template: null,
  // Any other entry point clears the previous card's choice, so reopening
  // create or opening a folder cannot inherit a stale starter.
  show: (dialog, template) =>
    set({ dialog, template: dialog === "create" ? (template ?? null) : null }),
}));
