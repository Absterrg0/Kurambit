import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CircleStopIcon,
  CrosshairIcon,
  ChevronDownIcon,
  DownloadIcon,
  FastForwardIcon,
  FilmIcon,
  FolderOpenIcon,
  HistoryIcon,
  MaximizeIcon,
  MinimizeIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PencilIcon,
  PlayIcon,
  Redo2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
  Undo2Icon,
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
import { GAME_ENGINES, parkedEngineMessage } from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

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
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentQuerySelector } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useStableCallback } from "../../hooks/useStableCallback";
import { isGameStatusFailure, useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { type GameStageRequest, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { isElectron } from "../../env";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { StatusDot } from "../ui/status-dot";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameBuildCompare } from "./GameBuildCompare";
import { GameBuildStrip, type GameBuildSlot, type GameStripRequest } from "./GameBuildStrip";
import { GameExports } from "./GameExports";
import { GameKeepGoingMenuContent } from "./GameKeepGoingControl";
import { GameNameInput, useGameName, useRenameGame } from "./GameName";
import { GameStageOverlay } from "./GameStageOverlay";
import {
  clearStageSelection,
  toggleStageFreeze,
  useStageAwayFreeze,
  useStageBridge,
  useThreadStageBridge,
} from "./gameStageBridge";
import { keepGoingControlView } from "./keepGoing.logic";
import { useKeepGoing } from "./useKeepGoing";
import { buildName } from "./gameBuilds.logic";
import { useBuildPlay, useBuildStop, useTurnUndo } from "./useBuildActions";
import { GameElapsed } from "./GameElapsed";
import { gameStatusLine, type GameStatusPart } from "./gameStatusLine.logic";
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

// The build the folder holds, by name, for the held build's chip.
const folderBuildName = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result)) return null;
  const build = result.value.builds.find((each) => each.id === result.value.current);
  return build === undefined ? null : buildName(build);
};

const hasAnyBuild = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) =>
  AsyncResult.isSuccess(result) && result.value.builds.length > 0;

/** The build the folder holds, as a sentence names it ("build 7"), unless edited since. */
const folderBuildPhrase = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result) || result.value.folderEdited === true) return null;
  const build = result.value.builds.find((each) => each.id === result.value.current);
  return build === undefined ? null : buildPhrase(buildName(build));
};

/** The number the next person build takes: one past the newest numbered one. */
const nextBuildOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result)) return 1;
  const numbered = result.value.builds.find((each) => each.number !== null);
  return (numbered?.number ?? 0) + 1;
};

const hasStepsOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) =>
  AsyncResult.isSuccess(result) &&
  result.value.builds.some((each) => each.source._tag === "turn" && each.source.step !== null);

const buildPhrase = (name: string) => name.replace(/^Build /, "build ").replace(/^Step /, "step ");

/** The folder's own game frame, not a build copy's. */
const isFolderGameFrame = (target: EventTarget) =>
  target instanceof HTMLIFrameElement && target.closest('[data-game-play-surface="true"]') !== null;

/**
 * The game workspace for a game thread: the game owns the centre of the
 * window, its builds sit under it, and chat is docked to its right. ChatView
 * mounts this once the thread's game status resolves, which is also what makes
 * it a game thread. How the game shows depends on its engine
 * (`GAME_ENGINES[engine].stage`): its folder served live, a Web export, or its
 * own window.
 */
let webGlProbe: boolean | undefined;
/** Whether this renderer can make a WebGL context at all; asked once. */
const rendererHasWebGl = () => {
  if (webGlProbe === undefined) {
    const canvas = document.createElement("canvas");
    webGlProbe = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) !== null;
  }
  return webGlProbe;
};

function NoWebGlCard() {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-stage p-6">
      <div className="flex max-w-md flex-col gap-2 rounded-xl border border-border bg-background p-5 text-body">
        <p className="text-label">This computer's browser can't run 3D here</p>
        <p className="text-muted-foreground">
          WebGL is turned off in Kurambit on this computer, usually because the graphics driver is
          blocked or there is no GPU (a virtual machine, a remote desktop). The game itself is fine:
          Kurambit still measures its facts, and its web export plays in another browser.
        </p>
      </div>
    </div>
  );
}

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
  /** The workbench shows a single pane, so the Inspector is a switch rather than a column. */
  compact?: boolean;
  /** Another compact pane is showing; the stage stays mounted but is inert. */
  hidden?: boolean;
  /** Opens the compact workbench's Inspector pane. */
  onShowInspector?: (() => void) | undefined;
  /** What the person asked of the turn now running, for the build slot's caption. */
  turnRequest?: string | null;
  /** The agent's live note, for the Stage while the first build is made. */
  note?: string | null;
}

