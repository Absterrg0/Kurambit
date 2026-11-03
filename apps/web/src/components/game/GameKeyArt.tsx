import { useState } from "react";
import type { EnvironmentId, ThreadId } from "@kurambit/contracts";

import { useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";

/**
 * The game's key art over whatever sits beneath it (initials), through a
 * signed asset URL for the file the server found inside the game folder.
 * Renders nothing until the image is ready, and nothing when it fails.
 */
export function GameKeyArt({
  environmentId,
  threadId,
  path,
  className,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  path: string | null;
  className?: string;
}) {
  const state = useAssetUrlState(
    environmentId,
    threadId === null || path === null ? null : { _tag: "media-file", threadId, path },
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
