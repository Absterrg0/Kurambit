// Bot kit: the idle tier. Starts a run, then sends no input at all: does the
// game end on its own, and when? (SWE-Game's no-input control.)
import { makeTier } from "./tier.mjs";

const tier = makeTier("idle", () => []);
export const { goal, observe, options, status } = tier;
export { stallSeconds } from "./tier.mjs";
