import { ChevronRightIcon, MinusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { changeWord, compareHeadline, type CompareRows } from "./gameBuilds.logic";

const DELTA_TEXT = {
  better: "text-success-foreground",
  worse: "text-destructive-foreground",
  neutral: "text-muted-foreground",
} as const;

/** A compare side's letter, as its picture and the table's columns both show it. */
export function CompareSideBadge({ side }: { side: "A" | "B" }) {
  return (
    <Text
      variant="micro"
      tone="inherit"
      numeric
      render={
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-strong-foreground text-background"
        />
      }
    >
      {side}
    </Text>
  );
}

/**
 * Two builds' facts side by side, named as the Inspector names them, with the shared diff's
 * direction and tone. Facts neither build measured close the table, one row per reason.
 */
export function GameBuildFactsDiff({ compared }: { compared: CompareRows }) {
  // The readings that are the same fold under one counted line, so the differences fit in view
  // and the headline's count of them is one click from its rows.
  const [sameOpen, setSameOpen] = useState(false);
  const same = compared.rows.filter((row) => row.mark === "=").length;
  if (compared.rows.length === 0 && compared.unmeasured.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <Text variant="label" tone="strong" render={<p />}>
        {compareHeadline(compared)}
      </Text>
      {compared.oneSided
        .filter((entry) => entry.why !== "still being measured")
        .map((entry) => (
          <Text key={`${entry.side}${entry.why}`} variant="caption" tone="muted" render={<p />}>
            {entry.side} has no reading of {namesList(entry.names)}: {entry.why}.
          </Text>
        ))}
      <table className="w-full table-fixed border-collapse">
        <thead>
          <Text variant="caption" tone="muted" render={<tr className="text-left" />}>
            <th className="w-[34%] py-1.5 pr-3 font-normal">Check</th>
            <th className="py-1.5 pr-3 font-normal">
              <span className="flex items-center gap-1.5">
                <CompareSideBadge side="A" />
                <span className="sr-only">A</span>
              </span>
            </th>
            <th className="py-1.5 pr-3 font-normal">
              <span className="flex items-center gap-1.5">
                <CompareSideBadge side="B" />
                <span className="sr-only">B</span>
              </span>
            </th>
            <th className="w-16 py-1.5 text-right font-normal">Change</th>
          </Text>
        </thead>
        <tbody>
          {compared.rows.map((row, index) => [
            // The readings that are the same follow the ones that differ, under their own line.
            row.mark === "=" && compared.rows[index - 1]?.mark !== "=" ? (
              <tr key="same-heading">
                <td colSpan={4} className="border-t border-border pt-2 pb-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-expanded={sameOpen}
                    onClick={() => setSameOpen(!sameOpen)}
                  >
                    <ChevronRightIcon
                      className={cn("transition-transform", sameOpen && "rotate-90")}
                      aria-hidden="true"
                    />
                    {same === 1
                      ? "1 reading the same on both"
                      : `${same} readings the same on both`}
                  </Button>
                </td>
              </tr>
            ) : null,
            row.mark === "=" && !sameOpen ? null : (
              <tr key={row.id} className="border-t border-border align-baseline">
                <Text variant="meta" tone="muted" render={<td className="py-2 pr-3" />}>
                  {row.name}
                </Text>
                <Text
                  variant="meta"
                  tone={row.a === null ? "dim" : "default"}
                  render={<td className="py-2 pr-3" />}
                >
                  {row.a ?? "Not measured"}
                </Text>
                <Text
                  variant="meta"
                  tone={row.b === null ? "dim" : "default"}
                  render={<td className="py-2 pr-3" />}
                >
                  {row.b ?? "Not measured"}
                </Text>
                <Text
                  variant="meta"
                  tone="inherit"
                  render={
                    <td
                      className={cn(
                        "py-2 text-right",
                        // Colour only for a verdict; a number that moved reads plain.
                        row.tone === null || !["Better", "Worse"].includes(changeWord(row) ?? "")
                          ? "text-muted-foreground"
                          : DELTA_TEXT[row.tone],
                      )}
                    />
                  }
                >
                  {changeWord(row) ?? ""}
                </Text>
              </tr>
            ),
            row.note === null || (row.mark === "=" && !sameOpen) ? null : (
              <tr key={`${row.id}-note`}>
                <td />
                <Text
                  variant="caption"
                  tone="muted"
                  render={<td colSpan={3} className="pb-2 pr-3" />}
                >
                  {row.note}
                </Text>
              </tr>
            ),
          ])}
          {compared.unmeasured.map((group) => (
            <tr key={group.why} className="border-t border-border align-baseline">
              <td colSpan={4} className="py-2">
                <span className="flex items-baseline gap-2.5">
                  <MinusIcon
                    className="size-3.5 shrink-0 translate-y-0.5 text-dim-foreground"
                    aria-hidden="true"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <Text variant="meta" tone="muted">
                      {group.names.join(", ")}
                    </Text>
                    <Text variant="caption" tone="dim">
                      Not measured on either build: {group.why}
                    </Text>
                  </span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const namesList = (names: ReadonlyArray<string>) =>
  names.length <= 2
    ? names.map((name) => name.toLowerCase()).join(" or ")
    : `${names.length} checks`;
