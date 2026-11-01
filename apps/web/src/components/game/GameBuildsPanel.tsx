import type { GameStatus, ScopedThreadRef } from "@t3tools/contracts";
import {
  DownloadIcon,
  FolderOpenIcon,
  Gamepad2Icon,
  LaptopIcon,
  MonitorIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { gameSourceFreshnessLabel } from "./gameStageLogic";
import { resolveAssetUrl } from "../../assets/assetUrls";
import { usePreparedConnection } from "../../state/session";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";

type BuildEntry = GameStatus["builds"][number];
type ExportTarget = "Windows" | "Linux";
const BUILD_TARGETS = ["Web", "Windows", "Linux"] as const;

const BUILD_META: Record<
  (typeof BUILD_TARGETS)[number],
  { title: string; body: string; icon: typeof Gamepad2Icon; play: boolean }
> = {
  Web: {
    title: "Web build",
    body: "Runs in this window. This is what Play serves.",
    icon: Gamepad2Icon,
    play: true,
  },
  Windows: {
    title: "Windows build",
    body: "A standalone 64-bit Windows build for Windows PCs. Download package zips this exported release, not later source edits. Play still serves the Web build.",
    icon: MonitorIcon,
    play: false,
  },
  Linux: {
    title: "Linux build",
    body: "A standalone build for Linux desktops. Play still serves the Web build.",
    icon: LaptopIcon,
    play: false,
  },
};

export function GameBuildsPanel({
  threadRef,
  builds,
  webBuildStale,
  sourcesDifferFromPlay,
  canOperate,
  operationRunning,
  onPlay,
  onExport,
}: {
  threadRef: ScopedThreadRef;
  builds: readonly BuildEntry[];
  webBuildStale: boolean;
  sourcesDifferFromPlay: GameStatus["sourcesDifferFromPlay"];
  canOperate: boolean;
  operationRunning: boolean;
  onPlay: () => void;
  onExport: (target: ExportTarget) => void;
}) {
  const check = useAtomCommand(gameEnvironment.checkSources, { reportFailure: false });
  const packageWindows = useAtomCommand(gameEnvironment.packageWindows, { reportFailure: false });
  const packageWeb = useAtomCommand(gameEnvironment.packageWeb, { reportFailure: false });
  const preparedConnection = usePreparedConnection(threadRef.environmentId);
  const [packaging, setPackaging] = useState<"Windows" | "Web" | null>(null);
  const [packageNotice, setPackageNotice] = useState<{
    readonly target: "Windows" | "Web";
    readonly buildKey: string;
    readonly status: string | null;
    readonly error: string | null;
  } | null>(null);
  const [checked, setChecked] = useState<GameStatus["sourcesDifferFromPlay"] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const windowsBuild = builds.find((entry) => entry.target === "Windows");
  const webBuild = builds.find((entry) => entry.target === "Web");
  // A new export or selection can remove the package. Tie the ready message to
  // the build it described so the previous archive's notice disappears with it.
  const buildKey = (build: BuildEntry | undefined) =>
    build ? `${threadRef.threadId}\n${build.path}\n${build.updatedAt}` : null;
  const packageNoticeFor = (target: "Windows" | "Web") => {
    if (packageNotice === null || packageNotice.target !== target) return null;
    const key = buildKey(target === "Windows" ? windowsBuild : webBuild);
    return packageNotice.buildKey === key ? packageNotice : null;
  };
  const checkSources = async () => {
    setChecking(true);
    const result = await check({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, checkSources: true },
    });
    setChecking(false);
    if (result._tag === "Failure") setCheckError(String(squashAtomCommandFailure(result)));
    else {
      setChecked(result.value.sourcesDifferFromPlay);
      setCheckError(null);
    }
  };
  const reveal = (relativePath: string) =>
    useRightPanelStore.getState().openFile(threadRef, relativePath);
  const downloadPackage = async (target: "Windows" | "Web") => {
    if (operationRunning || packaging !== null) return;
    const targetBuildKey = buildKey(target === "Windows" ? windowsBuild : webBuild) ?? "";
    setPackaging(target);
    setPackageNotice(null);
    const result =
      target === "Web"
        ? await packageWeb({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          })
        : await packageWindows({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          });
    setPackaging(null);
    if (result._tag === "Failure") {
      setPackageNotice({
        target,
        buildKey: targetBuildKey,
        status: null,
        error: String(squashAtomCommandFailure(result)),
      });
      return;
    }
    const url =
      preparedConnection._tag === "Some"
        ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.downloadPath)
        : null;
    if (url === null) {
      setPackageNotice({
        target,
        buildKey: targetBuildKey,
        status: null,
        error: "The server address is not ready. Try the download again.",
      });
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.value.fileName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setPackageNotice({
      target,
      buildKey: targetBuildKey,
      status: [result.value.message, ...result.value.notes].join(" "),
      error: null,
    });
  };
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{gameSourceFreshnessLabel(checked ?? sourcesDifferFromPlay)}</span>
        <Button size="xs" variant="outline" disabled={checking} onClick={() => void checkSources()}>
          Check
        </Button>
        {checkError ? <span role="alert">{checkError}</span> : null}
      </div>
      {BUILD_TARGETS.map((target) => {
        const meta = BUILD_META[target];
        const build = builds.find((entry) => entry.target === target);
        const stale = target === "Web" && build !== undefined && webBuildStale;
        const notice = target === "Linux" ? null : packageNoticeFor(target);
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
              {target === "Web" ? (
                <p className="text-2xs text-muted-foreground">
                  Packages the build Play serves; later source edits are not included.
                </p>
              ) : null}
              {notice?.error ? (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {notice.error}
                </p>
              ) : null}
              {notice?.status ? (
                <p className="text-xs text-muted-foreground">{notice.status}</p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {build ? (
                <>
                  {meta.play ? (
                    <>
                      <Button size="sm" disabled={!canOperate} onClick={onPlay}>
                        <Gamepad2Icon className="size-3.5" aria-hidden="true" />
                        Play
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canOperate || operationRunning || packaging !== null}
                        aria-busy={packaging === "Web"}
                        onClick={() => void downloadPackage("Web")}
                      >
                        <DownloadIcon className="size-3.5" aria-hidden="true" />
                        {packaging === "Web" ? "Packaging…" : "Download package"}
                      </Button>
                    </>
                  ) : (
                    <>
                      {target === "Windows" ? (
                        <Button
                          size="sm"
                          disabled={!canOperate || operationRunning || packaging !== null}
                          aria-busy={packaging === "Windows"}
                          onClick={() => void downloadPackage("Windows")}
                        >
                          <DownloadIcon className="size-3.5" aria-hidden="true" />
                          {packaging === "Windows" ? "Packaging…" : "Download package"}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canOperate || operationRunning || packaging !== null}
                        onClick={() => {
                          if (target !== "Web") onExport(target);
                        }}
                      >
                        <DownloadIcon className="size-3.5" aria-hidden="true" />
                        Export again
                      </Button>
                    </>
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
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canOperate || operationRunning}
                  onClick={onPlay}
                >
                  Build & play
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canOperate || operationRunning || packaging !== null}
                  onClick={() => {
                    if (target !== "Web") onExport(target);
                  }}
                >
                  <DownloadIcon className="size-3.5" aria-hidden="true" />
                  Export {target}
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
