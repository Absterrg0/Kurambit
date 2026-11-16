import { create } from "zustand";
import type { GameLogLine, GamePlayMark } from "@kurambit/contracts";

/**
 * What the Workbench's Debug section watches of the folder's game, per thread: the run's once-a-second
 * marks (studio-mark) and the page's console (studio-log). In memory only, and bounded: a mark a
 * second and a few log batches a second are the only updates, so nothing here repaints per frame.
 */
export interface StageConsoleLine extends GameLogLine {
  /** Unique within the thread's console, for list keys. */
  readonly n: number;
}

interface StageWatch {
  readonly marks: ReadonlyArray<GamePlayMark>;
  readonly lines: ReadonlyArray<StageConsoleLine>;
  /** Lines the game logged past what was kept or sent. */
  readonly dropped: number;
  readonly next: number;
}

/** Ten minutes of a run, and the console's last few hundred lines. */
const MAX_MARKS = 600;
const MAX_LINES = 400;
const EMPTY: StageWatch = { marks: [], lines: [], dropped: 0, next: 0 };
const NO_MARKS: ReadonlyArray<GamePlayMark> = [];

const useStageWatches = create<Readonly<Record<string, StageWatch>>>()(() => ({}));

const update = (threadKey: string, change: (watch: StageWatch) => StageWatch) =>
  useStageWatches.setState((all) => ({ [threadKey]: change(all[threadKey] ?? EMPTY) }));

export const watchMark = (threadKey: string, mark: GamePlayMark) =>
  update(threadKey, (watch) => ({
    ...watch,
    // A mark at or before the last one is a new run that skipped its reset (a fork's handover).
    marks: [
      ...(watch.marks.length > 0 && mark.t <= watch.marks.at(-1)!.t
        ? []
        : watch.marks.slice(-(MAX_MARKS - 1))),
      mark,
    ],
  }));

/** The run on screen is gone: the watch starts over with the next run. */
export const watchRunReset = (threadKey: string) =>
  update(threadKey, (watch) => (watch.marks.length === 0 ? watch : { ...watch, marks: [] }));

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

export const useStageMarks = (threadKey: string): ReadonlyArray<GamePlayMark> =>
  useStageWatches((all) => all[threadKey]?.marks ?? NO_MARKS);

export const useStageConsole = (threadKey: string) =>
  useStageWatches((all) => all[threadKey] ?? EMPTY);

/** How many of the console's kept lines are errors, or warnings: the Debug switch's count. */
export const useStageConsoleCount = (threadKey: string, level: "error" | "warn") =>
  useStageWatches(
    (all) => all[threadKey]?.lines.filter((line) => line.level === level).length ?? 0,
  );
