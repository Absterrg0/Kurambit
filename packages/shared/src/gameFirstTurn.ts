/**
 * The instruction line Kurambit puts after the person's brief in a new game's first message. It
 * names AGENTS.md because some providers (Grok, Antigravity) do not load it by themselves. When
 * the engine has first-turn steps, they follow the line in the same message. Both are the
 * harness talking to the agent, so the Log shows the brief without them.
 */
export const FIRST_TURN_LEADS = {
  brief: "Make this game. Read AGENTS.md first.",
  steps: 'Make this game. Read AGENTS.md first, then follow "The first turn" below.',
} as const;

// Games made before the first turn's steps moved from AGENTS.md into the message.
const EARLIER_LEADS = ['Make this game. Follow "The first turn" in AGENTS.md.'];

const LEADS: ReadonlySet<string> = new Set([...Object.values(FIRST_TURN_LEADS), ...EARLIER_LEADS]);

/** The first turn's instruction line, which names no game. */
export const isFirstTurnLead = (line: string): boolean => LEADS.has(line.trim());

/** A first message as the person wrote it: the brief, without the harness's instructions after it. */
export const withoutFirstTurnLead = (text: string): string => {
  const paragraphs = text.split("\n\n");
  const lead = paragraphs.findIndex((paragraph, index) => index > 0 && isFirstTurnLead(paragraph));
  return lead === -1 ? text : paragraphs.slice(0, lead).join("\n\n");
};
