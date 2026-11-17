import { StatusDot } from "../ui/status-dot";

/**
 * A tool's one quiet hello: a dot on its control from the moment it arrives until it is first
 * opened. `corner` sits it on an icon button's corner; otherwise it follows its label.
 */
export function ArrivalDot({ on, corner = false }: { on: boolean; corner?: boolean }) {
  if (!on) return null;
  return corner ? (
    <span data-arrival-dot="" className="pointer-events-none absolute top-1 right-1 flex">
      <StatusDot tone="foreground" />
    </span>
  ) : (
    <span data-arrival-dot="" className="flex">
      <StatusDot tone="foreground" />
    </span>
  );
}
