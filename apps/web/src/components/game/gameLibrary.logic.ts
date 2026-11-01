import type { GameSummary } from "@t3tools/contracts";

export interface GameTemplateAppearance {
  readonly label: string;
  readonly initialClassName: string;
  readonly coverClassName: string;
}

export const gameTemplateAppearance = (
  _template: GameSummary["template"],
): GameTemplateAppearance => ({
  label: "Blank",
  initialClassName: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  coverClassName: "from-zinc-500/20 via-zinc-400/10 to-transparent",
});

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

/** A quiet, deterministic "2h ago" used by cards and the qualification label. */
export const formatGameEditedAgo = (timestamp: string, now = Date.now()): string => {
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return "recently";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
};

/** A quiet, deterministic "edited 2h ago" for library cards. */
export const formatGameEditedAt = (timestamp: string, now = Date.now()): string =>
  `edited ${formatGameEditedAgo(timestamp, now)}`;

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
