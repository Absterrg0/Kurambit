import { useEffect, useRef, useState, type ReactNode } from "react";
import { Slider } from "@base-ui/react/slider";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import type { GamePlay, ScopedThreadRef } from "@kurambit/contracts";
import {
  FlagIcon,
  HistoryIcon,
  KeyboardIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
} from "lucide-react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { attachRunToComposer } from "./gameComposerContext";
import { GameControlsMenu } from "./GameControlsMenu";
import type { StudioMessage } from "./GamePlaySurface";
import {
  replayStageRun,
  requestStageRun,
  startStageFresh,
  takeStageRun,
  toggleStageFreeze,
  useStageBridge,
  useThreadStageBridge,
} from "./gameStageBridge";
import type { StageRuns } from "./useStageRuns";
import {
  canCompare,
  clockLabel,
  compareReplays,
  playSeconds,
  resumable,
  resumeNotice,
  rewindNotice,
  runTimelineMarks,
  RESUME_MAX_S,
  type RewindNotice,
  type RunFork,
} from "./gameStageRewind";

/** The run the timeline shows, where the game on the Stage stands in it, and the fork it is on. */
interface Timeline {
  readonly play: GamePlay;
  /** The second the Stage's game stands at; null at the run's end. */
  readonly at: number | null;
  readonly fork: RunFork | null;
}

type CompareSide = "before" | "after";

/** A fork still applies to a run of its seed that went on from that second. */
const keepFork = (fork: RunFork | null, play: GamePlay) =>
  fork !== null && play.seed === fork.origin.seed && play.fork === fork.seconds ? fork : null;

/**
 * Rewind and resume on the Stage, on the game's fixed clock (shell/replay.js): the run so far is
 * taken before a reload into play and replayed on the page that comes up, handed over frozen at
 * the step it had reached; the timeline replays the current or just-ended run to any second and
 * goes on from there as a new run; Compare plays the seconds after a fork with and without the
 * values tuned there.
 */
