import { useState } from "react";
import type { EnvironmentId } from "@kurambit/contracts";

import { useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";

/**
 * The game's key art over whatever sits beneath it (initials), through a
 * signed asset URL resolved inside the game folder like any workspace file.
 * Renders nothing until the image is ready, and nothing when it fails.
 */
export function GameKeyArt({
  environmentId,
  root,
  path,
  className,
}: {
  environmentId: EnvironmentId;
  root: string;
  /** Relative to the game root. */
  path: string | null;
  className?: string;
}) {
  const state = useAssetUrlState(
    environmentId,
    path === null ? null : { _tag: "draft-workspace-file", cwd: root, path },
  );
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (state._tag !== "Success" || state.url === failedUrl) return null;
  return (
    <img
      src={state.url}
      alt=""
      loading="lazy"
      decoding="async"
      className={cn("absolute inset-0 size-full object-cover", className)}
      onError={() => setFailedUrl(state.url)}
    />
  );
}
