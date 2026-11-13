import type { GameBuildsResult, ScopedThreadRef } from "@kurambit/contracts";
import { AsyncResult } from "effect/reactivity";

import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";

/** The lead checks of the folder's build, as marks: passed, failed, or not read yet. */
export interface StageChecks {
  readonly marks: ReadonlyArray<"pass" | "fail" | "none">;
  readonly pass: number;
  readonly of: number;
}

const stageChecksOf = (
  result: AsyncResult.AsyncResult<GameBuildsResult, unknown>,
): StageChecks | null => {
  if (!AsyncResult.isSuccess(result)) return null;
  const build = result.value.builds.find((each) => each.id === result.value.current);
  const lead = build?.facts.lead;
  if (lead === undefined) return null;
  const measured = lead.measured ?? [];
  const passing = new Set(lead.passing ?? []);
  const marks = Array.from({ length: lead.of }, (_, index): StageChecks["marks"][number] => {
    const id = measured[index];
    return id === undefined ? "none" : passing.has(id) ? "pass" : "fail";
  });
  return { marks, pass: lead.pass, of: lead.of };
};

export const useStageChecks = (threadRef: ScopedThreadRef) =>
  useEnvironmentQuerySelector(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    stageChecksOf,
  ) ?? null;

/** One small square per lead check, coloured by how it read. */
export function CheckMarks({ checks }: { checks: StageChecks }) {
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {checks.marks.map((mark, index) => (
        <span
          // The marks are positional: the lead checks in their fixed order.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className={cn(
            "size-1.5 rounded-xs",
            mark === "pass"
              ? "bg-success"
              : mark === "fail"
                ? "bg-destructive"
                : "bg-dim-foreground/40",
          )}
        />
      ))}
    </span>
  );
}
