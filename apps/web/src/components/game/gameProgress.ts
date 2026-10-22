import type { GameSummary } from "@t3tools/contracts";

import { formatGameEditedAgo } from "./gameLibrary.logic";

export type GameProgressKind =
  | "drafting"
  | "design-changed"
  | "building"
  | "unqualified"
  | "qualified";

export interface GameProgress {
  readonly kind: GameProgressKind;
  /** Short text for a sidebar row or a library card badge. */
  readonly label: string;
  /** One sentence for a tooltip or aria description. */
  readonly detail: string;
}

/**
 * The library's status line, derived from server-owned state only. "Qualified"
 * is the record's verdict as of when it was written, not a fresh source check;
 * the Stage re-checks the files and may downgrade it. A running operation wins
 * over everything else because it is what the game is doing right now.
 */
export const gameProgress = (
  summary: Pick<GameSummary, "designState" | "operation" | "qualification">,
  now = Date.now(),
): GameProgress => {
  const operation = summary.operation;
  if (operation?.state === "running")
    return {
      kind: "building",
      label: "Building",
      detail: `${operation.name} is running.`,
    };
  if (summary.designState === "draft")
    return {
      kind: "drafting",
      label: "Design draft",
      detail: "The design is still a draft. Review and approve it on the Design tab.",
    };
  if (summary.designState === "changed")
    return {
      kind: "design-changed",
      label: "Design changed",
      detail: "The design changed after approval. Review the new revision on the Design tab.",
    };
  if (summary.qualification.completion === "complete") {
    const ago =
      summary.qualification.asOf === null
        ? null
        : formatGameEditedAgo(summary.qualification.asOf, now);
    const certified = summary.qualification.state === "qualified";
    return {
      kind: "qualified",
      label: certified
        ? ago === null
          ? "Qualified"
          : `Qualified as of ${ago}`
        : ago === null
          ? "Playable"
          : `Playable as of ${ago}`,
      detail: certified
        ? "A web export and its playtest are current, and the optional test, state and visual certification passed when this record was written."
        : "A web export and its playtest are current. Test, state and visual are optional certification; their absence does not make the game incomplete.",
    };
  }
  return {
    kind: "unqualified",
    label: "Unqualified",
    detail: "No current playable build exists for these sources yet.",
  };
};
