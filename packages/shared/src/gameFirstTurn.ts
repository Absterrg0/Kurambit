/**
 * The instruction line Kurambit ends a new game's first message with, after the person's brief.
 * It names AGENTS.md because some providers (Grok, Antigravity) do not load it by themselves. It
 * is the harness talking to the agent, so the Log shows the brief without it.
 */
export const FIRST_TURN_LEADS = [
  "Make this game. Read AGENTS.md first.",
  'Make this game. Follow "The first turn" in AGENTS.md.',
] as const;

/** The first turn's instruction line, which names no game. */
export const isFirstTurnLead = (line: string): boolean =>
  (FIRST_TURN_LEADS as ReadonlyArray<string>).includes(line.trim());

/** A first message as the person wrote it: the brief, without the closing instruction line. */
export const withoutFirstTurnLead = (text: string): string => {
  const at = text.lastIndexOf("\n\n");
  return at !== -1 && isFirstTurnLead(text.slice(at + 2)) ? text.slice(0, at) : text;
};
