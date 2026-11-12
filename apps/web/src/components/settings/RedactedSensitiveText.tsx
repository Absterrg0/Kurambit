import { useState } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Hidden values read as masked text ("p•••@gmail.com"): a blur over scrambled letters looked
 * like a rendering fault, not privacy. An email keeps its domain, which says which account
 * it is without naming the person.
 */
function maskedPlaceholder(value: string): string {
  const at = value.lastIndexOf("@");
  return at > 0 ? `${value[0]}•••${value.slice(at)}` : `${value[0]}•••`;
}

export function RedactedSensitiveText(props: {
  readonly value: string | null | undefined;
  readonly ariaLabel: string;
  readonly revealTooltip: string;
  readonly hideTooltip: string;
  readonly className?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const value = props.value?.trim();
  const masked = value ? maskedPlaceholder(value) : "";

  if (!value) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "min-w-0 cursor-pointer rounded-sm leading-normal text-muted-foreground transition-colors hover:text-foreground",
              !revealed && "select-none",
              props.className,
            )}
            onClick={() => setRevealed((current) => !current)}
            aria-label={props.ariaLabel}
          >
            {revealed ? value : masked}
          </button>
        }
      />
      <TooltipPopup side="top">{revealed ? props.hideTooltip : props.revealTooltip}</TooltipPopup>
    </Tooltip>
  );
}
