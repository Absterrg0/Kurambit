import { gameNextLine } from "@kurambit/shared/gameNextLine";

/**
 * The agent's `Next:` line, after a settled turn whose reply proposes a change. It is the
 * composer's placeholder, with "Ask for it" beside the composer to put it in the box to edit or
 * send, so it takes no row above the composer. Pass `null` while a turn runs or off game threads.
 */
export function useGameNext(
  reply: { readonly key: string; readonly text: string } | null,
): string | null {
  return reply === null ? null : gameNextLine(reply.text);
}
