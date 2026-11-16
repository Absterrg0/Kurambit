import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { playOutcomeWords, type GamePlayOutcome, type ScopedThreadRef } from "@kurambit/contracts";
import { MessageSquareIcon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { captureStageFrame, requestStageRun, useThreadStageBridge } from "./gameStageBridge";
import type { StudioMessage } from "./GamePlaySurface";
import { tellAgentAboutRun } from "./gameRunTell";
import { GameRunCompare, GameRunTimeline, type StageRewind } from "./GameRunTimeline";
import { clockLabel } from "./gameStageRewind";

/** The name a first win is saved under from the Stage. */
const FIRST_WIN_NAME = "first win";

interface EndedRun {
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

  const receive = useStableCallback((message: StudioMessage) => {
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
      input: { threadId: threadRef.threadId, play: message.play },
    }).then(async (result) => {
      if (result._tag !== "Success") return;
      const { kept } = result.value;
      if (message.asked === true) {
        tellAgentAboutRun({
          threadKey: scopedThreadKey(threadRef),
          kept,
          outcome,
          paused: true,
          frame: await captureStageFrame(),
        });
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

/**
 * Over the Stage's bottom edge: how the run just ended, with "Tell the agent about this run" and,
 * for a first win, "Keep this win as a test play". While paused mid-run, only the tell. Above
 * them, frozen or ended, the run's timeline to rewind it, and what the last replay found (back
 * where the person was after a reload, a fork, Compare). Its own dark backing, like the Stage's
 * other cards, so it reads over whatever the game drew.
 */
export function GameRunCard({
  threadRef,
  runs,
  rewind,
  onNote,
  onFocusGame,
}: {
  threadRef: ScopedThreadRef;
  runs: ReturnType<typeof useStageRuns>;
  rewind: StageRewind;
  /** Says how a save went, in the Stage's status line. */
  onNote: (text: string) => void;
  /** Gives the game the keyboard: playing on from a rewind is playing. */
  onFocusGame: () => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const frozen = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const tellsRuns = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("runs"),
    false,
  );
  const savePlay = useAtomCommand(gameEnvironment.savePlay, { reportFailure: false });
  const canSave = useAtomValue(gameEnvironment.savePlay.permissionAtom(threadRef.environmentId));
  const [saving, setSaving] = useState(false);
  const { ended } = runs;
  const { notice, busy, timeline } = rewind;
  const shown = ended !== null || (frozen && tellsRuns);
  if (!shown && busy === null && notice === null) return null;

  const tell = async () => {
    // A paused run is asked for first; the game answers with it (useStageRuns).
    if (ended === null) {
      requestStageRun();
      return;
    }
    tellAgentAboutRun({
      threadKey,
      kept: ended.kept,
      outcome: ended.outcome,
      paused: false,
      frame: await captureStageFrame(),
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
      onNote(String(squashAtomCommandFailure(result)));
      return;
    }
    runs.dismiss();
    onNote(`Saved "${result.value.name}" as a test play: every build replays it from now on.`);
  };

  // What the last replay found, said in full above the buttons; else how the run ended, beside them.
  const said = busy !== null ? `Getting back to ${clockLabel(busy)}…` : (notice?.text ?? null);
  const words = said !== null || ended === null ? null : playOutcomeWords(ended.outcome);
  const withTimeline = timeline !== null && (shown || busy !== null);
  const playOn = () => {
    rewind.playOn();
    onFocusGame();
  };
  return (
    // With its timeline the card stands above the Stage's frozen hint in the bottom corner.
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 z-20 flex justify-center px-3",
        withTimeline ? "bottom-11" : "bottom-3",
      )}
    >
      <div
        className={cn(
          "pointer-events-auto flex max-w-full min-w-0 flex-col gap-1 rounded-xl bg-stage-well py-1.5 ps-3 pe-1.5 text-stage-foreground shadow-lg",
          withTimeline && "w-[40rem]",
        )}
        data-game-run-card=""
      >
        {withTimeline ? <GameRunTimeline rewind={rewind} /> : null}
        {said === null ? null : (
          <Text variant="meta" tone="inherit" render={<p className="line-clamp-2 pe-1.5" />}>
            {said}
          </Text>
        )}
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {words === null ? null : (
            <Text variant="meta" tone="inherit" truncate render={<span className="flex-1" />}>
              {`${words.charAt(0).toUpperCase()}${words.slice(1)}`}
            </Text>
          )}
          {busy === null && frozen ? <GameRunCompare rewind={rewind} /> : null}
          {busy === null && notice !== null && frozen ? (
            <Button size="sm" variant="overlay" onClick={playOn}>
              <PlayIcon aria-hidden="true" />
              Play on
            </Button>
          ) : null}
          {busy === null && notice !== null && (frozen || notice.ended) ? (
            <>
              <Button
                size="sm"
                variant="overlay"
                onClick={() => {
                  rewind.fresh();
                  onFocusGame();
                }}
              >
                <RotateCcwIcon aria-hidden="true" />
                Start fresh
              </Button>
            </>
          ) : null}
          {/* A replay held at an ending it reached has no run in play to tell of. */}
          {shown && busy === null && notice?.ended !== true ? (
            <Button size="sm" variant="overlay" onClick={() => void tell()}>
              <MessageSquareIcon aria-hidden="true" />
              Tell the agent about this run
            </Button>
          ) : null}
          {ended?.firstWin === true && canSave ? (
            <Button size="sm" variant="overlay" disabled={saving} onClick={() => void keepWin()}>
              {saving ? "Checking it replays the same…" : "Keep this win as a test play"}
            </Button>
          ) : null}
          {ended === null && notice === null ? null : (
            <Button
              size="icon-micro"
              variant="overlay"
              aria-label="Dismiss the run"
              onClick={() => {
                runs.dismiss();
                rewind.dismiss();
              }}
            >
              <XIcon aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
