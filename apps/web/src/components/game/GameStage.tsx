import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronDownIcon,
  DownloadIcon,
  HistoryIcon,
  MaximizeIcon,
  MessageSquareIcon,
  MinimizeIcon,
  MonitorIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import type { GameAction, ScopedThreadRef } from "@kurambit/contracts";
import { GAME_ENGINES, GAME_TEMPLATES } from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";

import {
  buildPlaysOf,
  gameEnvironment,
  stageAfterGameAction,
  stagePlayTarget,
} from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useGameStageAccess } from "../../hooks/useGameStageAccess";
import { isGameStatusFailure, useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import {
  clampGameChatWidth,
  type GameStageTab,
  useGameWorkspaceStore,
} from "../../gameWorkspaceStore";
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
import { GameBuildsView } from "./GameBuildsView";
import { GameExports } from "./GameExports";
import { useBuildStop } from "./useBuildActions";
import { GameElapsed } from "./GameElapsed";
import { gamePigment } from "./gameLibrary.logic";
import { GameFrame, GameFrameBox, GamePlaySurface } from "./GamePlaySurface";
import { GameRunPanel } from "./GameRunPanel";
import {
  buildFailurePrompt,
  deriveGameStagePhase,
  nextGamePreviewFrame,
  type GamePreviewServe,
} from "./gameStageLogic";

const BUSY_LABELS: Record<GameAction, string> = {
  preview: "Building the web preview",
  rebuild: "Rebuilding the web preview",
  stop: "Stopping",
  "export-linux": "Exporting for Linux",
  "export-windows": "Exporting for Windows",
};

const PLAY_TABS: ReadonlyArray<{ value: GameStageTab; label: string }> = [
  // The stage is the game itself; "Play" is the action, not the tab, so the
  // header does not read as two Play buttons side by side.
  { value: "play", label: "Stage" },
  { value: "run", label: "Run" },
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
  const canAct = useAtomValue(gameEnvironment.action.permissionAtom(threadRef.environmentId));
  // A run's role thread shows the game but never writes beside the run.
  const access = useGameStageAccess(threadRef);
  const canOperate = canAct && access === "writer";
  const action = useAtomCommand(gameEnvironment.action, { reportFailure: false });
  const chatWidth = useGameWorkspaceStore((state) => state.chatWidth);
  const chatCollapsed = useGameWorkspaceStore((state) => state.chatCollapsed);
  const setChatWidth = useGameWorkspaceStore((state) => state.setChatWidth);
  const setChatCollapsed = useGameWorkspaceStore((state) => state.setChatCollapsed);
  const [tab, setTab] = useState<GameStageTab | null>(null);
  // An earlier build the stage plays from a copy instead of the folder's own preview.
  const asked = useAtomValue(stagePlayTarget(threadRef));
  const stopBuild = useBuildStop(threadRef);
  const tabRequest = useGameWorkspaceStore((state) => state.stageTabRequest);
  const [seenTabRequest, setSeenTabRequest] = useState(tabRequest);
  // The latest build another surface asked the Builds tab to open; the view
  // remounts for each one and reads it once.
  const [buildRequest, setBuildRequest] = useState<typeof tabRequest>(null);
  if (tabRequest !== seenTabRequest) {
    setSeenTabRequest(tabRequest);
    if (tabRequest !== null) setTab(tabRequest.tab);
    if (tabRequest?.build !== undefined) setBuildRequest(tabRequest);
  }
  const [buildsSeen, setBuildsSeen] = useState(false);
  const [askedSeen, setAskedSeen] = useState(asked);
  const [askedStatus, setAskedStatus] = useState<typeof query.data>(null);
  // A game being made by its production run opens on the run, not on an
  // empty stage; the creator's own choice of tab always wins.
  const runStatus = useEnvironmentQuery(
    gameEnvironment.runStatus({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const [busy, setBusy] = useState<{ action: GameAction; startedAt: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissedRevision, setDismissedRevision] = useState<number | null>(null);
  // The server keeps the last operation per game for the whole session, so the
  // stage treats an operation as news only when a push changed it after the
  // stage's first read: an older one would greet the user with a build they
  // already know about. Revisions are the server's, so no clock is compared.
  const [seenRevision, setSeenRevision] = useState<number | null>(null);
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
  if (seenRevision === null && data) setSeenRevision(data.operation?.revision ?? 0);
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
  if (!data)
    return query.error !== null && isGameStatusFailure(query.failure) ? (
      <section className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        <span className="flex max-w-prose items-start gap-2">
          <TriangleAlertIcon
            className="mt-0.5 size-4 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <span className="min-w-0 break-words">The game could not be read: {query.error}</span>
        </span>
      </section>
    ) : null;
  // The copy the stage was asked to play shows only while the server says it
  // plays (CONTRACT A3), so a Stop from the palette, another client or an
  // agent takes the banner down. Until the status is read again after the ask,
  // the ask stands.
  if (asked !== askedSeen) {
    setAskedSeen(asked);
    setAskedStatus(data);
  }
  const plays = buildPlaysOf(data);
  const playTarget =
    asked !== null &&
    (plays === null || data === askedStatus || plays.some((play) => play.build === asked.build))
      ? asked
      : null;
  const tabs = PLAY_TABS;
  // A live run brings the creator to the Run view once; its stopping or ending
  // later never moves them off it.
  if (tab === null && runStatus.data?.active === true) setTab("run");
  const activeTab = tab ?? "play";
  // The Builds tab stays mounted once opened, so going to the stage to play a
  // build and coming back keeps what was open there.
  if (activeTab === "builds" && !buildsSeen) setBuildsSeen(true);
  const webBuild = data.builds.find((build) => build.target === "Web");
  const phase = deriveGameStagePhase({
    // The game's own engine tool, as the server resolved it for this project.
    toolchainReady: data.engineTool === null || data.engineTool.status !== "error",
    // A failure becomes the stage's own only when this chat's work failed: a
    // run's or a role's operation is that work's news, not this game's build.
    operation:
      data.operation?.state === "failed" && data.operation.ownerThreadId !== threadRef.threadId
        ? null
        : data.operation,
    hasWebBuild: webBuild !== undefined,
    webBuildStale: data.webBuildStale,
    previewUrl: data.previewUrl,
    busyStartedAt: busy?.startedAt ?? null,
    localError: error,
  });
  const building = busy !== null || operationState === "running";
  // Play only starts a preview when none is running; a started game can always
  // be brought back to Stage.
  // Play of a build that exists only reads, so a run's role thread may play it.
  const webPlay = data.exportTargets.includes("Web");
  const playEnabled =
    webPlay &&
    canAct &&
    (access === "writer" || webBuild !== undefined) &&
    (data.previewUrl !== null || !building);
  const stagingEnabled = canOperate && !building;
  const rebuildEnabled = stagingEnabled && webPlay;
  const buildingStartedAt =
    busy?.startedAt ??
    (operationState === "running" && data.operation !== null
      ? Date.parse(data.operation.at)
      : null);
  const operation = data.operation;
  // Only this thread's own operations land as news here: a production run's
  // captures and checks on the game are its own work, not this chat's.
  const operationVisible =
    operation !== null &&
    operation.ownerThreadId === threadRef.threadId &&
    operation.revision !== dismissedRevision &&
    seenRevision !== null &&
    operation.revision > seenRevision;
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
  const stagePhaseLabel =
    phase.kind === "playing"
      ? data.webBuildStale
        ? "Playing · older than the game"
        : "Playing"
      : phase.kind === "ready"
        ? data.webBuildStale
          ? "Ready · older than the game"
          : "Ready to play"
        : phase.kind === "never-built"
          ? "No build yet"
          : phase.kind === "failed"
            ? "Build failed"
            : phase.kind === "tools-missing"
              ? "Engine not ready"
              : null;
  const runningSomething =
    busy !== null ||
    operationState === "running" ||
    data.processes.length > 0 ||
    data.previewUrl !== null ||
    playTarget !== null ||
    (plays?.length ?? 0) > 0;
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
    // The served build's identity: a new build (or a rebuilt legacy one)
    // remounts the game, while source edits and failed rebuilds leave it
    // running untouched.
    servedArtifactId: webBuild === undefined ? null : `${webBuild.path}#${webBuild.updatedAt}`,
  });
  if (frame !== frameFold) setFrameFold(frame);
  const frameKey = frame.key;
  const askAgentToFix = (failure: string) => onAskAgent(buildFailurePrompt(failure));
  const perform = async (stageAction: GameAction) => {
    if (stageAction === "preview") stageAfterGameAction(threadRef, stageAction);
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
      if (stageAction === "stop") stageAfterGameAction(threadRef, stageAction);
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
  const templateName =
    template?.name ??
    `${GAME_ENGINES[data.manifest.engine.name].name} ${data.manifest.engine.version}`;
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
            setDismissedRevision(operation?.revision ?? null);
          }}
        >
          <XIcon className="size-3" aria-hidden="true" />
        </Button>
      </div>
    ) : staleChipVisible ? (
      <div className="flex items-center gap-2 border-t border-warning/20 bg-warning-surface/50 px-3 py-1.5 text-xs text-warning-foreground">
        <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">This web export is older than the latest changes.</span>
        <Button
          size="xs"
          variant="warning-outline"
          disabled={!rebuildEnabled}
          onClick={() => void perform("rebuild")}
        >
          Rebuild
        </Button>
      </div>
    ) : null;
  const [pigment, pigmentInk] = gamePigment(data.manifest.name);
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
        <div className="flex min-h-[var(--workspace-topbar-height)] items-center gap-2.5 px-2 py-1.5 pl-3">
          <span
            aria-hidden="true"
            className="hidden size-8 shrink-0 items-end justify-end overflow-hidden rounded-lg @[28rem]/stage-header:flex"
            style={{
              background: `radial-gradient(120% 95% at 20% 10%, ${pigment}, ${pigmentInk})`,
            }}
          >
            <span className="-mb-1 me-0.5 font-display text-2xl leading-none text-washi/90">
              {data.manifest.name.trim().charAt(0).toUpperCase()}
            </span>
          </span>
          <div className="flex min-w-0 flex-1 flex-col justify-center">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="min-w-0 truncate text-base font-semibold leading-5 tracking-tight">
                <TruncatedText text={data.manifest.name} />
              </h2>
            </div>
            {building ? (
              <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
                {/* Static: the elapsed timer already shows it is live. */}
                <RefreshCwIcon className="size-3 shrink-0" aria-hidden="true" />
                <TruncatedText text={buildingMessage} />
                {buildingStartedAt === null ? null : (
                  <GameElapsed since={buildingStartedAt} className="shrink-0" />
                )}
              </span>
            ) : stagePhaseLabel !== null ? (
              <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
                {phase.kind === "playing" ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
                ) : null}
                <span className="truncate">{stageSubtitle}</span>
              </span>
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
              if (next === "run" || next === "play" || next === "builds") setTab(next);
            }}
          >
            {tabs.map((entry) => (
              <Toggle key={entry.value} value={entry.value} data-game-tab={entry.value}>
                {entry.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="default"
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
                    aria-label="Rebuild the web export"
                    className="hidden @[46rem]/stage-header:inline-flex"
                    disabled={!rebuildEnabled}
                    onClick={() => void perform("rebuild")}
                  />
                }
              >
                <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Rebuild the web export</TooltipPopup>
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
                <MenuItem disabled={!rebuildEnabled} onClick={() => void perform("rebuild")}>
                  <RefreshCwIcon />
                  Rebuild the web export
                </MenuItem>
                <MenuItem
                  disabled={!canOperate || !runningSomething}
                  onClick={() => void perform("stop")}
                >
                  <SquareIcon />
                  Stop the game
                </MenuItem>
                {data.exportTargets.includes("Windows") ? (
                  <MenuItem
                    disabled={!stagingEnabled}
                    onClick={() => void perform("export-windows")}
                  >
                    <MonitorIcon />
                    Export for Windows
                  </MenuItem>
                ) : null}
                {data.exportTargets.includes("Linux") ? (
                  <MenuItem disabled={!stagingEnabled} onClick={() => void perform("export-linux")}>
                    <DownloadIcon />
                    Export for Linux
                  </MenuItem>
                ) : null}
                <MenuSeparator />
                <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">View</div>
                <MenuRadioGroup
                  value={activeTab}
                  onValueChange={(value) => {
                    if (value === "run" || value === "play" || value === "builds") setTab(value);
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
      {activeTab === "run" ? <GameRunPanel threadRef={threadRef} /> : null}
      {/*
        The stage stays mounted across workspace tabs; hiding it keeps the
        iframe alive and the frame key unchanged, so the game keeps its
        progress. The engine cannot see CSS hiding (an iframe's document stays
        visible with its parent), so GamePlaySurface tells the game over
        postMessage to pause and mute while the tab is elsewhere.
      */}
      {playTarget !== null && activeTab === "play" ? (
        <div className="flex items-center gap-2 border-b border-info/20 bg-info/8 px-3 py-1.5 text-xs text-info-foreground">
          <HistoryIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            Playing {playTarget.label} from a copy. The game folder is untouched.
          </span>
          <Button size="xs" variant="ghost" onClick={() => void stopBuild(playTarget.build)}>
            Back to the current game
          </Button>
        </div>
      ) : null}
      {playTarget !== null ? (
        <div
          aria-hidden={activeTab !== "play"}
          data-game-play-surface="build"
          className={
            activeTab === "play"
              ? "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-stage p-3 [container-type:size]"
              : "hidden"
          }
        >
          <GameFrameBox viewport={data.viewport} gameName={data.manifest.name} playing>
            {playTarget.result._tag === "web" ? (
              <GameFrame
                key={`${playTarget.build}\0${playTarget.result.url}`}
                url={playTarget.result.url}
                title={`${data.manifest.name}, ${playTarget.label}`}
                hidden={hidden || activeTab !== "play"}
              />
            ) : (
              <p className="flex size-full items-center justify-center p-6 text-center text-sm text-washi/90">
                {playTarget.result.message}
              </p>
            )}
          </GameFrameBox>
        </div>
      ) : null}
      <div
        aria-hidden={activeTab !== "play" || playTarget !== null}
        className={
          activeTab === "play" && playTarget === null ? "flex min-h-0 flex-1 flex-col" : "hidden"
        }
      >
        <GamePlaySurface
          phase={phase}
          viewport={data.viewport}
          gameName={data.manifest.name}
          previewUrl={data.previewUrl}
          frameKey={frameKey}
          hidden={hidden || activeTab !== "play" || playTarget !== null}
          canOperate={canOperate}
          operation={
            busy !== null
              ? { name: BUSY_LABELS[busy.action], own: true }
              : operationState === "running" && data.operation !== null
                ? {
                    name: data.operation.name,
                    own: data.operation.ownerThreadId === threadRef.threadId,
                  }
                : null
          }
          onPlay={() => void perform("preview")}
          onRebuild={() => void perform("rebuild")}
          onStop={() => void perform("stop")}
          onAskAgent={askAgentToFix}
          onOpenTools={() => void navigate({ to: "/settings/general", hash: "game-tools" })}
        />
      </div>
      {buildsSeen ? (
        <GameBuildsView
          key={`${threadRef.threadId}\0${buildRequest?.n ?? 0}`}
          threadRef={threadRef}
          compact={compact}
          writer={canOperate}
          turnRunning={turnRunning}
          runActive={runStatus.data?.active === true}
          viewport={data.viewport}
          gameName={data.manifest.name}
          request={buildRequest}
          hidden={hidden || activeTab !== "builds"}
          onShowStage={() => setTab("play")}
          exports={
            <GameExports
              threadRef={threadRef}
              builds={data.builds}
              exportTargets={data.exportTargets}
              webBuildStale={data.webBuildStale}
              sourcesDifferFromPlay={data.sourcesDifferFromPlay}
              canOperate={canOperate}
              operationRunning={building}
              onPlay={() => {
                setTab("play");
                void perform("preview");
              }}
              onExport={(target) =>
                void perform(target === "Windows" ? "export-windows" : "export-linux")
              }
            />
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
