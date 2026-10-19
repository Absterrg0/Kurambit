import type { GameAsset, ScopedThreadRef } from "@t3tools/contracts";
import { BoxesIcon, FileBoxIcon } from "lucide-react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";

type AssetWithUsage = GameAsset & { readonly usedBy: readonly string[] };

export function GameAssetsPanel({
  threadRef,
  assets,
}: {
  threadRef: ScopedThreadRef;
  assets: readonly AssetWithUsage[];
}) {
  if (assets.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <BoxesIcon className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">No models yet</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Ask your agent for a model and its Blender source and preview will appear here.
        </p>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
        {assets.map((asset) => (
          <GameAssetCard
            key={`${asset.id}:${asset.updatedAt}`}
            asset={asset}
            threadRef={threadRef}
          />
        ))}
      </ul>
    </div>
  );
}

function GameAssetCard({
  asset,
  threadRef,
}: {
  asset: AssetWithUsage;
  threadRef: ScopedThreadRef;
}) {
  const thumbnail = useAssetUrlState(
    threadRef.environmentId,
    asset.thumbnail
      ? { _tag: "workspace-file", threadId: threadRef.threadId, path: asset.thumbnail }
      : null,
  );
  const reveal = (relativePath: string) =>
    useRightPanelStore.getState().openFile(threadRef, relativePath);
  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex aspect-4/3 items-center justify-center bg-stage">
        {thumbnail._tag === "Success" ? (
          <img
            src={thumbnail.url}
            alt={`${asset.id} preview`}
            className="size-full object-contain p-4"
          />
        ) : (
          <FileBoxIcon className="size-8 text-stage-subtle" aria-hidden="true" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{asset.id}</p>
          <p className="truncate text-xs text-muted-foreground">Blender model</p>
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {asset.usedBy.length
            ? `Used by ${asset.usedBy.map((file) => file.replace(/^godot\//, "")).join(", ")}`
            : "Not used in a scene yet"}
        </p>
        <div className="mt-auto flex flex-wrap gap-1">
          <Button size="xs" variant="ghost" onClick={() => reveal(asset.source)}>
            Open .blend
          </Button>
          <Button size="xs" variant="ghost" onClick={() => reveal(asset.export)}>
            Open .glb
          </Button>
        </div>
      </div>
    </li>
  );
}
