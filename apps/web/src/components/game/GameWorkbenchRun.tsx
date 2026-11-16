import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import {
  playOutcomeWords,
  type GamePlayMark,
  type GameSavedPlaySummary,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import {
  ActivityIcon,
  FlagIcon,
  MessageSquareIcon,
  PlayIcon,
  RotateCcwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Text } from "../ui/text";
import { attachRunToComposer } from "./gameComposerContext";
import { GameRunCompare, GameRunTimeline } from "./GameRunTimeline";
import { requestStageRun, useThreadStageBridge } from "./gameStageBridge";
import { clockLabel } from "./gameStageRewind";
import {
  clearStageConsole,
  type StageConsoleLine,
  useStageConsole,
  useStageMarks,
} from "./gameStageWatch";
import { Workbench } from "./GameWorkbenchParts";
import { useStageRunSession } from "./useStageRuns";

/** The name a first win is saved under from the Run tab. */
const FIRST_WIN_NAME = "first win";

/**
 * The Workbench's Run tab: the run being played or just played. Its timeline to rewind and fork,
 * its values over time, the page's console, and the two things to do with a run: tell the agent
 * about it, and keep it as a test play every build replays.
 */
export function GameWorkbenchRun({ threadRef }: { threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(threadRef);
  const session = useStageRunSession(threadKey);
  const status = useThreadStageBridge(threadKey, (state) => state.status, null);
  const frozen = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const tellsRuns = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("runs"),
    false,
  );
  const live = useStageMarks(threadKey);
  const timeline = session?.rewind.timeline ?? null;
  // Frozen or ended, the run's own recording; while playing, the marks as they arrive.
  const marks = live.length > 0 ? live : (timeline?.play.marks ?? live);
  const consoleState = useStageConsole(threadKey);
  if (status === null && marks.length === 0 && consoleState.lines.length === 0)
    return (
      <Workbench.Empty
        icon={<ActivityIcon />}
        title="Play the game on the Stage"
        body="Your run shows here as you play: a timeline to rewind it, its values over time, and the game's console."
      />
    );
  return (
    <Workbench.Body>
      <RunNow threadRef={threadRef} frozen={frozen} tellsRuns={tellsRuns} marks={marks} />
      <ValuesWatch marks={marks} />
      <StageConsole threadKey={threadKey} />
      <TestPlays threadRef={threadRef} />
    </Workbench.Body>
  );
}

/** How the run stands, its timeline and what to do with it. */
function RunNow({
  threadRef,
  frozen,
  tellsRuns,
  marks,
}: {
  threadRef: ScopedThreadRef;
  frozen: boolean;
  tellsRuns: boolean;
  marks: ReadonlyArray<GamePlayMark>;
}) {
  const session = useStageRunSession(scopedThreadKey(threadRef));
  const savePlay = useAtomCommand(gameEnvironment.savePlay, { reportFailure: false });
  const canSave = useAtomValue(gameEnvironment.savePlay.permissionAtom(threadRef.environmentId));
  const [saving, setSaving] = useState(false);
  const ended = session?.runs.ended ?? null;
  const rewind = session?.rewind ?? null;
  const notice = rewind?.notice ?? null;
  const busy = rewind?.busy ?? null;
  const seconds = marks.at(-1)?.t ?? null;
  const state =
    ended !== null
      ? `${playOutcomeWords(ended.outcome).charAt(0).toUpperCase()}${playOutcomeWords(ended.outcome).slice(1)}`
      : busy !== null
        ? `Getting back to ${clockLabel(busy)}…`
        : frozen
          ? seconds === null
            ? "Paused"
            : `Paused at ${clockLabel(seconds)}`
          : seconds === null
            ? "Not started"
            : `Playing · ${clockLabel(seconds)}`;
  const tell = async () => {
    // A paused run is asked for first; the game answers with it (useStageRuns).
    if (ended === null) {
      requestStageRun();
      return;
    }
    await attachRunToComposer(threadRef, {
      kept: ended.kept,
      outcome: ended.outcome,
      paused: false,
    });
  };
  const keepWin = async () => {
    if (ended === null) return;
    setSaving(true);
    // The save replays the run once on its own build first, which takes a moment.
    const result = await savePlay({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, name: FIRST_WIN_NAME, kept: ended.kept },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      session?.onNote(String(squashAtomCommandFailure(result)));
      return;
    }
    session?.runs.dismiss();
    session?.onNote(
      `Saved "${result.value.name}" as a test play: every build replays it from now on.`,
    );
  };
  const shownTimeline =
    rewind === null || rewind.timeline === null ? null : <GameRunTimeline rewind={rewind} />;
  const canTell =
    (ended !== null || (frozen && tellsRuns)) && busy === null && notice?.ended !== true;
  return (
    <Workbench.Section
      title="Run"
      aside={
        <Text
          variant="caption"
          tone={ended?.outcome.won === true ? "default" : "muted"}
          numeric
          render={<span />}
        >
          {state}
        </Text>
      }
    >
      {shownTimeline}
      {notice === null ? null : (
        <Text variant="meta" tone="muted" render={<p />}>
          {notice.text}
        </Text>
      )}
      {shownTimeline === null && ended === null ? (
        <Text variant="meta" tone="muted" render={<p />}>
          Pause the game or play a run to its end, and its timeline shows here to rewind it to any
          second and play on from there.
        </Text>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {rewind !== null && busy === null && frozen ? <GameRunCompare rewind={rewind} /> : null}
        {rewind !== null && busy === null && notice !== null && frozen ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              rewind.playOn();
              session?.onFocusGame();
            }}
          >
            <PlayIcon aria-hidden="true" />
            Play on
          </Button>
        ) : null}
        {rewind !== null && busy === null && notice !== null && (frozen || notice.ended) ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              rewind.fresh();
              session?.onFocusGame();
            }}
          >
            <RotateCcwIcon aria-hidden="true" />
            Start fresh
          </Button>
        ) : null}
        <Button size="xs" variant="outline" disabled={!canTell} onClick={() => void tell()}>
          <MessageSquareIcon aria-hidden="true" />
          Tell the agent about this run
        </Button>
        {ended?.firstWin === true && canSave ? (
          <Button size="xs" disabled={saving} onClick={() => void keepWin()}>
            <FlagIcon aria-hidden="true" />
            {saving ? "Checking it replays the same…" : "Keep this win as a test play"}
          </Button>
        ) : null}
      </div>
    </Workbench.Section>
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

