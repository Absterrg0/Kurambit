import { cn } from "../../lib/utils";
import type { ThemeCardPreviewColors } from "./ThemePreviewCircles";

// The System preview splits light and dark on a diagonal. The half the app is not
// showing recedes, so a light half never becomes the brightest thing on a dark page.
const PANE_CLIP_CLASS = {
  left: "[clip-path:polygon(0_0,62%_0,38%_100%,0_100%)] dark:opacity-55",
  right: "[clip-path:polygon(62%_0,100%_0,100%_100%,38%_100%)] light:opacity-55",
} as const;

function ThemeWireframePane({
  colors,
  clip,
}: {
  colors: ThemeCardPreviewColors;
  clip?: "left" | "right" | undefined;
}) {
  const line = "rgb(127 127 127 / 0.25)";
  return (
    <span className={cn("absolute inset-0", clip === undefined ? null : PANE_CLIP_CLASS[clip])}>
      <span className="absolute inset-0" style={{ backgroundColor: colors.canvas }} />
      <span
        className="absolute inset-y-0 left-0 w-[22%]"
        style={{ backgroundColor: colors.sidebar, boxShadow: `inset -1px 0 0 ${line}` }}
      />

      <span
        className="absolute left-[3%] top-[8%] h-[8%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${line}` }}
      />
      <span
        className="absolute left-[3%] top-[22%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.accentSurface }}
      />
      <span
        className="absolute left-[3%] top-[32%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.messageSurface, opacity: 0.7 }}
      />
      <span
        className="absolute left-[3%] top-[42%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.messageSurface, opacity: 0.5 }}
      />

      <span
        className="absolute right-[28%] top-[11%] h-[9%] w-[24%] rounded-lg"
        style={{ backgroundColor: colors.messageSurface }}
      />
      <span
        className="absolute left-[27%] top-[28%] h-[5%] w-[34%] rounded-sm"
        style={{ backgroundColor: line }}
      />
      <span
        className="absolute left-[27%] top-[38%] h-[5%] w-[26%] rounded-sm"
        style={{ backgroundColor: line }}
      />

      <span
        className="absolute bottom-[8%] left-[26%] right-[6%] flex h-[15%] items-center justify-between rounded-md px-1"
        style={{
          backgroundColor: colors.surface,
          boxShadow: `inset 0 0 0 1px ${line}`,
        }}
      >
        <span
          className="block h-[26%] w-[34%] rounded-full"
          style={{ backgroundColor: line, opacity: 0.7 }}
        />
        <span
          className="block aspect-square h-[58%] rounded-full"
          style={{ backgroundColor: colors.messageAction }}
        />
      </span>

      <span
        className="absolute right-[5%] top-[8%] h-[46%] w-[20%] rounded-lg"
        style={{
          backgroundColor: colors.surface,
          boxShadow: `inset 0 0 0 1px ${line}, 0 2px 5px rgb(0 0 0 / 0.14)`,
        }}
      >
        {[0, 1, 2].map((row) => (
          <span
            className="absolute left-[11%] right-[11%] flex items-center gap-1"
            key={row}
            style={{ top: `${10 + row * 30}%`, height: "20%" }}
          >
            <span
              className="block aspect-square h-[26%] rounded-full"
              style={{
                backgroundColor:
                  row === 0 ? "#34d399" : row === 1 ? colors.messageAction : "#fbbf24",
                opacity: 0.55,
              }}
            />
            <span className="block h-[30%] w-[52%] rounded-sm" style={{ backgroundColor: line }} />
          </span>
        ))}
      </span>
    </span>
  );
}

/** `left` is the light half and `right` the dark half of a System preview. */
export function ThemeWireframe({
  className,
  panes,
  selected = false,
}: {
  className?: string;
  panes: ReadonlyArray<{ colors: ThemeCardPreviewColors; clip?: "left" | "right" }>;
  selected?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block w-full overflow-hidden rounded-lg border transition-colors",
        // Selection is one 2px ring in place of the rim, never a rim inside a ring.
        selected
          ? "border-transparent ring-2 ring-ring"
          : "border-border/60 group-hover/mode:border-border",
        className,
      )}
    >
      {panes.map((pane) => (
        <ThemeWireframePane clip={pane.clip} colors={pane.colors} key={pane.clip ?? "pane"} />
      ))}
    </span>
  );
}
