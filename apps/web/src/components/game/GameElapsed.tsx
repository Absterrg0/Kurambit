import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

/** How long an operation has been running, in the format game tools use. */
export function formatGameElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

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
      const text = `${prefix ?? ""}${formatGameElapsed((Date.now() - since) / 1_000)}`;
      if (ref.current.textContent !== text) ref.current.textContent = text;
    };
    update();
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [since, prefix]);
  return <span ref={ref} className={cn("tabular-nums", className)} />;
}
