import type { GameStatus, GameSubmissionFacts } from "../../packages/contracts/src/index.ts";

export const assertSelectedBuildComplete = (
  label: string,
  status: Pick<GameStatus, "selectedBuildId" | "selectedArtifactUsable">,
  facts: GameSubmissionFacts | null | undefined,
): void => {
  if (status.selectedBuildId === null || status.selectedArtifactUsable !== true)
    throw new Error(`${label}: the selected artifact is missing or unusable.`);
  if (facts == null) throw new Error(`${label}: the selected build has no submission facts.`);
  if (facts.buildId !== status.selectedBuildId)
    throw new Error(`${label}: the facts describe a different build than Play selected.`);
  if (!facts.passed)
    throw new Error(
      `${label}: the selected build failed submission facts: ${facts.reason ?? "unverified build"}`,
    );
};
