import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  DownloadIcon,
  Gamepad2Icon,
  MaximizeIcon,
  MinimizeIcon,
  MonitorPlayIcon,
  PanelRightIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type { GameAction, ScopedThreadRef } from "@t3tools/contracts";
import { GAME_TEMPLATES } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameAssetsPanel } from "./GameAssetsPanel";
import { GameBuildsPanel } from "./GameBuildsPanel";
import { GameElapsed } from "./GameElapsed";
import { GamePlaySurface } from "./GamePlaySurface";
import { buildFailurePrompt, deriveGameStagePhase } from "./gameStageLogic";

type GameStageTab = "play" | "assets" | "builds";

const BUSY_LABELS: Record<GameAction, string> = {
  preview: "Building the web preview",
  rebuild: "Rebuilding the web preview",
  native: "Starting the native game",
  stop: "Stopping",
  "export-linux": "Exporting the Linux build",
  verify: "Verifying game tools",
};

const TABS: ReadonlyArray<{ value: GameStageTab; label: string }> = [
  { value: "play", label: "Play" },
  { value: "assets", label: "Assets" },
  { value: "builds", label: "Builds" },
];

/**
 * The game workspace for a game thread: the stage owns the centre of the
 * window and chat is docked to its right. ChatView mounts this once the
 * thread's game status resolves, which is also what makes it a game thread.
 */
