/**
 * The text Kurambit's harness hands a game's agent: turn rules, the first turn, the game tools'
 * descriptions and the words their results carry. It lives in `templates/studio/harness/` so a
 * change to what agents read is a text edit, not a code change. JSON, imported, because the
 * same import works in the dev tree, in tests and inlined in the packed server, and tool
 * descriptions are needed when their module loads. Never copied into a game (runSetup).
 */
import firstTurn from "../../templates/studio/harness/first-turn.json" with { type: "json" };
import results from "../../templates/studio/harness/results.json" with { type: "json" };
import tools from "../../templates/studio/harness/tools.json" with { type: "json" };
import turnRules from "../../templates/studio/harness/turn-rules.json" with { type: "json" };

/** A text's `{name}` slots filled; a slot with no value stays as written. */
export const fill = (text: string, values: Readonly<Record<string, string | number | boolean>>) =>
  text.replace(/\{(\w+)\}/g, (slot, name: string) =>
    name in values ? String(values[name]) : slot,
  );

/** A multi-line text kept as one line per array entry, for a readable file. */
const lines = (text: string | ReadonlyArray<string>) =>
  typeof text === "string" ? text : text.join("\n");

export const STUDIO_TEXT = {
  firstTurn,
  results,
  tools,
  turnRules: {
    ...turnRules,
    everyTurn: {
      live: lines(turnRules.everyTurn.live),
      export: lines(turnRules.everyTurn.export),
    },
    scope: lines(turnRules.scope),
    keepGoing: lines(turnRules.keepGoing),
  },
} as const;
