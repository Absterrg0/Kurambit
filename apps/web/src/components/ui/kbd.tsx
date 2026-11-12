import type * as React from "react";

import { cn } from "~/lib/utils";

// One key-hint look: the surface-kbd recipe. The nearest kbd-in-* / kbd-on-* context
// (buttons, fields, menus, popovers and tooltips set one) adjusts its fill and label.
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded-[0.3125rem] px-1 font-sans text-caption text-[color:var(--kbd-foreground,var(--contrast-muted-foreground))] surface-kbd [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-1", className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}

// "Ctrl+Shift+F" and "⌘⇧F" both become one key per chip; a trailing "+" is the plus key.
function shortcutKeys(label: string): string[] {
  return label.split(/\+(?!$)|(?<=[⌃⌥⇧⌘])/).filter((key) => key.length > 0);
}

/** A shortcut label drawn as one chip per key. Anything other than a string is drawn as given. */
function KbdShortcut({ className, children, ...props }: React.ComponentProps<"kbd">) {
  if (typeof children !== "string") {
    return (
      <KbdGroup className={className} {...props}>
        {children}
      </KbdGroup>
    );
  }
  return (
    <KbdGroup className={className} aria-label={children} {...props}>
      {shortcutKeys(children).map((key, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Keys can repeat and hold no state.
        <Kbd key={index} aria-hidden>
          {key}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

export { Kbd, KbdGroup, KbdShortcut, shortcutKeys };
