import type { ReactNode } from "react";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import type {
  GameBuild,
  GameBuildFacts,
  GameBuildsResult,
  GameFactView,
  GameQaControl,
  ScopedThreadRef,
} from "@kurambit/contracts";
import { PlayIcon } from "lucide-react";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { openExpandedImagePreview } from "../chat/ExpandedImageDialog";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { refOf } from "./gameBuildRef";
import { GameKeyArt } from "./GameKeyArt";
import { clockLabel } from "./gameStageRewind";
import { Workbench } from "./GameWorkbenchParts";

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
function useBaseFacts(threadRef: ScopedThreadRef, build: GameBuild, list: GameBuildsResult) {
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

/**
 * The build's evidence, all of it in view: its screens, its performance with what changed since
 * the build before, the harness's own play, and its controls. Every number is the build's own;
 * a section the build has no reading for is not shown. Nothing here repaints: the chart is a
 * static drawing and the recording plays only when opened.
 */
export function GameChecksBoard({
  threadRef,
  build,
  list,
  facts,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult;
  facts: GameBuildFacts;
}) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const base = useBaseFacts(threadRef, build, list);
  if (root === null) return null;
  return (
    <>
      <Screens threadRef={threadRef} root={root} facts={facts} />
      <Performance facts={facts} base={base} />
      <LastPlay threadRef={threadRef} root={root} facts={facts} />
      <Controls facts={facts} />
    </>
  );
}

/** The row height both frames are scaled to, side by side. */
const SCREEN_ROW_PX = 96;
const SCREEN_WORDS = { phone: "Phone", widescreen: "Widescreen" } as const;

