// Adapted from T3 Code's redesign (MIT, Copyright (c) T3 Tools Inc.).
import { cva, type VariantProps } from "class-variance-authority";

import type { ReactNode } from "react";

import { Text } from "~/components/ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

// Tones are the status hues. `neutral` is idle or unknown, `live` is vermilion
// and only for what is live right now (an agent at work, a build being made),
// and `foreground` is the text color beside its own label.
const statusDotVariants = cva("relative inline-flex shrink-0 rounded-full", {
  defaultVariants: { size: "sm", tone: "neutral" },
  variants: {
    size: {
      // Inline beside text.
      sm: "size-1.5",
      // A row's state, or a badge on a picture.
      md: "size-2",
    },
    tone: {
      neutral: "bg-dim-foreground",
      live: "bg-live",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-destructive",
      info: "bg-info",
      foreground: "bg-foreground",
    },
  },
});

const pingToneClassName = {
  neutral: "bg-dim-foreground/60",
  live: "bg-live/60",
  success: "bg-success/60",
  warning: "bg-warning/60",
  danger: "bg-destructive/60",
  info: "bg-info/60",
  foreground: "bg-foreground/60",
} as const;

type StatusDotTone = NonNullable<VariantProps<typeof statusDotVariants>["tone"]>;

/**
 * A small state dot. Without a `label` the dot is decorative and the state must
 * be in nearby text; with one it becomes a focusable dot with a tooltip.
 * `pulse` and `ping` are duty-cycled (a few frames per cycle) and stop under
 * reduced motion; `framed` gives the dot a 12px box so rows of dots align.
 */
function StatusDot({
  tone = "neutral",
  size = "sm",
  pulse = false,
  ping = false,
  framed = ping,
  label,
}: {
  tone?: StatusDotTone;
  size?: "sm" | "md";
  pulse?: boolean;
  ping?: boolean;
  framed?: boolean;
  label?: string | null | undefined;
}) {
  const dot = (
    <span
      aria-hidden
      className={statusDotVariants({
        size,
        tone,
        className: pulse && "motion-safe:animate-status-pulse",
      })}
      data-slot="status-dot"
      data-tone={tone}
    />
  );
  const halo = ping ? (
    <span
      aria-hidden
      className={`absolute inline-flex h-full w-full motion-safe:animate-status-ping rounded-full ${pingToneClassName[tone]}`}
    />
  ) : null;

  if (label) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
            />
          }
        >
          {halo}
          {dot}
        </TooltipTrigger>
        <TooltipPopup side="top" className="whitespace-pre-wrap">
          {label}
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (framed) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {halo}
        {dot}
      </span>
    );
  }
  return dot;
}

/** A row's state in words: a dot and a short label, the one readiness recipe across the app. */
function StatusLabel({
  tone = "neutral",
  children,
}: {
  tone?: StatusDotTone;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2" data-slot="status-label">
      <StatusDot tone={tone} size="md" />
      <Text variant="meta" tone="muted">
        {children}
      </Text>
    </span>
  );
}

export { StatusDot, StatusLabel, type StatusDotTone };