const SPARK_W = 120;
const SPARK_H = 22;
/** The most values the watch draws; a game's GameState rarely has more worth watching. */
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
  const y = (v: number) =>
    range === 0 ? SPARK_H / 2 : SPARK_H - 2 - ((v - series.low) / range) * (SPARK_H - 4);
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
      <path d={d} fill="none" className="stroke-primary" strokeWidth={1.5} strokeLinejoin="round" />
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

/** The game's own values (its GameState) over the run, a mark a second. */
function ValuesWatch({ marks }: { marks: ReadonlyArray<GamePlayMark> }) {
  const series = seriesOf(marks);
  const from = marks[0]?.t ?? 0;
  const to = marks.at(-1)?.t ?? 0;
  return (
    <Workbench.Section
      title="Values"
      detail={
        series.length === 0
          ? null
          : `The game's numbers over ${clockLabel(Math.max(0, to - from))}, one reading a second`
      }
    >
      {series.length === 0 ? (
        <Text variant="meta" tone="muted" render={<p />}>
          The game's own numbers and switches (score, health, timers) show here a second at a time
          once a run is under way.
        </Text>
      ) : (
        <ul className="flex flex-col">
          {series.map((each) => (
            <li key={each.key} className="flex min-h-7 items-center gap-3">
              <Text variant="meta" tone="default" truncate render={<span className="flex-1" />}>
                {keyWords(each.key)}
              </Text>
              <Sparkline series={each} from={from} to={to} />
              <Text
                variant="meta"
                tone="strong"
                numeric
                render={<span className="w-14 shrink-0 text-end" />}
              >
                {valueText(each.last)}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </Workbench.Section>
  );
}

const LEVEL_ICON_CLASS = { error: "text-destructive", warn: "text-warning" } as const;

function ConsoleRow({ line }: { line: StageConsoleLine }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="flex h-4.5 w-3.5 shrink-0 items-center">
        {line.level === "log" ? null : (
          <TriangleAlertIcon
            className={cn("size-3", LEVEL_ICON_CLASS[line.level])}
            aria-hidden="true"
          />
        )}
      </span>
      <Text
        variant="caption"
        tone="muted"
        numeric
        render={<span className="w-11 shrink-0 text-end" />}
      >
        {line.t < 60 ? `${line.t.toFixed(1)} s` : clockLabel(line.t)}
      </Text>
      <Text
        variant="caption"
        tone={line.level === "error" ? "destructive" : "default"}
        mono
        render={<span className="min-w-0 flex-1 break-words whitespace-pre-wrap" />}
      >
        {line.text}
      </Text>
    </div>
  );
}

/** The game page's errors and console lines as they happen, newest at the bottom. */
function StageConsole({ threadKey }: { threadKey: string }) {
  const { lines, dropped } = useStageConsole(threadKey);
  const errors = lines.filter((line) => line.level === "error").length;
  const warnings = lines.filter((line) => line.level === "warn").length;
  return (
    <Workbench.Section
      title="Console"
      detail={
        lines.length === 0
          ? null
          : [
              errors === 0 ? "No errors" : `${errors} ${errors === 1 ? "error" : "errors"}`,
              ...(warnings === 0 ? [] : [`${warnings} ${warnings === 1 ? "warning" : "warnings"}`]),
              ...(dropped === 0 ? [] : [`${dropped} older lines not kept`]),
            ].join(" · ")
      }
      aside={
        lines.length === 0 ? undefined : (
          <Button size="xs" variant="ghost" onClick={() => clearStageConsole(threadKey)}>
            Clear
          </Button>
        )
      }
    >
      {lines.length === 0 ? (
        <Text variant="meta" tone="muted" render={<p />}>
          Nothing logged yet. The game's errors and console lines show here as they happen.
        </Text>
      ) : (
        <div className="h-56 rounded-md surface-well px-2 py-1">
          <LegendList<StageConsoleLine>
            data={lines}
            keyExtractor={(line) => String(line.n)}
            renderItem={({ item }) => <ConsoleRow line={item} />}
            estimatedItemSize={20}
            maintainScrollAtEnd
            initialScrollIndex={Math.max(0, lines.length - 1)}
            className="h-full overflow-x-hidden overscroll-y-contain"
          />
        </div>
      )}
    </Workbench.Section>
  );
}

/** Saving the last run as a test play under a name, and the plays saved so far. */
function TestPlays({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { environmentId } = threadRef;
  const session = useStageRunSession(scopedThreadKey(threadRef));
  const kept = session?.runs.lastEnded ?? null;
  const savePlay = useAtomCommand(gameEnvironment.savePlay, { reportFailure: false });
  const listPlays = useAtomCommand(gameEnvironment.savedPlays, { reportFailure: false });
  const deletePlay = useAtomCommand(gameEnvironment.deletePlay, { reportFailure: false });
  const canSave = useAtomValue(gameEnvironment.savePlay.permissionAtom(environmentId));
  const canDelete = useAtomValue(gameEnvironment.deletePlay.permissionAtom(environmentId));
  const [plays, setPlays] = useState<ReadonlyArray<GameSavedPlaySummary> | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  const refresh = useStableCallback(async () => {
    const result = await listPlays({ environmentId, input: { threadId: threadRef.threadId } });
    if (result._tag === "Success") setPlays(result.value);
    else setNote({ text: String(squashAtomCommandFailure(result)), failed: true });
  });
  // Read when shown, and again after each run ends: the agent saves and deletes plays too.
  const refreshAfter = useStableCallback((_ended: string | null) => refresh());
  useEffect(() => {
    void refreshAfter(kept);
  }, [refreshAfter, kept]);
  const save = async () => {
    if (kept === null) return;
    setBusy(true);
    setNote({ text: "Checking that the run replays the same…", failed: false });
    const result = await savePlay({
      environmentId,
      input: { threadId: threadRef.threadId, name: name.trim(), kept },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setNote({ text: String(squashAtomCommandFailure(result)), failed: true });
      return;
    }
    setName("");
    setNote({
      text: `${result.value.replaced ? "Replaced" : "Saved"} "${result.value.name}": every build replays it from now on.`,
      failed: false,
    });
    await refresh();
  };
  const remove = async (play: string) => {
    const result = await deletePlay({
      environmentId,
      input: { threadId: threadRef.threadId, name: play },
    });
    if (result._tag === "Failure")
      setNote({ text: String(squashAtomCommandFailure(result)), failed: true });
    await refresh();
  };
  const trimmed = name.trim();
  return (
    <Workbench.Section
      title="Test plays"
      detail="A run you save is replayed on every build, and each build's checks say whether it still ends the same way."
    >
      {canSave ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            size="sm"
            value={name}
            maxLength={60}
            disabled={kept === null || busy}
            placeholder={kept === null ? "Play a run to its end first" : "Name the last run"}
            aria-label="Name for the last run"
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Button size="sm" type="submit" disabled={kept === null || busy || trimmed.length === 0}>
            Save as test play
          </Button>
        </form>
      ) : null}
      {note === null ? null : (
        <Text
          variant="meta"
          tone={note.failed ? "destructive" : "muted"}
          render={<p role={note.failed ? "alert" : undefined} />}
        >
          {note.text}
        </Text>
      )}
      {plays === null || plays.length === 0 ? null : (
        <ul className="flex flex-col">
          {plays.map((play) => (
            <li key={play.name} className="flex min-h-8 items-center gap-2">
              <FlagIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Text variant="meta" tone="default" truncate render={<span className="flex-1" />}>
                {play.name}
              </Text>
              <Text variant="caption" tone="muted" numeric>
                {playOutcomeWords(play.outcome)}
              </Text>
              {canDelete ? (
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={`Delete ${play.name}`}
                  onClick={() => void remove(play.name)}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Workbench.Section>
  );
}