export function useStageRewind(threadRef: ScopedThreadRef, keep: (message: StudioMessage) => void) {
  const threadKey = scopedThreadKey(threadRef);
  const owner = useThreadStageBridge(threadKey, (state) => state.owner, null);
  const ready = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("rewind"),
    false,
  );
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [notice, setNotice] = useState<RewindNotice | null>(null);
  const [side, setSide] = useState<CompareSide | null>(null);
  // A replay asked for and not answered: the second it is getting back to.
  const [busy, setBusy] = useState<number | null>(null);
  const busyRef = useRef(false);
  // The run the last page handed over as it went away, and the frame that takes it: the next one.
  const carried = useRef<{ readonly play: GamePlay; readonly from: string | null } | null>(null);
  const claimed = useRef<{ readonly play: GamePlay; readonly owner: string } | null>(null);

  const replay = async (request: Parameters<typeof replayStageRun>[0], to: number) => {
    busyRef.current = true;
    setBusy(to);
    const replayed = await replayStageRun(request);
    busyRef.current = false;
    setBusy(null);
    return replayed;
  };

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
      setNotice({
        text: `Runs over ${RESUME_MAX_S / 60} minutes start fresh after a reload`,
        handedOver: false,
        ended: false,
      });
      return;
    }
    const replayed = await replay({ play: run.play, step: run.play.steps }, playSeconds(run.play));
    if (replayed === null) return;
    setSide(null);
    setNotice(resumeNotice(run.play, replayed));
    setTimeline({ play: run.play, at: replayed.seconds ?? null, fork: null });
  });
  useEffect(() => {
    if (ready) void resume();
  }, [ready, resume]);

  // Frozen mid-run, the timeline shows the run so far. A replay's own freeze at its moment is not
  // a new run to show: the timeline stays on the run being rewound.
  const look = useStableCallback(async () => {
    if (busyRef.current) return;
    const play = await takeStageRun(false);
    if (play === null || busyRef.current) return;
    setTimeline((current) =>
      current !== null &&
      current.at !== null &&
      current.play.seed === play.seed &&
      play.steps <= stepsAt(current)
        ? current
        : { play, at: null, fork: keepFork(current?.fork ?? null, play) },
    );
  });
  useEffect(
    () =>
      useStageBridge.subscribe((state, before) => {
        if (state.frozen === before.frozen || state.owner?.startsWith(`${threadKey}\0`) !== true)
          return;
        if (!state.frozen) {
          // Played on: what the last replay said no longer stands, but for an ending it reached.
          setNotice((current) => (current?.ended === true ? current : null));
          return;
        }
        if (state.status === "ready" && state.capabilities.includes("rewind")) void look();
      }),
    [threadKey, look],
  );

  /** What the Stage's game posts of its runs: an ending shows on the timeline; a new run clears it. */
  const receive = useStableCallback((message: StudioMessage) => {
    if (message.type === "studio-run-reset") {
      // A replay starts its run afresh: that is the rewind itself, not the person leaving.
      if (busyRef.current) return;
      setTimeline(null);
      setNotice(null);
      setSide(null);
      return;
    }
    if (message.type !== "studio-play" || message.asked === true) return;
    if (message.play.outcome.left === true) return;
    const { play } = message;
    setTimeline((current) => ({ play, at: null, fork: keepFork(current?.fork ?? null, play) }));
  });

  /**
   * Before the Stage's game reloads into play: takes the run so far from the page, keeps it as
   * left (so the agent hears of it, and the run that goes on replaces it), and carries it to the
   * page that comes up. Resolves when the page answered, or did not in time.
   */
  const leave = useStableCallback(async () => {
    const from = useStageBridge.getState().owner;
    const play = await takeStageRun(true);
    if (play === null) return;
    carried.current = { play, from };
    keep({ type: "studio-play", play });
  });

  /**
   * To a second of the run, from anywhere on the timeline: a run still playing is paused and
   * taken as it stands first, so a click while playing rewinds as one while paused does.
   */
  const rewindTo = useStableCallback(async (seconds: number) => {
    const live = !useStageBridge.getState().frozen;
    if (live) toggleStageFreeze();
    const source = live || timeline === null ? await takeStageRun(false) : timeline.play;
    if (source === null) return;
    const replayed = await replay({ play: source, at: seconds, fork: seconds }, seconds);
    if (replayed === null) return;
    const read = rewindNotice(source, replayed);
    setSide(null);
    setNotice(read);
    setTimeline({
      play: source,
      at: replayed.seconds ?? seconds,
      fork:
        read.handedOver && replayed.steps !== undefined
          ? { origin: source, step: replayed.steps, seconds }
          : null,
    });
  });

  const compare = useStableCallback(async (next: CompareSide) => {
    const run = timeline?.play ?? null;
    const fork = timeline?.fork ?? null;
    if (run === null || fork === null || !canCompare(fork, run)) return;
    const { before, after, stop } = compareReplays(fork, run);
    const to = stop * run.dt;
    const replayed = await replay(
      { play: next === "before" ? before : after, step: stop, pace: fork.step, fork: fork.seconds },
      to,
    );
    if (replayed === null) return;
    setSide(next);
    const span = `${clockLabel(fork.seconds)} to ${clockLabel(replayed.seconds ?? to)}`;
    setNotice({
      text:
        replayed.ended != null
          ? `${next === "before" ? "As it was" : "With the change"}, the run ends at ${clockLabel(replayed.ended.seconds)}`
          : `${next === "before" ? "As it was" : "With the change"}: ${span}, the same input`,
      handedOver: replayed.ended == null,
      ended: replayed.ended != null,
    });
    setTimeline((current) =>
      current === null ? null : { ...current, at: replayed.seconds ?? to },
    );
  });

  const fresh = () => {
    startStageFresh();
    setTimeline(null);
    setNotice(null);
    setSide(null);
  };

  const playOn = () => {
    if (useStageBridge.getState().frozen) toggleStageFreeze();
  };

  return {
    timeline,
    notice,
    busy,
    side,
    comparable: timeline !== null && canCompare(timeline.fork, timeline.play),
    receive,
    leave,
    rewindTo,
    compare,
    fresh,
    playOn,
    dismiss: () => setNotice(null),
  };
}

/** The step a timeline's game stands at: a later take of the same run is the same moment or on. */
const stepsAt = (timeline: Timeline) =>
  timeline.at === null ? timeline.play.steps : Math.round(timeline.at / timeline.play.dt);

export type StageRewind = ReturnType<typeof useStageRewind>;

/**
 * The run's timeline in the control bar, shown only when there is something to scrub: paused or
 * ended, the run with its losses, its ending and a fork marked, and its one time after it.
 * Dragging or clicking it rewinds to that second. While the game plays its room stays empty, so
 * the bar's buttons never move. Redraws only on input and on pausing, rewinding or an ending.
 */
