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
): { readonly item: ComposerBannerStackItem | null; readonly hidesNext: boolean } {
  const keepGoing = useKeepGoing(threadRef);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const status = keepGoing.status;
  const threadId = threadRef?.threadId ?? "";
  const view = keepGoingBannerView(status, threadId);
  const hidesNext = keepGoingHidesNext(status, threadId);
  if (view === null || dismissed === view.id) return { item: null, hidesNext };
  const busy = keepGoing.sending;
  const stop = (
    <Button
      size="xs"
      variant="ghost"
      disabled={busy || !keepGoing.canOperate}
      onClick={() => void keepGoing.set({ mode: "off" })}
    >
      Stop
    </Button>
  );
  const icon = <FastForwardIcon />;
  switch (view.kind) {
    case "proposal":
      return {
        hidesNext,
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
                <TooltipPopup side="top">{view.text}</TooltipPopup>
              </Tooltip>
            </span>
          ),
          description: view.detail,
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
            </>
          ),
        },
      };
    case "live":
      return {
        hidesNext,
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
