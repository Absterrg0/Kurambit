import { useEffect } from "react";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import type {
  GameBuild,
  GameBuildFacts,
  GameBuildsResult,
  GameFactView,
  GameQaControl,
  GameStageControl,
  ScopedThreadRef,
} from "@kurambit/contracts";
import { MonitorSmartphoneIcon, PlayIcon } from "lucide-react";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { openExpandedImagePreview } from "../chat/ExpandedImageDialog";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Text } from "../ui/text";
import { refOf } from "./gameBuildRef";
import { GameKeyArt } from "./GameKeyArt";
import { requestStageControls, useThreadStageBridge } from "./gameStageBridge";
import { stageDeviceAt } from "./gameStageDevice";
import { clockLabel } from "./gameStageRewind";

/**
 * The proof under each check in Checks: the frames a screen check took, the frame rate and what
 * it costs to draw, the harness's own play, and the controls as keys. Every number is the
 * build's own. Nothing here repaints: the chart is a static drawing and a recording plays only
 * when opened.
 */

type RunEvidence = GameFactView["evidence"][number];

/**
 * A recording or frame opens in a lightbox sized to it, with the check it proves; its files are
 * one explicit "Show files" away. A log is a file, so it opens as one.
 */
export function openEvidence(
  threadRef: ScopedThreadRef,
  root: string | null,
  item: RunEvidence,
  detail: string,
) {
  const showFiles = () => useRightPanelStore.getState().openFile(threadRef, item.path);
  if (item.kind === "log" || root === null) {
    showFiles();
    return;
  }
  const kind = item.kind === "video" ? "video" : "image";
  openExpandedImagePreview(scopedThreadKey(threadRef), {
    index: 0,
    images: [
      {
        src: null,
        name: item.label,
        ...(kind === "video" ? { type: "video" as const } : {}),
        detail,
        fileAction: "Show files",
        actionsSource: {
          kind,
          name: item.label,
          src: null,
          asset: {
            environmentId: threadRef.environmentId,
            resource: { _tag: "draft-workspace-file", cwd: root, path: item.path },
          },
          onOpenFile: showFiles,
        },
      },
    ],
  });
}

const measured = <T,>(fact: { status: string; value?: T }): T | null =>
  fact.status === "measured" ? (fact.value as T) : null;

/** The facts of the build this one was made from: what each reading is compared with. */
export function useBaseFacts(threadRef: ScopedThreadRef, build: GameBuild, list: GameBuildsResult) {
  const base = list.builds.find((entry) => entry.id === build.base) ?? null;
  return (
    useEnvironmentQuery(
      base === null || !base.available
        ? null
        : gameEnvironment.buildFacts({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, build: refOf(base) },
          }),
    ).data ?? null
  );
}

// ─── Readouts ──────────────────────────────────────────────────────────────────

/**
 * One read-only number as a field: its label a muted prefix inside it, the value in tabular
 * figures, and its change since the build before after it, amber when it got worse.
 */
function Readout({
  label,
  value,
  delta = null,
  worse = false,
}: {
  label: string;
  value: string;
  delta?: string | null;
  worse?: boolean;
}) {
  return (
    <span className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1.5 surface-well">
      <Text variant="caption" tone="muted" render={<span className="shrink-0" />}>
        {label}
      </Text>
      <Text variant="meta" tone="default" numeric truncate>
        {value}
      </Text>
      {delta === null ? null : (
        <Text
          variant="caption"
          tone="inherit"
          numeric
          render={
            <span
              className={cn("ms-auto shrink-0", worse ? "text-warning" : "text-dim-foreground")}
            />
          }
        >
          {delta}
        </Text>
      )}
    </span>
  );
}

// ─── Screens ───────────────────────────────────────────────────────────────────

/** The row height both frames are scaled to, side by side. */
const SCREEN_ROW_PX = 72;
const SCREEN_WORDS = { phone: "Phone", widescreen: "Widescreen" } as const;

/** Whether the screens check took any frames to show. */
export const hasScreenFrames = (facts: GameBuildFacts) =>
  (measured(facts.screens)?.sizes ?? []).some((size) => size.frame !== null);

/**
 * The two frames the screens check took, each opening large, and the way to try any size live:
 * the Stage's responsive view, at the phone's size.
 */
