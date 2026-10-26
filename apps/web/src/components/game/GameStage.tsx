import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronDownIcon,
  DownloadIcon,
  Gamepad2Icon,
  MaximizeIcon,
  MessageSquareIcon,
  MinimizeIcon,
  MonitorIcon,
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
import {
  buildFailurePrompt,
  deriveGameStagePhase,
  gameDesignLock,
  nextGamePreviewFrame,
  type GameDesignLock,
  type GamePreviewServe,
} from "./gameStageLogic";

type GameStageTab = "design" | "play" | "assets" | "builds";

const DESIGN_LOCK_LABEL: Record<GameDesignLock, string> = {
  draft: "Approve the design",
  changed: "Design changed — re-approve",
  "revision-pending": "Review requested change",
};

const BUSY_LABELS: Record<GameAction, string> = {
  preview: "Building the web preview",
  rebuild: "Rebuilding the web preview",
  native: "Starting the native game",
  stop: "Stopping",
  "export-linux": "Exporting the Linux build",
  "export-windows": "Exporting the Windows build",
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
  // An unapproved design is what unblocks staging, so the creator starts there.
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
  compact = false,
  hidden = false,
  onShowChat,
}: {
  threadRef: ScopedThreadRef;
  /** The thread's agent turn is running; a settled turn refreshes the stage. */
  turnRunning: boolean;
  onAskAgent: (text: string) => void;
  /** The workbench shows a single pane, so chat is a switch rather than a dock toggle. */
  compact?: boolean;
  /** Another compact pane is showing; the stage stays mounted but is inert. */
  hidden?: boolean;
  /** Opens the compact workbench's chat pane. */
  onShowChat?: (() => void) | undefined;
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
  // The fold of what the play surface runs across status reads; state, so the
  // render below can pin this serve without touching refs.
  const [frameFold, setFrameFold] = useState<{
    readonly key: string;
    readonly serve: GamePreviewServe;
  } | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  // A compact switch unmounts nothing, but focus would die with the hidden
  // pane's button. Move it to the stage when the stage comes back.
  const stageWasHidden = useRef(hidden);
  useEffect(() => {
    const wasHidden = stageWasHidden.current;
    stageWasHidden.current = hidden;
    if (wasHidden && !hidden) stageRef.current?.focus({ preventScroll: true });
  }, [hidden]);
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
  const designLock = gameDesignLock(data.design);
  // A running game stays on Stage while its design is waiting for review; a
  // stopped or never-started game opens on the Design tab that unblocks it. An
  // auto game still starts on its draft, as before, without calling it locked.
  const designFirst =
    (designLock !== null || data.design.state === "draft") && data.previewUrl === null;
  const tabs = designFirst ? DESIGN_FIRST_TABS : PLAY_TABS;
  const activeTab = tab ?? (designFirst ? "design" : "play");
  const webBuild = data.builds.find((build) => build.target === "Web");
  const phase = deriveGameStagePhase({
    toolchainReady: data.toolchain.tools.every((tool) => tool.ready),
    operation: data.operation,
    hasWebBuild: webBuild !== undefined,
    webBuildStale: data.webBuildStale,
    previewUrl: data.previewUrl,
    designLock,
    busyStartedAt: busy?.startedAt ?? null,
    localError: error,
  });
  const building = busy !== null || operationState === "running";
  // Play only starts a preview when none is running; a started game can always
  // be brought back to Stage. Every other staging action is refused by the
  // server until a reviewed design is approved.
  const playEnabled =
    canOperate && (data.previewUrl !== null || (!building && designLock === null));
  const stagingEnabled = canOperate && !building && designLock === null;
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
      ? "Checked"
      : qualification.completion === "complete"
        ? "Playable"
        : qualification.completion === "unknown"
          ? "Completion unknown"
          : "Incomplete";
  const certification = qualification.stages
    .filter(
      (stage) => stage.stage !== "design" && stage.stage !== "export" && stage.stage !== "playtest",
    )
    .map((stage) => `${stage.stage}=${stage.status}`)
    .join(", ");
  const qualificationDetail =
    qualification.completion !== "complete"
      ? `No current playable build for the current sources. ${qualificationIssues.join(", ")}.`
      : qualification.state === "qualified"
        ? "Playable, and the optional test and state checks passed for the current sources."
        : `Playable: the web export and its playtest are current. Optional checks: ${certification}.`;
  const stagePhaseLabel =
    phase.kind === "playing"
      ? qualification.completion === "complete"
        ? "Playing"
        : `Playing · ${qualificationLabel}`
      : phase.kind === "ready"
        ? qualification.completion === "complete"
          ? "Ready to play"
          : qualificationLabel
        : phase.kind === "design-locked"
          ? DESIGN_LOCK_LABEL[phase.reason]
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
  // Fold the served identity across status reads: remount the game only when
  // its preview session or served artifact really changed — a source edit and a
  // failed rebuild leave both running untouched. Absorbed reads return the
  // same object, so this only adjusts state when the fold advanced.
  const frame = nextGamePreviewFrame(frameFold, {
    previewUrl: data.previewUrl,
    // The selected build's identity, not the last export's descriptor: a
    // candidate export is evidence for a round and must not remount the
    // incumbent the creator is playing.
    servedArtifactId: data.selectedBuildId ?? data.qualification.servedArtifactId,
  });
  if (frame !== frameFold) setFrameFold(frame);
  const frameKey = frame.key;
  const askAgentToFix = (failure: string) => onAskAgent(buildFailurePrompt(failure));
  const perform = async (stageAction: GameAction) => {
    if (stageAction === "preview" && data.previewUrl !== null) {
      setTab("play");
      return;
    }
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
      if (stageAction === "export-linux" || stageAction === "export-windows") setTab("builds");
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
  const templateName = template?.name ?? `Godot ${data.manifest.engine.version}`;
  const stageSubtitle =
    stagePhaseLabel === null
      ? templateName
      : template === undefined
        ? stagePhaseLabel
        : `${templateName} · ${stagePhaseLabel}`;
  const activeTabLabel = tabs.find((entry) => entry.value === activeTab)?.label ?? "Stage";
  const statusBanner =
    failureVisible !== null ? (
      <div className="flex items-center gap-2 border-t border-destructive/20 bg-destructive/8 px-3 py-1.5 text-xs text-destructive-foreground">
        <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <span className="line-clamp-2 min-w-0 flex-1 break-words">
          {failureVisible.split("\n")[0] ?? failureVisible}
        </span>
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0"
          onClick={() => askAgentToFix(failureVisible)}
        >
          Ask agent to fix
        </Button>
      </div>
    ) : noticeVisible !== null ? (
      <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">
          <TruncatedText text={noticeVisible} className="block" />
        </span>
        <Button
          size="icon-micro"
          variant="ghost"
          className="shrink-0"
          aria-label="Dismiss status"
          onClick={() => {
            setError(null);
            setMessage(null);
            setDismissedOperationAt(operation?.at ?? null);
          }}
        >
          <XIcon className="size-3" aria-hidden="true" />
        </Button>
      </div>
    ) : designLock !== null && phase.kind === "playing" ? (
      <div className="border-t border-warning/20 bg-warning-surface/50 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setTab("design")}
          className="flex cursor-pointer items-center gap-1.5 text-xs text-warning-foreground underline-offset-2 hover:underline"
        >
          <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {DESIGN_LOCK_LABEL[designLock]}
        </button>
      </div>
    ) : staleChipVisible ? (
      <div className="flex items-center gap-2 border-t border-warning/20 bg-warning-surface/50 px-3 py-1.5 text-xs text-warning-foreground">
        <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">This web build is older than the latest changes.</span>
        <Button
          size="xs"
          variant="warning-outline"
          disabled={!stagingEnabled}
          onClick={() => void perform("rebuild")}
        >
          Rebuild
        </Button>
      </div>
    ) : null;
  return (
    <section
      ref={stageRef}
      data-game-stage="true"
      aria-label={`${data.manifest.name} game stage`}
      aria-hidden={hidden}
      inert={hidden}
      tabIndex={-1}
      className={cn(
        "relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background outline-none",
        hidden ? "hidden" : "flex",
      )}
    >
      <header className="@container/stage-header flex shrink-0 flex-col border-b border-border bg-background">
        <div className="flex min-h-12 items-center gap-2 px-2 py-1.5 pl-3">
          <Gamepad2Icon
            className="hidden size-4 shrink-0 text-muted-foreground @[28rem]/stage-header:block"
            aria-hidden="true"
          />
          <div className="flex min-w-0 flex-1 flex-col justify-center">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="min-w-0 truncate text-sm font-semibold leading-5 tracking-tight">
                <TruncatedText text={data.manifest.name} />
              </h2>
            </div>
            {building ? (
              <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
                <RefreshCwIcon
                  className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <TruncatedText text={buildingMessage} />
                {buildingStartedAt === null ? null : (
                  <GameElapsed since={buildingStartedAt} className="shrink-0" />
                )}
              </span>
            ) : stagePhaseLabel !== null ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground" />
                  }
                >
                  {phase.kind === "playing" && qualification.state === "qualified" ? (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-success"
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="truncate">{stageSubtitle}</span>
                </TooltipTrigger>
                <TooltipPopup side="bottom">{qualificationDetail}</TooltipPopup>
              </Tooltip>
            ) : (
              <span className="truncate text-xs leading-4 text-muted-foreground">
                {templateName}
              </span>
            )}
          </div>
          <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Game view: ${activeTabLabel}`}
                  className="inline-flex @[48rem]/stage-header:hidden"
                />
              }
            >
              {activeTabLabel}
              <ChevronDownIcon className="size-3.5" aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="start">
              {tabs.map((entry) => (
                <MenuItem key={entry.value} onClick={() => setTab(entry.value)}>
                  {entry.label}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
          <ToggleGroup
            aria-label="Game workspace"
            className="hidden shrink-0 @[48rem]/stage-header:flex"
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
          <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant={designFirst ? "secondary" : "default"}
              aria-label={webBuild === undefined ? "Build and play" : "Play game"}
              disabled={!playEnabled}
              onClick={() => void perform("preview")}
            >
              <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
              <span className="hidden @[40rem]/stage-header:inline">
                {webBuild === undefined ? "Build & play" : "Play"}
              </span>
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Rebuild the web build"
                    className="hidden @[46rem]/stage-header:inline-flex"
                    disabled={!stagingEnabled}
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
                    disabled={!stagingEnabled || nativeRunning}
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
                <MenuItem disabled={!stagingEnabled} onClick={() => void perform("rebuild")}>
                  <RefreshCwIcon />
                  Rebuild the web build
                </MenuItem>
                <MenuItem
                  disabled={!stagingEnabled || nativeRunning}
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
                <MenuItem disabled={!stagingEnabled} onClick={() => void perform("export-windows")}>
                  <MonitorIcon />
                  Export Windows build
                </MenuItem>
                <MenuItem disabled={!stagingEnabled} onClick={() => void perform("export-linux")}>
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
                    size={compact ? "sm" : "icon-sm"}
                    variant="ghost"
                    aria-label={compact || chatCollapsed ? "Show chat" : "Hide chat"}
                    onClick={() => {
                      if (compact) onShowChat?.();
                      else setChatCollapsed(!chatCollapsed);
                    }}
                  />
                }
              >
                {compact ? (
                  <MessageSquareIcon className="size-3.5" aria-hidden="true" />
                ) : (
                  <PanelRightIcon className="size-3.5" aria-hidden="true" />
                )}
                {compact ? <span className="hidden @[34rem]/stage-header:inline">Chat</span> : null}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {compact || chatCollapsed ? "Show chat" : "Hide chat"}
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>
        {statusBanner}
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
        The stage stays mounted across workspace tabs; hiding it keeps the
        iframe alive and the frame key unchanged, so the game keeps its
        progress. The engine cannot see CSS hiding (an iframe's document stays
        visible with its parent), so GamePlaySurface tells the game over
        postMessage to pause and mute while the tab is elsewhere.
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
          hidden={hidden || activeTab !== "play"}
          canOperate={canOperate}
          onPlay={() => void perform("preview")}
          onRebuild={() => void perform("rebuild")}
          onStop={() => void perform("stop")}
          onAskAgent={askAgentToFix}
          onOpenTools={() => void navigate({ to: "/settings/general", hash: "game-tools" })}
          onOpenDesign={() => setTab("design")}
        />
      </div>
      {activeTab === "assets" ? (
        <GameAssetsPanel threadRef={threadRef} assets={data.assets} />
      ) : null}
      {activeTab === "builds" ? (
        <GameBuildsPanel
          key={`${threadRef.threadId}:${data.selectedBuildId ?? "legacy"}`}
          threadRef={threadRef}
          builds={data.builds}
          webBuildStale={data.webBuildStale}
          lastPlaytest={data.lastPlaytest}
          sourcesDifferFromPlay={data.sourcesDifferFromPlay}
          selectedBuildId={data.selectedBuildId}
          canOperate={canOperate}
          operationRunning={building}
          stagingLocked={designLock !== null}
          previewAvailable={data.previewUrl !== null}
          onOpenDesign={() => setTab("design")}
          onPlay={() => {
            setTab("play");
            void perform("preview");
          }}
          onExport={(target) =>
            void perform(target === "Windows" ? "export-windows" : "export-linux")
          }
        />
      ) : null}
      {compact || hidden || chatCollapsed || fullscreen ? null : (
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
