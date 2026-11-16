import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { playOutcomeWords, type GamePlayOutcome, type ScopedThreadRef } from "@kurambit/contracts";
import { MessageSquareIcon, XIcon } from "lucide-react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { captureStageFrame, requestStageRun, useThreadStageBridge } from "./gameStageBridge";
import type { StudioMessage } from "./GamePlaySurface";
import { tellAgentAboutRun } from "./gameRunTell";

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
 * for a first win, "Keep this win as a test play". While paused mid-run, only the tell. Its own
 * dark backing, like the Stage's other cards, so it reads over whatever the game drew.
 */
export function GameRunCard({
  threadRef,
  runs,
  onNote,
}: {
  threadRef: ScopedThreadRef;
  runs: ReturnType<typeof useStageRuns>;
  /** Says how a save went, in the Stage's status line. */
  onNote: (text: string) => void;
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
  if (ended === null && !(frozen && tellsRuns)) return null;

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

  const words = ended === null ? null : playOutcomeWords(ended.outcome);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
      <div
        className="pointer-events-auto flex max-w-full min-w-0 items-center gap-2 rounded-xl bg-stage-well py-1.5 ps-3 pe-1.5 text-stage-foreground shadow-lg"
        data-game-run-card=""
      >
        {words === null ? null : (
          <Text variant="meta" tone="inherit" truncate>
            {`${words.charAt(0).toUpperCase()}${words.slice(1)}`}
          </Text>
        )}
        <Button size="sm" variant="overlay" onClick={() => void tell()}>
          <MessageSquareIcon aria-hidden="true" />
          Tell the agent about this run
        </Button>
        {ended?.firstWin === true && canSave ? (
          <Button size="sm" variant="overlay" disabled={saving} onClick={() => void keepWin()}>
            {saving ? "Checking it replays the same…" : "Keep this win as a test play"}
          </Button>
        ) : null}
        {ended === null ? null : (
          <Button
            size="icon-micro"
            variant="overlay"
            aria-label="Dismiss the run"
            onClick={runs.dismiss}
          >
            <XIcon aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
