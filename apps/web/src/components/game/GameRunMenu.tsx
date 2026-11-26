import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import type { GamePlay, ScopedThreadRef } from "@kurambit/contracts";
import { FlagIcon, KeyboardIcon, MessageSquarePlusIcon, MoreHorizontalIcon } from "lucide-react";

import { openGameTool } from "../../gameArrivalStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup } from "../ui/popover";
import { Text } from "../ui/text";
import { ArrivalDot } from "./ArrivalDot";
import { attachRunToComposer } from "./gameComposerContext";
import { GameControlsMenu } from "./GameControlsMenu";
import type { StudioMessage } from "./GamePlaySurface";
import {
  replayStageRun,
  requestStageRun,
  takeStageRun,
  toggleStageFreeze,
  useStageBridge,
  useThreadStageBridge,
} from "./gameStageBridge";
import { playSeconds, RESUME_MAX_S, resumable, resumeNotice } from "./gameStageResume";
import { type GameArrival, useArrival } from "./useGameArrivals";
import type { StageRuns } from "./useStageRuns";

/**
 * Back where you were, on the game's fixed clock (shell/replay.js): before the Stage's game
 * reloads into play, the run so far is taken from the page and carried to the page that comes up,
 * which replays it to the step it had reached and plays on. What the replay found, when it is
 * news, goes to `note`. Returns the leave to call before such a reload.
 */
export function useStageResume(
  threadRef: ScopedThreadRef,
  keep: (message: StudioMessage) => void,
  note: (text: string) => void,
) {
  const threadKey = scopedThreadKey(threadRef);
  const owner = useThreadStageBridge(threadKey, (state) => state.owner, null);
  const ready = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("rewind"),
    false,
  );
  // The run the last page handed over as it went away, and the frame that takes it: the next one.
  const carried = useRef<{ readonly play: GamePlay; readonly from: string | null } | null>(null);
  const claimed = useRef<{ readonly play: GamePlay; readonly owner: string } | null>(null);

  // The frame after a reload into play takes the carried run; any later frame finds none.
  useEffect(() => {
    if (owner === null) return;
    const run = carried.current;
    carried.current = null;
    claimed.current = run === null || run.from === owner ? null : { play: run.play, owner };
  }, [owner]);

  const resume = useStableCallback(async () => {
    const run = claimed.current;
    if (run === null || run.owner !== useStageBridge.getState().owner) return;
    claimed.current = null;
    if (!resumable(run.play)) {
      if (playSeconds(run.play) > RESUME_MAX_S)
        note(`Runs over ${RESUME_MAX_S / 60} minutes start fresh after a reload`);
      return;
    }
    const replayed = await replayStageRun({ play: run.play, step: run.play.steps });
    if (replayed === null) return;
    // The page hands a replay over frozen, the person's own pause for pointing at things, where
    // the first click picks. Coming back after a reload is no such pause: the run plays on, and
    // the Stage holds it as it holds any game (Click to play while the person is elsewhere).
    const bridge = useStageBridge.getState();
    if (bridge.owner === run.owner && bridge.frozen) toggleStageFreeze();
    const said = resumeNotice(run.play, replayed);
    if (said !== null) note(said);
  });
  useEffect(() => {
    if (ready) void resume();
  }, [ready, resume]);

  /**
   * Before the Stage's game reloads into play: takes the run so far from the page, keeps it as
   * left (so the agent hears of it, and the run that goes on replaces it), and carries it to the
   * page that comes up. Resolves when the page answered, or did not in time.
   */
  return useStableCallback(async () => {
    const from = useStageBridge.getState().owner;
    const play = await takeStageRun(true);
    if (play === null) return;
    carried.current = { play, from };
    keep({ type: "studio-play", play });
  });
}

/**
 * The bar's `⋯` menu, in three sections. Run: tell the agent about the run, save it as a test play
 * (named in a small form beside the menu). View: the game's controls. Stage: what the Stage does
 * with the game.
 */