export function GameStage({
  threadRef,
  turnRunning,
  onAskAgent,
}: {
  threadRef: ScopedThreadRef;
  /** The thread's agent turn is running; a settled turn refreshes the stage. */
  turnRunning: boolean;
  onAskAgent: (text: string) => void;
}) {
  const navigate = useNavigate();
  const query = useEnvironmentQuery(
    gameEnvironment.status({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const canOperate = useAtomValue(gameEnvironment.action.permissionAtom(threadRef.environmentId));
  const action = useAtomCommand(gameEnvironment.action, { reportFailure: false });
  const chatWidth = useGameWorkspaceStore((state) => state.chatWidth);
  const chatCollapsed = useGameWorkspaceStore((state) => state.chatCollapsed);
  const setChatWidth = useGameWorkspaceStore((state) => state.setChatWidth);
  const setChatCollapsed = useGameWorkspaceStore((state) => state.setChatCollapsed);
  const [tab, setTab] = useState<GameStageTab>("play");
  // The server keeps the last operation per game for the whole session, so the
  // stage treats an operation as news only when it happened after this stage
  // mounted. Older ones would greet the user with a build they already know about.
  const [mountedAt] = useState(() => Date.now());
  const [busy, setBusy] = useState<{ action: GameAction; startedAt: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissedOperationAt, setDismissedOperationAt] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ x: number; width: number } | null>(null);
  const refresh = query.refresh;
  const data = query.data;
  const operationState = data?.operation?.state ?? null;
  // Poll only while an operation is in flight; otherwise the stage sits still.
  useEffect(() => {
    if (operationState !== "running") return;
    const interval = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(interval);
  }, [operationState, refresh]);
  // The moment a turn settles, the game on disk is probably different.
  const previousTurnRunning = useRef(turnRunning);
  useEffect(() => {
    const wasRunning = previousTurnRunning.current;
    previousTurnRunning.current = turnRunning;
    if (wasRunning && !turnRunning) refresh();
  }, [turnRunning, refresh]);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  if (!data) return null;
  const webBuild = data.builds.find((build) => build.target === "Web");
  const phase = deriveGameStagePhase({
    toolchainReady: data.toolchain.tools.every((tool) => tool.ready),
    operation: data.operation,
    hasWebBuild: webBuild !== undefined,
    webBuildStale: data.webBuildStale,
    previewUrl: data.previewUrl,
    busyStartedAt: busy?.startedAt ?? null,
    localError: error,
  });
  const building = busy !== null || operationState === "running";
  const buildingStartedAt =
    busy?.startedAt ??
    (operationState === "running" && data.operation !== null
      ? Date.parse(data.operation.at)
      : null);
  const operation = data.operation;
  const operationVisible =
    operation !== null &&
    operation.at !== dismissedOperationAt &&
    Date.parse(operation.at) >= mountedAt;
  const failureVisible =
    error ??
    (operation !== null && operationVisible && operation.state === "failed"
      ? operation.message
      : null);
  const noticeVisible =
    message ?? (operation !== null && operationVisible ? operation.message : null);
  // The strip is one line: a failure's excerpt belongs in the card, and its
  // headline (with the full text in the tooltip) is what the strip has room for.
  const strip = building
    ? null
    : failureVisible !== null
      ? (failureVisible.split("\n")[0] ?? failureVisible)
      : noticeVisible;
  const showStrip = strip !== null && phase.kind !== "failed";
  // One status line, and a failure outranks the staleness it just caused.
  const staleChipVisible =
    failureVisible === null &&
    (phase.kind === "playing" || phase.kind === "ready" ? phase.stale : false);
  const nativeRunning = data.processes.some((process) => process.operation === "native");
  const runningSomething =
    busy !== null ||
    operationState === "running" ||
    data.processes.length > 0 ||
    data.previewUrl !== null;
  const buildingMessage =
    operationState === "running" && data.operation !== null
      ? data.operation.message
      : `${busy === null ? "Working" : BUSY_LABELS[busy.action]}…`;
  const template = GAME_TEMPLATES.find((entry) => entry.id === data.manifest.template);
  const frameKey = `${data.previewUrl ?? ""}#${webBuild?.updatedAt ?? ""}`;
  const askAgentToFix = (failure: string) => onAskAgent(buildFailurePrompt(failure));
  const perform = async (stageAction: GameAction) => {
    if (busy !== null && stageAction !== "stop") return;
    setBusy({ action: stageAction, startedAt: Date.now() });
    setMessage(null);
    setError(null);
    const result = await action({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, action: stageAction },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
    } else if (!result.value.success) {
      setError(result.value.message);
    } else {
      setMessage(result.value.message);
      if (stageAction === "export-linux") setTab("builds");
    }
    refresh();
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen();
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, width: chatWidth };
    setDragging(true);
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    setChatWidth(drag.width - (event.clientX - drag.x));
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <section
      ref={stageRef}
      data-game-stage="true"
      aria-label={`${data.manifest.name} game stage`}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Gamepad2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 className="min-w-0 truncate text-sm font-semibold">
          <TruncatedText text={data.manifest.name} />
        </h2>
        <span className="hidden truncate text-xs text-muted-foreground xl:inline">
          {template?.name ?? `Godot ${data.manifest.engine.version}`}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            disabled={!canOperate || building}
            onClick={() => void perform("preview")}
          >
            <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
            {webBuild === undefined ? "Build & play" : "Play"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate || building}
            onClick={() => void perform("rebuild")}
          >
            Rebuild
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate || !runningSomething}
            onClick={() => void perform("stop")}
          >
            <SquareIcon className="size-3.5" aria-hidden="true" />
            Stop
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Run native"
                  disabled={!canOperate || building || nativeRunning}
                  onClick={() => void perform("native")}
                />
              }
            >
              <MonitorPlayIcon className="size-3.5" aria-hidden="true" />
              Run native
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {nativeRunning
                ? "The native game window is already running"
                : "Run the game in its own window"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
                  disabled={phase.kind !== "playing"}
                  onClick={toggleFullscreen}
                />
              }
            >
              {fullscreen ? (
                <MinimizeIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <MaximizeIcon className="size-3.5" aria-hidden="true" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {fullscreen ? "Leave fullscreen" : "Fullscreen"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Export Linux build"
                  disabled={!canOperate || building}
                  onClick={() => void perform("export-linux")}
                />
              }
            >
              <DownloadIcon className="size-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Export a Linux build</TooltipPopup>
          </Tooltip>
        </div>
      </header>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <ToggleGroup
          aria-label="Game workspace"
          className="shrink-0"
          variant="segmented"
          value={[tab]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "play" || next === "assets" || next === "builds") setTab(next);
          }}
        >
          {TABS.map((entry) => (
            <Toggle key={entry.value} value={entry.value} data-game-tab={entry.value}>
              {entry.label}
              {entry.value === "assets" && data.assets.length > 0 ? (
                <span className="text-muted-foreground">{data.assets.length}</span>
              ) : null}
              {entry.value === "builds" && data.builds.length > 0 ? (
                <span className="text-muted-foreground">{data.builds.length}</span>
              ) : null}
            </Toggle>
          ))}
        </ToggleGroup>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {staleChipVisible ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning-surface px-2 py-0.5 text-2xs text-warning-foreground">
              <TriangleAlertIcon className="size-3" aria-hidden="true" />
              Rebuild to see latest changes
            </span>
          ) : null}
          {building ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCwIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <TruncatedText text={buildingMessage} />
              {buildingStartedAt === null ? null : (
                <GameElapsed since={buildingStartedAt} className="shrink-0" />
              )}
            </span>
          ) : showStrip ? (
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-xs",
                failureVisible !== null ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {failureVisible !== null ? (
                <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
              ) : null}
              <TruncatedText text={strip} className="min-w-16 max-w-md" />
              {failureVisible === null ? null : (
                <Button size="xs" variant="ghost" onClick={() => askAgentToFix(failureVisible)}>
                  Ask agent to fix
                </Button>
              )}
              <Button
                size="icon-micro"
                variant="ghost"
                aria-label="Dismiss status"
                onClick={() => {
                  setError(null);
                  setMessage(null);
                  setDismissedOperationAt(operation?.at ?? null);
                }}
              >
                <XIcon className="size-3" aria-hidden="true" />
              </Button>
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={chatCollapsed ? "Show chat" : "Hide chat"}
                  onClick={() => setChatCollapsed(!chatCollapsed)}
                />
              }
            >
              <PanelRightIcon className="size-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{chatCollapsed ? "Show chat" : "Hide chat"}</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {tab === "play" ? (
        <GamePlaySurface
          phase={phase}
          viewport={data.viewport}
          gameName={data.manifest.name}
          previewUrl={data.previewUrl}
          frameKey={frameKey}
          canOperate={canOperate}
          onPlay={() => void perform("preview")}
          onRebuild={() => void perform("rebuild")}
          onStop={() => void perform("stop")}
          onAskAgent={askAgentToFix}
          onOpenTools={() => void navigate({ to: "/settings/general", hash: "game-tools" })}
        />
      ) : null}
      {tab === "assets" ? <GameAssetsPanel threadRef={threadRef} assets={data.assets} /> : null}
      {tab === "builds" ? (
        <GameBuildsPanel
          threadRef={threadRef}
          builds={data.builds}
          webBuildStale={data.webBuildStale}
          canOperate={canOperate}
          onPlay={() => {
            setTab("play");
            void perform("preview");
          }}
          onExportLinux={() => void perform("export-linux")}
        />
      ) : null}
      {chatCollapsed || fullscreen ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat column"
          aria-valuenow={chatWidth}
          tabIndex={0}
          data-dragging={dragging ? "true" : "false"}
          className={cn(
            "absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none select-none outline-none",
            "hover:bg-primary/40 focus-visible:bg-primary/40 data-[dragging=true]:bg-primary/60",
          )}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") setChatWidth(chatWidth + 24);
            else if (event.key === "ArrowRight") setChatWidth(chatWidth - 24);
            else return;
            event.preventDefault();
          }}
        />
      )}
    </section>
  );
}

/** Truncated text keeps its full value in a styled tooltip, not a native title. */
function TruncatedText({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("truncate", className)} />}>
        {text}
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-md">
        {text}
      </TooltipPopup>
    </Tooltip>
  );
}
