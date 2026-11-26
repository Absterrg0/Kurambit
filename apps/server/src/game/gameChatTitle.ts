import { replaceComposerContextReferences } from "@kurambit/shared/composerContextReferences";
import { withoutFirstTurnLead } from "@kurambit/shared/gameFirstTurn";
import { truncate } from "@kurambit/shared/String";

/** PURE. Whether a chat's stored title is only its game's name (or nothing), in any of its names. */
export const namedAfterGame = (title: string, gameNames: ReadonlyArray<string>): boolean => {
  const trimmed = title.trim();
  return trimmed === "" || gameNames.some((name) => name.trim() === trimmed);
};

/**
 * PURE. The title for a chat Kurambit once titled with its game's name, from the chat's own
 * first message: the person's words (a brief without the harness's lead after it, a context
 * chip as its label), their first line, cut as T3 cuts a title seed. Null when the chat keeps
 * its title: it is not named after its game, nobody wrote in it, or its first message gives
 * nothing that says more than the game's name.
 */
export const titleFromFirstMessage = (input: {
  readonly title: string;
  /** The name the game has now and the one it was made with. */
  readonly gameNames: ReadonlyArray<string>;
  readonly firstMessage: string | null;
}): string | null => {
  if (input.firstMessage === null || !namedAfterGame(input.title, input.gameNames)) return null;
  const words = replaceComposerContextReferences(
    withoutFirstTurnLead(input.firstMessage),
    (reference) => reference.label,
  );
  const line = words
    .split("\n")
    .map((each) => each.trim().replace(/\s+/gu, " "))
    .find((each) => each !== "");
  const title = truncate(line ?? "");
  return title === "" || namedAfterGame(title, input.gameNames) ? null : title;
};

/** A name: capitalised words, joined by the small words titles keep lower case. */
const NAME_WORD = String.raw`[\p{Lu}\p{N}][\p{L}\p{N}'’&!-]*`;
const NAMED_IN_BRIEF = new RegExp(
  String.raw`\b(?:[Gg]ame|[Ii]t|[Tt]his one)(?:'s|’s| is)?(?:\s+[\p{Ll}\d-]+){0,1}\s+(?:called|named|titled)\s+` +
    String.raw`(?:["“'‘]([^"”'’\n]{1,60})["”'’]|(${NAME_WORD}(?:\s+(?:(?:of|the|and|in|on|a|an|to|for|at)\s+)*${NAME_WORD}){0,5}))`,
  "u",
);

/**
 * PURE. The name a brief gives its game ("a puzzle game called Prism Isles", "it's called
 * \"Hive Breaker\""), else null. Read from the words rather than left to the naming model,
 * which sometimes invents its own over the person's.
 */
export const nameInBrief = (brief: string): string | null => {
  const match = NAMED_IN_BRIEF.exec(brief);
  const name = (match?.[1] ?? match?.[2] ?? "").trim();
  return name === "" ? null : name;
};
