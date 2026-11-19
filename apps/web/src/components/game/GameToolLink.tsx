import type { GameToolStatus } from "@kurambit/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "../ui/button";

const GAME_TOOL_NAMES = {
  blender: "Blender",
  uv: "uv",
  addon: "Add-on",
  ffmpeg: "ffmpeg",
} as const satisfies Record<GameToolStatus["tool"], string>;
/** A tool's own name; an add-on's comes from the add-ons list. */
export const gameToolName = (tool: GameToolStatus): string =>
  tool.addon?.name ?? GAME_TOOL_NAMES[tool.tool];

/** "Get <tool>": the vendor's download page, opened in the system browser on desktop. */
export function GameToolLink({ tool }: { tool: GameToolStatus }) {
  if (tool.downloadUrl === null) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      render={<a href={tool.downloadUrl} target="_blank" rel="noreferrer" />}
    >
      Get {gameToolName(tool)}
      <ExternalLinkIcon aria-hidden />
    </Button>
  );
}
