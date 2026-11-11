// Adapted from T3 Code's redesign (MIT, Copyright (c) T3 Tools Inc.).
import type { ReactNode } from "react";

import { Text } from "~/components/ui/text";

/**
 * A muted meta heading over a group of content, such as "Checks" above a list
 * of check rows. The section owns the heading and the gap below it, so headings
 * have one size and one rhythm wherever they are used. `action` sits at the end
 * of the heading row, for one small control such as an icon button.
 */
export function LabeledSection({
  label,
  action,
  children,
}: {
  readonly label: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center gap-2">
        <Text variant="meta" tone="muted" truncate render={<h3 className="flex-1" />}>
          {label}
        </Text>
        {action}
      </div>
      {children}
    </section>
  );
}
