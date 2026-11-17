import {
  engineDisplayName,
  gameEngineEntry,
  type GameThingValue,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { useThreadStageBridge } from "./gameStageBridge";

// ─── Scene ────────────────────────────────────────────────────────────────────

/**
 * Why there is nothing to select, said as what is true now: this engine or this game's shell
 * cannot point at things, the game is not on the Stage, or it has not answered yet. Null when
 * selecting works, and the list itself says whether it is empty.
 */
export function useSelectNotice(
  threadRef: ScopedThreadRef,
): { readonly title: string; readonly body: string } | null {
  const engine = useIsGameThreadStatus(threadRef).data?.manifest.engine.name ?? null;
  const status = useThreadStageBridge(scopedThreadKey(threadRef), (state) => state.status, null);
  if (engine !== null && gameEngineEntry(engine)?.stageBridge !== true)
    return {
      title: "Not in this engine yet",
      body: `Pointing at things in the running game is not in ${engineDisplayName(engine)} yet.`,
    };
  if (status === "none")
    return {
      title: "This game's shell is older",
      body: "Pointing at things needs the newer game shell, which games made from now on have. Freeze still pauses this one.",
    };
  if (status === null)
    return {
      title: "Play the game to tune it",
      body: "Its speeds, jump height, timers and counts show here while it runs on the Stage, to change as you play.",
    };
  if (status === "waiting")
    return {
      title: "Waiting for the game",
      body: "The game is starting. Its named things show here once it answers.",
    };
  return null;
}

/** Short words a player writes in capitals: "maxHp" reads "Max HP". */
const VALUE_ACRONYMS: ReadonlySet<string> = new Set([
  "hp",
  "xp",
  "mp",
  "ap",
  "fov",
  "ai",
  "ui",
  "hud",
  "fps",
  "npc",
  "dps",
]);

/** A value's name as a person reads it: the game's label, else its key in words ("dashCooldown" → "Dash cooldown"). */
export const valueLabel = (value: GameThingValue) => {
  if (value.label !== undefined) return value.label;
  const words = value.key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((word) => (VALUE_ACRONYMS.has(word) ? word.toUpperCase() : word))
    .join(" ");
  return words.length === 0 ? value.key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};
