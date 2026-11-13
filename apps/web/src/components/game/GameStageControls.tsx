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
const NONE: ReadonlyArray<string> = [];

/**
 * The toolbar's play group, the way an engine's play bar works: restart, pause (which also
 * lets you point at things), and slow motion. Each hands the keyboard back to the game.
 */
export function GameStagePlayControls({
  threadRef,
  playing,
  canReload,
  onRestart,
  onFocus,
}: {
  threadRef: ScopedThreadRef;
  playing: boolean;
  canReload: boolean;
  onRestart: () => void;
  onFocus: () => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const capabilities = useThreadStageBridge(threadKey, (state) => state.capabilities, NONE);
  const ready = useThreadStageBridge(threadKey, (state) => state.status === "ready", false);
  const paused = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const speed = useThreadStageBridge(threadKey, (state) => state.speed, 1);
  return (
    <div className="flex shrink-0 items-center gap-1.5" data-game-play-controls="">
      <div className="flex items-center gap-0.5">
        <Control
          label="Restart the game"
          disabled={!playing || !canReload}
          onClick={() => {
            onRestart();
            onFocus();
          }}
        >
          <RotateCcwIcon aria-hidden="true" />
        </Control>
        <Control
          label={paused ? "Play on" : "Pause, and point at things"}
          pressed={paused}
          live={!paused && playing}
          disabled={!playing || !ready || !capabilities.includes("freeze")}
          onClick={() => {
            toggleStageFreeze();
            if (paused) onFocus();
          }}
        >
          {paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
        </Control>
      </div>
      {ready && capabilities.includes("speed") ? (
        <ToggleGroup
          aria-label="Game speed"
          variant="segmented"
          size="xs"
          disabled={!playing}
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
              {each === 0.25 ? "¼×" : each === 0.5 ? "½×" : "1×"}
            </Toggle>
          ))}
        </ToggleGroup>
      ) : null}
    </div>
  );
}

/** The toolbar's view group: sound and fullscreen. */
export function GameStageViewControls({
  threadRef,
  playing,
  onFullscreen,
  onFocus,
}: {
  threadRef: ScopedThreadRef;
  playing: boolean;
  onFullscreen: () => void;
  onFocus: () => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const capabilities = useThreadStageBridge(threadKey, (state) => state.capabilities, NONE);
  const ready = useThreadStageBridge(threadKey, (state) => state.status === "ready", false);
  const muted = useThreadStageBridge(threadKey, (state) => state.muted, false);
  return (
    <>
      {ready && capabilities.includes("mute") ? (
        <Control
          label={muted ? "Sound on" : "Mute"}
          pressed={muted}
          disabled={!playing}
          onClick={() => {
            setStageMuted(!muted);
            onFocus();
          }}
        >
          {muted ? <VolumeXIcon aria-hidden="true" /> : <Volume2Icon aria-hidden="true" />}
        </Control>
      ) : null}
      <Control label="Fullscreen" disabled={!playing} onClick={onFullscreen}>
        <MaximizeIcon aria-hidden="true" />
      </Control>
    </>
  );
}

function Control({
  label,
  pressed,
  live = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  /** Playing: the pause button carries the live colour, as an engine's play bar does. */
  live?: boolean;
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
            data-live={live ? "" : undefined}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
