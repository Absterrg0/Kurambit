import { useState, type ReactNode } from "react";
import type { EnvironmentId } from "@kurambit/contracts";

import { useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";

/**
 * The game's key art over whatever sits beneath it (its pigment), through a
 * signed asset URL resolved inside the game folder like any workspace file.
 * While it loads the pigment alone shows, and the picture fades in over it;
 * when it cannot load, `missing` shows instead, so a missing picture never
 * looks like one still on its way.
 */
export function GameKeyArt({
  environmentId,
  root,
  path,
  missing = null,
  className,
}: {
  environmentId: EnvironmentId;
  root: string;
  /** Relative to the game root. */
  path: string | null;
  missing?: ReactNode;
  className?: string;
}) {
  const state = useAssetUrlState(
    environmentId,
    path === null ? null : { _tag: "draft-workspace-file", cwd: root, path },
  );
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  if (state._tag === "Loading") return null;
  if (state._tag === "Failure" || state.url === failedUrl) return missing;
  return (
    <img
      src={state.url}
      alt=""
      decoding="async"
      className={cn(
        "absolute inset-0 size-full object-cover transition-opacity motion-surface",
        loadedUrl === state.url ? "opacity-100" : "opacity-0",
        className,
      )}
      onLoad={() => setLoadedUrl(state.url)}
      onError={() => setFailedUrl(state.url)}
    />
  );
}