function ThreadGameStage({
  threadRef,
  turnRunning,
  onAskAgent,
  compact = false,
  hidden = false,
  onShowInspector,
  turnRequest = null,
  note = null,
}: GameStageProps) {
  const navigate = useNavigate();
  const query = useIsGameThreadStatus(threadRef);
  const canAct = useAtomValue(gameEnvironment.action.permissionAtom(threadRef.environmentId));
  const action = useAtomCommand(gameEnvironment.action, { reportFailure: false });
  const inspectorCollapsed = useGameWorkspaceStore((state) => state.inspectorCollapsed);
  const setInspectorCollapsed = useGameWorkspaceStore((state) => state.setInspectorCollapsed);
  const inspectBuild = useGameWorkspaceStore((state) => state.inspectBuild);
  // An earlier build the stage plays from a copy instead of the folder's own game.
  const asked = useAtomValue(stagePlayTarget(threadRef));
  const stopBuild = useBuildStop(threadRef);
  const plays = useBuildPlay(threadRef);
  const turnUndo = useTurnUndo(threadRef, null);
  const turnUndoAllowed = (kind: "undo" | "redo") =>
    turnUndo.action?.kind === kind &&
    turnUndo.action.blocked === null &&
    turnUndo.canRestore &&
    !turnUndo.pending;
  const live = useAtomValue(liveSignal(threadRef));
  // Which live change the frame shows: while this chat's turn runs, at
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
  const [timelineRequest, setTimelineRequest] = useState<GameStripRequest | null>(null);
  const [reelOpen, setReelOpen] = useState(false);
  const [compare, setCompare] = useState<readonly [GameBuildRef, GameBuildRef] | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const showInspectorTab = useGameWorkspaceStore((state) => state.showInspectorTab);
  const threadKey = scopedThreadKey(threadRef);
  // Frozen by the person; a game held while the Stage has no focus reads as away instead.
  const frozen = useThreadStageBridge(
    threadKey,
    (state) => state.frozen && !state.autoFrozen,
    false,
  );
  const away = useThreadStageBridge(threadKey, (state) => state.frozen && state.autoFrozen, false);
  const bridgeStatus = useThreadStageBridge(threadKey, (state) => state.status, null);
  const selectedId = useThreadStageBridge(
    threadKey,
    (state) => state.selected?.thing.id ?? null,
    null,
  );
  // Pointing at a thing opens Scene on it.
  const shownSelection = useRef(selectedId);
  useEffect(() => {
    const before = shownSelection.current;
    shownSelection.current = selectedId;
    if (selectedId !== null && selectedId !== before) showInspectorTab("scene");
  }, [selectedId, showInspectorTab]);
  const keepGoing = useKeepGoing(threadRef);
  const keepGoingView = keepGoingControlView({
    status: keepGoing.status,
    error: keepGoing.error,
    threadId: threadRef.threadId,
    canOperate: keepGoing.canOperate,
    sending: keepGoing.sending,
    chosenBudget: keepGoing.chosenBudget,
  });
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
  // The fold of what the play surface runs across reads; state, so the render
  // below can pin this serve without touching refs.
  const [frameFold, setFrameFold] = useState<GameFrameFold | null>(null);
  // The person is in the game: its frame is the document's focused element.
  const [gameFocused, setGameFocused] = useState(false);
  const [stageFocused, setStageFocused] = useState(false);
  useStageAwayFreeze(threadKey, !stageFocused);
  // The live game's first page error, for the frame that threw it.
  const [studioError, setStudioError] = useState<{ key: string; text: string } | null>(null);
  // A shown live game opens itself while the server says nobody asked for it
  // since it started; once someone stopped it, Play is the person's.
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
  // Read only while an export engine's build is held: the Builds list names it.
  const heldName = useEnvironmentQuerySelector(
    frameFold?.held == null || frameFold.serve.servedArtifactId?.startsWith("live:") === true
      ? null
      : gameEnvironment.builds({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
    folderBuildName,
  );
  // Before the first build the Stage plays only the starter shell: no game is paused.
  const buildsAtom = gameEnvironment.builds({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const hasBuild = useEnvironmentQuerySelector(buildsAtom, hasAnyBuild) === true;
  const stageBuildName = useEnvironmentQuerySelector(buildsAtom, folderBuildPhrase);
  const nextBuildNumber = useEnvironmentQuerySelector(buildsAtom, nextBuildOf);
  const hasSteps = useEnvironmentQuerySelector(buildsAtom, hasStepsOf);
  const buildsRead = useEnvironmentQuerySelector(buildsAtom, AsyncResult.isSuccess);
  const stageRef = useRef<HTMLElement | null>(null);
  // A compact switch unmounts nothing, but focus would die with the hidden
  // pane's button. Move it to the stage when the stage comes back.
  const stageWasHidden = useRef(hidden);
  useEffect(() => {
    const wasHidden = stageWasHidden.current;
    stageWasHidden.current = hidden;
    if (wasHidden && !hidden) stageRef.current?.focus({ preventScroll: true });
  }, [hidden]);
  const refresh = query.refresh;
  const data = query.data;
  const liveStaged = data != null && GAME_ENGINES[data.manifest.engine.name].stage === "live";
  const gameName = useGameName(
    threadRef.environmentId,
    quietShell?.projectId ?? null,
    data?.manifest.name ?? "",
  );
  const renameGame = useRenameGame(threadRef.environmentId);
  const [renamingGame, setRenamingGame] = useState(false);
  if (seenRevision === null && data) setSeenRevision(data.operation?.revision ?? 0);
  // Operation pushes reread the status (statusSignal in state/game), so nothing polls it.
  const operationState = data?.operation?.state ?? null;
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
      case "freeze":
        toggleStageFreeze();
        return;
      case "undo":
      case "redo":
        // The header, the palette and the keys restore here: a refusal (another chat at
        // work) is the person's news, not the game's failure.
        if (turnUndoAllowed(request.kind))
          void turnUndo.send().then((refused) => {
            if (refused !== null) setMessage(refused);
          });
        return;
      case "export":
        setExportOpen(true);
        return;
      case "generated-art":
        showInspectorTab("scene");
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
      <section className="flex min-h-0 flex-1 items-center justify-center p-6 text-body text-muted-foreground">
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
  // plays, so a Stop from the palette, another client or an
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
    parked: engine.status === "parked" ? parkedEngineMessage(data.manifest.engine.name) : null,
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
  // (a server restart) asks again.
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
  // A parked engine's game builds and plays nothing here.
  const webPlay = engine.status === "active" && data.exportTargets.includes("Web");
  const playEnabled =
    !awaitingTurnBuild && webPlay && canAct && (data.previewUrl !== null || !building);
  const stagingEnabled = canAct && !building;
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
  // Fold the served identity across reads: a live change or a replaced
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
  // A game that cannot make a WebGL context here is the machine's browser, not
  // the agent's work: confirmed by the app's own renderer, which shares the GPU.
  const noWebGl = liveError !== null && /webgl/i.test(liveError) && !rendererHasWebGl();
  const failureVisible =
    error ??
    (operation !== null && operationVisible && operation.state === "failed"
      ? operation.message
      : null) ??
    (liveError !== null && !noWebGl && !turnRunning && !gameTurnRunning ? liveError : null);
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
            label: heldName === null ? "New build" : `New build from ${heldName}`,
            action: "Play",
          };
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
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen();
  };
  const statusBanner =
    failureVisible !== null ? (
      <div className="flex items-center gap-2 border-t border-destructive/20 bg-destructive/8 px-3 py-1.5 text-meta text-destructive-foreground">
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
    ) : liveError !== null && !noWebGl ? (
      // Mid-turn, a save may be half-written: the error is named, not alarmed.
      <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-1.5 text-meta text-muted-foreground">
        <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <TruncatedText
            text={`The game threw while an agent is editing it: ${liveError}`}
            className="block"
          />
        </span>
      </div>
    ) : noticeVisible !== null ? (
      <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-1.5 text-meta text-muted-foreground">
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
      <div className="flex items-center gap-2 border-t border-warning/20 bg-warning-surface/50 px-3 py-1.5 text-meta text-warning-foreground">
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
  // A live game's folder plays its starter shell until the first build lands;
  // the Stage says what is being made instead of showing a game that is not yet one.
  const shownPhase: typeof phase =
    stageKind === "live" && buildsRead && !hasBuild && turnRunning && phase.kind === "playing"
      ? {
          kind: "first-build",
          startedAt: turnStartedAt === null ? null : Date.parse(turnStartedAt),
        }
      : phase;
  const keepGoingStatus = keepGoing.status;
  const keepGoingHere =
    keepGoingStatus !== null &&
    keepGoingStatus.mode !== "off" &&
    keepGoingStatus.chat === threadRef.threadId;
  const statusLine = gameStatusLine({
    phase: shownPhase.kind,
    onStage: playTarget === null ? stageBuildName : buildPhrase(playTarget.label),
    frozen,
    away: away && hasBuild,
    needsChoice:
      quietShell !== null && (quietShell.hasPendingApprovals || quietShell.hasPendingUserInput),
    keepGoingStep: keepGoingHere ? keepGoingStatus.step : null,
    keepGoingLive: keepGoingHere,
    turnRunning,
    turnStartedAt: turnStartedAt === null ? null : Date.parse(turnStartedAt),
    nextBuild: nextBuildNumber,
    operation: building ? { text: buildingMessage, since: buildingStartedAt } : null,
    live: stageKind === "live",
  });
  const keepGoingMaking =
    keepGoingHere && (keepGoingStatus.phase === "turn" || keepGoingStatus.phase === "waiting");
  const buildSlot: GameBuildSlot | null = keepGoingMaking
    ? {
        label: keepGoingStatus.step === null ? "Next step" : `Step ${keepGoingStatus.step}`,
        caption: keepGoingStatus.proposal?.summary ?? null,
        since: turnRunning && turnStartedAt !== null ? Date.parse(turnStartedAt) : null,
        keepGoing: true,
      }
    : turnRunning
      ? {
          label: `Making build ${nextBuildNumber}`,
          caption: turnRequest,
          since: turnStartedAt === null ? null : Date.parse(turnStartedAt),
          keepGoing: false,
        }
      : null;
  // Keep going makes the next builds, so it sits with them in the strip's header.
  // A parked engine's game builds and plays nothing, so it offers neither.
  const keepGoingControl =
    engine.status === "active" && hasBuild ? (
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="secondary"
                    aria-label="Keep going"
                    aria-pressed={keepGoingView.pressed}
                    data-game-keep-going=""
                    disabled={!hasBuild}
                  />
                }
              />
            }
          >
            <FastForwardIcon className="size-3.5" aria-hidden="true" />
            {keepGoingView.label}
          </TooltipTrigger>
          <TooltipPopup side="top">{keepGoingView.tooltip}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          <GameKeepGoingMenuContent threadRef={threadRef} />
        </MenuPopup>
      </Menu>
    ) : null;
  return (
    <section
      ref={stageRef}
      data-game-stage="true"
      aria-label={`${gameName} game stage`}
      aria-hidden={hidden}
      inert={hidden}
      tabIndex={-1}
      onFocus={(event) => {
        setGameFocused(isFolderGameFrame(event.target));
        setStageFocused(true);
      }}
      onBlur={(event) => {
        if (isFolderGameFrame(event.target)) setGameFocused(false);
        if (
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        )
          setStageFocused(false);
      }}
      onKeyDown={(event) => {
        // Tab freezes and plays on, and Esc clears the selection, when the Stage itself
        // has focus; a focused game sends both up as studio-key. Controls keep their keys.
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey)
          return;
        if (
          event.key === "Tab" &&
          !event.shiftKey &&
          engine.stageBridge &&
          phase.kind === "playing"
        ) {
          event.preventDefault();
          toggleStageFreeze();
        } else if (event.key === "Escape" && useStageBridge.getState().selected !== null) {
          event.preventDefault();
          clearStageSelection();
        }
      }}
      className={cn(
        "relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background outline-none",
        hidden ? "hidden" : "flex",
      )}
    >
      <header className="@container/stage-header flex shrink-0 flex-col bg-background">
        <div
          className={cn(
            "flex h-(--workspace-topbar-height) min-w-0 items-center gap-1.5 px-2 pl-4",
            // The window is dragged by its top bar; its buttons stay clickable.
            isElectron && "drag-region",
            // With the sidebar collapsed, its toggle (and macOS's traffic lights) sit over this corner.
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            // With the Inspector hidden, the top bar runs under the desktop window controls.
            (compact || inspectorCollapsed) && "wco:pr-(--workspace-native-controls-inset)",
          )}
        >
          {renamingGame && quietShell !== null ? (
            <GameNameInput
              name={gameName}
              onRename={(name) => void renameGame(quietShell.projectId, name)}
              onDone={() => setRenamingGame(false)}
              className="-ms-2 w-56"
            />
          ) : (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${gameName}, game menu`}
                    className="-ms-2 min-w-0 shrink"
                  />
                }
              >
                <Text variant="label" tone="strong" truncate>
                  {gameName}
                </Text>
                <ChevronDownIcon className="text-dim-foreground" aria-hidden="true" />
              </MenuTrigger>
              <MenuPopup align="start">
                <MenuItem disabled={quietShell === null} onClick={() => setRenamingGame(true)}>
                  <PencilIcon />
                  Rename
                </MenuItem>
                <GameFolderMenuItem threadRef={threadRef} root={data.root} />
                <MenuItem disabled={engine.status === "parked"} onClick={() => setExportOpen(true)}>
                  <DownloadIcon />
                  Export…
                </MenuItem>
                <MenuItem
                  onClick={() => void navigate({ to: "/settings/general", hash: "game-tools" })}
                >
                  <WrenchIcon />
                  Game tools settings
                </MenuItem>
              </MenuPopup>
            </Menu>
          )}
          <GameStatusLine status={statusLine} />
          <span className="min-w-2 flex-1" />
          <IconAction
            label="Undo the last build"
            disabled={!turnUndoAllowed("undo")}
            onClick={() => handleRequest({ kind: "undo" }, 0)}
          >
            <Undo2Icon className="size-3.5" aria-hidden="true" />
          </IconAction>
          <IconAction
            label="Redo the build you undid"
            disabled={!turnUndoAllowed("redo")}
            onClick={() => handleRequest({ kind: "redo" }, 0)}
          >
            <Redo2Icon className="size-3.5" aria-hidden="true" />
          </IconAction>
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
              <MoreHorizontalIcon className="size-3.5" aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              {engine.stageBridge && stageKind === "live" ? (
                <MenuItem
                  disabled={phase.kind !== "playing" || bridgeStatus === null}
                  onClick={() => {
                    toggleStageFreeze();
                    // Focus the Stage, so Tab and Esc work here for a game without the bridge's keys.
                    stageRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <CrosshairIcon />
                  {frozen ? "Play on" : "Freeze to point at things"}
                  <MenuShortcut>Tab</MenuShortcut>
                </MenuItem>
              ) : null}
              {stageKind === "live" ? (
                <MenuItem
                  disabled={data.previewUrl === null}
                  onClick={() => setFrameFold(reloadFrame(frame, Date.now()))}
                >
                  <RefreshCwIcon />
                  Reload the game
                </MenuItem>
              ) : null}
              {stageKind === "export" && engine.status === "active" ? (
                <>
                  <MenuItem disabled={!playEnabled} onClick={() => void perform("preview")}>
                    <PlayIcon />
                    {webBuild === undefined ? "Build and play" : "Play"}
                  </MenuItem>
                  <MenuItem disabled={!rebuildEnabled} onClick={() => void perform("rebuild")}>
                    <RefreshCwIcon />
                    Rebuild the web export
                  </MenuItem>
                </>
              ) : null}
              {stageKind !== "window" ? (
                <MenuItem disabled={phase.kind !== "playing"} onClick={toggleFullscreen}>
                  {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
                  {fullscreen ? "Leave fullscreen" : "Fullscreen"}
                </MenuItem>
              ) : null}
              {hasSteps ? (
                <MenuItem onClick={() => setReelOpen(!reelOpen)}>
                  <FilmIcon />
                  {reelOpen ? "Close keep going's reel" : "Keep going's reel"}
                </MenuItem>
              ) : null}
              <MenuItem
                disabled={!canAct || !runningSomething}
                onClick={() => void perform("stop")}
              >
                <CircleStopIcon />
                Stop the game
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={
                    compact || inspectorCollapsed ? "Show the Inspector" : "Hide the Inspector"
                  }
                  aria-pressed={!compact && !inspectorCollapsed}
                  onClick={() => {
                    if (compact) onShowInspector?.();
                    else setInspectorCollapsed(!inspectorCollapsed);
                  }}
                />
              }
            >
              <PanelRightIcon className="size-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {compact || inspectorCollapsed ? "Show the Inspector" : "Hide the Inspector"}
            </TooltipPopup>
          </Tooltip>
        </div>
        {statusBanner}
      </header>
      {playTarget !== null && compare === null ? (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg bg-card py-1 ps-3 pe-1">
          <HistoryIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Text variant="meta" tone="muted" truncate render={<span className="flex-1" />}>
            Playing {playTarget.label} from a copy. The game folder is untouched.
          </Text>
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
            gameName={gameName}
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
              ? "group/stage relative mx-3 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-stage [container-type:size]"
              : "hidden"
          }
        >
          <GameFrameBox viewport={data.viewport} gameName={gameName} playing>
            {playTarget.result._tag === "web" ? (
              <GameFrame
                key={`${playTarget.build}\0${playTarget.result.url}`}
                url={playTarget.result.url}
                title={`${gameName}, ${playTarget.label}`}
                hidden={hidden || compare !== null}
                focusRequest={focusRequest?.frame === "copy" ? focusRequest.n : 0}
              />
            ) : (
              <p className="flex size-full items-center justify-center p-6 text-center text-body text-washi/90">
                {playTarget.result.message}
              </p>
            )}
          </GameFrameBox>
        </div>
      ) : null}
      <div
        aria-hidden={playTarget !== null || compare !== null}
        className={
          playTarget === null && compare === null
            ? "relative flex min-h-0 flex-1 flex-col px-3"
            : "hidden"
        }
      >
        {noWebGl ? <NoWebGlCard /> : null}
        <GamePlaySurface
          phase={shownPhase}
          viewport={data.viewport}
          gameName={gameName}
          // A live remount lands in play, the first load and Reload on the title.
          previewUrl={
            stageKind === "live" && frame.intoPlay && data.previewUrl !== null
              ? `${data.previewUrl}${LIVE_PLAY_HASH}`
              : data.previewUrl
          }
          frameKey={frameKey}
          hidden={frameHidden}
          canOperate={canAct}
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
          bridge={{ threadKey, enabled: engine.stageBridge }}
          overlay={<GameStageOverlay threadKey={threadKey} />}
          note={note}
        />
      </div>
      <GameBuildStrip
        threadRef={threadRef}
        gameName={gameName}
        playing={playTarget?.build ?? null}
        slot={buildSlot}
        request={timelineRequest}
        reelOpen={reelOpen}
        onPlay={(build) => void playBuild(build)}
        onPlayUnlisted={(ref) => void playBuild(ref)}
        onLive={backToLive}
        onCompare={setCompare}
        actions={keepGoingControl}
        onInspect={(build) => {
          inspectBuild({ threadKey, build: build.id, snapshot: build });
          if (useGameWorkspaceStore.getState().inspectorTab !== "build") showInspectorTab("build");
        }}
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
              canOperate={canAct}
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

function GameStatusLine({ status }: { status: ReadonlyArray<GameStatusPart> }) {
  return (
    <span
      role="status"
      className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden whitespace-nowrap"
    >
      {status.map((part, index) => (
        <span key={part.text} className="flex min-w-0 items-center gap-1.5">
          {index > 0 ? (
            <Text variant="meta" tone="dim" aria-hidden="true">
              ·
            </Text>
          ) : null}
          {part.dot === "live" ? <StatusDot tone="live" pulse /> : null}
          <Text variant="meta" tone={part.strong ? "default" : "muted"} truncate>
            {part.text}
          </Text>
          {part.since === null ? null : (
            <Text variant="meta" tone="muted" numeric>
              <GameElapsed since={part.since} prefix="· " />
            </Text>
          )}
          {part.key === null ? null : (
            <>
              <Kbd>{part.key.key}</Kbd>
              <Text variant="meta" tone="dim">
                {part.key.after}
              </Text>
            </>
          )}
        </span>
      ))}
    </span>
  );
}

/** The game's folder in the system's file manager, else the app's file panel. */
function GameFolderMenuItem({ threadRef, root }: { threadRef: ScopedThreadRef; root: string }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: true });
  const system = config?.availableEditors.includes("file-manager") === true;
  return (
    <MenuItem
      onClick={() => {
        if (!system) {
          useRightPanelStore.getState().open(threadRef, "files");
          return;
        }
        void openInEditor({
          environmentId: threadRef.environmentId,
          input: { cwd: root, editor: "file-manager" },
        });
      }}
    >
      <FolderOpenIcon />
      Open the game's folder
    </MenuItem>
  );
}
