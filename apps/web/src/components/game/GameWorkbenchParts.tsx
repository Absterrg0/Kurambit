import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Text } from "../ui/text";

/**
 * The Workbench's slots, the way ComposerBanner composes: each owns its classes, so every section
 * is a few lines of slots on one grid. Text starts 16px in, rows are 28px, and headings, readings
 * and their marks line up from section to section, as T3's own panels do.
 */

/** A section's scrolling body: its parts one under the other, parted by hairlines. */
function Body({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto pb-2",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A titled part: its heading on one line with a quieter count after it and its actions at the
 * right, its rows under it.
 */
function Section({
  title,
  detail,
  aside,
  label,
  children,
}: {
  title: string;
  /** A count or a reading after the title, quieter. */
  detail?: ReactNode;
  aside?: ReactNode;
  /** The section's accessible name, when the title alone is not enough. */
  label?: string;
  children?: ReactNode;
}) {
  return (
    <section aria-label={label ?? title} className="flex flex-col py-3">
      <div className="flex h-8 min-w-0 items-center gap-2 ps-4 pe-2">
        <Text variant="label" tone="strong" render={<h3 className="shrink-0" />}>
          {title}
        </Text>
        {detail === undefined || detail === null || detail === "" ? null : (
          <Text variant="caption" tone="muted" numeric truncate render={<span />}>
            {detail}
          </Text>
        )}
        <span className="flex-1" />
        {aside === undefined ? null : (
          <span className="flex shrink-0 items-center gap-0.5">{aside}</span>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * One row of a section: a mark in a fixed column, its name, and its reading at the right in tabular
 * figures. A reading that does not fit beside the name wraps under it as a quieter second line;
 * neither is ever cut. The end slot keeps its width so readings line up.
 */
function Row({
  mark,
  name,
  reading,
  end,
  muted = false,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  mark?: ReactNode;
  name: ReactNode;
  reading?: ReactNode;
  end?: ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      className={cn("flex min-h-7 min-w-0 items-start gap-2 py-1 ps-4 pe-2", className)}
      {...props}
    >
      {mark === undefined ? null : (
        <span className="flex h-5 w-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5">
          {mark}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
        <Text
          variant="meta"
          tone={muted ? "muted" : "default"}
          render={<span className="min-w-0 leading-5" />}
        >
          {name}
        </Text>
        {/* Pushes a reading that fits to the right; one that wraps starts under the name. */}
        <span aria-hidden="true" className="flex-1" />
        {reading === undefined || reading === null ? null : (
          <Text
            variant="caption"
            tone="muted"
            numeric
            render={<span className="min-w-0 leading-5" />}
          >
            {reading}
          </Text>
        )}
      </span>
      <span className="flex h-5 w-6 shrink-0 items-center justify-end">{end}</span>
    </div>
  );
}

/**
 * What a section shows once there is something to show: a small glyph, one title, a line of
 * explanation and at most one way forward, in the section's own place.
 */
function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-10 text-center">
      <span aria-hidden="true" className="mb-2 inline-flex text-dim-foreground [&_svg]:size-4">
        {icon}
      </span>
      <Text variant="label" tone="default" render={<p />}>
        {title}
      </Text>
      {body === undefined ? null : (
        <Text variant="body" tone="muted" render={<p className="max-w-72" />}>
          {body}
        </Text>
      )}
      {action === undefined ? null : <div className="mt-3">{action}</div>}
    </div>
  );
}

export const Workbench = { Body, Section, Row, Empty };