export function GameRunMenu({
  threadRef,
  runs,
  playing,
  live,
  viewItems,
  responsive,
  stageItems,
  onNote,
  onFocus,
}: {
  threadRef: ScopedThreadRef;
  runs: StageRuns;
  /** A game plays on the Stage, so it has controls to show. */
  playing: boolean;
  /** It is the folder's own game, running, so its run so far can be taken. */
  live: boolean;
  viewItems: ReactNode;
  responsive: GameArrival;
  stageItems: ReactNode;
  onNote: (text: string) => void;
  onFocus: () => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  // Test plays arrive when a run first ends: there is a run worth keeping.
  const testPlays = useArrival("test-plays", runs.ended !== null);
  const frozen = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const tellsRuns = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("runs"),
    false,
  );
  const hasControls = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("controls"),
    false,
  );
  const takesRuns = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("rewind"),
    false,
  );
  const keepPlay = useAtomCommand(gameEnvironment.keepPlay, { reportFailure: false });
  const savePlay = useAtomCommand(gameEnvironment.savePlay, { reportFailure: false });
  const canSave = useAtomValue(gameEnvironment.savePlay.permissionAtom(threadRef.environmentId));
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [naming, setNaming] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [name, setName] = useState("");
  // The run Save as test play took when it was chosen: the run so far, or the one that ended.
  const [kept, setKept] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const ended = runs.ended;
  const canTell = ended !== null || (frozen && tellsRuns);
  const canTake = live && takesRuns;
  const tell = async () => {
    // A paused run is asked of the game first; it answers with the run (useStageRuns).
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
  /**
   * Any run can be a test play, an open-ended game's too: the run so far, or else the run that
   * ended.
   */
  const take = async () => {
    setFailed(null);
    setKept(null);
    // A first win is offered under its own name.
    if (name === "" && ended?.firstWin === true) setName("first win");
    setNaming(true);
    const play = canTake ? await takeStageRun(false) : null;
    if (play === null) {
      if (ended !== null) setKept(ended.kept);
      else setFailed("The game has no run to save yet.");
      return;
    }
    const result = await keepPlay({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        play: { ...play, outcome: { ...play.outcome, text: "" } },
      },
    });
    if (result._tag === "Failure") setFailed(String(squashAtomCommandFailure(result)));
    else setKept(result.value.kept);
  };
  const save = async () => {
    if (kept === null) return;
    setSaving(true);
    setFailed(null);
    // The save replays the run once on its own build first, which takes a moment.
    const result = await savePlay({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, name: name.trim(), kept },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      setFailed(String(squashAtomCommandFailure(result)));
      return;
    }
    setNaming(false);
    setName("");
    setKept(null);
    runs.saved();
    onNote(
      `${result.value.replaced ? "Replaced" : "Saved"} "${result.value.name}" as a test play: every build replays it, in Checks.`,
    );
  };
  return (
    <>
      <Menu
        onOpenChange={(open) => {
          if (!open) return;
          if (testPlays.shown) openGameTool("test-plays");
          if (responsive.shown) openGameTool("responsive");
        }}
      >
        <MenuTrigger
          ref={anchor}
          render={<Button size="icon-sm" variant="ghost" aria-label="Run actions" />}
        >
          <MoreHorizontalIcon aria-hidden="true" />
          <ArrivalDot on={testPlays.dot || responsive.dot} corner />
        </MenuTrigger>
        <MenuPopup side="top" align="end">
          <MenuGroup>
            <MenuGroupLabel>Run</MenuGroupLabel>
            <MenuItem disabled={!canTell} onClick={() => void tell()}>
              <MessageSquarePlusIcon />
              Tell the agent about this run
            </MenuItem>
            {canSave && testPlays.shown ? (
              <MenuItem disabled={ended === null && !canTake} onClick={() => void take()}>
                <FlagIcon />
                Save as test play…
              </MenuItem>
            ) : null}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>View</MenuGroupLabel>
            <MenuItem disabled={!playing || !hasControls} onClick={() => setControlsOpen(true)}>
              <KeyboardIcon />
              Show controls
            </MenuItem>
            {viewItems}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Stage</MenuGroupLabel>
            {stageItems}
          </MenuGroup>
        </MenuPopup>
      </Menu>
      <GameControlsMenu
        threadRef={threadRef}
        open={controlsOpen}
        anchor={anchor}
        onOpenChange={setControlsOpen}
        onFocus={onFocus}
      />
      <Popover open={naming} onOpenChange={setNaming}>
        <PopoverPopup anchor={anchor} side="top" align="end" padding="compact" width="sm">
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Input
              size="sm"
              value={name}
              maxLength={60}
              autoFocus
              disabled={saving}
              placeholder="Name this run"
              aria-label="Name this run"
              onChange={(event) => setName(event.currentTarget.value)}
            />
            {failed === null ? null : (
              <Text variant="caption" tone="destructive" render={<p role="alert" />}>
                {failed}
              </Text>
            )}
            <Button
              size="sm"
              type="submit"
              disabled={saving || kept === null || name.trim().length === 0}
            >
              {saving ? "Checking it replays the same…" : "Save as test play"}
            </Button>
          </form>
        </PopoverPopup>
      </Popover>
    </>
  );
}
