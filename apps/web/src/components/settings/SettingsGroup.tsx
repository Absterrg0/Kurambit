import { createContext, use, type ComponentProps } from "react";

import { cn } from "../../lib/utils";

// A settings card inside another settings card (a detail pane in a list card) drops
// its own surface and keeps only its row dividers, so a page never stacks three cards.
const InsideSettingsCardContext = createContext(false);

export function SettingsGroup({
  variant = "grouped",
  divided = true,
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  variant?: "grouped" | "plain";
  divided?: boolean;
}) {
  const insideCard = use(InsideSettingsCardContext);
  const card = variant === "grouped" && !insideCard;
  return (
    <div
      {...props}
      className={cn(
        "relative overflow-visible text-foreground",
        card ? "surface-card-settings rounded-xl" : variant === "plain" ? "space-y-1" : null,
        variant === "grouped" &&
          divided &&
          "[&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none",
        // Without its card, the group's rows still sit between two hairlines.
        variant === "grouped" && insideCard && "border-y border-border/50",
        className,
      )}
    >
      {card ? (
        <InsideSettingsCardContext value={true}>{children}</InsideSettingsCardContext>
      ) : (
        children
      )}
    </div>
  );
}
