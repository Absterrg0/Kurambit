import type { GameVisualJudgement } from "@t3tools/contracts";

const DIMENSION_LABELS: Record<string, string> = {
  readability: "readability",
  valueSeparation: "value separation",
  cameraFraming: "camera/framing",
  styleConsistency: "style consistency",
  feedback: "feedback",
  designCompliance: "design compliance",
};

/**
 * The playtest tool result's visual section: the score table and the bounded
 * repair requests, in the form the agent acts on. Pass/fail is the server's
 * rule, never a sentence in the model's reply.
 */
export function formatVisualReport(judgement: GameVisualJudgement): string {
  const lines: string[] = [];
  const verdict =
    judgement.status === "passed"
      ? "passed"
      : judgement.status === "unavailable"
        ? "unavailable"
        : "failed";
  lines.push(`Visual judge (${judgement.model}): ${verdict}.`);
  if (judgement.frames.length > 0)
    lines.push(
      `Frames: ${judgement.frames
        .map((frame) => `${frame.id} ${frame.role} "${frame.label}"`)
        .join(", ")}.`,
    );
  for (const score of judgement.dimensions) {
    const label = DIMENSION_LABELS[score.dimension] ?? score.dimension;
    const value = score.score === "missing" ? "missing" : `${score.score}/4`;
    lines.push(`- ${label} ${value}${score.note === undefined ? "" : ` — ${score.note}`}`);
  }
  if (judgement.status === "unavailable")
    lines.push(
      `The visual stage cannot pass: ${judgement.detail ?? "no reason was recorded"}. The judge is never treated as passed without seeing the game.`,
    );
  else if (judgement.repairRequests.length > 0)
    lines.push(
      `Repair requests:\n${judgement.repairRequests
        .map((request, index) => `${index + 1}. ${request.frame} — ${request.fix}`)
        .join("\n")}`,
    );
  if (judgement.status !== "passed") {
    if (judgement.detail !== undefined) lines.push(`Why: ${judgement.detail}.`);
    lines.push(
      judgement.roundsLeft > 0
        ? "One repair round left: fix only these requests through the palette/kit or camera, re-run export and playtest once, then stop."
        : "No rounds left — visual failed, report it to the creator and stop.",
    );
  }
  return lines.join("\n");
}
