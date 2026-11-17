import { create } from "zustand";
import type { GameLogLine } from "@kurambit/contracts";

/**
 * The folder's game's console (studio-log) per thread, for Checks' Console. In memory only, and
 * bounded: a few log batches a second are the only updates, so nothing here repaints per frame.
 */
export interface StageConsoleLine extends GameLogLine {
  /** Unique within the thread's console, for list keys. */
  readonly n: number;
}

interface StageWatch {
  readonly lines: ReadonlyArray<StageConsoleLine>;
  /** Lines the game logged past what was kept or sent. */
  readonly dropped: number;
  readonly next: number;
}

/** The console's last few hundred lines. */
const MAX_LINES = 400;
const EMPTY: StageWatch = { lines: [], dropped: 0, next: 0 };

const useStageWatches = create<Readonly<Record<string, StageWatch>>>()(() => ({}));

const update = (threadKey: string, change: (watch: StageWatch) => StageWatch) =>
  useStageWatches.setState((all) => ({ [threadKey]: change(all[threadKey] ?? EMPTY) }));

export const watchLog = (threadKey: string, lines: ReadonlyArray<GameLogLine>, dropped: number) =>
  update(threadKey, (watch) => {
    const numbered = lines.map((line, index) => ({ ...line, n: watch.next + index }));
    const all = [...watch.lines, ...numbered];
    return {
      ...watch,
      lines: all.slice(-MAX_LINES),
      dropped: watch.dropped + dropped + Math.max(0, all.length - MAX_LINES),
      next: watch.next + lines.length,
    };
  });

export const clearStageConsole = (threadKey: string) =>
  update(threadKey, (watch) => ({ ...watch, lines: [], dropped: 0 }));

export const useStageConsole = (threadKey: string) =>
  useStageWatches((all) => all[threadKey] ?? EMPTY);

/** How many of the console's kept lines are errors, or warnings: the Checks segment's count. */
export const useStageConsoleCount = (threadKey: string, level: "error" | "warn") =>
  useStageWatches(
    (all) => all[threadKey]?.lines.filter((line) => line.level === level).length ?? 0,
  );
