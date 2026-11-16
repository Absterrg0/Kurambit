import { LegendList } from "@legendapp/list/react";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import type { GamePlayMark, ScopedThreadRef } from "@kurambit/contracts";
import { BugIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { clockLabel } from "./gameStageRewind";
import {
  clearStageConsole,
  type StageConsoleLine,
  useStageConsole,
  useStageMarks,
} from "./gameStageWatch";
import { Workbench } from "./GameWorkbenchParts";

/**
 * The Workbench's Debug: what the game on the Stage says as it plays. Its own values (its
 * GameState) as a compact list, a line drawn only where a value moved, and its console as a
 * plain log. Quiet until there is something to read; the switch counts errors and warnings.
 */
export function GameWorkbenchDebug({ threadRef }: { threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(threadRef);
  const marks = useStageMarks(threadKey);
  const { lines } = useStageConsole(threadKey);
  // A page with no game yet still marks its seconds, with no values in them.
  const hasValues = marks.some((mark) => Object.keys(mark.values).length > 0);
  if (!hasValues && lines.length === 0)
    return (
      <Workbench.Empty
        icon={<BugIcon />}
        title="Nothing to read yet"
        body="The game's own values and its console show here as it plays."
      />
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col divide-y divide-border">
      {hasValues ? <Values marks={marks} /> : null}
      <Console threadKey={threadKey} />
    </div>
  );
}

/** "fishCaught" and "fish_caught" read "Fish caught". */
const keyWords = (key: string) => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.length === 0 ? key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const SPARK_W = 72;
const SPARK_H = 14;
/** The most values the list shows; a game's GameState rarely has more worth watching. */
const WATCHED = 16;

interface Series {
  readonly key: string;
  readonly kind: "number" | "boolean";
  readonly points: ReadonlyArray<readonly [number, number]>;
  readonly last: number | boolean;
  readonly low: number;
  readonly high: number;
}

/** Each value's points over the run's marks: numbers as they are, booleans as 0 and 1. */
const seriesOf = (marks: ReadonlyArray<GamePlayMark>): ReadonlyArray<Series> => {
  const keys = new Map<string, "number" | "boolean">();
  for (const mark of marks)
    for (const [key, value] of Object.entries(mark.values))
      if (!keys.has(key)) keys.set(key, typeof value === "boolean" ? "boolean" : "number");
  return [...keys].slice(0, WATCHED).flatMap(([key, kind]) => {
    const points: Array<readonly [number, number]> = [];
    let last: number | boolean | undefined;
    for (const mark of marks) {
      const value = mark.values[key];
      if (value === undefined) continue;
      last = value;
      points.push([mark.t, typeof value === "boolean" ? Number(value) : value]);
    }
    if (last === undefined) return [];
    const ys = points.map(([, y]) => y);
    return [{ key, kind, points, last, low: Math.min(...ys), high: Math.max(...ys) }];
  });
};

/** A value's line over the run: drawn once per new mark, never animated. */
function Sparkline({ series, from, to }: { series: Series; from: number; to: number }) {
  const span = Math.max(to - from, 1);
  const range = series.high - series.low;
  const x = (t: number) => ((t - from) / span) * SPARK_W;
  const y = (v: number) => SPARK_H - 1 - ((v - series.low) / range) * (SPARK_H - 2);
  const d = series.points
    .map(([t, v], i) => {
      const at = `${x(t).toFixed(1)} ${y(v).toFixed(1)}`;
      // Booleans step: they are on or off, never between.
      if (i === 0) return `M${at}`;
      return series.kind === "boolean" ? `H${x(t).toFixed(1)} V${y(v).toFixed(1)}` : `L${at}`;
    })
    .join(" ");
  return (
    <svg
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      <path
        d={d}
        fill="none"
        className="stroke-muted-foreground"
        strokeWidth={1.25}
        strokeLinejoin="round"
      />
    </svg>
  );
}

const valueText = (value: number | boolean) =>
  typeof value === "boolean"
    ? value
      ? "on"
      : "off"
    : Number.isInteger(value)
      ? value.toLocaleString("en-US")
      : value.toFixed(Math.abs(value) < 10 ? 2 : 1);

/** The game's own values (its GameState) now, each with its line over the run if it moved. */
function Values({ marks }: { marks: ReadonlyArray<GamePlayMark> }) {
  const series = seriesOf(marks);
  const from = marks[0]?.t ?? 0;
  const to = marks.at(-1)?.t ?? 0;
  return (
    <Workbench.Section
      title="Values"
      detail={`over ${clockLabel(Math.max(0, to - from))}, a reading a second`}
    >
      <ul className="flex flex-col">
        {series.map((each) => (
          <li key={each.key} className="flex h-7 min-w-0 items-center gap-3 ps-4 pe-4">
            <Text variant="meta" tone="muted" truncate render={<span className="flex-1" />}>
              {keyWords(each.key)}
            </Text>
            {each.high === each.low ? null : <Sparkline series={each} from={from} to={to} />}
            <Text
              variant="meta"
              tone="default"
              mono
              numeric
              render={<span className="w-14 shrink-0 text-end" />}
            >
              {valueText(each.last)}
            </Text>
          </li>
        ))}
      </ul>
    </Workbench.Section>
  );
}

const LINE_PX = 20;
const LEVEL_TONE = { error: "destructive", warn: "default", log: "muted" } as const;

/** One log line: the game second it came at, then the text, coloured by its level. */
function LogLine({ line }: { line: StageConsoleLine }) {
  return (
    <div className="flex items-start gap-3 ps-4 pe-4 leading-5">
      <Text
        variant="caption"
        tone="dim"
        mono
        numeric
        render={<span className="w-10 shrink-0 text-end" />}
      >
        {line.t < 60 ? line.t.toFixed(1) : clockLabel(line.t)}
      </Text>
      <Text
        variant="caption"
        tone={line.level === "warn" ? "inherit" : LEVEL_TONE[line.level]}
        mono
        render={
          <span
            className={
              line.level === "warn"
                ? "min-w-0 flex-1 break-words whitespace-pre-wrap text-warning-foreground"
                : "min-w-0 flex-1 break-words whitespace-pre-wrap"
            }
          />
        }
      >
        {line.text}
      </Text>
    </div>
  );
}

/** The game page's console as a plain log, newest at the bottom, taking the room left. */
function Console({ threadKey }: { threadKey: string }) {
  const { lines, dropped } = useStageConsole(threadKey);
  return (
    <section aria-label="Console" className="flex min-h-0 flex-1 flex-col py-1.5">
      <div className="flex h-8 shrink-0 items-center gap-2 ps-4 pe-2">
        <Text variant="meta" tone="strong" emphasis render={<h3 />}>
          Console
        </Text>
        {dropped === 0 ? null : (
          <Text variant="caption" tone="muted" numeric>
            {dropped} older lines not kept
          </Text>
        )}
        <span className="flex-1" />
        {lines.length === 0 ? null : (
          <Button size="xs" variant="ghost" onClick={() => clearStageConsole(threadKey)}>
            Clear
          </Button>
        )}
      </div>
      {lines.length === 0 ? (
        <Text variant="caption" tone="muted" render={<p className="px-4 py-1" />}>
          Nothing logged yet.
        </Text>
      ) : (
        <div className="min-h-0 flex-1">
          <LegendList<StageConsoleLine>
            data={lines}
            keyExtractor={(line) => String(line.n)}
            renderItem={({ item }) => <LogLine line={item} />}
            estimatedItemSize={LINE_PX}
            maintainScrollAtEnd
            initialScrollIndex={Math.max(0, lines.length - 1)}
            className="h-full overflow-x-hidden overscroll-y-contain"
          />
        </div>
      )}
    </section>
  );
}
