import type { GameStatus, ScopedThreadRef } from "@t3tools/contracts";
import {
  DownloadIcon,
  FolderOpenIcon,
  Gamepad2Icon,
  MonitorIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";

type BuildEntry = GameStatus["builds"][number];

const BUILD_META: Record<
  string,
  { title: string; body: string; icon: typeof Gamepad2Icon; play: boolean }
> = {
  Web: {
    title: "Web build",
    body: "Runs in this window. This is what Play serves.",
    icon: Gamepad2Icon,
    play: true,
  },
  Linux: {
    title: "Linux build",
    body: "A standalone build for Linux desktops.",
    icon: MonitorIcon,
    play: false,
  },
};

export function GameBuildsPanel({
  threadRef,
  builds,
  webBuildStale,
  canOperate,
  onPlay,
  onExportLinux,
}: {
  threadRef: ScopedThreadRef;
  builds: readonly BuildEntry[];
  webBuildStale: boolean;
  canOperate: boolean;
  onPlay: () => void;
  onExportLinux: () => void;
}) {
  const reveal = (relativePath: string) =>
    useRightPanelStore.getState().openFile(threadRef, relativePath);
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
      {(["Web", "Linux"] as const).map((target) => {
        const meta = BUILD_META[target]!;
        const build = builds.find((entry) => entry.target === target);
        const stale = target === "Web" && build !== undefined && webBuildStale;
        const Icon = meta.icon;
        return (
          <section
            key={target}
            data-game-build={target.toLowerCase()}
            className="flex flex-wrap items-start gap-4 rounded-lg border border-border bg-card p-4"
          >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
              <Icon className="size-4.5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{meta.title}</h3>
                {stale ? (
                  <span className="flex items-center gap-1 rounded-full border border-warning/40 bg-warning-surface px-2 py-0.5 text-2xs text-warning-foreground">
                    <TriangleAlertIcon className="size-3" aria-hidden="true" />
                    Older than the game
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{meta.body}</p>
              <p className="truncate font-mono text-2xs text-muted-foreground">
                {build
                  ? `${build.path} · updated ${new Date(build.updatedAt).toLocaleString()}`
                  : "Not built yet"}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {build ? (
                <>
                  {meta.play ? (
                    <Button size="sm" disabled={!canOperate} onClick={onPlay}>
                      <Gamepad2Icon className="size-3.5" aria-hidden="true" />
                      Play
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canOperate}
                      onClick={onExportLinux}
                    >
                      <DownloadIcon className="size-3.5" aria-hidden="true" />
                      Export again
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => reveal(build.path.replace(/\/[^/]+$/, ""))}
                  >
                    <FolderOpenIcon className="size-3.5" aria-hidden="true" />
                    Open folder
                  </Button>
                </>
              ) : meta.play ? (
                <Button size="sm" variant="outline" disabled={!canOperate} onClick={onPlay}>
                  Build & play
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={!canOperate} onClick={onExportLinux}>
                  <DownloadIcon className="size-3.5" aria-hidden="true" />
                  Export Linux
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => reveal("builds/logs")}>
                <ScrollTextIcon className="size-3.5" aria-hidden="true" />
                Logs
              </Button>
            </div>
          </section>
        );
      })}
      <p className="px-1 text-xs text-muted-foreground">
        Builds live in <span className="font-mono">builds/</span> and are not committed to the game
        repository. Every operation writes its output to{" "}
        <span className="font-mono">builds/logs/</span>.
      </p>
    </div>
  );
}
