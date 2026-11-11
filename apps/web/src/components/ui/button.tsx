"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

// Secondary and outline are the same raised recipe: outline is the older name
// most call sites use, secondary the one T3's redesign settled on.
const RAISED_VARIANT =
  "surface-raised [--control-icon-color:var(--contrast-muted-foreground)] text-foreground focus-visible:[--surface-rim:var(--surface-fill)] [:hover,[data-pressed]]:surface-raised-hover";

const buttonVariants = cva(
  // kbd-in-control and the trailing-Kbd padding let a key hint sit inside the
  // button ("Start building ⏎") without its own props. Focus is an outline, not
  // a ring: the recipes own box-shadow.
  "[--control-icon-color:currentColor] kbd-in-control [&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-(--button-gap) [--button-gap:--spacing(2)] has-[>[data-slot=kbd]:last-child]:pe-[calc(var(--button-gap)-1px)] whitespace-nowrap rounded-[var(--control-radius)] border text-label outline-none transition-[box-shadow,scale] [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        compact:
          "h-7 [--button-gap:--spacing(1)] rounded-md px-[calc(--spacing(2)-1px)] text-meta before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-micro":
          "size-5 rounded-sm p-0 before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 sm:size-7",
        "icon-xs":
          "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
        micro:
          "h-5 [--button-gap:--spacing(1)] rounded-sm px-[calc(--spacing(1.5)-1px)] text-caption before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3 sm:[&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 [--button-gap:--spacing(1.5)] px-[calc(--spacing(2.5)-1px)] sm:h-7",
        "sm-multiline":
          "min-h-8 [--button-gap:--spacing(1.5)] px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] whitespace-normal sm:min-h-7",
        xs: "h-7 [--button-gap:--spacing(1)] px-[calc(--spacing(2)-1px)] text-meta sm:h-6 [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        // The primary action: the lit recipe.
        default:
          "surface-lit kbd-on-lit text-primary-foreground focus-visible:[--surface-rim:var(--lit-fill)] [:hover,[data-pressed]]:surface-lit-hover",
        destructive:
          "surface-destructive kbd-on-destructive text-white focus-visible:[--surface-rim:var(--surface-fill)] [:hover,[data-pressed]]:surface-destructive-hover",
        // Raised, with a red label and a red rim on hover.
        "destructive-outline":
          "surface-raised text-destructive-foreground focus-visible:[--surface-rim:var(--surface-fill)] [:hover,[data-pressed]]:surface-danger-hover",
        // Icon buttons and ghost rows stay chrome-less: a hover fill, and the
        // muted icon brightens to the label color.
        ghost:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground [:hover,[data-pressed]]:surface-ghost-hover [:hover,[data-pressed]]:[--control-icon-color:currentColor]",
        "ghost-muted":
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground [:hover,[data-pressed]]:surface-ghost-hover [:hover,[data-pressed]]:text-foreground",
        "ghost-destructive":
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground [:hover,[data-pressed]]:surface-ghost-hover [:hover,[data-pressed]]:text-destructive-foreground",
        // No surface at any state: hover brightens the muted label. For controls
        // on a shape that already frames them.
        bare: "[--control-icon-color:currentColor] border-transparent text-muted-foreground [:hover,[data-pressed]]:text-foreground",
        glass:
          "surface-glass [--control-icon-color:var(--contrast-muted-foreground)] rounded-full border-border/60 text-foreground shadow-sm before:rounded-full [:hover,[data-pressed]]:border-border",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        "media-close":
          "[--control-icon-color:currentColor] border-transparent bg-black/65 text-white shadow-sm ring-1 ring-white/20 [:hover,[data-pressed]]:bg-black/80 focus-visible:outline-white",
        "media-navigation":
          "[--control-icon-color:currentColor] absolute top-1/2 z-20 -translate-y-1/2 border-transparent text-white/90 [:hover,[data-pressed]]:bg-white/10 [:hover,[data-pressed]]:text-white focus-visible:outline-white",
        outline: RAISED_VARIANT,
        overlay: "border-transparent bg-black/70 text-white/65 [:hover,[data-pressed]]:bg-black/90",
        secondary: RAISED_VARIANT,
        "warning-outline":
          "surface-tint [--surface-tint:var(--warning-foreground)] text-warning-foreground [:hover,[data-pressed]]:[--surface-tint:color-mix(in_srgb,var(--warning-foreground),var(--foreground)_20%)]",
      },
    },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export { Button, buttonVariants, type ButtonSize, type ButtonVariant };

const inlineButtonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 [text-align:var(--inline-button-text-align,center)] [white-space:var(--inline-button-white-space,nowrap)] hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64",
  {
    defaultVariants: { tone: "default" },
    variants: {
      tone: {
        default: "text-foreground",
        muted: "text-muted-foreground hover:text-foreground",
        destructive: "text-destructive/80 hover:text-destructive",
        picker:
          "gap-1.5 text-foreground underline decoration-foreground/30 decoration-dotted decoration-from-font underline-offset-4 hover:decoration-foreground hover:decoration-solid data-popup-open:decoration-foreground data-popup-open:decoration-solid",
      },
    },
  },
);

export function InlineButton({
  className,
  tone,
  render,
  ...props
}: useRender.ComponentProps<"button"> & VariantProps<typeof inlineButtonVariants>) {
  const defaultProps = {
    className: cn(inlineButtonVariants({ tone }), className),
    "data-slot": "inline-button",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
