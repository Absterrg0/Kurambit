import { useEffect, useRef, useState } from "react";
import { Slider } from "@base-ui/react/slider";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import type { GamePlay, ScopedThreadRef } from "@kurambit/contracts";
import { FlagIcon, MessageSquarePlusIcon, MoreHorizontalIcon, RotateCcwIcon } from "lucide-react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup } from "../ui/popover";
import { Text } from "../ui/text";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { attachRunToComposer } from "./gameComposerContext";
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

  const rewindTo = useStableCallback(async (seconds: number) => {
    const source = timeline?.play;
    if (source === undefined) return;
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
 * The run's scrubber in the Stage's control bar, the way a video player's is: shown while the game
 * is paused or a run has ended, its deaths and its ending marked. Dragging shows the second;
 * letting go replays the run to it, frozen there, and playing on forks it. After a fork, "As it
 * was" and "With the change" replay the seconds after it. Beside it, the run goes to the agent or
 * is saved as a test play. Redraws only on input.
 */
export function GameRunScrubber({
  threadRef,
  rewind,
  runs,
  onRestart,
  onNote,
}: {
  threadRef: ScopedThreadRef;
  rewind: StageRewind;
  runs: StageRuns;
  /** A fresh run from the title. */
  onRestart: () => void;
  /** Says how a save went, in the Stage's status. */
  onNote: (text: string) => void;
}) {
  const { timeline, busy } = rewind;
  const tellsRuns = useThreadStageBridge(
    scopedThreadKey(threadRef),
    (state) => state.status === "ready" && state.capabilities.includes("runs"),
    false,
  );
  const [dragging, setDragging] = useState<number | null>(null);
  if (timeline === null) return null;
  const length = Math.max(playSeconds(timeline.play), 0.1);
  const at = dragging ?? busy ?? timeline.at ?? length;
  const marks = runTimelineMarks(timeline.play);
  const ended = runs.ended;
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
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" data-game-run-scrubber="">
      {/* What the last rewind or compare found is the time's own note, said on hover and to
          screen readers; the bar shows the moment itself. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Text
              variant="caption"
              tone="default"
              numeric
              aria-live="polite"
              aria-description={rewind.notice?.text}
              render={<span className="shrink-0" />}
            />
          }
        >
          {clockLabel(at)}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-xs">
          {rewind.notice?.text ?? "Drag to rewind; play on from any second to fork the run"}
        </TooltipPopup>
      </Tooltip>
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
        aria-label="Rewind the run to a second"
      >
        <Slider.Control className="flex h-8 w-full touch-none items-center">
          <Slider.Track className="relative h-1 w-full rounded-full bg-foreground/12">
            <Slider.Indicator className="rounded-full bg-foreground/30" />
            {timeline.fork === null ? null : (
              <TimelineMark
                seconds={timeline.fork.seconds}
                length={length}
                label="went on from here"
                className="h-3 w-0.5 rounded-full bg-live"
              />
            )}
            {marks.map((mark) => (
              <TimelineMark
                key={`${mark.kind}:${mark.seconds}:${mark.label}`}
                seconds={mark.seconds}
                length={length}
                label={mark.label}
                className={cn(
                  "size-1.5 rounded-full ring-2 ring-background",
                  mark.kind === "won"
                    ? "bg-success"
                    : mark.kind === "loss"
                      ? "bg-warning"
                      : "bg-destructive",
                )}
              />
            ))}
            <Slider.Thumb className="size-3 rounded-full bg-strong-foreground shadow-sm ring-2 ring-background outline-none focus-visible:ring-ring" />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <Text variant="caption" tone="muted" numeric render={<span className="shrink-0" />}>
        {clockLabel(length)}
      </Text>
      {rewind.comparable ? (
        <ToggleGroup
          aria-label="Compare the seconds after the fork"
          variant="segmented"
          size="xs"
          className="shrink-0"
          value={rewind.side === null ? [] : [rewind.side]}
          disabled={busy !== null}
          onValueChange={(value) => {
            const next = value[0] === "before" || value[0] === "after" ? value[0] : rewind.side;
            if (next !== null) void rewind.compare(next);
          }}
        >
          <Toggle value="before">As it was</Toggle>
          <Toggle value="after">With the change</Toggle>
        </ToggleGroup>
      ) : null}
      <RunActions
        threadRef={threadRef}
        runs={runs}
        canTell={busy === null && (ended !== null || tellsRuns)}
        onTell={() => void tell()}
        onRestart={onRestart}
        onNote={onNote}
      />
    </div>
  );
}

/**
 * What to do with the run, in one menu at the scrubber's end: tell the agent about it, save it as
 * a test play every build replays (named in a small form beside the menu), or start fresh.
 */
function RunActions({
  threadRef,
  runs,
  canTell,
  onTell,
  onRestart,
  onNote,
}: {
  threadRef: ScopedThreadRef;
  runs: StageRuns;
  canTell: boolean;
  onTell: () => void;
  onRestart: () => void;
  onNote: (text: string) => void;
}) {
  const savePlay = useAtomCommand(gameEnvironment.savePlay, { reportFailure: false });
  const canSave = useAtomValue(gameEnvironment.savePlay.permissionAtom(threadRef.environmentId));
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const ended = runs.ended;
  const save = async () => {
    if (ended === null) return;
    setSaving(true);
    setFailed(null);
    // The save replays the run once on its own build first, which takes a moment.
    const result = await savePlay({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, name: name.trim(), kept: ended.kept },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      setFailed(String(squashAtomCommandFailure(result)));
      return;
    }
    setNaming(false);
    setName("");
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
          {/* A first win is worth keeping: a small mark says so without another button. */}
          {ended?.firstWin === true ? (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-live"
            />
          ) : null}
        </MenuTrigger>
        <MenuPopup side="top" align="end">
          <MenuItem disabled={!canTell} onClick={onTell}>
            <MessageSquarePlusIcon />
            Tell the agent about this run
          </MenuItem>
          {canSave ? (
            <MenuItem
              disabled={ended === null}
              onClick={() => {
                // A first win is offered under its own name.
                if (name === "" && ended?.firstWin === true) setName("first win");
                setNaming(true);
              }}
            >
              <FlagIcon />
              {ended === null
                ? "Save as test play (play it to its end)"
                : ended.firstWin
                  ? "Save your first win as a test play…"
                  : "Save as test play…"}
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={onRestart}>
            <RotateCcwIcon />
            Restart from the title
          </MenuItem>
        </MenuPopup>
      </Menu>
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
            <Button size="sm" type="submit" disabled={saving || name.trim().length === 0}>
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