function Screens({
  threadRef,
  root,
  facts,
}: {
  threadRef: ScopedThreadRef;
  root: string;
  facts: GameBuildFacts;
}) {
  const screens = measured(facts.screens);
  const sizes = (screens?.sizes ?? []).filter((size) => size.frame !== null);
  if (sizes.length === 0) return null;
  return (
    <Workbench.Section title="Screens">
      <div className="flex min-w-0 items-start gap-3 px-4 pt-1">
        {sizes.map((size) => {
          const word = SCREEN_WORDS[size.name];
          const label = `${word} ${size.width}×${size.height}`;
          return (
            <Tooltip key={size.name}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Open ${label}`}
                    onClick={() =>
                      openEvidence(
                        threadRef,
                        root,
                        { kind: "frame", label, path: size.frame! },
                        label,
                      )
                    }
                    className="flex min-w-0 shrink cursor-pointer flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  />
                }
              >
                <span
                  className="relative block max-w-full overflow-hidden rounded-md bg-muted"
                  style={{
                    height: SCREEN_ROW_PX,
                    aspectRatio: `${size.width} / ${size.height}`,
                  }}
                >
                  <GameKeyArt
                    environmentId={threadRef.environmentId}
                    root={root}
                    path={size.frame!}
                    className="object-cover"
                  />
                </span>
                <Text variant="caption" tone="muted">
                  {word}
                </Text>
              </TooltipTrigger>
              <TooltipPopup side="bottom">{`${size.width} × ${size.height}`}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </Workbench.Section>
  );
}

const MB = 1_000_000;
const bytesText = (bytes: number) =>
  bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
const countText = (count: number) =>
  count >= 10_000
    ? `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k`
    : count.toLocaleString("en-US");
const signed = (delta: number, text: string) => `${delta > 0 ? "+" : "−"}${text}`;

/**
 * One reading, its change since the build before in muted text, amber when it got worse by more
 * than `worse` says.
 */
interface Tile {
  readonly label: string;
  readonly value: string;
  readonly delta: string | null;
  readonly worse: boolean;
}
const tileOf = (
  label: string,
  now: number | null | undefined,
  before: number | null | undefined,
  text: (value: number) => string,
  /** Higher is worse (draw calls), or lower is (fps), and by how much it is worth a warning. */
  rule: { readonly higherIsWorse: boolean; readonly past: (before: number) => number },
): Tile | null => {
  if (now === null || now === undefined) return null;
  if (before === null || before === undefined || Math.abs(now - before) < 1e-9)
    return { label, value: text(now), delta: null, worse: false };
  const delta = now - before;
  const shown = text(Math.abs(delta));
  const worsened = rule.higherIsWorse ? delta : -delta;
  return {
    label,
    value: text(now),
    delta: shown === text(0) ? null : signed(delta, shown),
    worse: worsened > rule.past(before),
  };
};

const CHART_W = 160;
const CHART_H = 72;

function Performance({ facts, base }: { facts: GameBuildFacts; base: GameBuildFacts | null }) {
  const perf = measured(facts.performance);
  const was = base === null ? null : measured(base.performance);
  const bytes = measured(facts.screens)?.bytes ?? null;
  const wasBytes = base === null ? null : (measured(base.screens)?.bytes ?? null);
  const tiles = [
    tileOf("fps", perf?.fps, was?.fps, (v) => `${Math.round(v)}`, {
      higherIsWorse: false,
      past: () => 4,
    }),
    tileOf("1% low", perf?.low1, was?.low1, (v) => `${Math.round(v)}`, {
      higherIsWorse: false,
      past: () => 4,
    }),
    tileOf("Draw calls", perf?.drawCalls, was?.drawCalls, (v) => countText(Math.round(v)), {
      higherIsWorse: true,
      past: (b) => Math.max(10, b * 0.1),
    }),
    tileOf("Triangles", perf?.triangles, was?.triangles, (v) => countText(Math.round(v)), {
      higherIsWorse: true,
      past: (b) => Math.max(20_000, b * 0.15),
    }),
    tileOf("Load", bytes, wasBytes, bytesText, {
      higherIsWorse: true,
      past: (b) => Math.max(0.5 * MB, b * 0.1),
    }),
  ].filter((tile) => tile !== null);
  const series = perf?.series ?? [];
  if (tiles.length === 0 && series.length < 2) return null;
  return (
    <Workbench.Section title="Performance">
      <div className="flex min-w-0 gap-4 px-4 pt-1">
        {series.length < 2 ? null : <FrameChart series={series} low={perf?.low1 ?? null} />}
        <dl
          className={cn(
            "grid min-w-0 flex-1 gap-x-4 gap-y-3",
            series.length < 2 ? "grid-cols-3" : "grid-cols-2",
          )}
        >
          {tiles.map((tile) => (
            <div key={tile.label} className="flex min-w-0 flex-col">
              <Text variant="caption" tone="muted" render={<dt />}>
                {tile.label}
              </Text>
              <Text variant="label" tone="strong" numeric truncate render={<dd />}>
                {tile.value}
              </Text>
              {tile.delta === null ? null : (
                <Text
                  variant="caption"
                  tone="inherit"
                  numeric
                  truncate
                  render={<dd className={tile.worse ? "text-warning" : "text-muted-foreground"} />}
                >
                  {tile.delta}
                </Text>
              )}
            </div>
          ))}
        </dl>
      </div>
    </Workbench.Section>
  );
}

/** Frames per second through the measured play, its 1% low a dashed line: drawn once. */
function FrameChart({ series, low }: { series: ReadonlyArray<number>; low: number | null }) {
  const top = Math.max(60, ...series);
  const y = (fps: number) => CHART_H - 2 - (fps / top) * (CHART_H - 4);
  const x = (index: number) => (index / (series.length - 1)) * CHART_W;
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      width={CHART_W}
      height={CHART_H}
      className="shrink-0 overflow-visible"
      role="img"
      aria-label={`Frame rate through the play, ${Math.min(...series)} to ${Math.max(...series)} fps${low === null ? "" : `, 1% low ${low}`}`}
    >
      <line x1={0} x2={CHART_W} y1={y(60)} y2={y(60)} className="stroke-border" strokeWidth={1} />
      {low === null ? null : (
        <line
          x1={0}
          x2={CHART_W}
          y1={y(low)}
          y2={y(low)}
          className="stroke-warning"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
      <polyline
        points={series.map((fps, index) => `${x(index).toFixed(1)},${y(fps).toFixed(1)}`).join(" ")}
        fill="none"
        className="stroke-foreground"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ENDING_WORDS: Record<string, string> = {
  won: "won",
  lost: "lost",
  "no-ending": "played on, no ending",
  crashed: "crashed",
  unresponsive: "stopped answering",
  "did-not-boot": "did not start",
};

/** The harness's own play of this build: its last frame, which opens its recording. */
function LastPlay({
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
    <Workbench.Section title="Last play">
      <div className="flex min-w-0 items-center gap-3 px-4 pt-1">
        <button
          type="button"
          aria-label={`Play the recording, ${clockLabel(play.played)}`}
          onClick={() =>
            openEvidence(threadRef, root, { kind: "video", label, path: video }, ended)
          }
          className="group/play relative aspect-video w-40 shrink-0 cursor-pointer overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <GameKeyArt
            environmentId={threadRef.environmentId}
            root={root}
            path={poster}
            className="object-cover"
          />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-8 items-center justify-center rounded-full bg-black/55 text-white group-hover/play:bg-black/70">
              <PlayIcon aria-hidden="true" className="size-4 translate-x-px" />
            </span>
          </span>
        </button>
        <span className="flex min-w-0 flex-col">
          <Text variant="label" tone="default" numeric>
            {clockLabel(play.played)}
          </Text>
          <Text variant="caption" tone={play.ending === "crashed" ? "destructive" : "muted"}>
            {ended}
          </Text>
        </span>
      </div>
    </Workbench.Section>
  );
}

// A KeyboardEvent code as a key cap says it.
const KEY_WORDS: Readonly<Record<string, string>> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
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

const MOVES = ["move_up", "move_left", "move_down", "move_right"] as const;
/** The controls as a player names them: the four moves as one, each with its first key. */
const controlRows = (controls: ReadonlyArray<GameQaControl>) => {
  const moves = MOVES.map((name) => controls.find((control) => control.name === name));
  const rows: Array<{ keys: ReadonlyArray<string>; label: string; did: boolean; read: boolean }> =
    [];
  if (moves.every((control) => control !== undefined)) {
    rows.push({
      keys: moves.map((control) => keyWord(control!.keys?.[0] ?? "")),
      label: "Move",
      did: moves.some((control) => control!.answers.length > 0),
      read: moves.some((control) => control!.read),
    });
  }
  for (const control of controls) {
    if (rows.length > 0 && (MOVES as ReadonlyArray<string>).includes(control.name)) continue;
    rows.push({
      keys: (control.keys ?? []).slice(0, 1).map(keyWord),
      label: control.label,
      did: control.answers.length > 0,
      read: control.read,
    });
  }
  return rows;
};

/** The controls the check found, each as its keys and what it is; one that did nothing says so. */
function Controls({ facts }: { facts: GameBuildFacts }) {
  const qa = measured(facts.qa);
  if (qa === null || qa.controls.length === 0) return null;
  const rows = controlRows(qa.controls);
  return (
    <Workbench.Section title="Controls">
      <ul className="flex flex-wrap gap-x-4 gap-y-2 px-4 pt-1">
        {rows.map((row) => (
          <li
            key={row.label}
            className={cn("flex min-w-0 items-center gap-1.5", !row.did && "opacity-60")}
          >
            {row.keys.map((key, index) => (
              <KeyCap
                // oxlint-disable-next-line react/no-array-index-key -- two moves may share a cap.
                key={index}
              >
                {key}
              </KeyCap>
            ))}
            <Text variant="meta" tone="default">
              {row.label}
            </Text>
            {row.did ? null : (
              <Text variant="caption" tone="muted">
                {row.read ? "did nothing" : "never read"}
              </Text>
            )}
          </li>
        ))}
      </ul>
    </Workbench.Section>
  );
}

function KeyCap({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-muted px-1 font-sans text-caption text-foreground tabular-nums">
      {children}
    </kbd>
  );
}
