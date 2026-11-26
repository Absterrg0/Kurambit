import { useState } from "react";
import { FastForwardIcon, SquareIcon } from "lucide-react";
import type { ScopedThreadRef } from "@kurambit/contracts";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { keepGoingBannerView, keepGoingHidesNext } from "./keepGoing.logic";
import { useKeepGoing } from "./useKeepGoing";

const endingTitle = (text: string) => (
  <Tooltip>
    <TooltipTrigger render={<span className="min-w-0 truncate font-normal" />}>
      {text}
    </TooltipTrigger>
    <TooltipPopup side="top">{text}</TooltipPopup>
  </Tooltip>
);

/**
 * Keep going above the composer, in its own chat: what the live run is doing with Stop, or why
 * it paused with Resume and what it did, until the person sends a turn there (`lastTurnAt`, when
 * the chat's newest turn was asked for). Nothing ticks, and it re-renders only on run pushes.
 * `hidesNext` says when keep going takes the agent's `Next:` line itself. Pass `null` off game
 * threads.
 */
export function useKeepGoingBanner(
  threadRef: ScopedThreadRef | null,
  lastTurnAt: string | null,
): {
  readonly item: ComposerBannerStackItem | null;
  readonly hidesNext: boolean;
  /** Ends the run, for the stop shortcut; `null` while nothing runs or it may not. */
  readonly stop: (() => void) | null;
} {
  const keepGoing = useKeepGoing(threadRef);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const status = keepGoing.status;
  const threadId = threadRef?.threadId ?? "";
  const view = keepGoingBannerView(status, threadId, lastTurnAt);
  const hidesNext = keepGoingHidesNext(status, threadId);
  const busy = keepGoing.sending;
  const stopRun =
    status !== null && status.mode !== "off" && keepGoing.canOperate && !busy
      ? () => void keepGoing.set({ mode: "off" })
      : null;
  if (view === null || dismissed === view.id) return { item: null, hidesNext, stop: stopRun };
  // A quiet action at the line's end, like the queued message's own; set a little apart from
  // the step's controls.
  const stop = (
    <Button
      size="xs"
      variant="ghost-muted"
      className="ms-1.5"
      disabled={busy || !keepGoing.canOperate}
      onClick={() => stopRun?.()}
    >
      <SquareIcon aria-hidden="true" />
      Stop
    </Button>
  );
  const icon = <FastForwardIcon />;
  // A run that stopped says what it did: its reel, step by step, before and after.
  const recap =
    status?.firstStep == null ? null : (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => useGameWorkspaceStore.getState().requestStage({ kind: "reel" })}
      >
        See what it did
      </Button>
    );
  switch (view.kind) {
    case "live":
      return {
        hidesNext,
        stop: stopRun,
        item: {
          id: view.id,
          variant: "default",
          priority: "activity",
          icon,
          title: (
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 truncate font-normal" />}>
                {view.line}
              </TooltipTrigger>
              <TooltipPopup side="top">{view.title}</TooltipPopup>
            </Tooltip>
          ),
          actions: stop,
        },
      };
    case "paused":
      return {
        hidesNext,
        stop: stopRun,
        item: {
          id: view.id,
          variant: "info",
          // Before the Next chip, so a stall never reads as keep going quietly
          // off; its reason keeps the row, with Resume under it.
          priority: "activity",
          layout: "wrap-actions",
          icon,
          title: endingTitle(view.title),
          actions: (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || !keepGoing.canOperate}
                onClick={() => void keepGoing.choose("on")}
              >
                Resume
              </Button>
              {recap}
            </>
          ),
          dismissLabel: "Dismiss why keep going paused",
          onDismiss: () => setDismissed(view.id),
        },
      };
    case "ended":
      return {
        hidesNext,
        stop: stopRun,
        item: {
          id: view.id,
          variant: "info",
          priority: "activity",
          layout: "wrap-actions",
          icon,
          title: endingTitle(view.title),
          ...(recap === null ? {} : { actions: recap }),
          dismissLabel: "Dismiss why keep going ended",
          onDismiss: () => setDismissed(view.id),
        },
      };
  }
}
