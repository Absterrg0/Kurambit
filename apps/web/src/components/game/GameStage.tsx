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
  MoreHorizontalIcon,
  PanelRightIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import type { GameAction, ScopedThreadRef } from "@t3tools/contracts";
import { GAME_TEMPLATES } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { clampGameChatWidth, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameAssetsPanel } from "./GameAssetsPanel";
import { GameBuildsPanel } from "./GameBuildsPanel";
import { GameDesignPanel } from "./GameDesignPanel";
import { GameElapsed } from "./GameElapsed";
import { GamePlaySurface } from "./GamePlaySurface";
import { buildFailurePrompt, deriveGameStagePhase, gamePreviewFrameKey } from "./gameStageLogic";

type GameStageTab = "design" | "play" | "assets" | "builds";

const BUSY_LABELS: Record<GameAction, string> = {
  preview: "Building the web preview",
  rebuild: "Rebuilding the web preview",
  native: "Starting the native game",
  stop: "Stopping",
  "export-linux": "Exporting the Linux build",
  verify: "Verifying game tools",
};

const PLAY_TABS: ReadonlyArray<{ value: GameStageTab; label: string }> = [
  // The stage is the game itself; "Play" is the action, not the tab, so the
  // header does not read as two Play buttons side by side.
  { value: "play", label: "Stage" },
  { value: "design", label: "Design" },
  { value: "assets", label: "Assets" },
  { value: "builds", label: "Builds" },
];
const DESIGN_FIRST_TABS: ReadonlyArray<{ value: GameStageTab; label: string }> = [
  // While the design is a draft it is the only thing the agent may work on,
  // so it is the tab the creator starts on.
  { value: "design", label: "Design" },
  { value: "play", label: "Stage" },
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
  const query = useIsGameThreadStatus(threadRef);
  const canOperate = useAtomValue(gameEnvironment.action.permissionAtom(threadRef.environmentId));
  const action = useAtomCommand(gameEnvironment.action, { reportFailure: false });
  const chatWidth = useGameWorkspaceStore((state) => state.chatWidth);
  const chatCollapsed = useGameWorkspaceStore((state) => state.chatCollapsed);
  const setChatWidth = useGameWorkspaceStore((state) => state.setChatWidth);
  const setChatCollapsed = useGameWorkspaceStore((state) => state.setChatCollapsed);
  const [tab, setTab] = useState<GameStageTab | null>(null);
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
  // Operation events invalidate the status query, so this is only a fallback
  // for a missed push while something is running. A whole-project status read
  // must never be a two-second loop.
  useEffect(() => {
    if (operationState !== "running") return;
    const interval = window.setInterval(refresh, 10_000);
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
  const designDraft = data.design.state === "draft";
  const tabs = designDraft ? DESIGN_FIRST_TABS : PLAY_TABS;
  const activeTab = tab ?? (designDraft ? "design" : "play");
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
    (message ?? (operation !== null && operationVisible ? operation.message : "")).trim() || null;
  // One status line, and a failure outranks the staleness it just caused.
  const staleChipVisible =
    failureVisible === null &&
    (phase.kind === "playing" || phase.kind === "ready" ? phase.stale : false);
  const qualification = data.qualification;
  const qualificationIssues = qualification.stages
    .filter((stage) => stage.status !== "passed")
    .map((stage) => `${stage.stage}: ${stage.status}`);
  const qualificationLabel =
    qualification.state === "qualified"
      ? "Qualified"
      : qualification.state === "unknown"
        ? "Qualification unknown"
        : "Unqualified";
  const qualificationDetail =
    qualification.state === "qualified"
      ? "Check, test, web export, playtest and state scenarios passed for the current sources."
      : `${qualificationLabel} for the current sources. ${qualificationIssues.join(", ")}. Visual acceptance is not implemented yet.`;
  const stagePhaseLabel =
    phase.kind === "playing"
      ? qualification.state === "qualified"
        ? "Playing"
        : `Playing · ${qualificationLabel}`
      : phase.kind === "ready"
        ? qualification.state === "qualified"
          ? "Ready to play"
          : qualificationLabel
        : phase.kind === "never-built"
          ? "No build yet"
          : phase.kind === "failed"
            ? "Build failed"
            : phase.kind === "tools-missing"
              ? "Game tools missing"
              : null;
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
  // Reload the iframe only when the served preview or the export it came from
  // changes; a tab switch must not restart the game.
  const frameKey = gamePreviewFrameKey({
    previewUrl: data.previewUrl,
    buildId: data.qualification.buildId,
    buildUpdatedAt: webBuild?.updatedAt ?? null,
  });
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
  const workspaceWidth = () => stageRef.current?.parentElement?.clientWidth ?? window.innerWidth;
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    setChatWidth(clampGameChatWidth(drag.width - (event.clientX - drag.x), workspaceWidth()));
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
      <header className="@container/stage-header flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 pl-3">
        <Gamepad2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 className="min-w-0 max-w-56 truncate text-sm font-semibold">
          <TruncatedText text={data.manifest.name} />
        </h2>
        <span className="hidden shrink-0 text-xs text-muted-foreground @[44rem]/stage-header:inline">
          {template?.name ?? `Godot ${data.manifest.engine.version}`}
        </span>
        <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />
        <ToggleGroup
          aria-label="Game workspace"
          className="hidden shrink-0 @[32rem]/stage-header:flex"
          variant="segmented"
          value={[activeTab]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "design" || next === "play" || next === "assets" || next === "builds")
              setTab(next);
          }}
        >
          {tabs.map((entry) => (
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
        <div
          data-game-stage-status
          className="flex min-w-0 flex-1 items-center justify-center overflow-hidden px-1"
        >
          {building ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCwIcon
                className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              <TruncatedText text={buildingMessage} className="max-w-64" />
              {buildingStartedAt === null ? null : (
                <GameElapsed since={buildingStartedAt} className="shrink-0" />
              )}
            </span>
          ) : failureVisible !== null ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-destructive-foreground">
              <TriangleAlertIcon
                className="size-3.5 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <TruncatedText
                text={failureVisible.split("\n")[0] ?? failureVisible}
                className="max-w-64"
              />
              <Button size="xs" variant="ghost" onClick={() => askAgentToFix(failureVisible)}>
                Ask agent to fix
              </Button>
            </span>
          ) : noticeVisible !== null ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <TruncatedText text={noticeVisible} className="max-w-64" />
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
          ) : staleChipVisible ? (
            <button
              type="button"
              disabled={!canOperate || building}
              onClick={() => void perform("rebuild")}
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-warning/40 bg-warning-surface px-2 py-0.5 text-2xs text-warning-foreground transition-colors hover:bg-warning/20 disabled:cursor-default"
            >
              <TriangleAlertIcon className="size-3" aria-hidden="true" />
              Rebuild to see latest changes
            </button>
          ) : (
            <span className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground @[42rem]/stage-header:flex">
              {stagePhaseLabel === null ? null : (
                <>
                  {phase.kind === "playing" && qualification.state === "qualified" ? (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-success"
                      aria-hidden="true"
                    />
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger render={<span className="truncate" />}>
                      {stagePhaseLabel}
                    </TooltipTrigger>
                    <TooltipPopup side="bottom">{qualificationDetail}</TooltipPopup>
                  </Tooltip>
                </>
              )}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant={designDraft ? "secondary" : "default"}
            disabled={!canOperate || building}
            onClick={() => void perform("preview")}
          >
            <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
            {webBuild === undefined ? "Build & play" : "Play"}
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Rebuild the web build"
                  className="hidden @[46rem]/stage-header:inline-flex"
                  disabled={!canOperate || building}
                  onClick={() => void perform("rebuild")}
                />
              }
            >
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Rebuild the web build</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Stop the game"
                  className="hidden @[40rem]/stage-header:inline-flex"
                  disabled={!canOperate || !runningSomething}
                  onClick={() => void perform("stop")}
                />
              }
            >
              <SquareIcon className="size-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Stop the game and its preview</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Run native"
                  className="hidden @[54rem]/stage-header:inline-flex"
                  disabled={!canOperate || building || nativeRunning}
                  onClick={() => void perform("native")}
                />
              }
            >
              <MonitorPlayIcon className="size-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {nativeRunning
                ? "The native game window is already running"
                : "Run the game in its own window"}
            </TooltipPopup>
          </Tooltip>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="More game actions"
                  data-game-stage-more=""
                />
              }
            >
              <MoreHorizontalIcon className="size-4" aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={!canOperate || building} onClick={() => void perform("rebuild")}>
                <RefreshCwIcon />
                Rebuild the web build
              </MenuItem>
              <MenuItem
                disabled={!canOperate || building || nativeRunning}
                onClick={() => void perform("native")}
              >
                <MonitorPlayIcon />
                {nativeRunning ? "Game window is running" : "Run native"}
              </MenuItem>
              <MenuItem
                disabled={!canOperate || !runningSomething}
                onClick={() => void perform("stop")}
              >
                <SquareIcon />
                Stop the game
              </MenuItem>
              <MenuItem
                disabled={!canOperate || building}
                onClick={() => void perform("export-linux")}
              >
                <DownloadIcon />
                Export Linux build
              </MenuItem>
              <MenuSeparator />
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">View</div>
              <MenuRadioGroup
                value={activeTab}
                onValueChange={(value) => {
                  if (
                    value === "design" ||
                    value === "play" ||
                    value === "assets" ||
                    value === "builds"
                  )
                    setTab(value);
                }}
              >
                {tabs.map((entry) => (
                  <MenuRadioItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuItem disabled={phase.kind !== "playing"} onClick={toggleFullscreen}>
                {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
                {fullscreen ? "Leave fullscreen" : "Fullscreen"}
              </MenuItem>
              <MenuItem
                onClick={() => void navigate({ to: "/settings/general", hash: "game-tools" })}
              >
                <WrenchIcon />
                Game tools settings
              </MenuItem>
            </MenuPopup>
          </Menu>
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
      </header>
      {activeTab === "design" ? (
        <GameDesignPanel
          threadRef={threadRef}
          status={data}
          turnRunning={turnRunning}
          canOperate={canOperate}
          onApproved={() => {
            setTab(null);
            refresh();
          }}
          onRefresh={refresh}
        />
      ) : null}
      {/*
        The stage stays mounted across workspace tabs. Unmounting it recreated
        the iframe and killed the running Godot session; hiding it instead makes
        the browser report the document as hidden, which is what the engine's
        web shell uses to pause and mute. It is reset only by Stop, a new build
        (frameKey), or the preview going away.
      */}
      <div
        aria-hidden={activeTab !== "play"}
        className={activeTab === "play" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
      >
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
      </div>
      {activeTab === "assets" ? (
        <GameAssetsPanel threadRef={threadRef} assets={data.assets} />
      ) : null}
      {activeTab === "builds" ? (
        <GameBuildsPanel
          threadRef={threadRef}
          builds={data.builds}
          webBuildStale={data.webBuildStale}
          lastPlaytest={data.lastPlaytest}
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
            if (event.key === "ArrowLeft")
              setChatWidth(clampGameChatWidth(chatWidth + 24, workspaceWidth()));
            else if (event.key === "ArrowRight")
              setChatWidth(clampGameChatWidth(chatWidth - 24, workspaceWidth()));
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
