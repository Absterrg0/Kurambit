import foxHeadInkUrl from "../../assets/brand/fox-head-ink.webp";
import foxHeadLightUrl from "../../assets/brand/fox-head-light.webp";
import foxInkUrl from "../../assets/brand/fox-ink.webp";
import foxLightUrl from "../../assets/brand/fox-light.webp";
import { cn } from "../../lib/utils";

/**
 * The fox mark: ink on light grounds, cream on dark ones. `tone` pins one
 * variant for surfaces that keep their own ground, like the sidebar artwork.
 */
export function KurambitMark({
  className,
  variant = "head",
  tone = "auto",
}: {
  className?: string;
  variant?: "head" | "full";
  tone?: "auto" | "light" | "ink";
}) {
  const ink = variant === "head" ? foxHeadInkUrl : foxInkUrl;
  const light = variant === "head" ? foxHeadLightUrl : foxLightUrl;
  if (tone !== "auto") {
    return (
      <img
        alt=""
        aria-hidden
        className={cn("select-none object-contain", className)}
        draggable={false}
        src={tone === "ink" ? ink : light}
      />
    );
  }
  return (
    <>
      <img
        alt=""
        aria-hidden
        className={cn("select-none object-contain dark:hidden", className)}
        draggable={false}
        src={ink}
      />
      <img
        alt=""
        aria-hidden
        className={cn("hidden select-none object-contain dark:block", className)}
        draggable={false}
        src={light}
      />
    </>
  );
}
