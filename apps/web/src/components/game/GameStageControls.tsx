import type { ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import {
  MaximizeIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  setStageMuted,
  setStageSpeed,
  toggleStageFreeze,
  useThreadStageBridge,
} from "./gameStageBridge";

const SPEEDS = [0.25, 0.5, 1] as const;

/**
 * The game's own controls, under it where they never cover its HUD: restart, pause, slow
 * motion, sound and fullscreen. Each hands the keyboard back to the game after it acts.
 */
export function GameStageControls({
  threadRef,
  playing,
  canReload,
  onRestart,
  onFullscreen,
  onFocus,
}: {
  threadRef: ScopedThreadRef;
  playing: boolean;
  canReload: boolean;
  onRestart: () => void;
  onFullscreen: () => void;
  onFocus: () => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const capabilities = useThreadStageBridge(threadKey, (state) => state.capabilities, NONE);
  const ready = useThreadStageBridge(threadKey, (state) => state.status === "ready", false);
  const paused = useThreadStageBridge(
    threadKey,
    (state) => state.frozen && !state.autoFrozen,
    false,
  );
  const speed = useThreadStageBridge(threadKey, (state) => state.speed, 1);
  const muted = useThreadStageBridge(threadKey, (state) => state.muted, false);
  if (!playing) return null;
  return (
    <div
      data-game-stage-controls=""
      className="mx-auto flex w-full max-w-(--game-stage-column) shrink-0 items-center gap-1 px-3 pt-2"
    >
      <Control
        label="Restart the game"
        disabled={!canReload}
        onClick={() => {
          onRestart();
          onFocus();
        }}
      >
        <RotateCcwIcon aria-hidden="true" />
      </Control>
      {ready && capabilities.includes("freeze") ? (
        <Control
          label={paused ? "Play on" : "Pause, and point at things"}
          pressed={paused}
          onClick={() => {
            toggleStageFreeze();
            if (paused) onFocus();
          }}
        >
          {paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
        </Control>
      ) : null}
      {ready && capabilities.includes("speed") ? (
        <ToggleGroup
          aria-label="Game speed"
          variant="segmented"
          size="xs"
          value={[String(speed)]}
          onValueChange={(value) => {
            const next = Number(value[0]);
            if (!Number.isFinite(next) || next <= 0) return;
            setStageSpeed(next);
            onFocus();
          }}
        >
          {SPEEDS.map((each) => (
            <Toggle key={each} value={String(each)} aria-label={`${each} times speed`}>
              {each === 1 ? "1×" : `${each}×`}
            </Toggle>
          ))}
        </ToggleGroup>
      ) : null}
      <span className="flex-1" />
      {ready && capabilities.includes("mute") ? (
        <Control
          label={muted ? "Sound on" : "Mute"}
          pressed={muted}
          onClick={() => {
            setStageMuted(!muted);
            onFocus();
          }}
        >
          {muted ? <VolumeXIcon aria-hidden="true" /> : <Volume2Icon aria-hidden="true" />}
        </Control>
      ) : null}
      <Control label="Fullscreen" onClick={onFullscreen}>
        <MaximizeIcon aria-hidden="true" />
      </Control>
    </div>
  );
}

const NONE: ReadonlyArray<string> = [];

function Control({
  label,
  pressed,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
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
            size="icon-xs"
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
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
