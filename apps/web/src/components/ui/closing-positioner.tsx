// Ported from T3 Code (MIT, Copyright (c) T3 Tools Inc.).
import { useState, type ComponentProps, type CSSProperties } from "react";

const PLACEMENT_KEYS = ["position", "top", "right", "bottom", "left", "transform"] as const;

// Popups keep 8px from the window edge, so nothing they hold touches it.
export const POPUP_COLLISION_PADDING = 8;

type Placement = Pick<CSSProperties, (typeof PLACEMENT_KEYS)[number]>;

// A popup animating out keeps the place it had while open. Without this, a pick
// that re-renders the anchor (a strip reflowing, a label changing width) moves
// the positioner and the closing popup jumps before it fades.
function ClosingPositioner({ open, style, ...props }: ComponentProps<"div"> & { open: boolean }) {
  const [openPlacement, setOpenPlacement] = useState<Placement>({});
  if (open && style && PLACEMENT_KEYS.some((key) => style[key] !== openPlacement[key])) {
    const { position, top, right, bottom, left, transform } = style;
    setOpenPlacement({ position, top, right, bottom, left, transform });
  }
  return <div {...props} style={open ? style : { ...style, ...openPlacement }} />;
}

/** Pass as a Base UI positioner's `render` prop. */
export function renderClosingPositioner(props: ComponentProps<"div">, state: { open: boolean }) {
  return <ClosingPositioner {...props} open={state.open} />;
}
