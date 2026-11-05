import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import { formatElapsedSeconds } from "../chat/AgentElapsed";

/**
 * Writes the elapsed seconds into a span on a one-second timer instead of
 * re-rendering the stage, which owns an iframe and a whole file list.
 */
export function GameElapsed({
  since,
  className,
  prefix,
}: {
  since: number;
  className?: string;
  prefix?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const update = () => {
      if (!ref.current) return;
      const text = `${prefix ?? ""}${formatElapsedSeconds((Date.now() - since) / 1_000)}`;
      if (ref.current.textContent !== text) ref.current.textContent = text;
    };
    update();
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [since, prefix]);
  return <span ref={ref} className={cn("tabular-nums", className)} />;
}
