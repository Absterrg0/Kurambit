import type { GameDecision } from "@kurambit/contracts";

/** A run of words, or a colour the line shows as a swatch rather than its hex. */
export type DecisionPiece =
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "colour"; readonly hex: string };

/** One line of Checks' Decisions: what it says, and the file's lines forgetting it removes. */
export interface DecisionRow {
  readonly key: string;
  readonly pieces: ReadonlyArray<DecisionPiece>;
  /** The line as plain words, for its accessible name. */
  readonly said: string;
  readonly lines: ReadonlyArray<GameDecision>;
}

const HEX = /#[0-9a-f]{6}\b/gi;
const text = (value: string): DecisionPiece => ({ _tag: "text", text: value });

/** Words with each "#rrggbb" in them as a swatch. */
const withSwatches = (words: string): ReadonlyArray<DecisionPiece> => {
  const pieces: DecisionPiece[] = [];
  let from = 0;
  for (const match of words.matchAll(HEX)) {
    if (match.index > from) pieces.push(text(words.slice(from, match.index)));
    pieces.push({ _tag: "colour", hex: match[0].toLowerCase() });
    from = match.index + match[0].length;
  }
  if (from < words.length) pieces.push(text(words.slice(from)));
  return pieces;
};

/** "Island › Cabin roof colour #3c4a5c → #b8322a" as who changed and from what to what. */
const SEGMENT = /^(.+) (\S+) → (\S+)$/;
const segmentsOf = (body: string) =>
  body.split("; ").flatMap((part) => {
    const match = SEGMENT.exec(part.trim());
    if (match === null) return [];
    const isColour = match[2]!.startsWith("#") && match[3]!.startsWith("#");
    // The path's holders and a colour's own word go: the swatch says it is a colour.
    const name = match[1]!.split(" › ").at(-1)!;
    const who = isColour ? name.replace(/ colou?r$/, "") : name;
    return [{ who, from: match[2]!, to: match[3]! }];
  });

const change = (from: string, to: string): ReadonlyArray<DecisionPiece> => [
  ...withSwatches(from),
  text(" → "),
  ...withSwatches(to),
];

/** The words after a harness line's "Kept tuned values as Build 2: " or "Undid Build 2: ". */
const bodyOf = (line: string) => line.slice(line.indexOf(": ") + 2);

const saidOf = (pieces: ReadonlyArray<DecisionPiece>) =>
  pieces.map((piece) => (piece._tag === "text" ? piece.text : piece.hex)).join("");

/**
 * PURE. The decisions as Checks shows them, newest first: each phrased for a person ("Cabin
 * roof: kept ■ → ■", "Undid: Cabin roof ■ → ■"), colours as swatches, and a keep that was
 * later undone folded into its undo's line. What the file holds for the agent is unchanged.
 */
export const decisionRows = (
  decisions: ReadonlyArray<GameDecision>,
): ReadonlyArray<DecisionRow> => {
  const undone = new Set(
    decisions.flatMap((each) =>
      each.kind === "undone" && each.build !== undefined ? [each.build] : [],
    ),
  );
  const keptBy = new Map(
    decisions.flatMap((each) =>
      each.kind === "kept-values" && each.build !== undefined ? [[each.build, each] as const] : [],
    ),
  );
  const rows: DecisionRow[] = [];
  for (const decision of decisions.toReversed()) {
    // Shown with the undo that took it back.
    if (
      decision.kind === "kept-values" &&
      decision.build !== undefined &&
      undone.has(decision.build)
    )
      continue;
    let pieces: ReadonlyArray<DecisionPiece>;
    const lines: GameDecision[] = [decision];
    if (decision.kind === "kept-values") {
      const segments = segmentsOf(bodyOf(decision.text));
      pieces =
        segments.length === 0
          ? withSwatches(decision.text)
          : segments.flatMap((segment, index) => [
              ...(index === 0 ? [] : [text(" · ")]),
              text(`${segment.who}: kept `),
              ...change(segment.from, segment.to),
            ]);
    } else if (decision.kind === "undone") {
      const body = bodyOf(decision.text);
      const segments = body.startsWith("tuned ") ? segmentsOf(body.slice("tuned ".length)) : [];
      pieces = [
        text("Undid: "),
        ...(segments.length === 0
          ? withSwatches(body)
          : segments.flatMap((segment, index) => [
              ...(index === 0 ? [] : [text(", ")]),
              text(`${segment.who} `),
              ...change(segment.from, segment.to),
            ])),
      ];
      const kept = decision.build === undefined ? undefined : keptBy.get(decision.build);
      if (kept !== undefined) lines.push(kept);
    } else pieces = withSwatches(decision.text);
    rows.push({ key: `${decision.line}:${decision.text}`, pieces, said: saidOf(pieces), lines });
  }
  return rows;
};
