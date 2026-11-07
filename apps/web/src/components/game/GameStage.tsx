import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  DownloadIcon,
  HistoryIcon,
  MaximizeIcon,
  MessageSquareIcon,
  MinimizeIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import type {
  GameAction,
  GameBuild,
  GameBuildRef,
  GameBuildsResult,
  ScopedThreadRef,
} from "@kurambit/contracts";
import { GAME_ENGINES, GAME_TEMPLATES } from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";

import {
  buildPlaysOf,
  gameEnvironment,
  liveSignal,
  projectTurnRunning,
  setStagePlayTarget,
  stageAfterGameAction,
  stagePlayTarget,
  turnBuild,
} from "../../state/game";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuerySelector } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useGameStageAccess } from "../../hooks/useGameStageAccess";
import { useStableCallback } from "../../hooks/useStableCallback";
import { isGameStatusFailure, useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import {
  clampGameChatWidth,
  type GameStageRequest,
  useGameWorkspaceStore,
} from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameBuildCompare } from "./GameBuildCompare";
import { GameBuildTimeline, type GameTimelineRequest } from "./GameBuildTimeline";
import { GameExports } from "./GameExports";
import { buildName } from "./gameBuilds.logic";
import { useBuildPlay, useBuildStop, useTurnUndo } from "./useBuildActions";
import { GameElapsed } from "./GameElapsed";
import { gamePigment } from "./gameLibrary.logic";
import { GameFrame, GameFrameBox, GamePlaySurface, type StudioMessage } from "./GamePlaySurface";
import {
  buildFailurePrompt,
  deriveGameStagePhase,
  liveErrorPrompt,
  LIVE_PLAY_HASH,
  liveServe,
  liveToShow,
  playHeldFrame,
  reloadFrame,
  remountOrHold,
  type GameFrameFold,
  type LiveShown,
} from "./gameStageLogic";

const BUSY_LABELS: Record<GameAction, string> = {
  preview: "Building the web preview",
  rebuild: "Rebuilding the web preview",
  stop: "Stopping",
  "export-linux": "Exporting for Linux",
  "export-windows": "Exporting for Windows",
};

// The turn whose build the folder holds, for the held build's chip.
const folderBuildTurn = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result)) return null;
  const source = result.value.builds.find((build) => build.id === result.value.current)?.source;
  return source?._tag === "turn" ? source.turn : null;
};

/** The folder's own game frame, not a build copy's. */
const isFolderGameFrame = (target: EventTarget) =>
  target instanceof HTMLIFrameElement && target.closest('[data-game-play-surface="true"]') !== null;

/** "Changed web/enemies/imp.js" → "imp.js". */
const changedFile = (message: string) =>
  message
    .replace(/^Changed\s+/, "")
    .split(/[/\\]/)
    .at(-1) ?? message;

const clockTime = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

/**
 * The game workspace for a game thread: the game owns the centre of the
 * window, its builds sit under it, and chat is docked to its right. ChatView
 * mounts this once the thread's game status resolves, which is also what makes
 * it a game thread. How the game shows depends on its engine
 * (`GAME_ENGINES[engine].stage`): its folder served live, a Web export, or its
 * own window.
 */
export function GameStage(props: GameStageProps) {
  // One stage per thread: a compare, a pick, a held reload or an error of one
  // game never carries into another (ChatView keeps its children mounted).
  return (
    <ThreadGameStage
      key={`${props.threadRef.environmentId}\0${props.threadRef.threadId}`}
      {...props}
    />
  );
}

interface GameStageProps {
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
}

