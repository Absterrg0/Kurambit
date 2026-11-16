import { create } from "zustand";
import type { GamePlayOutcome } from "@kurambit/contracts";

/**
 * A run the person is telling the agent about from the Stage ("Tell the agent about this run"):
 * like a thing pointed at on the frozen Stage, it goes with their next message, its frame
 * attached and its id, how it went and how to replay it in the text. In memory only.
 */
export interface ToldRun {
  readonly threadKey: string;
  /** The kept run's id, which `game_play` op `replay` takes. */
  readonly kept: string;
  readonly outcome: GamePlayOutcome;
  /** Told while paused mid-run, rather than from its end. */
  readonly paused: boolean;
  /** The Stage's canvas when they asked, as a PNG data URL; null when the game gave none. */
  readonly frame: string | null;
}

const useToldRuns = create<{ readonly told: ToldRun | null }>()(() => ({ told: null }));

export const tellAgentAboutRun = (run: ToldRun) => useToldRuns.setState({ told: run });
export const clearToldRun = () => useToldRuns.setState({ told: null });

export const readToldRun = (threadKey: string): ToldRun | null => {
  const { told } = useToldRuns.getState();
  return told?.threadKey === threadKey ? told : null;
};

export const useToldRun = (threadKey: string | null): ToldRun | null =>
  useToldRuns((state) =>
    threadKey !== null && state.told?.threadKey === threadKey ? state.told : null,
  );
