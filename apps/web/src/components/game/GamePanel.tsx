import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import type { GameAction, GameAsset, ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { gameEnvironment } from "../../state/game";
import { previewEnvironment } from "../../state/preview";
import { useRightPanelStore } from "../../rightPanelStore";
import { useAssetUrlState } from "../../assets/assetUrls";
import { Button } from "../ui/button";
import { openPreviewSession } from "../preview/openPreviewSession";

function AssetCard({
  asset,
  threadRef,
}: {
  asset: GameAsset & { usedBy: readonly string[] };
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
    <li className="flex gap-3 rounded border border-border p-3">
      {thumbnail._tag === "Success" ? (
        <img
          src={thumbnail.url}
          alt={asset.id}
          width={64}
          height={64}
          className="size-16 rounded object-contain"
        />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <p className="font-medium">{asset.id}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="link" onClick={() => reveal(asset.source)}>
            Source .blend
          </Button>
          <Button size="xs" variant="link" onClick={() => reveal(asset.export)}>
            Export .glb
          </Button>
        </div>
        <p className="break-words text-xs text-muted-foreground">
          {asset.usedBy.length ? `Used by ${asset.usedBy.join(", ")}` : "Not used in a scene yet"}
        </p>
      </div>
    </li>
  );
}
export function GamePanel({
  threadRef,
  visible,
}: {
  threadRef: ScopedThreadRef;
  visible: boolean;
}) {
  const query = useEnvironmentQuery(
    gameEnvironment.status({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const canOperate = useAtomValue(gameEnvironment.action.permissionAtom(threadRef.environmentId));
  const canInstall = useAtomValue(gameEnvironment.install.permissionAtom(threadRef.environmentId));
  const action = useAtomCommand(gameEnvironment.action, { reportFailure: false });
  const install = useAtomCommand(gameEnvironment.install, { reportFailure: false });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = query.refresh;
  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(refresh, 3_000);
    return () => clearInterval(interval);
  }, [visible, refresh]);
  const perform = async (operation: GameAction) => {
    if (busy && operation !== "stop") return;
    setBusy(operation);
    setMessage(null);
    setError(null);
    try {
      const result = await action({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, action: operation },
      });
      if (result._tag === "Failure") {
        setError(String(squashAtomCommandFailure(result)));
        return;
      }
      if (!result.value.success) {
        setError(result.value.message);
        return;
      }
      setMessage(result.value.message);
      if (result.value.url && (operation === "preview" || operation === "rebuild")) {
        const opened = await openPreviewSession({ openPreview, threadRef, url: result.value.url });
        if (opened._tag === "Failure") setError(String(squashAtomCommandFailure(opened)));
        else useRightPanelStore.getState().openBrowser(threadRef, opened.value.tabId);
      }
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const installTools = async () => {
    setBusy("install");
    setError(null);
    setMessage(null);
    try {
      const result = await install({ environmentId: threadRef.environmentId, input: {} });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else
        setMessage(
          result.value.tools.every((tool) => tool.ready && tool.verified)
            ? "Tools installed and verified."
            : result.value.tools.map((tool) => tool.message).join("\n"),
        );
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const data = query.data;
  if (!data) return <div className="p-4 text-sm">{query.error ?? "Loading game…"}</div>;
  const running = busy !== null || data.operation?.state === "running" || data.toolchain.installing;
  return (
    <div className="h-full space-y-5 overflow-auto p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{data.manifest.name}</h2>
        <Button size="sm" variant="ghost" onClick={refresh}>
          Refresh
        </Button>
      </div>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Toolchain</h3>
        {data.toolchain.tools.map((tool) => (
          <div key={tool.tool} className="break-words text-xs">
            <p className="font-medium">
              {tool.tool} {tool.version ?? "missing"} {tool.verified ? "· verified" : ""}
            </p>
            <p className="text-muted-foreground">{tool.message}</p>
            <p className="text-muted-foreground">{tool.path}</p>
          </div>
        ))}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!canInstall || running || data.toolchain.installing}
            onClick={() => void installTools()}
          >
            {busy === "install" || data.toolchain.installing
              ? "Installing tools…"
              : "Install tools"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate || running}
            onClick={() => void perform("verify")}
          >
            Verify
          </Button>
        </div>
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Build and play</h3>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["preview", "Play in app"],
              ["rebuild", "Rebuild preview"],
              ["native", "Run native"],
              ["export-linux", "Export Linux"],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant="outline"
              disabled={!canOperate || running}
              onClick={() => void perform(key)}
            >
              {label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate}
            onClick={() => void perform("stop")}
          >
            Stop
          </Button>
        </div>
        {busy ? (
          <p role="status" className="text-sm">
            {busy} is running…
          </p>
        ) : data.operation ? (
          <p className="whitespace-pre-wrap text-xs">
            {data.operation.state}: {data.operation.message}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="whitespace-pre-wrap text-sm">
            {message}
          </p>
        ) : null}
        {error || query.error ? (
          <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
            {error ?? query.error}
          </p>
        ) : null}
        {data.previewUrl ? <p className="break-all text-xs">Preview: {data.previewUrl}</p> : null}
        {data.processes.map((process) => (
          <p key={process.pid} className="text-xs">
            {process.operation}, PID {process.pid}
          </p>
        ))}
        <Button
          size="sm"
          variant="link"
          onClick={() => useRightPanelStore.getState().openFile(threadRef, "builds/logs")}
        >
          Open build logs
        </Button>
        {data.builds.map((build) => (
          <p key={build.target} className="break-words text-xs">
            {build.target}: {build.path}, {new Date(build.updatedAt).toLocaleString()}
          </p>
        ))}
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Assets</h3>
        {data.assets.length ? (
          <ul className="space-y-2">
            {data.assets.map((asset) => (
              <AssetCard
                key={`${asset.id}:${asset.updatedAt}`}
                asset={asset}
                threadRef={threadRef}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Your agent's Blender assets will appear here.
          </p>
        )}
      </section>
    </div>
  );
}
