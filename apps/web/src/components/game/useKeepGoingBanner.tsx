import { useState } from "react";
import { FastForwardIcon } from "lucide-react";
import type { ScopedThreadRef } from "@kurambit/contracts";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { KEEP_GOING_MODES, keepGoingBannerView, keepGoingHidesNext } from "./keepGoing.logic";
import { useKeepGoing } from "./useKeepGoing";

const modeLabel = (mode: string) =>
  KEEP_GOING_MODES.find((entry) => entry.mode === mode)?.label ?? mode;

const endingTitle = (text: string) => (
  <Tooltip>
    <TooltipTrigger render={<span className="min-w-0 truncate font-normal" />}>
      {text}
    </TooltipTrigger>
    <TooltipPopup side="top">{text}</TooltipPopup>
  </Tooltip>
);

/**
 * Keep going above the composer, in its own chat: what
 * the live run is doing with Stop, a Guided proposal with Start now, Edit
 * and Skip, or why it paused with Resume. Times are clock times; nothing
 * ticks, and it re-renders only on run pushes. `hidesNext` says when keep
 * going takes the agent's `Next:` line itself. Pass `null` off game threads.
 */
export function useKeepGoingBanner(
  threadRef: ScopedThreadRef | null,
  onEdit: (text: string) => void,
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
  const view = keepGoingBannerView(status, threadId);
  const hidesNext = keepGoingHidesNext(status, threadId);
  const busy = keepGoing.sending;
  const stopRun =
    status !== null && status.mode !== "off" && keepGoing.canOperate && !busy
      ? () => void keepGoing.set({ mode: "off" })
      : null;
  if (view === null || dismissed === view.id) return { item: null, hidesNext, stop: stopRun };
  const stop = (
    <Button
      size="xs"
      variant="ghost"
      disabled={busy || !keepGoing.canOperate}
      onClick={() => stopRun?.()}
    >
      Stop
    </Button>
  );
  const icon = <FastForwardIcon />;
  switch (view.kind) {
    case "proposal":
      return {
        hidesNext,
        stop: stopRun,
        item: {
          id: view.id,
          variant: "default",
          priority: "activity",
          icon,
          title: (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 text-muted-foreground">{view.lead}</span>
              <Tooltip>
                <TooltipTrigger
                  render={<span className="min-w-0 truncate font-normal text-foreground" />}
                >
                  {view.line}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  <span className="flex flex-col gap-1">
                    <span>{view.text}</span>
                    <span className="text-muted-foreground">Why: {view.why}</span>
                  </span>
                </TooltipPopup>
              </Tooltip>
            </span>
          ),
          // A separator before the time, so the action and when it starts read as two things.
          description: `· ${view.detail}`,
          actions: (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !keepGoing.canDecide}
                onClick={() => void keepGoing.decide(view.stepId, "start")}
              >
                Start now
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || !keepGoing.canDecide}
                onClick={() => {
                  // The text lands in the composer first; holding stops the
                  // default from starting the step under the person's hands.
                  onEdit(view.text);
                  if (!view.held) void keepGoing.decide(view.stepId, "hold");
                }}
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || !keepGoing.canDecide}
                onClick={() => void keepGoing.decide(view.stepId, "skip")}
              >
                Skip
              </Button>
              {/* The way out of the run, beside the step it would start. */}
              {stop}
            </>
          ),
        },
      };
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
                {view.title}
              </TooltipTrigger>
              <TooltipPopup side="top">Your message goes before its next step.</TooltipPopup>
            </Tooltip>
          ),
          ...(view.note === null ? {} : { description: view.note }),
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
            <Button
              size="xs"
              variant="ghost"
              disabled={busy || !keepGoing.canOperate}
              onClick={() => void keepGoing.choose(view.resume)}
            >
              Resume ({modeLabel(view.resume)})
            </Button>
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
          dismissLabel: "Dismiss why keep going ended",
          onDismiss: () => setDismissed(view.id),
        },
      };
  }
}
