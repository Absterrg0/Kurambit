import { type GameSummary } from "@kurambit/contracts";

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

// Words that frame a brief rather than name the game: "can you please create a…", "I'd like to make…".
const NAME_FRAMING =
  /^(?:(?:hey|hi|hello|ok|okay|can|could|would|you|pls|please|kindly|let'?s|(?:i|we)(?:'?d|\s+would)\s+(?:like|love)|i|we|want|need|to|make|build|create|design|write|generate|give|me|us|a|an|the|some)\s+)+/;
// A clause break: punctuation, or a word that starts the brief's details.
const NAME_CLAUSE_END = /[,.;:!?()\n]|\s(?:with|where|that|which|who|and|but|while|until|so)\s/;
const NAME_PREPOSITIONS = new Set([
  "on",
  "in",
  "at",
  "into",
  "onto",
  "inside",
  "through",
  "under",
  "over",
  "across",
  "down",
  "up",
  "along",
  "around",
  "about",
  "beneath",
  "below",
  "above",
  "between",
  "from",
  "to",
  "of",
  "for",
  "by",
  "near",
  "beyond",
  "within",
  "set",
]);
const NAME_SKIP = new Set([
  "a",
  "an",
  "the",
  "game",
  "games",
  "your",
  "my",
  "our",
  "its",
  "their",
  "really",
  "very",
  "super",
  "extremely",
]);

const titleWord = (word: string) =>
  word
    .split("-")
    .map((part) => (part === "" ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join("-");

/**
 * PURE. A short title for a brief, the person's to edit before Start: the
 * brief's opening words (what kind of game) and the main noun of the place or
 * thing that follows ("A cozy fishing game on a floating island at dusk" is
 * "Cozy Fishing Island"). Empty when the brief has no words to use.
 */
const NAME_FILLER = new Set([
  "will",
  "would",
  "should",
  "can",
  "be",
  "is",
  "are",
  "it",
  "related",
  "basically",
  "really",
  "very",
  "kind",
  "sort",
  "like",
  "just",
]);

const nameWords = (clause: string) =>
  clause
    .replace(NAME_FRAMING, "")
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9'-]/g, "").replace(/^[-']+|[-']+$/g, ""))
    .filter((word) => word !== "");

export const draftGameName = (brief: string): string => {
  const [first = "", second = ""] = brief.trim().toLowerCase().split(NAME_CLAUSE_END);
  // Phrases between prepositions: the first says what the game is, the next where or what.
  const phrases: string[][] = [[]];
  for (const word of nameWords(first)) {
    if (NAME_PREPOSITIONS.has(word)) phrases.push([]);
    else if (!NAME_SKIP.has(word)) phrases.at(-1)!.push(word);
  }
  const [lead = [], ...rest] = phrases.filter((phrase) => phrase.length > 0);
  const place = rest[0]?.at(-1);
  const name = [
    ...lead.slice(0, place === undefined ? 3 : 2),
    ...(place === undefined ? [] : [place]),
  ];
  // "A cozy game which will be fishing related": one word says too little, so
  // the next clause's first real words finish the name.
  if (name.length === 1)
    name.push(
      ...nameWords(second)
        .filter((word) => !NAME_SKIP.has(word) && !NAME_FILLER.has(word))
        .slice(0, 1),
    );
  return name.map(titleWord).join(" ").slice(0, 60).trim();
};

export const sortGameSummaries = <T extends GameSummary>(games: readonly T[]): T[] =>
  [...games].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.name.localeCompare(right.name),
  );

/**
 * A chat's title as the sidebar, the top bar and Checks say it. Kurambit once titled a game's
 * chats with the game's name, which every one of those places already says beside it: such a chat
 * nobody wrote in yet is a new chat, and one with messages is the chat the game was made in.
 */
export const chatTitle = (
  chat: { readonly title: string; readonly latestUserMessageAt: string | null },
  gameName: string,
): string => {
  const title = chat.title.trim();
  if (title !== "" && title !== gameName.trim()) return title;
  return chat.latestUserMessageAt === null ? "New chat" : "First chat";
};
