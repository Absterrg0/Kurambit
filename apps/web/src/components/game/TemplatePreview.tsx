import type { GameTemplateId } from "@t3tools/contracts";
import { BoxIcon } from "lucide-react";

import { cn } from "~/lib/utils";

const PREVIEWS: Partial<Record<GameTemplateId, { readonly src: string; readonly alt: string }>> = {
  "3d-explorer": {
    src: "/templates/3d-explorer.webp",
    alt: "A 3D explorer level: a golden character on a stone path, with relics and a gate ahead",
  },
  "2d-platformer": {
    src: "/templates/2d-platformer.webp",
    alt: "A 2D platformer level: coins and platforms under a starry night sky",
  },
};

/**
 * A starter's best frame, so the New game gallery sells the actual game rather
 * than a genre label. Blank has no generated frame; its neutral tile is a
 * deliberate "start from nothing" signal.
 */
export function TemplatePreview({
  template,
  className,
}: {
  template: GameTemplateId;
  className?: string;
}) {
  const preview = PREVIEWS[template];
  if (preview !== undefined)
    return (
      <img
        src={preview.src}
        alt={preview.alt}
        loading="lazy"
        decoding="async"
        className={cn("size-full object-cover", className)}
      />
    );
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex size-full items-center justify-center overflow-hidden bg-[linear-gradient(135deg,var(--color-muted)_25%,transparent_25%,transparent_50%,var(--color-muted)_50%,var(--color-muted)_75%,transparent_75%)] bg-[length:18px_18px] text-muted-foreground",
        className,
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-background/80 shadow-sm">
        <BoxIcon className="size-4" />
      </span>
    </div>
  );
}
