import type { GameToolStatus } from "@kurambit/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "../ui/button";

export const GAME_TOOL_NAMES = {
  blender: "Blender",
  godot: "Godot",
  uv: "uv",
  unity: "Unity",
  mpfb: "MPFB2",
  ffmpeg: "ffmpeg",
} as const satisfies Record<GameToolStatus["tool"], string>;

/** "Get <tool>": the vendor's download page, opened in the system browser on desktop. */
export function GameToolLink({ tool }: { tool: GameToolStatus }) {
  if (tool.downloadUrl === null) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      render={<a href={tool.downloadUrl} target="_blank" rel="noreferrer" />}
    >
      Get {GAME_TOOL_NAMES[tool.tool]}
      <ExternalLinkIcon aria-hidden />
    </Button>
  );
}
