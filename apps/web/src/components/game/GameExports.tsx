import type { GameStatus, ScopedThreadRef } from "@kurambit/contracts";
import {
  DownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  Gamepad2Icon,
  LaptopIcon,
  MonitorIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { GameSavedList } from "./GameSavedMedia";
import { gameSourceFreshnessLabel } from "./gameStageLogic";
import { resolveAssetUrl } from "../../assets/assetUrls";
import { usePreparedConnection } from "../../state/session";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { useOpenLink } from "../../browser/useOpenLink";

type BuildEntry = GameStatus["builds"][number];
type ExportTarget = "Windows" | "Linux";
const BUILD_TARGETS = ["Web", "Windows", "Linux"] as const;

const BUILD_META: Record<
  (typeof BUILD_TARGETS)[number],
  { title: string; body: string; icon: typeof Gamepad2Icon; play: boolean }
> = {
  Web: {
    title: "Web export",
    body: "Runs in this window. This is what Play serves.",
    icon: Gamepad2Icon,
    play: true,
  },
  Windows: {
    title: "Windows export",
    body: "A standalone 64-bit Windows release for Windows PCs. Download package zips this export, not later source edits. Play still serves the Web export.",
    icon: MonitorIcon,
    play: false,
  },
  Linux: {
    title: "Linux export",
    body: "A standalone release for Linux desktops. Play still serves the Web export.",
    icon: LaptopIcon,
    play: false,
  },
};

/** The game folder's exports: the release files Play serves and the person ships. */
/** A release path as a person reads it: content-hash folder names become "…" (the full path is in Details). */
const humanBuildPath = (path: string) =>
  path
    .split("/")
    .map((part) => (/^[0-9a-f]{16,}$/.test(part) ? "…" : part))
    .join("/");

export function GameExports({
  threadRef,
  builds,
  exportTargets,
  live,
  webBuildStale,
  sourcesDifferFromPlay,
  canOperate,
  operationRunning,
  onPlay,
  onExportWeb,
  onExport,
}: {
  threadRef: ScopedThreadRef;
  builds: readonly BuildEntry[];
  /** The release targets this game's engine exports; the panel offers only those. */
  exportTargets: GameStatus["exportTargets"];
  /** The Stage plays the folder itself: the Web export is a release, never what Play serves. */
  live: boolean;
  webBuildStale: boolean;
  sourcesDifferFromPlay: GameStatus["sourcesDifferFromPlay"];
  canOperate: boolean;
  operationRunning: boolean;
  onPlay: () => void;
  /** Writes a fresh Web export (a live game's Web release). */
  onExportWeb: () => void;
  onExport: (target: ExportTarget) => void;
}) {
  const check = useAtomCommand(gameEnvironment.checkSources, { reportFailure: false });
  const packageWindows = useAtomCommand(gameEnvironment.packageWindows, { reportFailure: false });
  const packageWeb = useAtomCommand(gameEnvironment.packageWeb, { reportFailure: false });
  const canPackageWindows = useAtomValue(
    gameEnvironment.packageWindows.permissionAtom(threadRef.environmentId),
  );
  const canPackageWeb = useAtomValue(
    gameEnvironment.packageWeb.permissionAtom(threadRef.environmentId),
  );
  const webExportUrl = useAtomCommand(gameEnvironment.webExportUrl, { reportFailure: false });
  const canOpenWeb = useAtomValue(
    gameEnvironment.webExportUrl.permissionAtom(threadRef.environmentId),
  );
  const openLink = useOpenLink(threadRef);
  const preparedConnection = usePreparedConnection(threadRef.environmentId);
  const [packaging, setPackaging] = useState<"Windows" | "Web" | null>(null);
  const [packageNotice, setPackageNotice] = useState<{
    readonly target: "Windows" | "Web";
    readonly buildKey: string;
    readonly status: string | null;
    readonly error: string | null;
  } | null>(null);
  // A check answers for the builds and sources it saw: a new build or an edit
  // since then makes the server's own answer current again.
  const checkedFor = `${builds.map((entry) => `${entry.path}#${entry.updatedAt}`).join("|")}|${webBuildStale}`;
  const [checkedState, setChecked] = useState<{
    readonly value: GameStatus["sourcesDifferFromPlay"];
    readonly for: string;
  } | null>(null);
  const checked =
    checkedState !== null && checkedState.for === checkedFor ? checkedState.value : null;
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
      setChecked({ value: result.value.sourcesDifferFromPlay, for: checkedFor });
      setCheckError(null);
    }
  };
  const reveal = (relativePath: string) =>
    useRightPanelStore.getState().openFile(threadRef, relativePath);
  // The way every other link opens: the app's browser or the system one, as Settings choose.
  const openWebExport = async () => {
    const failed = (error: string) =>
      setPackageNotice({ target: "Web", buildKey: buildKey(webBuild) ?? "", status: null, error });
    setPackageNotice(null);
    const result = await webExportUrl({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") return failed(String(squashAtomCommandFailure(result)));
    await openLink(result.value.url).catch((cause: unknown) =>
      failed(cause instanceof Error ? cause.message : String(cause)),
    );
  };
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
    <div className="space-y-3">
      {/* A live game plays its folder, so no build can be older than what plays. */}
      {live ? null : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{gameSourceFreshnessLabel(checked ?? sourcesDifferFromPlay)}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={checking}
            onClick={() => void checkSources()}
          >
            Check
          </Button>
          {checkError ? <span role="alert">{checkError}</span> : null}
        </div>
      )}
      {BUILD_TARGETS.filter((target) => exportTargets.includes(target)).map((target) => {
        const meta =
          live && target === "Web"
            ? {
                ...BUILD_META.Web,
                body: "A static copy of the game for any web host. The Stage plays the game folder live, not this export.",
                play: false,
              }
            : BUILD_META[target];
        const build = builds.find((entry) => entry.target === target);
        const canPackage =
          canOperate &&
          build?.packageable === true &&
          (target === "Web" ? canPackageWeb : canPackageWindows);
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
              {build?.ships === "folder" ? (
                <p className="text-2xs text-muted-foreground">
                  This release is a whole folder; ship it as it is.
                </p>
              ) : null}
              {build ? (
                <details className="text-2xs text-muted-foreground">
                  <summary className="cursor-pointer truncate font-mono">
                    {humanBuildPath(build.path)} · updated{" "}
                    {new Date(build.updatedAt).toLocaleString()}
                  </summary>
                  <p className="mt-1 font-mono break-all">{build.path}</p>
                </details>
              ) : (
                <p className="text-2xs text-muted-foreground">Not built yet</p>
              )}
              {target === "Web" && !live ? (
                <p className="text-2xs text-muted-foreground">
                  Packages the export Play serves; later source edits are not included.
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
                      {build.packageable ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canPackage || operationRunning || packaging !== null}
                          aria-busy={packaging === "Web"}
                          onClick={() => void downloadPackage("Web")}
                        >
                          <DownloadIcon className="size-3.5" aria-hidden="true" />
                          {packaging === "Web" ? "Packaging…" : "Download package"}
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      {(target === "Windows" || target === "Web") && build.packageable ? (
                        <Button
                          size="sm"
                          disabled={!canPackage || operationRunning || packaging !== null}
                          aria-busy={packaging === target}
                          onClick={() => void downloadPackage(target === "Web" ? "Web" : "Windows")}
                        >
                          <DownloadIcon className="size-3.5" aria-hidden="true" />
                          {packaging === target ? "Packaging…" : "Download package"}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canOperate || operationRunning || packaging !== null}
                        onClick={() => {
                          if (target === "Web") onExportWeb();
                          else onExport(target);
                        }}
                      >
                        <DownloadIcon className="size-3.5" aria-hidden="true" />
                        Export again
                      </Button>
                    </>
                  )}
                  {target === "Web" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!canOpenWeb || operationRunning}
                      onClick={() => void openWebExport()}
                    >
                      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                      Open in browser
                    </Button>
                  ) : null}
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
                // The card's one action before its first export, so it reads as the primary.
                <Button
                  size="sm"
                  disabled={!canOperate || operationRunning || packaging !== null}
                  onClick={() => {
                    if (target === "Web") onExportWeb();
                    else onExport(target);
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
      <GameSavedList threadRef={threadRef} />
    </div>
  );
}
