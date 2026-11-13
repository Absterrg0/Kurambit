import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * Items on a line with a middot between them. Each item leads with its separator and a line's
 * first one is clipped, so when the line wraps no line starts or ends on a dot.
 */
function Separated({
  children,
  nowrap = false,
  controls = false,
}: {
  children: ReactNode;
  /** Each item stays on one line: the line breaks only between items. */
  nowrap?: boolean;
  /** The items hold buttons: each is a row a control's height, with room between wrapped lines. */
  controls?: boolean;
}) {
  return (
    <span className="block overflow-hidden">
      <span
        className={cn(
          "-ms-3.5 flex flex-wrap items-center *:before:inline-block *:before:w-3.5 *:before:text-center *:before:text-muted-foreground *:before:content-['·']",
          nowrap && "*:whitespace-nowrap",
          controls && "gap-y-1 *:flex *:min-h-6 *:items-center",
        )}
      >
        {children}
      </span>
    </span>
  );
}

export { Separated };
