import type { GameLastPlaytest, GameStatus, ScopedThreadRef } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  DownloadIcon,
  FolderOpenIcon,
  Gamepad2Icon,
  LaptopIcon,
  MonitorIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";

import { useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { GameReviewPanel } from "./GameReviewPanel";
import { gameSourceFreshnessLabel } from "./gameStageLogic";
import { useAssetUrlState, resolveAssetUrl } from "../../assets/assetUrls";
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
  lastPlaytest,
  sourcesDifferFromPlay,
  selectedBuildId,
  canOperate,
  onPlay,
  onExport,
}: {
  threadRef: ScopedThreadRef;
  builds: readonly BuildEntry[];
  webBuildStale: boolean;
  lastPlaytest: GameLastPlaytest | null;
  sourcesDifferFromPlay: GameStatus["sourcesDifferFromPlay"];
  selectedBuildId: string | null;
  canOperate: boolean;
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
      <LastPlaytestSection threadRef={threadRef} lastPlaytest={lastPlaytest} onReveal={reveal} />
      <GameReviewPanel key={threadRef.threadId} threadRef={threadRef} />
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
                  {selectedBuildId === null
                    ? "Packaging needs a selected build; build & play first."
                    : `Packages selected build ${selectedBuildId.slice(0, 12)}; later source edits are not included.`}
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
                        disabled={!canOperate || packaging !== null || selectedBuildId === null}
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
                          disabled={!canOperate || packaging !== null}
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
                        disabled={!canOperate || packaging !== null}
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
                <Button size="sm" variant="outline" disabled={!canOperate} onClick={onPlay}>
                  Build & play
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canOperate}
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
  // `success` only says the browser run worked; the verdict says whether it
  // did any of the play the game owes. Show both, and keep old evidence that
  // predates the verdict on its own Passed/Failed wording.
  const qualifies = lastPlaytest.qualifies;
  const badge =
    qualifies === true
      ? {
          label: "Gameplay checked",
          icon: CheckCircle2Icon,
          className: "border-success/40 bg-secondary text-success-foreground",
        }
      : qualifies === false
        ? {
            label: "Not counted",
            icon: TriangleAlertIcon,
            className: "border-warning/40 bg-warning-surface text-warning-foreground",
          }
        : lastPlaytest.success
          ? {
              label: "Passed",
              icon: CheckCircle2Icon,
              className: "border-success/40 bg-secondary text-success-foreground",
            }
          : {
              label: "Failed",
              icon: XCircleIcon,
              className: "border-destructive/40 bg-secondary text-destructive-foreground",
            };
  const BadgeIcon = badge.icon;
  return (
    <section
      data-game-last-playtest={
        qualifies === false ? "unqualified" : lastPlaytest.success ? "success" : "failed"
      }
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Last playtest</h3>
        <span
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs ${badge.className}`}
        >
          <BadgeIcon className="size-3" aria-hidden="true" />
          {badge.label}
        </span>
        {lastPlaytest.stale ? (
          <span className="flex items-center gap-1 rounded-full border border-warning/40 bg-warning-surface px-2 py-0.5 text-2xs text-warning-foreground">
            <TriangleAlertIcon className="size-3" aria-hidden="true" />
            Not current
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
      {qualifies === false ? (
        <p className="mt-1 text-xs text-warning-foreground">
          Not counted as gameplay evidence
          {lastPlaytest.blockers !== undefined && lastPlaytest.blockers.length > 0
            ? `: ${lastPlaytest.blockers.join("; ")}`
            : "."}
        </p>
      ) : null}
      {qualifies === true && lastPlaytest.interaction !== undefined ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Interaction: {lastPlaytest.interaction}.
        </p>
      ) : null}
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
      <Button size="xs" variant="ghost" onClick={() => onReveal(lastPlaytest.directory)}>
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
