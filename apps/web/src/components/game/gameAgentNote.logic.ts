import type { TimelineEntry, WorkLogEntry } from "../../session-logic";

/** The one line the direction bar says for the agent. */
export interface GameAgentNote {
  readonly text: string;
  /** The agent is at work: the note is its latest step, with the turn's elapsed time. */
  readonly live: boolean;
  readonly since: number | null;
}

/** Markdown read as plain words: emphasis, code ticks, links and headings dropped. */
const plain = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_](\S)/g, "$1$2")
    .replace(/(\S)[*_](?=\s|[.,;:!?]|$)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-+]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

/** The first sentences that fit two lines, at most `max` characters. */
const leadSentences = (text: string, max = 220): string => {
  const words = plain(text);
  // A sentence ends at . ! or ? before a capital, so "0.8" and "e.g. this" stay whole.
  const sentences = words.split(/(?<=[.!?])\s+(?=["'“(]?[A-Z])/);
  let lead = "";
  for (const sentence of sentences) {
    const next = `${lead}${lead === "" ? "" : " "}${sentence.trim()}`;
    if (next.length > max && lead !== "") break;
    lead = next;
    if (lead.length >= max * 0.6) break;
  }
  return lead.length > max ? `${lead.slice(0, max - 1).trimEnd()}…` : lead;
};

const fileName = (path: string) => path.split(/[/\\]/).at(-1) ?? path;

/** A work step in a person's words: never a tool's own name. */
const activity = (entry: WorkLogEntry): string | null => {
  if (entry.itemType === "reasoning" || entry.tone === "thinking") return "Thinking";
  const changed = entry.changedFiles?.[0];
  if (changed !== undefined)
    return entry.changedFiles!.length === 1
      ? `Editing ${fileName(changed)}`
      : `Editing ${fileName(changed)} and ${entry.changedFiles!.length - 1} more`;
  if (entry.command !== undefined) return "Running a command";
  if (entry.itemType === "file_search" || entry.itemType === "web_search")
    return "Looking things up";
  if (entry.tone === "tool") return "Working on the game";
  return null;
};

/**
 * PURE. The agent's note: while it works, its newest step in the current turn
 * (its words when they are the newest thing, else what it is doing); idle,
 * the opening of its last reply in the latest turn.
 */
export const gameAgentNote = (
  entries: ReadonlyArray<TimelineEntry>,
  working: boolean,
  since: number | null,
): GameAgentNote | null => {
  // A step that names nothing ("Thinking") gives way to the agent's own last words in the turn.
  let vague: string | null = null;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.kind === "message") {
      const message = entry.message;
      // The turn's start: nothing older belongs to this turn.
      if (message.role === "user") break;
      if (message.role !== "assistant" || message.text.trim() === "") continue;
      return { text: leadSentences(message.text), live: working, since: working ? since : null };
    }
    if (working && vague === null && entry.kind === "work") {
      const text = activity(entry.entry);
      if (text !== null && text.startsWith("Editing ")) return { text, live: true, since };
      vague = text;
    }
  }
  return working ? { text: vague ?? "Working on it", live: true, since } : null;
};