export function GameRunTimeline({
  threadRef,
  rewind,
  ended,
  enabled,
}: {
  threadRef: ScopedThreadRef;
  rewind: StageRewind;
  /** The run reached its end and stands on its end screen. */
  ended: boolean;
  /** The folder's own game plays and can be rewound; a copy or a parked engine cannot. */
  enabled: boolean;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const { timeline, busy } = rewind;
  const frozen = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const [dragging, setDragging] = useState<number | null>(null);
  // Paused, ended or rewinding: the run taken from the game. Playing, or not the folder's game (a
  // copy, a compare, a state card): nothing to scrub, so nothing shows.
  const held = enabled && timeline !== null && (frozen || busy !== null || ended);
  if (!held) return <div className="min-w-0 flex-1" data-game-run-timeline="" />;
  const length = Math.max(playSeconds(timeline.play), 0.1);
  const at = dragging ?? busy ?? timeline.at ?? length;
  const runMarks = runTimelineMarks(timeline.play);
  const fork = timeline.fork;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3" data-game-run-timeline="">
      <Slider.Root
        className="min-w-12 flex-1"
        value={Math.min(at, length)}
        min={0}
        max={length}
        step={0.1}
        disabled={busy !== null}
        onValueChange={(next) => {
          const single = Array.isArray(next) ? next[0] : next;
          if (typeof single === "number") setDragging(single);
        }}
        onValueCommitted={(next) => {
          const single = Array.isArray(next) ? next[0] : next;
          setDragging(null);
          if (typeof single === "number") void rewind.rewindTo(single);
        }}
        aria-label="Run timeline: drag to rewind"
      >
        <Slider.Control className="group/timeline flex h-9 w-full touch-none items-center">
          <Slider.Track className="relative h-0.5 w-full rounded-full bg-foreground/12">
            <Slider.Indicator className="rounded-full bg-foreground/40" />
            {fork === null || fork.seconds > length ? null : (
              <TimelineMark
                seconds={fork.seconds}
                length={length}
                label="went on from here"
                className="h-2.5 w-px bg-foreground"
              />
            )}
            {runMarks.map((mark) => (
              <TimelineMark
                key={`${mark.kind}:${mark.seconds}:${mark.label}`}
                seconds={mark.seconds}
                length={length}
                label={mark.label}
                className={cn(
                  "size-1.5 rounded-full",
                  mark.kind === "won"
                    ? "bg-success"
                    : mark.kind === "loss"
                      ? "bg-warning"
                      : "bg-destructive",
                )}
              />
            ))}
            <Slider.Thumb className="size-2.5 rounded-full bg-foreground outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      {/* The one time; what the last rewind or replay found is its note, on hover. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Text
              variant="caption"
              tone="muted"
              numeric
              aria-description={rewind.notice?.text}
              render={<span className="w-9 shrink-0 text-end" />}
            />
          }
        >
          {clockLabel(at)}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-xs">
          {rewind.notice?.text ?? "Drag the timeline to rewind; play on from any second to fork"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/**
 * The bar's `⋯` menu, in three sections. Run: tell the agent about the run, save it as a test play
 * (named in a small form beside the menu), replay a fork as it was. View: the game's controls and
 * the dev views. Stage: what the Stage does with the game.
 */
export function GameRunMenu({
  threadRef,
  rewind,
  runs,
  playing,
  live,
  viewItems,
  stageItems,
  onNote,
  onFocus,
}: {
  threadRef: ScopedThreadRef;
  rewind: StageRewind;
  runs: StageRuns;
  /** A game plays on the Stage, so it has controls to show. */
  playing: boolean;
  /** It is the folder's own game, running, so its run so far can be taken. */
  live: boolean;
  viewItems: ReactNode;
  stageItems: ReactNode;
  onNote: (text: string) => void;
  onFocus: () => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
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
  const canTell = rewind.busy === null && (ended !== null || (frozen && tellsRuns));
  const canTake = live && takesRuns && rewind.busy === null;
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
   * Any run can be a test play, an open-ended game's too: the run so far, to now or to the second
   * the timeline was rewound to (the page holds the run from there), or else the run that ended.
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
      <Menu>
        <MenuTrigger
          ref={anchor}
          render={<Button size="icon-sm" variant="ghost" aria-label="Run actions" />}
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup side="top" align="end">
          <MenuGroup>
            <MenuGroupLabel>Run</MenuGroupLabel>
            <MenuItem disabled={!canTell} onClick={() => void tell()}>
              <MessageSquarePlusIcon />
              Tell the agent about this run
            </MenuItem>
            {canSave ? (
              <MenuItem disabled={ended === null && !canTake} onClick={() => void take()}>
                <FlagIcon />
                Save as test play…
              </MenuItem>
            ) : null}
            {rewind.comparable ? (
              <MenuItem
                disabled={rewind.busy !== null}
                onClick={() => void rewind.compare(rewind.side === "before" ? "after" : "before")}
              >
                <HistoryIcon />
                {rewind.side === "before" ? "Replay with the change" : "Replay as it was"}
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

/** One mark on the scrubber, named on hover: a loss, the ending, the second the run went on from. */
function TimelineMark({
  seconds,
  length,
  label,
  className,
}: {
  seconds: number;
  length: number;
  label: string;
  className: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("absolute top-1/2 -translate-1/2", className)}
            style={{ left: `${Math.min(seconds / length, 1) * 100}%` }}
          />
        }
      />
      <TooltipPopup side="top">{`${clockLabel(seconds)} ${label}`}</TooltipPopup>
    </Tooltip>
  );
}