export function ScreensEvidence({
  threadRef,
  root,
  facts,
}: {
  threadRef: ScopedThreadRef;
  root: string;
  facts: GameBuildFacts;
}) {
  const setStageDevice = useGameWorkspaceStore((state) => state.setStageDevice);
  const sizes = (measured(facts.screens)?.sizes ?? []).filter((size) => size.frame !== null);
  if (sizes.length === 0) return null;
  const first = sizes.find((size) => size.name === "phone") ?? sizes[0]!;
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex min-w-0 max-w-full items-start gap-2">
        {sizes.map((size) => {
          const word = SCREEN_WORDS[size.name];
          const label = `${word} ${size.width}×${size.height}`;
          return (
            <button
              key={size.name}
              type="button"
              aria-label={`Open ${label}`}
              onClick={() =>
                openEvidence(threadRef, root, { kind: "frame", label, path: size.frame! }, label)
              }
              className="flex min-w-0 shrink cursor-pointer flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <span
                className="relative block max-w-full overflow-hidden rounded-md bg-muted"
                style={{ height: SCREEN_ROW_PX, aspectRatio: `${size.width} / ${size.height}` }}
              >
                <GameKeyArt
                  environmentId={threadRef.environmentId}
                  root={root}
                  path={size.frame!}
                  className="object-cover"
                />
              </span>
              <Text variant="caption" tone="muted" numeric>
                {word} · {size.width}×{size.height}
              </Text>
            </button>
          );
        })}
      </div>
      <Button
        size="xs"
        variant="ghost"
        className="-ms-2"
        onClick={() => setStageDevice(scopedThreadKey(threadRef), stageDeviceAt(first))}
      >
        <MonitorSmartphoneIcon aria-hidden="true" />
        Open in responsive view
      </Button>
    </div>
  );
}

// ─── Frame rate ────────────────────────────────────────────────────────────────

const MB = 1_000_000;
const bytesText = (bytes: number) =>
  bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
const countText = (count: number) =>
  count >= 10_000
    ? `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k`
    : count.toLocaleString("en-US");
const signed = (delta: number, text: string) => `${delta > 0 ? "+" : "−"}${text}`;

interface Reading {
  readonly label: string;
  readonly value: string;
  readonly delta: string | null;
  readonly worse: boolean;
}
const readingOf = (
  label: string,
  now: number | null | undefined,
  before: number | null | undefined,
  text: (value: number) => string,
  /** Higher is worse (draw calls), and by how much it is worth a warning. */
  past: (before: number) => number,
): Reading | null => {
  if (now === null || now === undefined) return null;
  if (before === null || before === undefined || Math.abs(now - before) < 1e-9)
    return { label, value: text(now), delta: null, worse: false };
  const delta = now - before;
  const shown = text(Math.abs(delta));
  return {
    label,
    value: text(now),
    delta: shown === text(0) ? null : signed(delta, shown),
    worse: delta > past(before),
  };
};

/** Whether the frame rate check has a chart or a count to show. */
export const hasPerformanceProof = (facts: GameBuildFacts) => {
  const perf = measured(facts.performance);
  return (
    (perf?.series?.length ?? 0) >= 2 ||
    perf?.drawCalls != null ||
    perf?.triangles != null ||
    measured(facts.screens)?.bytes != null
  );
};

/**
 * The frame rate through the measured play, its 1% low marked, then what a frame costs to
 * draw and what the game loads, each with its change since the build before.
 */
export function PerformanceEvidence({
  facts,
  base,
}: {
  facts: GameBuildFacts;
  base: GameBuildFacts | null;
}) {
  const perf = measured(facts.performance);
  const was = base === null ? null : measured(base.performance);
  const bytes = measured(facts.screens)?.bytes ?? null;
  const wasBytes = base === null ? null : (measured(base.screens)?.bytes ?? null);
  const readings = [
    readingOf(
      "Draws",
      perf?.drawCalls,
      was?.drawCalls,
      (v) => countText(Math.round(v)),
      (b) => Math.max(10, b * 0.1),
    ),
    readingOf(
      "Tris",
      perf?.triangles,
      was?.triangles,
      (v) => countText(Math.round(v)),
      (b) => Math.max(20_000, b * 0.15),
    ),
    readingOf("Load", bytes, wasBytes, bytesText, (b) => Math.max(0.5 * MB, b * 0.1)),
  ].filter((reading) => reading !== null);
  const series = perf?.series ?? [];
  return (
    <div className="flex flex-col gap-2">
      {series.length < 2 ? null : <FrameChart series={series} low={perf?.low1 ?? null} />}
      {readings.length === 0 ? null : (
        <div className="grid grid-cols-3 gap-1.5">
          {readings.map((reading) => (
            <Readout key={reading.label} {...reading} />
          ))}
        </div>
      )}
    </div>
  );
}

