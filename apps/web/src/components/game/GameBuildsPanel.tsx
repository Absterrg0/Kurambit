import type { GameLastPlaytest, GameStatus, ScopedThreadRef } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  DownloadIcon,
  FolderOpenIcon,
  Gamepad2Icon,
  MonitorIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";

import { useAssetUrlState } from "../../assets/assetUrls";
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
  lastPlaytest,
  canOperate,
  onPlay,
  onExportLinux,
}: {
  threadRef: ScopedThreadRef;
  builds: readonly BuildEntry[];
  webBuildStale: boolean;
  lastPlaytest: GameLastPlaytest | null;
  canOperate: boolean;
  onPlay: () => void;
  onExportLinux: () => void;
}) {
  const reveal = (relativePath: string) =>
    useRightPanelStore.getState().openFile(threadRef, relativePath);
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
      <LastPlaytestSection threadRef={threadRef} lastPlaytest={lastPlaytest} onReveal={reveal} />
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

function LastPlaytestSection({
  threadRef,
  lastPlaytest,
  onReveal,
}: {
  threadRef: ScopedThreadRef;
  lastPlaytest: GameLastPlaytest | null;
  onReveal: (relativePath: string) => void;
}) {
  if (lastPlaytest === null) {
    return (
      <section
        data-game-last-playtest="none"
        className="rounded-lg border border-border bg-card p-4"
      >
        <h3 className="text-sm font-medium">Last playtest</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          No playtest yet. Ask your agent to run{" "}
          <span className="font-mono">game_web_playtest</span> with steps that play the core loop.
        </p>
      </section>
    );
  }
  return (
    <section
      data-game-last-playtest={lastPlaytest.success ? "success" : "failed"}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Last playtest</h3>
        <span
          className={
            lastPlaytest.success
              ? "flex items-center gap-1 rounded-full border border-success/40 bg-secondary px-2 py-0.5 text-2xs text-success-foreground"
              : "flex items-center gap-1 rounded-full border border-destructive/40 bg-secondary px-2 py-0.5 text-2xs text-destructive-foreground"
          }
        >
          {lastPlaytest.success ? (
            <CheckCircle2Icon className="size-3" aria-hidden="true" />
          ) : (
            <XCircleIcon className="size-3" aria-hidden="true" />
          )}
          {lastPlaytest.success ? "Passed" : "Failed"}
        </span>
        {lastPlaytest.stale ? (
          <span className="flex items-center gap-1 rounded-full border border-warning/40 bg-warning-surface px-2 py-0.5 text-2xs text-warning-foreground">
            <TriangleAlertIcon className="size-3" aria-hidden="true" />
            Older than the web build
          </span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(lastPlaytest.at).toLocaleString()}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {lastPlaytest.responded
          ? `The game responded to the steps (${lastPlaytest.changedPercent}% of sampled pixels changed).`
          : "The game did not respond to the steps."}{" "}
        {lastPlaytest.consoleErrorCount === 0
          ? "No console errors."
          : `${lastPlaytest.consoleErrorCount} console error(s).`}
      </p>
      {lastPlaytest.frames.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {lastPlaytest.frames.map((frame) => (
            <PlaytestFrame
              key={frame.path}
              threadRef={threadRef}
              label={frame.label}
              path={frame.path}
              onOpen={() => onReveal(frame.path)}
            />
          ))}
        </ul>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        className="mt-2"
        onClick={() => onReveal(lastPlaytest.directory)}
      >
        <FolderOpenIcon className="size-3" aria-hidden="true" />
        Open evidence
      </Button>
    </section>
  );
}

function PlaytestFrame({
  threadRef,
  label,
  path,
  onOpen,
}: {
  threadRef: ScopedThreadRef;
  label: string;
  path: string;
  onOpen: () => void;
}) {
  const frame = useAssetUrlState(threadRef.environmentId, {
    _tag: "workspace-file",
    threadId: threadRef.threadId,
    path,
  });
  return (
    <li className="w-40">
      <button type="button" onClick={onOpen} className="block w-full cursor-pointer text-left">
        <span className="flex aspect-video items-center justify-center overflow-hidden rounded-md border border-border bg-stage">
          {frame._tag === "Success" ? (
            <img
              src={frame.url}
              alt={`Playtest frame ${label}`}
              className="size-full object-cover"
            />
          ) : (
            <span className="text-2xs text-stage-subtle">No frame</span>
          )}
        </span>
        <span className="mt-1 block truncate text-2xs text-muted-foreground">{label}</span>
      </button>
    </li>
  );
}
