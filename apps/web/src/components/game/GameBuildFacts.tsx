import { type GameFactDelta } from "@kurambit/contracts";

import { cn } from "../../lib/utils";
import { deltaLine } from "./gameBuilds.logic";

const DELTA_TEXT = {
  better: "text-success-foreground",
  worse: "text-destructive-foreground",
  neutral: "text-muted-foreground",
} as const;

/** Two builds' facts side by side, with the shared diff's direction and tone. */
export function GameBuildFactsDiff({
  deltas,
  labels,
}: {
  deltas: ReadonlyArray<GameFactDelta>;
  labels: readonly [string, string];
}) {
  if (deltas.length === 0) return null;
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <thead>
        <tr className="text-left text-2xs text-muted-foreground">
          <th className="w-1/4 py-1 pr-2 font-normal">Fact</th>
          <th className="py-1 pr-2 font-normal">{labels[0]}</th>
          <th className="py-1 pr-2 font-normal">{labels[1]}</th>
          <th className="w-8 py-1 font-normal" aria-label="Change" />
        </tr>
      </thead>
      <tbody>
        {deltas.map((delta) => {
          const line = deltaLine(delta);
          return (
            <tr key={delta.id} className="border-t border-border align-baseline">
              <td className="py-1.5 pr-2 text-muted-foreground">{line.label}</td>
              {line.why === null ? (
                <>
                  <td className="py-1.5 pr-2">{line.a}</td>
                  <td className="py-1.5 pr-2">{line.b}</td>
                </>
              ) : (
                <td colSpan={2} className="py-1.5 pr-2 text-muted-foreground">
                  {line.why}
                </td>
              )}
              <td
                className={cn(
                  "py-1.5 text-center font-medium",
                  line.tone === null ? "text-muted-foreground" : DELTA_TEXT[line.tone],
                )}
              >
                {line.mark ?? ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
