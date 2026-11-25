import type { ProjectIconColor } from "@kurambit/contracts";
import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "~/lib/utils";

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function ProjectMonogram({
  text,
  color,
  pigment,
  className,
}: {
  readonly text: string;
  readonly color: ProjectIconColor;
  /** A solid tile in this colour with light letters, for a game whose pigment is its identity. */
  readonly pigment?: string | undefined;
  readonly className?: string | undefined;
}) {
  // Wrapped like the emoji and Lucide branches so the monogram sits where an
  // <img> favicon would. Menu items, buttons and the like pull every bare svg
  // in with [&_svg]:-mx-0.5 to trim the padding stroke icons carry, and this
  // tile has no such padding.
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      <svg
        viewBox="0 0 16 16"
        className={cn(
          "size-full overflow-hidden rounded-[25%] font-mono select-none",
          pigment === undefined ? projectIconColorClassName(color) : "text-white/90",
        )}
        style={{
          backgroundColor: pigment ?? "color-mix(in srgb, currentColor 14%, transparent)",
        }}
      >
        <text
          x="8"
          y="10.8"
          textAnchor="middle"
          fill="currentColor"
          className="font-mono"
          fontSize="8.25"
          fontWeight="700"
          textLength={Array.from(monogramSegmenter.segment(text)).length === 1 ? 6 : 12}
          lengthAdjust="spacingAndGlyphs"
          textRendering="geometricPrecision"
        >
          {text}
        </text>
      </svg>
    </span>
  );
}
