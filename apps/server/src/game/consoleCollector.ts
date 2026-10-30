import type { GameConsoleMessage } from "@t3tools/contracts";

/**
 * Bounded console retention with honest error accounting. The retained text
 * is a ring of the newest messages, but the error total counts every error
 * ever recorded, so an engine error emitted after forty ordinary logs still
 * fails the run even though its text was not kept. Late errors displace the
 * oldest retained non-error first, so a salient failure is preserved when
 * the bound allows; truncation is always reported, never silent.
 */
export interface ConsoleCollector {
  readonly record: (level: GameConsoleMessage["level"], text: string) => void;
  readonly messages: () => GameConsoleMessage[];
  /** Every error recorded, including ones dropped from the retained text. */
  readonly totalErrors: () => number;
  /** Retained messages dropped by the bound, oldest first. */
  readonly dropped: () => number;
  /** Returns retained messages plus the drop count, then clears both. */
  readonly drain: () => { readonly messages: GameConsoleMessage[]; readonly dropped: number };
}

export const createConsoleCollector = (input: {
  readonly maxMessages: number;
  readonly maxChars: number;
}): ConsoleCollector => {
  const retained: GameConsoleMessage[] = [];
  let errors = 0;
  let dropped = 0;
  return {
    record: (level, text) => {
      const message: GameConsoleMessage = { level, text: text.slice(0, input.maxChars) };
      if (level === "error") errors += 1;
      if (retained.length >= input.maxMessages) {
        if (level === "error") {
          // A late error is salient: displace the oldest retained non-error
          // so the failure stays visible when the bound allows it.
          const ordinary = retained.findIndex((entry) => entry.level !== "error");
          if (ordinary !== -1) {
            retained.splice(ordinary, 1);
            dropped += 1;
            retained.push(message);
            return;
          }
        }
        retained.shift();
        dropped += 1;
      }
      retained.push(message);
    },
    messages: () => [...retained],
    totalErrors: () => errors,
    dropped: () => dropped,
    drain: () => {
      const fresh = [...retained];
      const missed = dropped;
      retained.length = 0;
      dropped = 0;
      return { messages: fresh, dropped: missed };
    },
  };
};