function ThreadGameStage({
  threadRef,
  turnRunning,
  onAskAgent,
  compact = false,
  hidden = false,
  onShowChat,
}: GameStageProps) {
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
  // An earlier build the stage plays from a copy instead of the folder's own game.
  const asked = useAtomValue(stagePlayTarget(threadRef));
  const stopBuild = useBuildStop(threadRef);
  const plays = useBuildPlay(threadRef);
  const turnUndo = useTurnUndo(threadRef, null);
  const live = useAtomValue(liveSignal(threadRef));
  // Which live change the frame shows (A6): while this chat's turn runs, at
  // most one per window, latest wins; at once otherwise and at the turn's end.
  const [liveShown, setLiveShown] = useState<LiveShown | null>(null);
  const [liveWokeAt, setLiveWokeAt] = useState(0);
  const liveLatest = { revision: live.revision, at: live.at === "" ? 0 : Date.parse(live.at) };
  const liveDecision = liveToShow({
    latest: liveLatest,
    shown: liveShown,
    turnRunning,
    now: Math.max(liveWokeAt, liveLatest.at),
  });
  if (liveDecision.show !== liveShown) setLiveShown(liveDecision.show);
  const liveWakeAt = liveDecision.wakeAt;
  // One timeout for the change that waits; none while nothing does.
  useEffect(() => {
    if (liveWakeAt === null) return;
    const timeout = window.setTimeout(
      () => setLiveWokeAt(Date.now()),
      Math.max(0, liveWakeAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [liveWakeAt]);
  const stageRequest = useGameWorkspaceStore((state) => state.stageRequest);
  // A request made before this stage mounted was for another one.
  const [mountRequestN] = useState(stageRequest?.n ?? 0);
  const [timelineRequest, setTimelineRequest] = useState<GameTimelineRequest | null>(null);
  const [compare, setCompare] = useState<readonly [GameBuildRef, GameBuildRef] | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // A focus request, for the frame on screen when it came: each frame acts on a new one only.
  const [focusRequest, setFocusRequest] = useState<{
    readonly n: number;
    readonly frame: "folder" | "copy";
  } | null>(null);
  // The build the person last asked to play, for its refusal.
  const [playRef, setPlayRef] = useState<GameBuildRef | null>(null);
  const [askedSeen, setAskedSeen] = useState(asked);
  const [askedStatus, setAskedStatus] = useState<typeof query.data>(null);
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
  // The fold of what the play surface runs across reads; state, so the render
  // below can pin this serve without touching refs.
  const [frameFold, setFrameFold] = useState<GameFrameFold | null>(null);
  // The person is in the game: its frame is the document's focused element.
  const [gameFocused, setGameFocused] = useState(false);
  // The live game's first page error, for the frame that threw it.
  const [studioError, setStudioError] = useState<{ key: string; text: string } | null>(null);
  // A shown live game opens itself while the server says nobody asked for it
  // since it started (A4); once someone stopped it, Play is the person's.
  const [liveOpenAsked, setLiveOpenAsked] = useState(false);
  // The action in flight or failed here, so a live game's card names it.
  const [errorAction, setErrorAction] = useState<GameAction | null>(null);
  // The quiet shell: streamed tokens do not re-render the stage.
  const quietShell = useQuietThreadShell(threadRef);
  const latestRun = quietShell?.latestRun ?? null;
  // Any chat of this game mid-turn may be mid-edit in the live folder.
  const gameTurnRunning = useAtomValue(
    projectTurnRunning(
      quietShell === null
        ? null
        : { environmentId: threadRef.environmentId, projectId: quietShell.projectId },
    ),
  );
  const turnStartedAt = latestRun?.startedAt ?? latestRun?.requestedAt ?? null;
  // Whether this stage watched the chat's turn end, and that turn's build is listed.
  const [seenTurnRunning, setSeenTurnRunning] = useState(turnRunning);
  const [sawTurnEnd, setSawTurnEnd] = useState(false);
  if (turnRunning !== seenTurnRunning) {
    setSeenTurnRunning(turnRunning);
    setSawTurnEnd(!turnRunning);
  }
  const endedTurnBuilt =
    useAtomValue(
      turnBuild(sawTurnEnd && latestRun !== null ? threadRef : null, latestRun?.runId ?? null),
    ) !== null;
  // Read only while an export engine's build is held: the Builds list names its turn.
  const heldTurn = useEnvironmentQuerySelector(
    frameFold?.held == null || frameFold.serve.servedArtifactId?.startsWith("live:") === true
      ? null
      : gameEnvironment.builds({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
    folderBuildTurn,
  );
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
  const liveStaged = data != null && GAME_ENGINES[data.manifest.engine.name].stage === "live";
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

  const perform = async (stageAction: GameAction) => {
    if (stageAction === "preview") stageAfterGameAction(threadRef, stageAction);
    if (stageAction === "preview" && data?.previewUrl != null) {
      setCompare(null);
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
    setErrorAction(stageAction);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
    } else if (!result.value.success) {
      setError(result.value.message);
    } else {
      // A live open needs no word: the game appears and the subtitle says Live.
      if (!(stageAction === "preview" && liveStaged)) setMessage(result.value.message);
      if (stageAction === "stop") stageAfterGameAction(threadRef, stageAction);
    }
    refresh();
  };
  const backToLive = () => {
    setCompare(null);
    if (asked !== null) void stopBuild(asked.build);
  };
  // An earlier build on the Stage, from a copy: the copy's frame shows it.
  const playBuild = async (build: GameBuild | GameBuildRef) => {
    const ref: GameBuildRef = "id" in build ? { _tag: "build", build: build.id } : build;
    if (ref._tag !== "build") return;
    setCompare(null);
    setPlayRef(ref);
    const result = await plays.send(ref);
    if (result === null) return;
    if (result._tag === "window") {
      setMessage(result.message);
      return;
    }
    setStagePlayTarget(threadRef, {
      build: ref.build,
      label: "id" in build ? buildName(build) : "an earlier build",
      result,
    });
  };
  const handleRequest = useStableCallback((request: GameStageRequest, n: number) => {
    switch (request.kind) {
      case "live":
        backToLive();
        return;
      case "play":
      case "detail":
      case "step":
        setCompare(null);
        setTimelineRequest({ request, n });
        return;
      case "compare":
        if (request.pair === undefined) setTimelineRequest({ request, n });
        else setCompare(request.pair);
        return;
      case "focus":
        setFocusRequest({ n, frame: asked !== null ? "copy" : "folder" });
        return;
      case "undo":
      case "redo": {
        const turn = turnUndo.action;
        if (
          turn?.kind === request.kind &&
          turn.blocked === null &&
          turnUndo.canRestore &&
          turnUndo.writer &&
          !turnUndo.pending
        )
          void turnUndo.send();
        return;
      }
      case "export":
        setExportOpen(true);
        return;
    }
  });
  const requestN = stageRequest?.n ?? 0;
  const latestRequest = stageRequest?.request ?? null;
  useEffect(() => {
    if (latestRequest !== null && requestN !== mountRequestN)
      handleRequest(latestRequest, requestN);
  }, [requestN, latestRequest, mountRequestN, handleRequest]);
  const openLive = useStableCallback(() => void perform("preview"));
  useEffect(() => {
    if (liveOpenAsked) openLive();
  }, [liveOpenAsked, openLive]);
  const onStudioMessage = useStableCallback((studio: StudioMessage) => {
    const key = frameFold?.key ?? "";
    setStudioError(studio.type === "studio-error" ? { key, text: studio.message } : null);
  });

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
  const engine = GAME_ENGINES[data.manifest.engine.name];
  const stageKind = engine.stage;
  // The copy the stage was asked to play shows only while the server says it
  // plays (CONTRACT A3), so a Stop from the palette, another client or an
  // agent takes the banner down. Until the status is read again after the ask,
  // the ask stands.
  if (asked !== askedSeen) {
    setAskedSeen(asked);
    setAskedStatus(data);
  }
  const buildPlays = buildPlaysOf(data);
  const playTarget =
    asked !== null &&
    (buildPlays === null ||
      data === askedStatus ||
      buildPlays.some((play) => play.build === asked.build))
      ? asked
      : null;
  const webBuild = data.builds.find((build) => build.target === "Web");
  const turnEndedAt = latestRun?.completedAt == null ? null : Date.parse(latestRun.completedAt);
  const operationSinceTurnEnd =
    data.operation !== null && turnEndedAt !== null && Date.parse(data.operation.at) >= turnEndedAt;
  const phase = deriveGameStagePhase({
    stage: stageKind,
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
    busyAction: busy?.action ?? null,
    localError: error,
    errorAction,
    liveServe: data.live,
    turnLoop: engine.turnLoop,
    turnRunning,
    turnStartedAt: turnStartedAt === null ? null : Date.parse(turnStartedAt),
    turnBuildPending: sawTurnEnd && endedTurnBuilt && !operationSinceTurnEnd,
  });
  // An ask is answered once the server serves it; a later loss of the serve
  // (a server restart) asks again (design §2.2).
  if (liveOpenAsked && data.live !== "off") setLiveOpenAsked(false);
  if (
    stageKind === "live" &&
    data.live === "off" &&
    !liveOpenAsked &&
    !hidden &&
    canAct &&
    busy === null &&
    error === null
  )
    setLiveOpenAsked(true);
  // The turn's own build is coming: a Build & play now would race it and be refused.
  const awaitingTurnBuild = phase.kind === "first-build";
  const building = busy !== null || operationState === "running";
  // Play of a build that exists only reads, so a run's role thread may play it.
  const webPlay = data.exportTargets.includes("Web");
  const playEnabled =
    !awaitingTurnBuild &&
    webPlay &&
    canAct &&
    (access === "writer" || webBuild !== undefined) &&
    (data.previewUrl !== null || !building);
  const stagingEnabled = canOperate && !building;
  const rebuildEnabled = stagingEnabled && webPlay && !awaitingTurnBuild;
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
  // The folder's frame is not on screen: a copy, a compare, or another pane.
  const frameHidden = hidden || playTarget !== null || compare !== null;
  // Fold the served identity across reads (D2): a live change or a replaced
  // export remounts the game, unless the person is in it (the chip asks) or
  // it is not on screen (it loads when shown). Absorbed reads return the same
  // object, so this only adjusts state when the fold advanced.
  const frame = remountOrHold(
    frameFold,
    stageKind === "live"
      ? liveServe(data.previewUrl, liveDecision.show.revision)
      : {
          previewUrl: data.previewUrl,
          servedArtifactId:
            webBuild === undefined ? null : `${webBuild.path}#${webBuild.updatedAt}`,
        },
    // A frame hidden by another view or pane may keep focus without a blur.
    { focused: gameFocused && !frameHidden, hidden: frameHidden },
  );
  if (frame !== frameFold) setFrameFold(frame);
  const frameKey = frame.key;
  // A reload clears what the old page threw; a later error sets it again.
  const liveError = studioError !== null && studioError.key === frameKey ? studioError.text : null;
  const failureVisible =
    error ??
    (operation !== null && operationVisible && operation.state === "failed"
      ? operation.message
      : null) ??
    (liveError !== null && !turnRunning && !gameTurnRunning ? liveError : null);
  const failurePrompt =
    failureVisible !== null && failureVisible === liveError
      ? liveErrorPrompt(failureVisible)
      : buildFailurePrompt(failureVisible ?? "");
  const playFailure = playRef === null ? null : plays.error(playRef);
  const noticeVisible =
    (
      message ??
      playFailure ??
      (operation !== null && operationVisible ? operation.message : "")
    ).trim() || null;
  const staleChipVisible =
    failureVisible === null &&
    (phase.kind === "playing" || phase.kind === "ready" ? phase.stale : false);
  const held =
    frame.heldFor !== "focus"
      ? null
      : stageKind === "live"
        ? { label: "Your agent changed the game while you were playing", action: "Reload" }
        : {
            label: heldTurn === null ? "New build" : `New build from turn ${heldTurn}`,
            action: "Play",
          };
  const stagePhaseLabel =
    stageKind === "live"
      ? phase.kind === "playing"
        ? live.revision === 0
          ? "Live"
          : `Live · reloaded when ${changedFile(live.message)} changed, ${clockTime(live.at)}`
        : phase.kind === "stopped"
          ? "Stopped"
          : null
      : phase.kind === "playing"
        ? data.webBuildStale
          ? "Playing · older than the game"
          : "Playing"
        : phase.kind === "ready"
          ? data.webBuildStale
            ? "Ready · older than the game"
            : "Ready to play"
          : phase.kind === "first-build"
            ? "Making the first build"
            : phase.kind === "never-built"
              ? "No build yet"
              : phase.kind === "failed"
                ? "Build failed"
                : phase.kind === "tools-missing"
                  ? "Engine not ready"
                  : phase.kind === "window"
                    ? "Plays in its own window"
                    : null;
  const runningSomething =
    busy !== null ||
    operationState === "running" ||
    data.processes.length > 0 ||
    data.previewUrl !== null ||
    playTarget !== null ||
    (buildPlays?.length ?? 0) > 0;
  const buildingMessage =
    operationState === "running" && data.operation !== null
      ? data.operation.message
      : `${busy === null ? "Working" : BUSY_LABELS[busy.action]}…`;
  const template = GAME_TEMPLATES.find((entry) => entry.id === data.manifest.template);
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
  const templateName = template?.name ?? `${engine.name} ${data.manifest.engine.version}`;
  const stageSubtitle =
    stagePhaseLabel === null
      ? templateName
      : stageKind === "live"
        ? `${engine.name} · ${stagePhaseLabel}`
        : template === undefined
          ? stagePhaseLabel
          : `${templateName} · ${stagePhaseLabel}`;
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
          onClick={() => onAskAgent(failurePrompt)}
        >
          Ask agent to fix
        </Button>
      </div>
    ) : liveError !== null ? (
      // Mid-turn, a save may be half-written: the error is named, not alarmed.
      <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <TruncatedText
            text={`The game threw while an agent is editing it: ${liveError}`}
            className="block"
          />
        </span>
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
            setPlayRef(null);
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
      onFocus={(event) => setGameFocused(isFolderGameFrame(event.target))}
      onBlur={(event) => {
        if (isFolderGameFrame(event.target)) setGameFocused(false);
      }}
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
            <h2 className="min-w-0 truncate text-base font-semibold leading-5 tracking-tight">
              <TruncatedText text={data.manifest.name} />
            </h2>
            {building && stageKind !== "live" ? (
              <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
                {/* Static: the elapsed timer already shows it is live. */}
                <RefreshCwIcon className="size-3 shrink-0" aria-hidden="true" />
                <TruncatedText text={buildingMessage} />
                {buildingStartedAt === null ? null : (
                  <GameElapsed since={buildingStartedAt} className="shrink-0" />
                )}
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
                {phase.kind === "playing" ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
                ) : null}
                <span className="truncate">{stageSubtitle}</span>
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {stageKind === "export" ? (
              <>
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
                <IconAction
                  label="Rebuild the web export"
                  disabled={!rebuildEnabled}
                  onClick={() => void perform("rebuild")}
                >
                  <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                </IconAction>
                <IconAction
                  label="Stop the game and its preview"
                  disabled={!canOperate || !runningSomething}
                  onClick={() => void perform("stop")}
                >
                  <SquareIcon className="size-3.5" aria-hidden="true" />
                </IconAction>
              </>
            ) : null}
            {stageKind === "live" ? (
              <IconAction
                label="Reload the game"
                disabled={data.previewUrl === null}
                onClick={() => setFrameFold(reloadFrame(frame, Date.now()))}
              >
                <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              </IconAction>
            ) : null}
            {stageKind !== "window" ? (
              <IconAction
                label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
                disabled={phase.kind !== "playing"}
                onClick={toggleFullscreen}
              >
                {fullscreen ? (
                  <MinimizeIcon className="size-3.5" aria-hidden="true" />
                ) : (
                  <MaximizeIcon className="size-3.5" aria-hidden="true" />
                )}
              </IconAction>
            ) : null}
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
                <MenuItem onClick={() => setExportOpen(true)}>
                  <DownloadIcon />
                  Export…
                </MenuItem>
                <MenuItem
                  disabled={!canOperate || !runningSomething}
                  onClick={() => void perform("stop")}
                >
                  <SquareIcon />
                  Stop the game
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  onClick={() => void navigate({ to: "/settings/general", hash: "game-tools" })}
                >
                  <WrenchIcon />
                  Game tools settings
                </MenuItem>
              </MenuPopup>
            </Menu>
            <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />
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
      {playTarget !== null && compare === null ? (
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
      {compare !== null ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <GameBuildCompare
            threadRef={threadRef}
            pair={compare}
            viewport={data.viewport}
            gameName={data.manifest.name}
            compact={compact}
            hidden={hidden}
            onClose={() => setCompare(null)}
          />
        </div>
      ) : null}
      {/*
        The folder's game stays mounted under a copy or a compare, so it keeps
        its progress. The engine cannot see CSS hiding (an iframe's document
        stays visible with its parent), so the frame tells the game over
        postMessage to pause and mute while it is not shown.
      */}
      {playTarget !== null ? (
        <div
          aria-hidden={compare !== null}
          data-game-play-surface="build"
          className={
            compare === null
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
                hidden={hidden || compare !== null}
                focusRequest={focusRequest?.frame === "copy" ? focusRequest.n : 0}
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
        aria-hidden={playTarget !== null || compare !== null}
        className={
          playTarget === null && compare === null ? "flex min-h-0 flex-1 flex-col" : "hidden"
        }
      >
        <GamePlaySurface
          phase={phase}
          viewport={data.viewport}
          gameName={data.manifest.name}
          // A live remount lands in play, the first load and Reload on the title (A5).
          previewUrl={
            stageKind === "live" && frame.intoPlay && data.previewUrl !== null
              ? `${data.previewUrl}${LIVE_PLAY_HASH}`
              : data.previewUrl
          }
          frameKey={frameKey}
          hidden={frameHidden}
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
          onAskAgent={(failure) => onAskAgent(buildFailurePrompt(failure))}
          onOpenTools={() => void navigate({ to: "/settings/general", hash: "game-tools" })}
          held={held}
          onTakeHeld={() => setFrameFold(playHeldFrame(frame))}
          onStudioMessage={onStudioMessage}
          focusRequest={focusRequest?.frame === "folder" ? focusRequest.n : 0}
        />
      </div>
      <GameBuildTimeline
        threadRef={threadRef}
        writer={canOperate}
        turnRunning={turnRunning}
        live={stageKind === "live"}
        playing={playTarget?.build ?? null}
        request={timelineRequest}
        onPlay={(build) => void playBuild(build)}
        onPlayUnlisted={(ref) => void playBuild(ref)}
        onLive={backToLive}
        onCompare={setCompare}
      />
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Export</DialogTitle>
            <DialogDescription>
              Releases of the game folder, written to builds/ and never committed.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <GameExports
              threadRef={threadRef}
              builds={data.builds}
              exportTargets={data.exportTargets}
              live={stageKind === "live"}
              webBuildStale={data.webBuildStale}
              sourcesDifferFromPlay={data.sourcesDifferFromPlay}
              canOperate={canOperate}
              operationRunning={building}
              onPlay={() => {
                setExportOpen(false);
                void perform("preview");
              }}
              onExportWeb={() => void perform("rebuild")}
              onExport={(target) =>
                void perform(target === "Windows" ? "export-windows" : "export-linux")
              }
            />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
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

/** A header icon button with its name in a tooltip. */
function IconAction({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
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
