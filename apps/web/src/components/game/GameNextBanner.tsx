import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { gameNextLine } from "./gameNextLine";

/**
 * The agent's `Next:` line as a one-click ask, like a plan turn's "Plan
 * ready": shown after a settled turn whose reply proposes a change. **Ask for
 * it** puts the text in the composer to edit or send; a dismiss lasts until
 * the next turn's reply. Pass `null` while a turn runs or off game threads.
 */
export function useGameNextBanner(
  reply: { readonly key: string; readonly text: string } | null,
  onAsk: (text: string) => void,
): ComposerBannerStackItem | null {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const next = reply === null ? null : gameNextLine(reply.text);
  if (reply === null || next === null || dismissedKey === reply.key) return null;
  return {
    id: `game-next:${reply.key}`,
    variant: "default",
    // The stack lays out an activity row inline, so the suggestion, Ask for it
    // and the dismiss share one line; a notice row wraps its actions under it.
    priority: "activity",
    icon: <ArrowRightIcon />,
    title: (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 text-muted-foreground">Next:</span>
        <Tooltip>
          <TooltipTrigger
            render={<span className="min-w-0 truncate font-normal text-foreground" />}
          >
            {next}
          </TooltipTrigger>
          <TooltipPopup side="top">{next}</TooltipPopup>
        </Tooltip>
      </span>
    ),
    actions: (
      <Button size="xs" variant="ghost" onClick={() => onAsk(next)}>
        Ask for it
      </Button>
    ),
    dismissLabel: "Dismiss the agent's next step",
    onDismiss: () => setDismissedKey(reply.key),
  };
}
