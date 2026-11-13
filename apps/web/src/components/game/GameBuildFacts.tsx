import { ChevronDownIcon, ChevronRightIcon, MinusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Separated } from "../ui/separated";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
  // The readings that are the same fold under their count, so the differences fit in view and
  // the count is one click from its rows.
  const [sameOpen, setSameOpen] = useState(false);
  const unmeasuredRow = useRef<HTMLTableRowElement | null>(null);
  if (compared.rows.length === 0 && compared.unmeasured.length === 0) return null;
  const headline = compareHeadline(compared);
  return (
    <div className="flex flex-col gap-2">
      {headline.kind === "sentence" ? (
        <Text variant="label" tone="strong" render={<p />}>
          {headline.text}
        </Text>
      ) : (
        // One count per kind of reading, each with its own control, in view at every width.
        // Each group leads with its separator and a line's first one is clipped, so a wrap
        // neither ends nor starts a line on it.
        <Separated controls>
          <Text variant="label" tone="strong" numeric render={<p />}>
            {headline.differ === 0
              ? "No measured difference"
              : `${headline.differ} ${headline.differ === 1 ? "reading differs" : "readings differ"}`}
          </Text>
          {headline.same > 0 ? (
            <span className="gap-0.5">
              <Text variant="meta" tone="muted" numeric>
                {headline.same} the same
              </Text>
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={sameOpen}
                aria-label={sameOpen ? "Hide the same readings" : "Show the same readings"}
                onClick={() => setSameOpen(!sameOpen)}
              >
                <ChevronRightIcon
                  className={cn("transition-transform", sameOpen && "rotate-90")}
                  aria-hidden="true"
                />
                {sameOpen ? "Hide" : "Show"}
              </Button>
            </span>
          ) : null}
          {headline.varies > 0 ? (
            <Tooltip>
              <TooltipTrigger render={<span />}>
                <Text variant="meta" tone="muted" numeric>
                  {headline.varies} {headline.varies === 1 ? "varies" : "vary"} between runs
                </Text>
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-xs">
                {headline.varies === 1 ? "This reading changes" : "These readings change"} from run
                to run by {headline.varies === 1 ? "itself" : "themselves"}, so{" "}
                {headline.varies === 1 ? "it is" : "they are"} not counted as a difference.
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {headline.missing > 0 ? (
            <span className="gap-0.5">
              {/* The row that says which, and why, may be below the fold: this goes to it,
                    in the shape of the count beside it. */}
              <Text variant="meta" tone="muted" numeric>
                {headline.missing} not measured
              </Text>
              <Button
                size="xs"
                variant="ghost"
                aria-label="Go to the readings that were not measured"
                onClick={() =>
                  unmeasuredRow.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
                }
              >
                <ChevronDownIcon aria-hidden="true" />
                See
              </Button>
            </span>
          ) : null}
        </Separated>
      )}
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
            {/* Which way the column reads: every word and amount is B's against A's. */}
            <th className="w-32 py-1.5 text-right font-normal">Change from A to B</th>
          </Text>
        </thead>
        <tbody>
          {compared.rows.map((row, index) => [
            // The readings that are the same follow the ones that differ, under their own line.
            row.mark === "=" && sameOpen && compared.rows[index - 1]?.mark !== "=" ? (
              <tr key="same-heading">
                <Text
                  variant="caption"
                  tone="muted"
                  render={<td colSpan={4} className="border-t border-border pt-3 pb-1" />}
                >
                  The same on both
                </Text>
              </tr>
            ) : null,
            row.mark === "=" && !sameOpen ? null : (
              <tr key={row.id} className="border-t border-border align-baseline">
                <Text variant="meta" tone="muted" render={<td className="py-2 pr-3" />}>
                  {row.name}
                </Text>
                <Text
                  variant="meta"
                  tone={row.a === null ? "muted" : "default"}
                  render={<td className="py-2 pr-3" />}
                >
                  {row.a ?? "Not measured"}
                </Text>
                <Text
                  variant="meta"
                  tone={row.b === null ? "muted" : "default"}
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
                  {/* How far it moved, beside which way, so nobody subtracts by eye. */}
                  {row.amount == null ? null : (
                    <span className="ms-1.5 text-muted-foreground tabular-nums">{row.amount}</span>
                  )}
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
          {compared.unmeasured.map((group, index) => (
            <tr
              key={group.why}
              ref={index === 0 ? unmeasuredRow : undefined}
              className="border-t border-border align-baseline"
            >
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
                    <Text variant="caption" tone="muted">
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