const CHART_H = 56;

/**
 * Frames per second through the play, as wide as its column: the 60 line quiet, the 1% low a
 * dashed amber line labelled at its end. Drawn once.
 */
function FrameChart({ series, low }: { series: ReadonlyArray<number>; low: number | null }) {
  const top = Math.max(60, ...series);
  // In a 100-wide box stretched to the column; strokes keep their width.
  const y = (fps: number) => CHART_H - 2 - (fps / top) * (CHART_H - 4);
  const x = (index: number) => (index / (series.length - 1)) * 100;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 100 ${CHART_H}`}
        preserveAspectRatio="none"
        height={CHART_H}
        className="block w-full overflow-visible"
        role="img"
        aria-label={`Frame rate through the play, ${Math.min(...series)} to ${Math.max(...series)} fps${low === null ? "" : `, 1% low ${low}`}`}
      >
        <line
          x1={0}
          x2={100}
          y1={y(60)}
          y2={y(60)}
          className="stroke-border"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {low === null ? null : (
          <line
            x1={0}
            x2={100}
            y1={y(low)}
            y2={y(low)}
            className="stroke-warning"
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <polyline
          points={series
            .map((fps, index) => `${x(index).toFixed(2)},${y(fps).toFixed(1)}`)
            .join(" ")}
          fill="none"
          className="stroke-foreground"
          strokeWidth={1.5}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <Text
        variant="caption"
        tone="muted"
        numeric
        render={<span className="absolute end-0 top-0 leading-none" />}
      >
        60
      </Text>
      {low === null ? null : (
        <Text
          variant="caption"
          tone="inherit"
          numeric
          render={
            <span
              className="absolute end-0 -translate-y-full bg-background ps-1 leading-none text-warning"
              style={{ top: y(low) - 2 }}
            />
          }
        >
          1% low {Math.round(low)}
        </Text>
      )}
    </div>
  );
}

// ─── The harness's play ────────────────────────────────────────────────────────

const ENDING_WORDS: Record<string, string> = {
  won: "won",
  lost: "lost",
  "no-ending": "played on, no ending",
  crashed: "crashed",
  unresponsive: "stopped answering",
  "did-not-boot": "did not start",
};

/** Whether the harness's own play left a recording to show. */
export const hasLastPlay = (facts: GameBuildFacts) => measured(facts.masher)?.evidence != null;

/** The harness's own play of this build: its last frame, which opens its recording. */
export function LastPlayEvidence({
  threadRef,
  root,
  facts,
}: {
  threadRef: ScopedThreadRef;
  root: string;
  facts: GameBuildFacts;
}) {
  const play = measured(facts.masher);
  if (play === null || play.evidence === null) return null;
  const video = `${play.evidence}/run.mp4`;
  const poster = `${play.evidence}/frames/frame-end.png`;
  const ended =
    play.at !== null && (play.ending === "won" || play.ending === "lost")
      ? `${ENDING_WORDS[play.ending]} at ${clockLabel(play.at)}`
      : (ENDING_WORDS[play.ending] ?? play.ending);
  const label = `The harness's play, ${clockLabel(play.played)}`;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <button
        type="button"
        aria-label={`Play the recording, ${clockLabel(play.played)}`}
        onClick={() => openEvidence(threadRef, root, { kind: "video", label, path: video }, ended)}
        className="group/play relative aspect-video w-32 shrink-0 cursor-pointer overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <GameKeyArt
          environmentId={threadRef.environmentId}
          root={root}
          path={poster}
          className="object-cover"
        />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-7 items-center justify-center rounded-full bg-black/55 text-white group-hover/play:bg-black/70">
            <PlayIcon aria-hidden="true" className="size-3.5 translate-x-px" />
          </span>
        </span>
      </button>
      <span className="flex min-w-0 flex-col">
        <Text variant="meta" tone="default">
          Last play · {clockLabel(play.played)}
        </Text>
        <Text variant="caption" tone={play.ending === "crashed" ? "destructive" : "muted"}>
          {ended}
        </Text>
      </span>
    </div>
  );
}

// ─── Controls ──────────────────────────────────────────────────────────────────

