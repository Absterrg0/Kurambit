import type { GameRecipeTryInput } from "@t3tools/contracts";

/**
 * One Godot reference as the catalog stores it. The engine and pinned version
 * live in the adapter map, so a module only owns the scene code, its boot/reset
 * instructions and the input route that demonstrates it.
 */
export interface GodotRecipeReference {
  readonly setup: string;
  readonly referenceCode: string;
  readonly tryInput: GameRecipeTryInput;
}
