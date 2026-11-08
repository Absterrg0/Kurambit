import { GAME_ENGINES, type GameSummary } from "@kurambit/contracts";

export interface GameTemplateAppearance {
  readonly label: string;
  readonly initialClassName: string;
  readonly coverClassName: string;
}

export const gameTemplateAppearance = (
  template: GameSummary["template"],
): GameTemplateAppearance => {
  // Games from before templates were Godot games.
  const engine =
    Object.values(GAME_ENGINES).find((entry) => entry.template === template) ?? GAME_ENGINES.godot;
  return {
    // A parked engine's game says so on its card, not only once it is opened.
    label: engine.status === "parked" ? `${engine.name} · paused` : engine.name,
    initialClassName: "bg-foreground/8 text-foreground/80",
    coverClassName: "from-foreground/10 via-foreground/5 to-transparent",
  };
};

/** Traditional ink pigments for game covers: indigo, moss, ochre, vermilion, wisteria, sumi. */
const GAME_PIGMENTS = [
  ["#2c3b5c", "#121826"],
  ["#3f4f31", "#161c12"],
  ["#7a5524", "#21170a"],
  ["#8a3418", "#24100a"],
  ["#4d3a5c", "#1a1320"],
  ["#45403a", "#151310"],
] as const;

/** A stable pigment per game, so a cover keeps its color across sessions and machines. */
export const gamePigment = (name: string): readonly [string, string] => {
  // FNV-1a: short names still spread across the palette.
  let hash = 0x811c9dc5;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return GAME_PIGMENTS[hash % GAME_PIGMENTS.length]!;
};

/** The New game dialog and the server derive the folder name the same way. */
export const gameSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const gameInitial = (name: string): string => {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .filter((letter): letter is string => letter !== undefined)
    .join("");
  return (letters || "G").slice(0, 2).toUpperCase();
};

export const sortGameSummaries = <T extends GameSummary>(games: readonly T[]): T[] =>
  [...games].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.name.localeCompare(right.name),
  );

export const sortGameThreadsByActivity = <T extends { readonly updatedAt: string }>(
  threads: readonly T[],
): T[] =>
  [...threads].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

/** Newest session per game, the row a game click should open. */
export const newestThreadByProject = <
  T extends { readonly projectId: string; readonly updatedAt: string },
>(
  threads: readonly T[],
): ReadonlyMap<string, T> => {
  const newest = new Map<string, T>();
  for (const thread of threads) {
    const current = newest.get(thread.projectId);
    if (current === undefined || Date.parse(thread.updatedAt) > Date.parse(current.updatedAt))
      newest.set(thread.projectId, thread);
  }
  return newest;
};