// A KeyboardEvent code as a key cap says it: the arrows and Shift as their symbols.
const KEY_WORDS: Readonly<Record<string, string>> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  ShiftLeft: "⇧",
  ShiftRight: "⇧",
  ControlLeft: "Ctrl",
  ControlRight: "Ctrl",
  AltLeft: "Alt",
  AltRight: "Alt",
  Backspace: "⌫",
};
const keyWord = (code: string) =>
  KEY_WORDS[code] ??
  code
    .replace(/^Key/, "")
    .replace(/^Digit/, "")
    .replace(/^Numpad/, "Num ");

interface ControlRow {
  readonly keys: ReadonlyArray<string>;
  readonly label: string;
  readonly did: string | null;
  readonly read: boolean;
}

const MOVES = ["move_up", "move_left", "move_down", "move_right"] as const;
/**
 * The controls as a player names them: the four moves as one, each with its first key, and what
 * each did. A play measured by a shell older than its keys names none; the game on the Stage
 * does, by the same action names. A control with no key known has no cap, never a blank one.
 */
const controlRows = (
  controls: ReadonlyArray<GameQaControl>,
  live: ReadonlyArray<GameStageControl> | null,
): ReadonlyArray<ControlRow> => {
  const firstKey = (control: GameQaControl) =>
    control.keys?.[0] ?? live?.find((each) => each.name === control.name)?.codes[0] ?? null;
  const capOf = (control: GameQaControl) => {
    const code = firstKey(control);
    return code === null ? [] : [keyWord(code)];
  };
  const didOf = (answers: ReadonlyArray<string>) =>
    answers.length === 0 ? null : [...new Set(answers)].join(", ");
  const rows: Array<ControlRow> = [];
  const moves = MOVES.map((name) => controls.find((control) => control.name === name));
  const groupMoves = moves.every((control) => control !== undefined);
  if (groupMoves) {
    const found = moves.filter((control) => control !== undefined);
    rows.push({
      keys: found.flatMap(capOf),
      label: "Move",
      did: didOf(found.flatMap((control) => control.answers)),
      read: found.some((control) => control.read),
    });
  }
  for (const control of controls) {
    if (groupMoves && (MOVES as ReadonlyArray<string>).includes(control.name)) continue;
    rows.push({
      keys: capOf(control),
      label: control.label,
      did: didOf(control.answers),
      read: control.read,
    });
  }
  return rows;
};

/** Whether the controls check found controls to show as keys. */
export const hasControls = (facts: GameBuildFacts) =>
  (measured(facts.qa)?.controls.length ?? 0) > 0;

/**
 * The controls the check pressed, each as its keys, its name and what it did. One that did
 * nothing is amber, keys and all.
 */
export function ControlsEvidence({
  threadKey,
  facts,
}: {
  threadKey: string;
  facts: GameBuildFacts;
}) {
  const qa = measured(facts.qa);
  const live = useThreadStageBridge(threadKey, (state) => state.controls, null);
  const answersControls = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("controls"),
    false,
  );
  const keyless = qa?.controls.some((control) => control.keys === undefined) ?? false;
  // A play measured before keys were recorded: the game on the Stage names them.
  useEffect(() => {
    if (keyless && answersControls && live === null) requestStageControls();
  }, [keyless, answersControls, live]);
  if (qa === null || qa.controls.length === 0) return null;
  const rows = controlRows(qa.controls, live);
  return (
    <ul className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
      {rows.map((row) => (
        <ControlLine key={row.label} row={row} />
      ))}
    </ul>
  );
}

function ControlLine({ row }: { row: ControlRow }) {
  const silent = row.did === null;
  return (
    <li className="contents">
      <span className={cn("flex h-6 items-center gap-1", silent && "kbd-on-warning")}>
        {row.keys.map((key, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- two moves may share a cap.
          <Kbd key={index}>{key}</Kbd>
        ))}
      </span>
      <Text
        variant="meta"
        tone={silent ? "inherit" : "default"}
        truncate
        render={<span className={silent ? "text-warning-foreground" : undefined} />}
      >
        {row.label}
      </Text>
      <Text
        variant="caption"
        tone={silent ? "inherit" : "muted"}
        truncate
        render={<span className={cn("text-end", silent && "text-warning-foreground")} />}
      >
        {silent ? (row.read ? "did nothing" : "never read") : row.did}
      </Text>
    </li>
  );
}
