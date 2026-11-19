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
 * Why Tune has nothing to list, in one line that is true now: this engine or this game's shell
 * cannot tune, the game is not on the Stage, or it has not answered yet. Null when tuning works,
 * and the list itself says whether it is empty.
 */
export function useSelectNotice(threadRef: ScopedThreadRef): string | null {
  const engine = useIsGameThreadStatus(threadRef).data?.manifest.engine.name ?? null;
  const status = useThreadStageBridge(scopedThreadKey(threadRef), (state) => state.status, null);
  if (engine !== null && gameEngineEntry(engine)?.stageBridge !== true)
    return `Tuning is not in ${engineDisplayName(engine)} yet.`;
  if (status === "none") return "Tuning needs the newer game shell.";
  if (status === null) return "Tunable numbers appear here while the game plays.";
  if (status === "waiting") return "Waiting for the game.";
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
