// Markdown an agent may wrap the line in: a list marker, a quote, emphasis.
const LINE_PREFIX = /^(?:[-*+>]\s+)*(?:[*_]{1,2})?/;
const NEXT = /^next(?:[*_]{1,2})?\s*:\s*(?:[*_]{1,2}\s*)?(.*)$/i;
const TRAILING_EMPHASIS = /\s*[*_]{1,2}$/;

/**
 * The change a game's agent proposes next: its reply's last line,
 * `Next: <text>`, as the game's AGENTS.md asks. `Next: none` (the brief is
 * done) and a reply that ends otherwise propose nothing.
 */
export function gameNextLine(reply: string): string | null {
  const last = reply.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const match = NEXT.exec(last.replace(LINE_PREFIX, ""));
  if (match === null) return null;
  const text = (match[1] ?? "").replace(TRAILING_EMPHASIS, "").trim();
  if (text === "" || /^none\.?$/i.test(text)) return null;
  return text;
}
