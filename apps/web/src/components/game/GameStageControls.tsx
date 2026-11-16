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
  VolumeXIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Text } from "../ui/text";
import { Tooltip, TooltipLabel, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameRunMenu, GameRunTimeline, type StageRewind } from "./GameRunTimeline";
import {
  setStageCannotLose,
  setStageMuted,
  setStageSpeed,
  toggleStageFreeze,
  useStageCannotLose,
  useThreadStageBridge,
} from "./gameStageBridge";
import type { StageRuns } from "./useStageRuns";

const SPEEDS = [1, 0.5, 0.25] as const;
const SPEED_WORDS: Record<(typeof SPEEDS)[number], string> = { 1: "1×", 0.5: "½×", 0.25: "¼×" };
const NONE: ReadonlyArray<string> = [];

/** The key a game command has here, as its tooltip says it. */
function useGameKey(command: "game.freeze" | "game.fullscreen" | "game.cannotLose.toggle") {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return shortcutLabelForCommand(keybindings, command, { context: { gameThread: true } });
}

/**
 * The control bar under the Stage, one layout in every state: Play or Pause and Restart, the run's
 * timeline taking the room with its time, then speed, Can't lose, sound, fullscreen and the run's
 * menu. Nothing appears, disappears or moves between playing, paused, ended and forked: only the
 * Play icon and the timeline's knob change. A control the game cannot use is disabled, not gone.
 */
export function GameStageBar({
  threadRef,
  playing,
  live,
  canReload,
  rewind,
  runs,
  onRestart,
  onFullscreen,
  onHide,
  onFocus,
  onNote,
}: {
  threadRef: ScopedThreadRef;
  /** A game plays on the Stage (not a compare, not a state card). */
  playing: boolean;
  /** It is the folder's own game, so its runs can be rewound. */
  live: boolean;
  canReload: boolean;
  rewind: StageRewind;
  runs: StageRuns;
  onRestart: () => void;
  onFullscreen: () => void;
  onHide: () => void;
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
  const cannotLose = useStageCannotLose(threadKey);
  const freezeKey = useGameKey("game.freeze");
  const cannotLoseKey = useGameKey("game.cannotLose.toggle");
  const fullscreenKey = useGameKey("game.fullscreen");
  // The bridge speaks for the folder's own game: a copy or a compare plays without it.
  const can = (capability: string) => playing && live && ready && capabilities.includes(capability);
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
      <Control
        label={cannotLose ? "Can't lose: on" : "Can't lose"}
        detail="A loss does not end the run, to tune a fight; the checks never see it"
        shortcut={cannotLoseKey}
        pressed={cannotLose}
        disabled={!can("cannot-lose")}
        onClick={() => {
          setStageCannotLose(threadKey, !cannotLose);
          onFocus();
        }}
      >
        <ShieldIcon aria-hidden="true" />
      </Control>
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
        onNote={onNote}
        onHide={onHide}
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
  onClick,
  children,
}: {
  label: string;
  /** What it does, under its name and key in the tooltip. */
  detail?: string | null;
  shortcut?: string | null;
  pressed?: boolean;
  disabled?: boolean;
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
