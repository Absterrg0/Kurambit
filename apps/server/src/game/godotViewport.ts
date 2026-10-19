/**
 * The game's design resolution, read from `godot/project.godot`. The play stage
 * letterboxes the web preview to it so a game that is not 16:9 keeps the frame
 * its author set instead of being stretched to the window.
 */
export interface GodotViewport {
  readonly width: number;
  readonly height: number;
}

/** Godot's own default when `[display]` sets no viewport size. */
const DEFAULT_VIEWPORT: GodotViewport = { width: 1152, height: 648 };
const MIN_SIDE = 16;
const MAX_SIDE = 16384;

const viewportValue = (projectGodot: string, key: "viewport_width" | "viewport_height") => {
  const match = projectGodot.match(
    new RegExp(`^[ \\t]*window/size/${key}[ \\t]*=[ \\t]*(\\d+)[ \\t]*$`, "m"),
  );
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isInteger(value) && value >= MIN_SIDE && value <= MAX_SIDE ? value : null;
};

export function parseGodotViewport(projectGodot: string): GodotViewport {
  return {
    width: viewportValue(projectGodot, "viewport_width") ?? DEFAULT_VIEWPORT.width,
    height: viewportValue(projectGodot, "viewport_height") ?? DEFAULT_VIEWPORT.height,
  };
}
