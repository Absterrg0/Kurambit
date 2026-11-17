"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { POINTER_FOCUS_QUIET, pointerFocusHandlers } from "~/lib/pointerFocus";
import { cn } from "~/lib/utils";

// Base UI places the indicator before its first measure too; the slide is
// turned on a frame later so the pill appears under the open tab instead of
// sliding in from the list's edge.
function enableSlideAfterFirstPlacement(indicator: HTMLSpanElement | null) {
  if (!indicator) return;
  const frame = requestAnimationFrame(() => indicator.setAttribute("data-ready", ""));
  return () => cancelAnimationFrame(frame);
}

/** Tabs with real tab semantics (arrow keys, `tabpanel`), drawn as a segmented control. */
function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root className={cn("min-w-0", className)} data-slot="tabs" {...props} />;
}

/**
 * The track. `segmented` (the default): the open tab's raised pill is one element that slides
 * between tabs on the motion tokens, so reduced motion makes it jump. `underline`: plain text tabs
 * with a 1px line under the open one, laid on the row's bottom hairline, as a panel header's tabs.
 */
function TabsList({
  className,
  children,
  variant = "segmented",
  ...props
}: TabsPrimitive.List.Props & { variant?: "segmented" | "underline" }) {
  return (
    <TabsPrimitive.List
      className={cn(
        variant === "underline"
          ? "relative flex h-full w-fit items-stretch gap-4"
          : "relative flex h-8 w-fit gap-0.5 rounded-lg p-0.5 surface-well",
        className,
      )}
      data-slot="tabs-list"
      data-variant={variant}
      {...props}
    >
      <TabsPrimitive.Indicator
        ref={enableSlideAfterFirstPlacement}
        className={
          variant === "underline"
            ? "pointer-events-none absolute bottom-0 left-0 h-px w-(--active-tab-width) translate-x-(--active-tab-left) bg-foreground data-ready:transition-[translate,width] data-ready:ease-enter"
            : "pointer-events-none absolute top-(--active-tab-top) left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) rounded-md surface-raised data-ready:transition-[translate,width] data-ready:ease-enter"
        }
        data-slot="tabs-indicator"
      />
      {children}
    </TabsPrimitive.List>
  );
}

function TabsTab({
  className,
  onPointerDown,
  onKeyDown,
  onBlur,
  ...props
}: TabsPrimitive.Tab.Props) {
  // Keyboard focus is the ring on the tab's edge with a page-colour ring just inside it, so on
  // the open tab it stands off the raised pill rather than passing for the pill's own edge.
  return (
    <TabsPrimitive.Tab
      className={cn(
        "relative flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 text-meta text-muted-foreground outline-none in-data-[variant=underline]:flex-none in-data-[variant=underline]:rounded-none in-data-[variant=underline]:px-0 in-data-[variant=underline]:text-label in-data-[variant=underline]:data-active:text-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid focus-visible:ring-4 focus-visible:ring-background focus-visible:ring-inset data-active:text-strong-foreground data-disabled:pointer-events-none data-disabled:opacity-64",
        POINTER_FOCUS_QUIET,
        className,
      )}
      data-slot="tabs-tab"
      {...pointerFocusHandlers({ onPointerDown, onKeyDown, onBlur })}
      {...props}
    />
  );
}

/** The open tab's content; fades in on the popup clock when the tab changes. */
function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn(
        "min-h-0 outline-none motion-popup transition-opacity data-starting-style:opacity-0",
        className,
      )}
      data-slot="tabs-panel"
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTab, TabsPanel };
