"use client";

import type { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Toggle as ToggleComponent, type toggleVariants } from "~/components/ui/toggle";

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: "default",
  variant: "default",
});

/**
 * Keeps a single-choice segmented group's pill under its pressed segment. It
 * watches the DOM instead of the group's value, so controlled and uncontrolled
 * groups and toggles wrapped in tooltips all work. The slide is turned on a
 * frame after the first placement, so the pill appears in place instead of
 * sliding in from the group's edge.
 */
function trackPressedSegment(indicator: HTMLSpanElement | null) {
  const group = indicator?.parentElement;
  if (!indicator || !group) return;
  const place = () => {
    const pressed = group.querySelector<HTMLElement>('[data-slot="toggle"][data-pressed]');
    indicator.hidden = pressed === null;
    if (pressed === null) return;
    indicator.style.setProperty("--segment-x", `${pressed.offsetLeft}px`);
    indicator.style.setProperty("--segment-y", `${pressed.offsetTop}px`);
    indicator.style.setProperty("--segment-width", `${pressed.offsetWidth}px`);
    indicator.style.setProperty("--segment-height", `${pressed.offsetHeight}px`);
  };
  place();
  const frame = requestAnimationFrame(() => indicator.setAttribute("data-ready", ""));
  const mutations = new MutationObserver(place);
  mutations.observe(group, {
    attributes: true,
    attributeFilter: ["data-pressed"],
    childList: true,
    subtree: true,
  });
  const stopResize = observeResize(group, place);
  return () => {
    cancelAnimationFrame(frame);
    mutations.disconnect();
    stopResize();
  };
}

function ToggleGroup({
  className,
  variant = "segmented",
  size: sizeProp,
  orientation = "horizontal",
  children,
  ...props
}: ToggleGroupPrimitive.Props & VariantProps<typeof toggleVariants>) {
  const size =
    sizeProp === undefined ? (variant === "segmented" ? "segmented" : "default") : sizeProp;
  // One pressed segment can slide; a multi-select group raises each pressed one.
  const slides = variant === "segmented" && props.multiple !== true;
  const value = { size, variant: slides ? ("segmented-slide" as const) : variant };
  return (
    <ToggleGroupPrimitive
      className={cn(
        "flex w-fit *:focus-visible:z-10 dark:*:[[data-slot=separator]:has(+[data-slot=toggle]:hover)]:before:bg-input/64 dark:*:[[data-slot=separator]:has(+[data-slot=toggle][data-pressed])]:before:bg-input dark:*:[[data-slot=toggle]:hover+[data-slot=separator]]:before:bg-input/64 dark:*:[[data-slot=toggle][data-pressed]+[data-slot=separator]]:before:bg-input",
        orientation === "horizontal"
          ? "*:pointer-coarse:after:min-w-auto"
          : "*:pointer-coarse:after:min-h-auto",
        variant === "segmented"
          ? "relative surface-well gap-0.5 rounded-lg p-0.5"
          : variant === "default"
            ? "gap-0.5"
            : orientation === "horizontal"
              ? "*:not-first:not-data-[slot=separator]:before:-start-[0.5px] *:not-last:not-data-[slot=separator]:before:-end-[0.5px] *:not-first:rounded-s-none *:not-last:rounded-e-none *:not-first:border-s-0 *:not-last:border-e-0 *:not-first:before:rounded-s-none *:not-last:before:rounded-e-none"
              : "*:not-first:not-data-[slot=separator]:before:-top-[0.5px] *:not-last:not-data-[slot=separator]:before:-bottom-[0.5px] flex-col *:not-first:rounded-t-none *:not-last:rounded-b-none *:not-first:border-t-0 *:not-last:border-b-0 *:not-first:before:rounded-t-none *:not-last:before:rounded-b-none *:data-[slot=toggle]:not-last:before:hidden dark:*:last:before:hidden dark:*:first:before:block",
        className,
      )}
      data-size={size}
      data-slot="toggle-group"
      data-variant={variant}
      orientation={orientation}
      {...props}
    >
      {slides ? (
        <span
          aria-hidden
          ref={trackPressedSegment}
          className="pointer-events-none absolute top-0 left-0 h-(--segment-height) w-(--segment-width) translate-x-(--segment-x) translate-y-(--segment-y) rounded-md surface-raised data-ready:transition-[translate,width] data-ready:ease-enter"
          data-slot="toggle-group-indicator"
        />
      ) : null}
      <ToggleGroupContext value={value}>{children}</ToggleGroupContext>
    </ToggleGroupPrimitive>
  );
}

function Toggle({
  className,
  children,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.use(ToggleGroupContext);

  const resolvedVariant = variant ?? context.variant;
  const resolvedSize = size ?? context.size;

  return (
    <ToggleComponent
      className={className}
      data-size={resolvedSize}
      data-variant={resolvedVariant}
      size={resolvedSize}
      variant={resolvedVariant}
      {...props}
    >
      {children}
    </ToggleComponent>
  );
}

export { ToggleGroup, Toggle, Toggle as ToggleGroupItem };
