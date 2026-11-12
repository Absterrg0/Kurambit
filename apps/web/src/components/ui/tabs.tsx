"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

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
 * The segmented track. The open tab's raised pill is one element that slides
 * between tabs on the motion tokens, so reduced motion makes it jump.
 */
function TabsList({ className, children, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      className={cn("relative flex h-8 w-fit gap-0.5 rounded-lg p-0.5 surface-well", className)}
      data-slot="tabs-list"
      {...props}
    >
      <TabsPrimitive.Indicator
        ref={enableSlideAfterFirstPlacement}
        className="pointer-events-none absolute top-(--active-tab-top) left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) rounded-md surface-raised data-ready:transition-[translate,width] data-ready:ease-enter"
        data-slot="tabs-indicator"
      />
      {children}
    </TabsPrimitive.List>
  );
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "relative flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 text-meta text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring focus-visible:outline-solid data-active:text-strong-foreground data-disabled:pointer-events-none data-disabled:opacity-64",
        className,
      )}
      data-slot="tabs-tab"
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
