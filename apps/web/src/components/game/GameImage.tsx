import { useState } from "react";
import type { EnvironmentId } from "@kurambit/contracts";

import { useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";

/** A picture inside the game folder, in a box that keeps its size while it loads. */
export function GameImage({
  environmentId,
  root,
  path,
  alt,
  className,
}: {
  environmentId: EnvironmentId;
  root: string | null;
  /** Relative to the game root. */
  path: string;
  alt: string;
  className?: string;
}) {
  const state = useAssetUrlState(
    environmentId,
    root === null ? null : { _tag: "draft-workspace-file", cwd: root, path },
  );
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span className={cn("block overflow-hidden rounded-md bg-muted/50", className)}>
      {state._tag === "Success" && state.url !== failedUrl ? (
        <img
          src={state.url}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="size-full object-contain"
          onError={() => setFailedUrl(state.url)}
        />
      ) : null}
    </span>
  );
}
