import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Text } from "../ui/text";

/**
 * The Workbench's slots, the way ComposerBanner composes: each owns its classes, so the tabs are
 * a few lines of slots and read as one panel.
 */

/** A tab's scrolling body: the tab's sections, one under the other. */
function Body({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto scrollbar-gutter-both",
        className,
      )}
      {...props}
    />
  );
}

/** A titled part of a tab. The heading reads above its content; `aside` sits at its right. */
function Section({
  title,
  detail,
  aside,
  className,
  children,
}: {
  title: string;
  /** One quieter line under the title: a count, what the section reads from. */
  detail?: ReactNode;
  aside?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-2.5 px-4 py-3.5", className)}>
      <div className="flex flex-col gap-0.5">
        <div className="flex min-h-6 items-center gap-2">
          <Text variant="meta" tone="strong" emphasis render={<h3 className="min-w-0 flex-1" />}>
            {title}
          </Text>
          {aside === undefined ? null : <span className="flex items-center gap-1">{aside}</span>}
        </div>
        {detail === undefined || detail === null ? null : typeof detail === "string" ? (
          <Text variant="caption" tone="muted" numeric render={<p />}>
            {detail}
          </Text>
        ) : (
          detail
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * What a tab will show once there is something to show: a calm sentence in the tab's own place,
 * never a lone line in a blank column.
 */
function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 py-10 text-center">
      <span className="mb-1 grid size-9 place-items-center rounded-lg surface-well text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <Text variant="label" tone="strong" render={<p />}>
        {title}
      </Text>
      <Text variant="meta" tone="muted" render={<p className="max-w-72" />}>
        {body}
      </Text>
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A label and its value on one line, the value right-aligned in tabular figures. */
function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "bad" }) {
  return (
    <div className="flex min-h-7 items-center gap-3">
      <Text variant="meta" tone="muted" render={<span className="min-w-0 flex-1" />}>
        {label}
      </Text>
      <Text
        variant="meta"
        tone={tone === "bad" ? "destructive" : "default"}
        numeric
        render={<span className="shrink-0" />}
      >
        {value}
      </Text>
    </div>
  );
}

export const Workbench = { Body, Section, Empty, Stat };
