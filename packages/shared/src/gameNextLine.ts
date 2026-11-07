// Markdown an agent may wrap the line in: a list marker, a quote, emphasis.
const LINE_PREFIX = /^(?:[-*+>]\s+)*(?:[*_]{1,2})?/;
const NEXT = /^next(?:[*_]{1,2})?\s*:\s*(?:[*_]{1,2}\s*)?(.*)$/i;
const TRAILING_EMPHASIS = /\s*[*_]{1,2}$/;

/**
 * The change a game's agent proposes next: its reply's last line,
 * `Next: <text>`, as the game's AGENTS.md asks. "none" when the agent says
 * the brief is done (`Next: none`), null when the reply ends otherwise. The
 * Next banner and keep going's look both read it here, so the person sees
 * exactly the line the run acts on.
 */
export const readNextLine = (reply: string): { readonly text: string } | "none" | null => {
  const last = reply.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const match = NEXT.exec(last.replace(LINE_PREFIX, ""));
  if (match === null) return null;
  const text = (match[1] ?? "").replace(TRAILING_EMPHASIS, "").trim();
  if (text === "") return null;
  if (/^none\.?$/i.test(text)) return "none";
  return { text };
};

/** The banner's reading: the proposed text, or null for "none" and for no line. */
export const gameNextLine = (reply: string): string | null => {
  const next = readNextLine(reply);
  return next === null || next === "none" ? null : next.text;
};
