import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import {
  MaximizeIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  ShieldIcon,
  Volume2Icon,
  VolumeIcon,
  VolumeXIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

import { shortcutLabelForCommand } from "../../keybindings";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Text } from "../ui/text";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipLabel, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { GameArrival } from "./useGameArrivals";
import { GameRunMenu, GameRunTimeline, type StageRewind } from "./GameRunTimeline";
import {
  setStageMuted,
  setStageSpeed,
  stageCannotLose,
  toggleStageCannotLose,
  toggleStageFreeze,
  useStageCannotLose,
  useThreadStageBridge,
} from "./gameStageBridge";
import type { StageRuns } from "./useStageRuns";

const SPEEDS = [1, 0.5, 0.25] as const;
const SPEED_WORDS: Record<(typeof SPEEDS)[number], string> = { 1: "1×", 0.5: "½×", 0.25: "¼×" };
const NONE: ReadonlyArray<string> = [];

/**
 * Can't lose flipped from anywhere (the bar, the palette, its key), saying what it now does.
 * Nothing for a game that can't be lost, or one not up on the Stage.
 */
export const flipStageCannotLose = (threadKey: string, canLose: boolean): boolean => {
  if (!canLose || !toggleStageCannotLose(threadKey)) return false;
  const on = stageCannotLose(threadKey);
  toastManager.add(
    on
      ? {
          type: "info",
          title: "Can't lose is on",
          description:
            "A loss no longer ends the run, so you can tune a fight. Checks never see it.",
        }
      : { type: "info", title: "Can't lose is off", description: "A loss ends the run again." },
  );
  return true;
};

/** The key a game command has here, as its tooltip says it. */
function useGameKey(command: "game.freeze" | "game.fullscreen" | "game.cannotLose.toggle") {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return shortcutLabelForCommand(keybindings, command, { context: { gameThread: true } });
}

/**
 * The control bar under the Stage, one layout in every state: Play or Pause and Restart, the run's
 * timeline with its time in the middle while there is something to scrub (paused, or a run ended),
 * then speed, Can't lose, sound, fullscreen and the `⋯` menu. The buttons never move: only the
 * Play icon and the middle change. A control the game cannot use is disabled, not gone.
 */
