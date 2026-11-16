import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import {
  MaximizeIcon,
  PanelTopCloseIcon,
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
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipLabel, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  setStageCannotLose,
  setStageMuted,
  setStageSpeed,
  toggleStageFreeze,
  useStageCannotLose,
  useThreadStageBridge,
} from "./gameStageBridge";

const SPEEDS = [0.25, 0.5, 1] as const;
const NONE: ReadonlyArray<string> = [];

/** The key a game command has here, as its tooltip says it. */
function useGameKey(command: "game.freeze" | "game.fullscreen" | "game.cannotLose.toggle") {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return shortcutLabelForCommand(keybindings, command, { context: { gameThread: true } });
}

/**
 * One group of the Stage's toolbar: its buttons sit in one well, the way an editor's play bar
 * groups play, pause and step, so the bar reads as a few tools rather than a row of icons.
 */
export function StageToolbarGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg p-0.5 surface-well"
    >
      {children}
    </div>
  );
}

/**
 * The toolbar's play group, the way an engine's play bar works: restart, pause (which also
 * lets you point at things), Can't lose, and slow motion beside them. Each hands the keyboard
 * back to the game.
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
  const cannotLose = useStageCannotLose(threadKey);
  const freezeKey = useGameKey("game.freeze");
  const cannotLoseKey = useGameKey("game.cannotLose.toggle");
  return (
    <div className="flex shrink-0 items-center gap-1.5" data-game-play-controls="">
      <StageToolbarGroup label="Play">
        <Control
          label="Restart the game"
          detail="A fresh run from the title"
          disabled={!playing || !canReload}
          onClick={() => {
            onRestart();
            onFocus();
          }}
        >
          <RotateCcwIcon aria-hidden="true" />
        </Control>
        <Control
          label={paused ? "Play on" : "Pause"}
          detail={paused ? null : "Then click something in the game to point at it"}
          shortcut={freezeKey}
          pressed={paused}
          disabled={!playing || !ready || !capabilities.includes("freeze")}
          onClick={() => {
            toggleStageFreeze();
            if (paused) onFocus();
          }}
        >
          {paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
        </Control>
        {ready && capabilities.includes("cannot-lose") ? (
          <Control
            label={cannotLose ? "Can't lose: on" : "Can't lose"}
            detail="A loss does not end the run, to tune a fight; the checks never see it"
            shortcut={cannotLoseKey}
            pressed={cannotLose}
            disabled={!playing}
            onClick={() => {
              setStageCannotLose(threadKey, !cannotLose);
              onFocus();
            }}
          >
            <ShieldIcon aria-hidden="true" />
          </Control>
        ) : null}
      </StageToolbarGroup>
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

/** The toolbar's view group: sound, fullscreen, and folding the game away. */
export function GameStageViewControls({
  threadRef,
  playing,
  onFullscreen,
  onHide,
  onFocus,
}: {
  threadRef: ScopedThreadRef;
  playing: boolean;
  onFullscreen: () => void;
  onHide: () => void;
  onFocus: () => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const capabilities = useThreadStageBridge(threadKey, (state) => state.capabilities, NONE);
  const ready = useThreadStageBridge(threadKey, (state) => state.status === "ready", false);
  const muted = useThreadStageBridge(threadKey, (state) => state.muted, false);
  const fullscreenKey = useGameKey("game.fullscreen");
  return (
    <StageToolbarGroup label="View">
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
      <Control
        label="Fullscreen"
        shortcut={fullscreenKey}
        disabled={!playing}
        onClick={onFullscreen}
      >
        <MaximizeIcon aria-hidden="true" />
      </Control>
      <Control
        label="Hide the game"
        detail="The chat takes the column; the game pauses"
        onClick={onHide}
      >
        <PanelTopCloseIcon aria-hidden="true" />
      </Control>
    </StageToolbarGroup>
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
