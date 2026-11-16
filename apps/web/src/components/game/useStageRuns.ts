import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useAtomValue } from "@effect/atom-react";
import { type GameBuildId, type GamePlayOutcome, type ScopedThreadRef } from "@kurambit/contracts";
import { useStableCallback } from "../../hooks/useStableCallback";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { attachRunToComposer } from "./gameComposerContext";
import type { StudioMessage } from "./GamePlaySurface";
import type { StageRewind } from "./GameRunTimeline";

export interface EndedRun {
  readonly kept: string;
  readonly outcome: GamePlayOutcome;
  /** Won, and no saved play wins this game yet: the Stage offers to keep it as a test. */
  readonly firstWin: boolean;
}

/**
 * The person's runs on this Stage: each one the game posts, ended or left, is kept for the agent
 * and for replays. The latest ended one stays on show until the next run starts; a run asked
 * for while paused goes to the agent with the frame.
 */
export function useStageRuns(threadRef: ScopedThreadRef) {
  const { environmentId } = threadRef;
  const keepPlay = useAtomCommand(gameEnvironment.keepPlay, { reportFailure: false });
  const listPlays = useAtomCommand(gameEnvironment.savedPlays, { reportFailure: false });
  const canKeep = useAtomValue(gameEnvironment.keepPlay.permissionAtom(environmentId));
  // The run this Stage last kept that ended, which "Save as a test play" names.
  const [lastEnded, setLastEnded] = useState<string | null>(null);
  const [ended, setEnded] = useState<EndedRun | null>(null);
  // Counts runs started: a keep that answers after the next run began shows nothing.
  const runSerial = useRef(0);

  /** `build`: the build whose copy the run played on, when not the folder. */
  const receive = useStableCallback((message: StudioMessage, build?: GameBuildId) => {
    if (message.type === "studio-run-reset") {
      runSerial.current += 1;
      setEnded(null);
      return;
    }
    if (message.type !== "studio-play" || !canKeep) return;
    const serial = runSerial.current;
    const { outcome } = message.play;
    void keepPlay({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        play: message.play,
        ...(build === undefined ? {} : { build }),
      },
    }).then(async (result) => {
      if (result._tag !== "Success") return;
      const { kept } = result.value;
      if (message.asked === true) {
        await attachRunToComposer(threadRef, { kept, outcome, paused: true });
        return;
      }
      if (outcome.left === true) return;
      setLastEnded(kept);
      if (serial !== runSerial.current) return;
      setEnded({ kept, outcome, firstWin: false });
      if (!outcome.won) return;
      const saved = await listPlays({ environmentId, input: { threadId: threadRef.threadId } });
      if (saved._tag === "Success" && !saved.value.some((play) => play.outcome.won))
        setEnded((current) => (current?.kept === kept ? { ...current, firstWin: true } : current));
    });
  });

  return { lastEnded, ended, dismiss: () => setEnded(null), receive };
}

export type StageRuns = ReturnType<typeof useStageRuns>;

/**
 * The Stage's runs and rewind as the Workbench's Run tab reads them: the Stage owns both (its game
 * frame posts the runs), and publishes them here per thread so the right panel needs no props
 * threaded through ChatView. In memory only; gone with the Stage.
 */
export interface StageRunSession {
  readonly runs: StageRuns;
  readonly rewind: StageRewind;
  /** Says how a save went, in the Stage's status line. */
  readonly onNote: (text: string) => void;
  /** Gives the game the keyboard: playing on from a rewind is playing. */
  readonly onFocusGame: () => void;
}

const useRunSessions = create<Readonly<Record<string, StageRunSession>>>()(() => ({}));

/** Publishes the Stage's runs and rewind each time what they show changes. */
export function usePublishStageRuns(threadKey: string, session: StageRunSession) {
  const { ended, lastEnded } = session.runs;
  const { timeline, notice, busy, side } = session.rewind;
  // The latest handlers; the state fields below are what make a new session worth publishing.
  const read = useStableCallback(() => session);
  useEffect(() => {
    const now = read();
    useRunSessions.setState({
      [threadKey]: {
        ...now,
        runs: { ...now.runs, ended, lastEnded },
        rewind: { ...now.rewind, timeline, notice, busy, side },
      },
    });
    // Gone with the Stage; a newer publish replaces it in the same commit.
    return () =>
      useRunSessions.setState((all) => {
        const { [threadKey]: _gone, ...rest } = all;
        return rest;
      }, true);
  }, [threadKey, read, ended, lastEnded, timeline, notice, busy, side]);
}

export const useStageRunSession = (threadKey: string): StageRunSession | null =>
  useRunSessions((all) => all[threadKey] ?? null);