export function GameStageBar({
  threadRef,
  canLose,
  playing,
  live,
  stopped,
  canReload,
  rewind,
  runs,
  onRestart,
  onFullscreen,
  viewItems,
  responsive,
  stageItems,
  onFocus,
  onNote,
}: {
  threadRef: ScopedThreadRef;
  /** The game's code can lose a run: only then is there a Can't lose to offer. */
  canLose: boolean;
  /** A game plays on the Stage (not a compare, not a state card). */
  playing: boolean;
  /** It is the folder's own game, so its runs can be rewound. */
  live: boolean;
  /**
   * The game on the Stage doesn't run (it doesn't start): play's own controls are off and the
   * time reads 0:00. Restart, fullscreen and the run's menu stay.
   */
  stopped: boolean;
  canReload: boolean;
  rewind: StageRewind;
  runs: StageRuns;
  onRestart: () => void;
  onFullscreen: () => void;
  /** The `⋯` menu's View section after Show controls: the dev views, each with its key. */
  viewItems: ReactNode;
  /** Responsive view's arrival: the menu says it once with a dot. */
  responsive: GameArrival;
  /** The `⋯` menu's Stage section: pausing when away, hiding and stopping the game. */
  stageItems: ReactNode;
  /** Gives the game the keyboard back after a control took it. */
  onFocus: () => void;
  onNote: (text: string) => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const capabilities = useThreadStageBridge(threadKey, (state) => state.capabilities, NONE);
  const ready = useThreadStageBridge(threadKey, (state) => state.status === "ready", false);
  const paused = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const speed = useThreadStageBridge(threadKey, (state) => state.speed, 1);
  const muted = useThreadStageBridge(threadKey, (state) => state.muted, false);
  // A game with no sound file has nothing to hear yet: said on the control, so a silent game
  // that is still being made is not taken for a broken one. Unknown until its files are read.
  const art = useEnvironmentQuery(
    gameEnvironment.artAssets({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const silent =
    art !== null &&
    art !== undefined &&
    art.more === 0 &&
    !art.assets.some((asset) => asset.kind === "audio");
  const cannotLose = useStageCannotLose(threadKey);
  const freezeKey = useGameKey("game.freeze");
  const cannotLoseKey = useGameKey("game.cannotLose.toggle");
  const fullscreenKey = useGameKey("game.fullscreen");
  // The bridge speaks for the folder's own game: a copy or a compare plays without it.
  const can = (capability: string) =>
    playing && live && !stopped && ready && capabilities.includes(capability);
  return (
    <div className="flex h-9 w-full min-w-0 items-center gap-1" data-game-play-controls="">
      <Control
        label={paused ? "Play" : "Pause"}
        detail={paused ? null : "Then click something in the game to point at it"}
        shortcut={freezeKey}
        pressed={paused}
        disabled={!can("freeze")}
        onClick={() => {
          toggleStageFreeze();
          if (paused) onFocus();
        }}
      >
        {paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
      </Control>
      <Control
        label="Restart"
        detail="A fresh run from the title"
        disabled={!playing || !canReload}
        onClick={() => {
          onRestart();
          onFocus();
        }}
      >
        <RotateCcwIcon aria-hidden="true" />
      </Control>
      <span className="w-2 shrink-0" aria-hidden="true" />
      <GameRunTimeline
        threadRef={threadRef}
        cannotLose={canLose && cannotLose}
        rewind={rewind}
        ended={runs.ended !== null}
        enabled={live && can("rewind")}
      />
      <span className="w-1 shrink-0" aria-hidden="true" />
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Speed: ${SPEED_WORDS[speed as (typeof SPEEDS)[number]] ?? `${speed}×`}`}
                    disabled={!can("speed")}
                  />
                }
              />
            }
          >
            <Text variant="label" tone="inherit" numeric>
              {SPEED_WORDS[speed as (typeof SPEEDS)[number]] ?? `${speed}×`}
            </Text>
          </TooltipTrigger>
          <TooltipPopup side="top">Speed</TooltipPopup>
        </Tooltip>
        <MenuPopup side="top" align="center">
          <MenuRadioGroup
            value={String(speed)}
            onValueChange={(value) => {
              const next = Number(value);
              if (!Number.isFinite(next) || next <= 0) return;
              setStageSpeed(next);
              onFocus();
            }}
          >
            {SPEEDS.map((each) => (
              <MenuRadioItem key={each} value={String(each)}>
                {SPEED_WORDS[each]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      {canLose ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                size="sm"
                aria-label="Can't lose"
                pressed={cannotLose}
                disabled={!can("cannot-lose")}
                onPressedChange={() => {
                  flipStageCannotLose(threadKey, canLose);
                  onFocus();
                }}
              />
            }
          >
            {/* On, the shield is filled in the live colour: the one thing changing play now. */}
            <ShieldIcon
              aria-hidden="true"
              className={cn(cannotLose && "fill-live text-live opacity-100")}
            />
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-xs">
            <span className="flex flex-col gap-1">
              <TooltipLabel shortcut={cannotLoseKey}>
                {cannotLose ? "Can't lose: on" : "Can't lose"}
              </TooltipLabel>
              <span className="text-muted-foreground">
                A loss does not end the run, to tune a fight; the checks never see it
              </span>
            </span>
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {silent ? (
        <Control label="No sound yet" unavailable onClick={onFocus}>
          <VolumeIcon aria-hidden="true" />
        </Control>
      ) : (
        <Control
          label={muted ? "Sound on" : "Mute"}
          pressed={muted}
          disabled={!can("mute")}
          onClick={() => {
            setStageMuted(!muted);
            onFocus();
          }}
        >
          {muted ? <VolumeXIcon aria-hidden="true" /> : <Volume2Icon aria-hidden="true" />}
        </Control>
      )}
      <Control
        label="Fullscreen"
        shortcut={fullscreenKey}
        disabled={!playing}
        onClick={onFullscreen}
      >
        <MaximizeIcon aria-hidden="true" />
      </Control>
      <GameRunMenu
        threadRef={threadRef}
        rewind={rewind}
        runs={runs}
        playing={playing}
        live={live && !stopped}
        viewItems={viewItems}
        responsive={responsive}
        stageItems={stageItems}
        onNote={onNote}
        onFocus={onFocus}
      />
    </div>
  );
}

function Control({
  label,
  detail = null,
  shortcut = null,
  pressed,
  disabled = false,
  unavailable = false,
  onClick,
  children,
}: {
  label: string;
  /** What it does, under its name and key in the tooltip. */
  detail?: string | null;
  shortcut?: string | null;
  pressed?: boolean;
  disabled?: boolean;
  /** Dimmed like a disabled control, but it still says its name on hover: a state, not an action. */
  unavailable?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
            {...(unavailable ? { "aria-disabled": true } : {})}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-xs">
        <span className="flex flex-col gap-1">
          <TooltipLabel shortcut={shortcut}>{label}</TooltipLabel>
          {detail === null ? null : <span className="text-muted-foreground">{detail}</span>}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
