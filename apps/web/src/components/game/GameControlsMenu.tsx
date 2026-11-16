import type { GameStageControl, ScopedThreadRef } from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { type RefObject, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Popover, PopoverPopup } from "../ui/popover";
import { Text } from "../ui/text";
import {
  rebindStageControl,
  requestStageControls,
  resetStageControls,
  useThreadStageBridge,
} from "./gameStageBridge";

const NO_CAPABILITIES: ReadonlyArray<string> = [];

/**
 * How to play this build, and the keys to change: the game's own action table (the one its
 * Controls screen and every `ctx.input` check read), listed with each action's keys and gamepad
 * buttons. A key rebinds as the game's screen does (pressed, it moves over or swaps) and is saved
 * with the game's settings, so the game's own menu agrees. It has no button of its own: the
 * control bar's run menu opens it, anchored to that menu's trigger, over the chat, never the game.
 */
export function GameControlsMenu({
  threadRef,
  open,
  anchor,
  onOpenChange,
  onFocus,
}: {
  threadRef: ScopedThreadRef;
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onFocus: () => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const capabilities = useThreadStageBridge(
    threadKey,
    (state) => state.capabilities,
    NO_CAPABILITIES,
  );
  const ready = useThreadStageBridge(threadKey, (state) => state.status === "ready", false);
  const controls = useThreadStageBridge(threadKey, (state) => state.controls, null);
  const note = useThreadStageBridge(threadKey, (state) => state.controlsNote, null);
  // The action waiting for its new key; Escape gives it up.
  const [listening, setListening] = useState<string | null>(null);
  useEffect(() => {
    if (open) requestStageControls();
  }, [open]);
  useEffect(() => {
    if (!open || listening === null) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code !== "Escape" && event.code !== "") rebindStageControl(listening, event.code);
      setListening(null);
    };
    // Capture: the popover's own Escape must not close it while a key is awaited.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, listening]);
  if (!ready || !capabilities.includes("controls")) return null;
  const changed = controls?.some((control) => control.changed) ?? false;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        setListening(null);
        if (!next) onFocus();
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side="bottom"
        align="end"
        padding="compact"
        className="w-[24rem]"
      >
        <div className="flex flex-col gap-2 py-1">
          <div className="flex items-baseline justify-between gap-2 px-1">
            <Text variant="meta" tone="strong" emphasis render={<h3 />}>
              Controls
            </Text>
            <Text variant="caption" tone="muted">
              Click a key to change it
            </Text>
          </div>
          {controls === null ? (
            <Text variant="meta" tone="muted" render={<p className="px-1 py-3" />}>
              Reading the game's controls…
            </Text>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,0.8fr)] items-center gap-x-3">
              {controls.map((control) => (
                <ControlRow
                  key={control.name}
                  control={control}
                  listening={listening === control.name}
                  onListen={() => setListening(control.name)}
                />
              ))}
            </div>
          )}
          {note === null && !changed ? null : (
            <div className="flex min-h-7 items-center gap-2 border-t border-border px-1 pt-2">
              <Text variant="caption" tone="muted" render={<p className="min-w-0 flex-1" />}>
                {note}
              </Text>
              {changed ? (
                <Button size="xs" variant="ghost" onClick={resetStageControls}>
                  Reset to the game's own
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ControlRow({
  control,
  listening,
  onListen,
}: {
  control: GameStageControl;
  listening: boolean;
  onListen: () => void;
}) {
  const bindings = [...control.keys, ...control.mouse];
  return (
    <>
      <Text
        variant="meta"
        tone={control.changed ? "inherit" : "default"}
        truncate
        render={<span className={cn("px-1", control.changed && "text-live")} />}
      >
        {control.label}
      </Text>
      {control.fixed ? (
        <span className="flex h-8 items-center gap-1 px-1.5">
          {bindings.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </span>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${control.label}: ${bindings.join(", ") || "no key"}. Press to change`}
          aria-pressed={listening}
          onClick={onListen}
        >
          {listening ? (
            <Text variant="caption" tone="inherit" render={<span className="text-live" />}>
              Press a key…
            </Text>
          ) : bindings.length === 0 ? (
            <Text variant="caption" tone="muted">
              None
            </Text>
          ) : (
            bindings.map((key) => <Kbd key={key}>{key}</Kbd>)
          )}
        </Button>
      )}
      {/* The first gamepad input is the one a player reaches for (the stick, before the d-pad). */}
      <Text variant="caption" tone="muted" truncate render={<span className="px-1" />}>
        {control.pad[0] ?? ""}
      </Text>
    </>
  );
}
