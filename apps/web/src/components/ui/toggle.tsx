"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const toggleVariants = cva(
  "[&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border text-label text-foreground outline-none pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:surface-ghost-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 aria-disabled:opacity-64 data-pressed:surface-selected data-pressed:text-strong-foreground [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        compact:
          "h-7 min-w-7 rounded-md px-[calc(--spacing(1)-1px)] text-meta [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-9 min-w-9 px-[calc(--spacing(2)-1px)] sm:h-8 sm:min-w-8",
        lg: "h-10 min-w-10 px-[calc(--spacing(2.5)-1px)] sm:h-9 sm:min-w-9",
        segmented: "h-6 min-w-0 rounded-md px-2.5 text-meta",
        sm: "h-8 min-w-8 px-[calc(--spacing(1.5)-1px)] sm:h-7 sm:min-w-7",
        xs: "h-7 min-w-7 px-[calc(--spacing(1)-1px)] sm:h-6 sm:min-w-6 rounded-md",
      },
      variant: {
        // Pressed (pointer down) deepens the hover fill; toggled-on is data-pressed.
        default: "border-transparent active:surface-selected",
        pill: "border-transparent rounded-full px-3 font-normal text-muted-foreground data-pressed:text-foreground",
        ghost:
          "border-transparent text-foreground active:surface-selected disabled:opacity-100 disabled:text-muted-foreground disabled:[&_svg]:opacity-100",
        outline: "surface-raised hover:surface-raised-hover data-pressed:surface-raised-hover",
        // The active segment is raised out of its track (a well on ToggleGroup).
        segmented:
          "border-transparent text-muted-foreground transition-colors hover:text-foreground data-pressed:surface-raised data-pressed:text-strong-foreground",
        // A segment of a single-choice group: the group slides one raised pill
        // under the pressed segment, so the segment paints only its label.
        "segmented-slide":
          "border-transparent text-muted-foreground transition-colors hover:text-foreground data-pressed:text-strong-foreground",
      },
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      className={cn(toggleVariants({ className, size, variant }))}
      data-slot="toggle"
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
