import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { showGameTab, toggleGameTab, useGameTabShown } from "./gameRightPanel";
import { GameStagePlayControls, GameStageViewControls } from "./GameStageControls";
import { GameKeepGoingButton } from "./GameKeepGoingButton";
import {
  CircleStopIcon,
  CrosshairIcon,
  SlidersHorizontalIcon,
  ChevronDownIcon,
  PaletteIcon,
  DownloadIcon,
  FilmIcon,
  FolderOpenIcon,
  HistoryIcon,
  MaximizeIcon,
  MinimizeIcon,
  MoreHorizontalIcon,
  PanelTopCloseIcon,
  PanelTopOpenIcon,
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
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { shortcutLabelForCommand } from "../../keybindings";
import { shellEnvironment } from "../../state/shell";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentQuerySelector } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useStableCallback } from "../../hooks/useStableCallback";
import { isGameStatusFailure, useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { type GameStageRequest, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { observeResize } from "../../lib/observeResize";
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
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import { StatusDot } from "../ui/status-dot";
import { Text } from "../ui/text";
import { Tooltip, TooltipLabel, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameBuildCompare } from "./GameBuildCompare";
import { GameBuildStrip, type GameBuildSlot, type GameStripRequest } from "./GameBuildStrip";
import { GameExports } from "./GameExports";
import { GameNameInput, useGameName, useRenameGame } from "./GameName";
import { GameStageOverlay } from "./GameStageOverlay";
import {
  clearStageSelection,
  toggleStageFreeze,
  useStageBridge,
  useStageStill,
  keepBuildFrame,
  useBuildFrame,
  captureStageFrame,
  useGameFreezeKey,
  useThreadStageBridge,
} from "./gameStageBridge";
import { useKeepGoing } from "./useKeepGoing";
import { clockTime } from "./keepGoing.logic";
import { buildName, buildPhrase, doesNotStart, undoOutcome } from "./gameBuilds.logic";
import { nextBuildOf } from "./GameLibraryStatus";
import { useBuildPlay, useBuildStop, useTurnUndo } from "./useBuildActions";
import { useTurnLanding } from "./useTurnLanding";
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

/** One selector per build id, so a reader of one build's name keeps the same derived atom. */
const buildPhraseSelectors = new Map<
  string,
  (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => string | null
>();
const NO_BUILD_PHRASE = () => null;
const buildPhraseOf = (id: string | null) => {
  if (id === null) return NO_BUILD_PHRASE;
  let select = buildPhraseSelectors.get(id);
  if (select === undefined) {
    select = (result) => {
      if (!AsyncResult.isSuccess(result)) return null;
      const build = result.value.builds.find((each) => each.id === id);
      return build === undefined ? null : buildPhrase(buildName(build));
    };
    buildPhraseSelectors.set(id, select);
  }
  return select;
};

/** The build the folder holds, unchanged since; null while it is edited or unknown. */
const folderBuildIdOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) =>
  AsyncResult.isSuccess(result) && result.value.folderEdited === false
    ? result.value.current
    : null;

/** The build the folder holds, as a sentence names it ("build 7"), unless edited since. */
const folderBuildPhrase = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result) || result.value.folderEdited === true) return null;
  const build = result.value.builds.find((each) => each.id === result.value.current);
  return build === undefined ? null : buildPhrase(buildName(build));
};

/** The build the folder holds was measured and does not start. */
const folderDoesNotStartOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result) || result.value.folderEdited !== false) return false;
  const build = result.value.builds.find((each) => each.id === result.value.current);
  return build !== undefined && doesNotStart(build.facts);
};

/** The folder's last build, as a sentence names it, when the folder changed since it. */
const changedSincePhrase = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result) || result.value.folderEdited !== true) return null;
  const build = result.value.builds.find((each) => each.id === result.value.current);
  return build === undefined ? null : buildPhrase(buildName(build));
};

const hasStepsOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) =>
  AsyncResult.isSuccess(result) &&
  result.value.builds.some((each) => each.source._tag === "turn" && each.source.step !== null);

/** A build card in the builds popover. */
const STRIP_CARD_WIDTH = 168;
/** The widest the game's column grows, so its chat never reads as one long line. */
const GAME_COLUMN_MAX = 1040;
/** The least the chat under the game keeps, whatever its share: its composer and a reply. */
const CHAT_ROOM_MIN = 220;
/**
 * The game's size on the column it shares with the chat: its own shape, as wide as the column's
 * lane allows, as tall as the room left once the chat keeps its share below. `taken` is the
 * height of the Stage's own rows (its top bar and controls).
 */
const gameColumnFit = (centre: HTMLElement, taken: number, ratio: number, chatShare: number) => {
  const gutter = centre.clientWidth >= 640 ? 48 : 12;
  const lane = Math.min(GAME_COLUMN_MAX, centre.clientWidth - 2 * gutter);
  const chat = Math.max(CHAT_ROOM_MIN, chatShare * centre.clientHeight);
  const height = Math.floor(
    Math.max(0, Math.min(lane * ratio, centre.clientHeight - taken - chat)),
  );
  return { width: Math.floor(height / ratio), height };
};

/** The folder's own game frame, not a build copy's. */
const isFolderGameFrame = (target: EventTarget) =>
  target instanceof HTMLIFrameElement && target.closest('[data-game-play-surface="true"]') !== null;

/**
 * The game on top of a game thread's column: its top bar, the game, and its controls with the
 * builds list, over the chat and composer that share its width. ChatView mounts this once the
 * thread's game status resolves, which is also what makes it a game thread. How the game shows
 * depends on its engine (`GAME_ENGINES[engine].stage`): its folder served live, a Web export, or
 * its own window.
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

/**
 * The Stage before its game is read: its top bar, a frame that says it is opening and its controls'
 * row, at the size a 16:9 game takes on this column, so nothing moves when the game is read.
 */
export function GameStageLoading() {
  const chatShare = useGameWorkspaceStore((state) => state.chatShare);
  const sectionRef = useRef<HTMLElement>(null);
  const [fit, setFit] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const centre = section?.closest<HTMLElement>("[data-game-centre]");
    if (section == null || centre == null) return;
    const measure = () => {
      let taken = 0;
      for (const child of section.children)
        if (child instanceof HTMLElement && child.dataset.stageFit === undefined)
          taken += child.offsetHeight;
      const next = gameColumnFit(centre, taken, 9 / 16, chatShare);
      setFit(next);
      // The composer under it already ends where the game will.
      centre.style.setProperty("--chat-content-max-width", `${next.width}px`);
    };
    measure();
    const stop = observeResize([centre], measure);
    return () => {
      stop();
      centre.style.removeProperty("--chat-content-max-width");
    };
  }, [chatShare]);
  return (
    <section
      ref={sectionRef}
      aria-busy="true"
      aria-label="Opening the game"
      className="relative flex min-w-0 flex-none flex-col bg-background"
    >
      <div className="flex h-(--workspace-topbar-height) shrink-0 items-center px-3">
        <Skeleton className="h-4 w-28" />
      </div>
      <div
        data-stage-fit=""
        className="mx-auto grid shrink-0 place-items-center rounded-xl bg-stage-well"
        style={fit ?? { width: 0, height: 0 }}
      >
        {/* Named from the first frame: the working area never sits blank after the splash. */}
        <Text variant="meta" tone="inherit" render={<p className="text-stage-muted" />}>
          Opening game…
        </Text>
      </div>
      <div className="h-11 shrink-0" />
    </section>
  );
}

/**
 * The game on screen, for fullscreen: only the game, edge to edge on black, never the
 * Stage's bar or strip. A copy or the folder's own game, whichever is shown.
 */
const playSurfaceOf = (section: HTMLElement | null): HTMLElement | null =>
  [...(section?.querySelectorAll<HTMLElement>("[data-game-play-surface]") ?? [])].find(
    (surface) => surface.offsetParent !== null,
  ) ?? null;

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
  /** Mounted but out of sight; the game holds still. */
  hidden?: boolean;
  /** What the person asked of the turn now running, for the build slot's caption. */
  turnRequest?: string | null;
}

function ThreadGameStage({
  threadRef,
  turnRunning,
  onAskAgent,
  hidden = false,
  turnRequest = null,
}: GameStageProps) {
  const navigate = useNavigate();
  // Hidden by the person: the chat takes the column, and the game pauses and mutes.
  const collapsed = useGameWorkspaceStore((state) => state.gameHidden);
  const setGameHidden = useGameWorkspaceStore((state) => state.setGameHidden);
  const panelOpen = useRightPanelStore(
    (state) => state.byThreadKey[scopedThreadKey(threadRef)]?.isOpen === true,
  );
  const tuneShown = useGameTabShown(threadRef, "tune");
  const buildTabShown = useGameTabShown(threadRef, "build");
  const query = useIsGameThreadStatus(threadRef);
  const canAct = useAtomValue(gameEnvironment.action.permissionAtom(threadRef.environmentId));
  const action = useAtomCommand(gameEnvironment.action, { reportFailure: false });
  const inspectBuild = useGameWorkspaceStore((state) => state.inspectBuild);
  // An earlier build the stage plays from a copy instead of the folder's own game.
  const asked = useAtomValue(stagePlayTarget(threadRef));
  const stopBuild = useBuildStop(threadRef);
  const plays = useBuildPlay(threadRef);
  const turnUndo = useTurnUndo(threadRef, null);
  // Undo and Redo say where they go before they are pressed, in the words the note after uses.
  const undoBase = turnUndo.view?.build.base ?? null;
  const undoBaseName = useEnvironmentQuerySelector(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    buildPhraseOf(undoBase),
  );
  const turnUndoAllowed = (kind: "undo" | "redo") =>
    turnUndo.action?.kind === kind &&
    turnUndo.action.blocked === null &&
    turnUndo.canRestore &&
    !turnUndo.pending;
  const live = useAtomValue(liveSignal(threadRef));
  const stageRequest = useGameWorkspaceStore((state) => state.stageRequest);
  // A request made before this stage mounted was for another one.
  const [mountRequestN] = useState(stageRequest?.n ?? 0);
  const [timelineRequest, setTimelineRequest] = useState<GameStripRequest | null>(null);
  const [reelOpen, setReelOpen] = useState(false);
  const [buildsOpen, setBuildsOpen] = useState(false);
  const [compare, setCompare] = useState<readonly [GameBuildRef, GameBuildRef] | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const threadKey = scopedThreadKey(threadRef);
  // Paused by the person, to point at things.
  const frozen = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const bridgeStatus = useThreadStageBridge(threadKey, (state) => state.status, null);
  const keepGoing = useKeepGoing(threadRef);
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
  // The build the mounted frame plays, for telling a new build from a live edit of the same one.
  const [frameBuild, setFrameBuild] = useState<string | null>(null);
  // The person is in the game: its frame is the document's focused element.
  const [gameFocused, setGameFocused] = useState(false);
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
  const landing = useTurnLanding(threadRef, turnRunning);
  // Which live change the frame shows: held while this chat's turn runs and its build is saved,
  // so the Stage switches games together with its label; the latest otherwise.
  const [liveShown, setLiveShown] = useState<number | null>(null);
  const liveRevision = liveToShow({
    latest: live.revision,
    shown: liveShown,
    turnRunning: turnRunning || landing,
  });
  if (liveRevision !== liveShown) setLiveShown(liveRevision);
  // Changes held back through a turn are its build: the remount that applies them is a new one.
  const [heldBuild, setHeldBuild] = useState(false);
  if ((turnRunning || landing) && liveShown !== null && live.revision !== liveShown && !heldBuild)
    setHeldBuild(true);
  // An Undo or Redo is a new build too, though its build list may update after the folder does.
  if (turnUndo.restoring && !heldBuild) setHeldBuild(true);
  // The request that made the slot, kept past the turn's end for the slot's last moments.
  const [slotRequest, setSlotRequest] = useState(turnRequest);
  if (turnRequest !== null && turnRequest !== slotRequest) setSlotRequest(turnRequest);
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
  const folderName = useEnvironmentQuerySelector(buildsAtom, folderBuildName);
  const changedSince = useEnvironmentQuerySelector(buildsAtom, changedSincePhrase);
  const folderDoesNotStart = useEnvironmentQuerySelector(buildsAtom, folderDoesNotStartOf) === true;
  const undoName = turnUndo.view === null ? null : buildPhrase(buildName(turnUndo.view.build));
  // On a game changed since its build, the restore keeps those changes as a build of their own.
  // The control names the build; the sentences under it are the build menu's own.
  const undoLabel = undoName === null ? "Undo the last build" : `Undo ${undoName}`;
  const undoDetail =
    undoName === null ? null : undoOutcome(undoBaseName ?? null, changedSince != null);
  const redoLabel = undoName === null ? "Redo the build you undid" : `Redo ${undoName}`;
  const nextBuildNumber = useEnvironmentQuerySelector(buildsAtom, nextBuildOf);
  const hasSteps = useEnvironmentQuerySelector(buildsAtom, hasStepsOf);
  const buildsRead = useEnvironmentQuerySelector(buildsAtom, AsyncResult.isSuccess);
  const stageStill = useStageStill(threadKey);
  // A frame the folder's game showed is the picture of the build the folder holds, unless a
  // turn is changing the folder under it. Only a new frame is kept, never one from before.
  const folderBuild = useEnvironmentQuerySelector(buildsAtom, folderBuildIdOf) ?? null;
  // One pane at a time, the Inspector's way in carries what it would show first.
  const keptStill = useRef(stageStill);
  // The folder settling on a new build (a turn's end, an Undo) takes one frame of it, since the
  // game may have come up mid-turn, before the build it now shows existed.
  const framed = useBuildFrame(folderBuild) !== null;
  useEffect(() => {
    if (folderBuild === null || turnRunning || framed || asked !== null) return;
    const timeout = window.setTimeout(() => void captureStageFrame(), 1500);
    return () => window.clearTimeout(timeout);
  }, [folderBuild, turnRunning, framed, asked]);
  useEffect(() => {
    if (stageStill === keptStill.current) return;
    keptStill.current = stageStill;
    // A copy of an older build on the Stage is not the folder's build.
    if (stageStill !== null && folderBuild !== null && !turnRunning && asked === null)
      keepBuildFrame(folderBuild, stageStill);
  }, [stageStill, folderBuild, turnRunning, asked]);
  const stageRef = useRef<HTMLElement | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const freezeKey = useGameFreezeKey();
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
  // The Stage takes the game's own shape: as tall as the column leaves after the
  // top bar, any banner and the builds strip, as wide as that height allows, so
  // the game fills its frame with no letterbox and the strip sits right under it.
  // Whatever height is left over collects below the strip, above the composer.
  const viewportWidth = data?.viewport.width ?? 16;
  const viewportHeight = data?.viewport.height ?? 9;
  const [stageFit, setStageFit] = useState<{
    width: number;
    height: number;
    cardWidth: number;
    cardPicture: number;
    /** A short window: the cards' captions take one request line. */
    compact: boolean;
  } | null>(null);
  // The column the game shares with its chat and composer: the fitted game's width.
  const [column, setColumn] = useState<number | null>(null);
  const comparing = compare !== null;
  const chatShare = useGameWorkspaceStore((state) => state.chatShare);
  const [titleUnderControls, setTitleUnderControls] = useState(true);
  const hasStatus = data != null;
  useLayoutEffect(() => {
    const section = stageRef.current;
    const row = section?.querySelector<HTMLElement>("[data-game-topbar]");
    if (section == null || row == null) return;
    const check = () => {
      const controls = document.querySelector<HTMLElement>("[data-sidebar-control]");
      setTitleUnderControls(
        controls !== null &&
          row.getBoundingClientRect().left < controls.getBoundingClientRect().right,
      );
    };
    check();
    return observeResize([section, row], check);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the top bar mounts once the status is read; before that there is no row to measure.
  }, [hasStatus]);
  useLayoutEffect(() => {
    const section = stageRef.current;
    // A compare fills the Stage's place: the Stage keeps the fit it had, for when it closes.
    if (section === null || comparing) return;
    const centre = section.closest<HTMLElement>("[data-game-centre]");
    const measure = () => {
      if (centre === null) return;
      let taken = 0;
      for (const child of section.children)
        if (
          child instanceof HTMLElement &&
          child.dataset.stageFit === undefined &&
          child.dataset.stageSpacer === undefined
        )
          taken += child.offsetHeight;
      const fit = gameColumnFit(centre, taken, viewportHeight / viewportWidth, chatShare);
      const next = {
        width: fit.width,
        height: fit.height,
        cardWidth: STRIP_CARD_WIDTH,
        cardPicture: Math.floor((STRIP_CARD_WIDTH * 9) / 16),
        compact: false,
      };
      setStageFit((previous) =>
        previous !== null &&
        Math.abs(previous.width - next.width) <= 1 &&
        Math.abs(previous.height - next.height) <= 1
          ? previous
          : next,
      );
      setColumn((previous) =>
        previous !== null && Math.abs(previous - next.width) <= 1 ? previous : next.width,
      );
    };
    measure();
    if (centre === null) return;
    return observeResize(
      [
        centre,
        ...[...section.children].filter(
          (child) => !(child instanceof HTMLElement && child.dataset.stageFit !== undefined),
        ),
      ],
      measure,
    );
  }, [viewportWidth, viewportHeight, comparing, chatShare]);
  const stageFitStyle =
    stageFit === null ? undefined : { height: stageFit.height, width: stageFit.width };
  // The game, its controls, the chat and the composer are one column with one pair of edges:
  // the chat's lane takes the game's width.
  useLayoutEffect(() => {
    const centre = stageRef.current?.closest<HTMLElement>("[data-game-centre]");
    if (centre == null || column === null) return;
    centre.style.setProperty("--chat-content-max-width", `${column}px`);
    return () => {
      centre.style.removeProperty("--chat-content-max-width");
    };
  }, [column]);
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
    // The Inspector follows the Stage back: Now's summary, not the build last clicked.
    if (useGameWorkspaceStore.getState().inspectedBuild?.threadKey === threadKey)
      inspectBuild(null);
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
      case "fullscreen": {
        // Asked now, inside the key's own gesture, which fullscreen needs. The Stage marks
        // itself when a game plays in it, the only time the menu offers fullscreen too.
        if (document.fullscreenElement) void document.exitFullscreen();
        else if (stageRef.current?.hasAttribute("data-fullscreen-ready"))
          void playSurfaceOf(stageRef.current)?.requestFullscreen();
        return;
      }
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
        showGameTab(threadRef, "look");
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
    ) : query.error === null ? (
      // Read but not answered yet: the Stage's own shape, so nothing moves when it lands.
      <GameStageLoading />
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
  const frameHidden = hidden || collapsed || playTarget !== null || compare !== null;
  // Fold the served identity across reads: a live change or a replaced
  // export remounts the game, unless the person is in it (the chip asks) or
  // it is not on screen (it loads when shown). Absorbed reads return the same
  // object, so this only adjusts state when the fold advanced.
  const frame = remountOrHold(
    frameFold,
    stageKind === "live"
      ? liveServe(data.previewUrl, liveRevision)
      : {
          previewUrl: data.previewUrl,
          servedArtifactId:
            webBuild === undefined ? null : `${webBuild.path}#${webBuild.updatedAt}`,
        },
    // A frame hidden by another view or pane may keep focus without a blur.
    {
      focused: gameFocused && !frameHidden,
      hidden: frameHidden,
      // An Undo or Redo changes the folder before its build list says so.
      newBuild:
        turnUndo.restoring ||
        heldBuild ||
        (frameBuild !== null && folderBuild !== null && frameBuild !== folderBuild),
    },
  );
  if (frame !== frameFold) {
    setFrameFold(frame);
    if (frame.key !== frameFold?.key) {
      setFrameBuild(folderBuild);
      setHeldBuild(false);
    }
  } else if (frameBuild === null && folderBuild !== null) setFrameBuild(folderBuild);
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
  const fullscreenKey = shortcutLabelForCommand(keybindings, "game.fullscreen", {
    context: { gameThread: true },
  });
  const inspectorKey = shortcutLabelForCommand(keybindings, "game.chat.toggle", {
    context: { gameThread: true },
  });
  const undoKey = shortcutLabelForCommand(keybindings, "game.undoTurn", {
    context: { gameThread: true },
  });
  const redoKey = shortcutLabelForCommand(keybindings, "game.redoTurn", {
    context: { gameThread: true },
  });
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void playSurfaceOf(stageRef.current)?.requestFullscreen();
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
    stageKind === "live" &&
    buildsRead &&
    !hasBuild &&
    (turnRunning || landing) &&
    phase.kind === "playing"
      ? {
          kind: "first-build",
          saving: !turnRunning,
          startedAt: turnStartedAt === null ? null : Date.parse(turnStartedAt),
        }
      : phase;
  const keepGoingStatus = keepGoing.status;
  const keepGoingHere =
    keepGoingStatus !== null &&
    keepGoingStatus.mode !== "off" &&
    keepGoingStatus.chat === threadRef.threadId;
  const keepGoingStartsAt =
    keepGoingHere &&
    keepGoingStatus.phase === "proposed" &&
    keepGoingStatus.proposal?.deadline != null
      ? clockTime(keepGoingStatus.proposal.deadline)
      : null;
  const statusLine = gameStatusLine({
    phase: shownPhase.kind,
    onStage: playTarget === null ? stageBuildName : buildPhrase(playTarget.label),
    onStageDoesNotStart: playTarget === null && folderDoesNotStart,
    onStageNamedElsewhere: true,
    copy: playTarget !== null,
    known: buildsRead,
    needsChoice:
      quietShell !== null && (quietShell.hasPendingApprovals || quietShell.hasPendingUserInput),
    keepGoingStep: keepGoingHere ? keepGoingStatus.step : null,
    keepGoingLive: keepGoingHere,
    keepGoingStartsAt,
    turnRunning,
    turnStartedAt: turnStartedAt === null ? null : Date.parse(turnStartedAt),
    nextBuild: nextBuildNumber,
    operation: building ? { text: buildingMessage, since: buildingStartedAt } : null,
    live: stageKind === "live",
    changedSince: playTarget === null ? (changedSince ?? null) : null,
    measured: hasBuild,
    landing,
    restoring:
      turnUndo.restoring && turnUndo.view !== null && turnUndo.action !== null
        ? `${turnUndo.action.kind === "redo" ? "Redoing" : turnUndo.action.kind === "undo" ? "Undoing" : "Going back to"} ${buildPhrase(buildName(turnUndo.view.build))}…`
        : null,
  });
  const keepGoingMaking =
    keepGoingHere && (keepGoingStatus.phase === "turn" || keepGoingStatus.phase === "waiting");
  const buildSlot: GameBuildSlot | null = keepGoingMaking
    ? {
        label: keepGoingStatus.step === null ? "Next step" : `Step ${keepGoingStatus.step}`,
        name: keepGoingStatus.step === null ? "Next step" : `Step ${keepGoingStatus.step}`,
        caption: keepGoingStatus.proposal?.summary ?? null,
        keepGoing: true,
      }
    : turnRunning || landing
      ? {
          label: landing ? `Saving build ${nextBuildNumber}` : `Making build ${nextBuildNumber}`,
          name: `Build ${nextBuildNumber}`,
          caption: turnRequest ?? slotRequest,
          keepGoing: false,
          saving: landing,
        }
      : null;
  return (
    <section
      ref={stageRef}
      data-game-stage="true"
      data-fullscreen-ready={stageKind !== "window" && phase.kind === "playing" ? "" : undefined}
      aria-label={`${gameName} game stage`}
      aria-hidden={hidden}
      inert={hidden}
      tabIndex={-1}
      onFocus={(event) => setGameFocused(isFolderGameFrame(event.target))}
      onBlur={(event) => {
        if (isFolderGameFrame(event.target)) setGameFocused(false);
      }}
      onKeyDown={(event) => {
        // Esc clears the selection when the Stage itself has focus; a focused game sends it up
        // as studio-key. Tab is never kept here: it moves on, like everywhere else.
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey)
          return;
        if (event.key === "Escape" && useStageBridge.getState().selected !== null) {
          event.preventDefault();
          clearStageSelection();
        }
      }}
      className={cn(
        "relative min-w-0 flex-none flex-col bg-background outline-none",
        hidden ? "hidden" : "flex",
      )}
    >
      <header className="@container/stage-header relative flex shrink-0 flex-col bg-background">
        <div
          data-game-topbar=""
          className={cn(
            // The name's text, not its button, starts on the column's one text edge (the
            // Stage, the strip's label and captions, the tray), so the button hangs left. A
            // height-bound Stage's column is centred, and the row spans it: its right group
            // ends on the Stage's edge, over the game rather than an empty margin.
            "mx-auto flex h-(--workspace-topbar-height) w-full min-w-0 items-center gap-1.5 px-2 pl-3",
            // The window is dragged by its top bar; its buttons stay clickable.
            isElectron && "drag-region",
            // With the sidebar collapsed, its toggle (and macOS's traffic lights) sit over this
            // corner, but only a column that starts under them steps aside: a centred one keeps
            // its title on the Stage's edge.
            titleUnderControls && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            // With the Inspector hidden, the top bar runs under the desktop window controls.
            !panelOpen && "wco:pr-(--workspace-native-controls-inset)",
          )}
        >
          {renamingGame && quietShell !== null ? (
            <GameNameInput
              name={gameName}
              onRename={(name) => void renameGame(quietShell.projectId, name)}
              onDone={() => setRenamingGame(false)}
              className="-ms-2.5 me-1 w-56"
            />
          ) : (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${gameName}, game menu`}
                    // The name keeps its room before the status line gives up any of its own.
                    className="-ms-2.5 min-w-0 max-w-1/2 shrink-0"
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
                <MenuItem onClick={() => showGameTab(threadRef, "look")}>
                  <PaletteIcon />
                  Look…
                </MenuItem>
                <MenuSeparator />
                <MenuItem onClick={() => void navigate({ to: "/settings/game-tools" })}>
                  <WrenchIcon />
                  Game tools…
                </MenuItem>
              </MenuPopup>
            </Menu>
          )}
          <GameStatusLine status={statusLine} />
          {/* An earlier build on the Stage says so in the line it already has, and its way back
              sits beside it: nothing is inserted over the Stage, so the column never moves. */}
          {playTarget !== null ? (
            <Button size="xs" variant="outline" className="shrink-0" onClick={backToLive}>
              <HistoryIcon aria-hidden="true" />
              Back to the current game
            </Button>
          ) : null}
          <span data-topbar-spacer="" className="min-w-2 flex-1" />
          <IconAction
            label={undoLabel}
            detail={undoDetail}
            shortcut={undoKey}
            disabled={!turnUndoAllowed("undo")}
            onClick={() => handleRequest({ kind: "undo" }, 0)}
          >
            <Undo2Icon className="size-3.5" aria-hidden="true" />
          </IconAction>
          <IconAction
            label={redoLabel}
            shortcut={redoKey}
            disabled={!turnUndoAllowed("redo")}
            onClick={() => handleRequest({ kind: "redo" }, 0)}
          >
            <Redo2Icon className="size-3.5" aria-hidden="true" />
          </IconAction>
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Stage actions"
                        data-game-stage-more=""
                      />
                    }
                  />
                }
              >
                <MoreHorizontalIcon className="size-3.5" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Stage actions</TooltipPopup>
            </Tooltip>
            {/* The game's own things (name, folder, export, tools) live under its name; this
                menu is only what plays on the Stage, and says so. */}
            <MenuPopup align="end">
              <MenuGroup>
                <MenuGroupLabel>On the Stage</MenuGroupLabel>
                {engine.stageBridge && stageKind === "live" ? (
                  <MenuItem
                    disabled={phase.kind !== "playing" || bridgeStatus === null}
                    onClick={() => {
                      toggleStageFreeze();
                      // Focus the Stage, so Esc works here for a game without the bridge's keys.
                      stageRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    <CrosshairIcon />
                    {frozen ? "Play on" : "Freeze to point at things"}
                    {freezeKey === null ? null : <MenuShortcut>{freezeKey}</MenuShortcut>}
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
                    {fullscreenKey === null ? null : <MenuShortcut>{fullscreenKey}</MenuShortcut>}
                  </MenuItem>
                ) : null}
                {hasSteps ? (
                  <MenuItem onClick={() => setReelOpen(!reelOpen)}>
                    <FilmIcon />
                    {reelOpen ? "Close keep going's reel" : "Keep going's reel"}
                  </MenuItem>
                ) : null}
              </MenuGroup>
              <MenuSeparator />
              <MenuItem
                disabled={!canAct || !runningSomething}
                onClick={() => void perform("stop")}
              >
                <CircleStopIcon />
                Stop the game
              </MenuItem>
            </MenuPopup>
          </Menu>
          <GameKeepGoingButton threadRef={threadRef} />
          {
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={tuneShown ? "Hide Tune" : "Tune the game"}
                    aria-pressed={tuneShown}
                    onClick={() => toggleGameTab(threadRef, "tune")}
                  />
                }
              >
                <SlidersHorizontalIcon className="size-3.5" aria-hidden="true" />
                Tune
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                <TooltipLabel shortcut={inspectorKey}>
                  Live values: jump height, speeds, timers
                </TooltipLabel>
              </TooltipPopup>
            </Tooltip>
          }
        </div>
      </header>
      {/* Hidden, the game stays mounted out of sight, so showing it again keeps its progress. */}
      <div className={collapsed ? "hidden" : "contents"}>
        {compare !== null ? (
          // In the game's own place and size, so the chat under it never moves.
          <div
            className="mx-auto flex w-full flex-col"
            style={
              stageFit === null ? undefined : { height: stageFit.height, maxWidth: stageFit.width }
            }
          >
            <GameBuildCompare
              threadRef={threadRef}
              pair={compare}
              viewport={data.viewport}
              gameName={gameName}
              hidden={hidden}
              inspectorOpen={buildTabShown}
              onPair={setCompare}
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
            data-stage-fit=""
            className={
              compare === null
                ? cn(
                    "group/stage relative flex min-h-0 items-center justify-center self-center overflow-hidden rounded-xl bg-stage-well [container-type:size]",
                    stageFit === null ? "flex-1" : "shrink-0",
                  )
                : "hidden"
            }
            style={
              compare === null && stageFit !== null
                ? { height: stageFit.height, width: stageFit.width }
                : undefined
            }
          >
            <GameFrameBox viewport={data.viewport} gameName={gameName} playing>
              {playTarget.result._tag === "web" ? (
                <GameFrame
                  key={`${playTarget.build}\0${playTarget.result.url}`}
                  url={playTarget.result.url}
                  title={`${gameName}, ${playTarget.label}`}
                  gameName={gameName}
                  hidden={hidden || collapsed || compare !== null}
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
          data-stage-fit=""
          className={
            playTarget === null && compare === null
              ? cn(
                  "relative flex min-h-0 flex-col self-center",
                  stageFit === null
                    ? "aspect-video w-full max-w-(--chat-content-max-width)"
                    : "shrink-0",
                )
              : "hidden"
          }
          style={playTarget === null && compare === null ? stageFitStyle : undefined}
        >
          {noWebGl ? <NoWebGlCard /> : null}
          {/* Inside the Stage's own edges: a build that does not start says so in the Stage's
            middle, with the way to fix it and the way back; any other error lies over the
            Stage's top edge. Neither takes a row, so the Stage keeps its size. */}
          {folderDoesNotStart && failureVisible !== null && stageBuildName !== null ? (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6">
              {/* Its own dark backing: the words never depend on what the dead game painted. */}
              <div className="pointer-events-auto flex max-w-lg min-w-0 flex-col items-center gap-2 rounded-xl bg-stage-well px-6 py-5 text-center text-stage-foreground shadow-lg">
                <TriangleAlertIcon className="size-5 text-destructive" aria-hidden="true" />
                <Text variant="label" tone="inherit" render={<p role="alert" />}>
                  {`${stageBuildName.charAt(0).toUpperCase()}${stageBuildName.slice(1)} does not start`}
                </Text>
                {/* What happened in plain words, then the error itself as its own detail, whole. */}
                <Text variant="meta" tone="inherit" render={<p className="opacity-75" />}>
                  An error in the game's code stops it before it starts.
                </Text>
                <Text
                  variant="caption"
                  tone="inherit"
                  render={
                    <p className="line-clamp-3 max-w-full rounded-md bg-white/6 px-2.5 py-1.5 text-left font-mono break-words" />
                  }
                >
                  {failureVisible.split("\n")[0] ?? failureVisible}
                </Text>
                <div className="mt-1 flex items-center gap-2">
                  {keepGoingStartsAt === null ? (
                    <Button size="sm" variant="overlay" onClick={() => onAskAgent(failurePrompt)}>
                      Ask your agent to fix it
                    </Button>
                  ) : (
                    // Keep going already has the agent's next step waiting, in the row above the
                    // composer: one route to the fix on screen, not two.
                    <Text variant="meta" tone="inherit" render={<p className="opacity-75" />}>
                      Keep going takes its next step at {keepGoingStartsAt}
                    </Text>
                  )}
                  {turnUndoAllowed("undo") ? (
                    <Button
                      size="sm"
                      variant="overlay"
                      onClick={() => handleRequest({ kind: "undo" }, 0)}
                    >
                      <Undo2Icon aria-hidden="true" />
                      Undo
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : statusBanner === null ? null : (
            <div className="absolute inset-x-0 top-0 z-20 overflow-hidden rounded-t-xl bg-background shadow-sm">
              {statusBanner}
            </div>
          )}
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
            onOpenTools={() => void navigate({ to: "/settings/game-tools" })}
            held={held}
            onTakeHeld={() => setFrameFold(playHeldFrame(frame))}
            onStudioMessage={onStudioMessage}
            focusRequest={focusRequest?.frame === "folder" ? focusRequest.n : 0}
            bridge={{ threadKey, enabled: engine.stageBridge, freezeKey }}
            overlay={<GameStageOverlay threadKey={threadKey} />}
          />
        </div>
      </div>
      <div
        data-game-controls=""
        className="mx-auto flex h-11 w-full shrink-0 items-center gap-1.5"
        style={{ maxWidth: column ?? undefined }}
      >
        {collapsed ? (
          <Button size="sm" variant="ghost" className="-ms-2" onClick={() => setGameHidden(false)}>
            <PanelTopOpenIcon aria-hidden="true" />
            Show the game
          </Button>
        ) : stageKind === "live" ? (
          <GameStagePlayControls
            threadRef={threadRef}
            playing={phase.kind === "playing" && compare === null}
            canReload={data.previewUrl !== null}
            onRestart={() => setFrameFold(reloadFrame(frame, Date.now()))}
            onFocus={() => handleRequest({ kind: "focus" }, Date.now())}
          />
        ) : null}
        <span className="min-w-2 flex-1" />
        <Popover open={buildsOpen} onOpenChange={setBuildsOpen}>
          <PopoverTrigger
            render={
              <Button size="sm" variant="ghost" aria-label="Builds" disabled={compare !== null} />
            }
          >
            <Text variant="meta" tone="default" truncate>
              {playTarget?.label ?? folderName ?? "No builds yet"}
            </Text>
            <ChevronDownIcon className="text-dim-foreground" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverPopup
            side="top"
            align="end"
            padding="compact"
            keepMounted
            className="max-w-[min(44rem,calc(100vw-2rem))]"
          >
            <GameBuildStrip
              hidden={false}
              cardWidth={STRIP_CARD_WIDTH}
              cardPicture={Math.floor((STRIP_CARD_WIDTH * 9) / 16)}
              // One caption line beside each picture: a timeline row, so the game keeps the height.
              compact
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
              onInspect={(build) => {
                inspectBuild({ threadKey, build: build.id, snapshot: build });
                showGameTab(threadRef, "build");
                setBuildsOpen(false);
              }}
            />
          </PopoverPopup>
        </Popover>
        {collapsed ? null : (
          <>
            <GameStageViewControls
              threadRef={threadRef}
              playing={phase.kind === "playing" && stageKind !== "window"}
              onFullscreen={toggleFullscreen}
              onFocus={() => handleRequest({ kind: "focus" }, Date.now())}
            />
            <IconAction label="Hide the game" side="top" onClick={() => setGameHidden(true)}>
              <PanelTopCloseIcon className="size-3.5" aria-hidden="true" />
            </IconAction>
          </>
        )}
      </div>
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Export</DialogTitle>
            <DialogDescription>
              Copies of the game you can share. They stay out of the game's history.
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
  detail = null,
  shortcut = null,
  disabled = false,
  side = "bottom",
  onClick,
  children,
}: {
  label: string;
  /** What it does, under its name and key in the tooltip, as a menu item's note. */
  detail?: string | null;
  /** Its key, shown in the tooltip beside the label. */
  shortcut?: string | null;
  disabled?: boolean;
  side?: "top" | "bottom";
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
            aria-label={detail === null ? label : `${label}. ${detail}`}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side={side} className="max-w-xs">
        <span className="flex flex-col gap-1">
          <TooltipLabel shortcut={shortcut}>{label}</TooltipLabel>
          {detail === null ? null : <span className="text-muted-foreground">{detail}</span>}
        </span>
      </TooltipPopup>
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
  const hints = status.map((part) => part.hint).filter((hint) => hint !== null);
  // The full line when it fits, else each phrase's short form: never an ellipsis mid-word. An
  // unseen copy of the full line is measured against the room the line has.
  const full = useRef<HTMLSpanElement | null>(null);
  const room = useRef<HTMLSpanElement | null>(null);
  const [short, setShort] = useState(false);
  const hasShort = status.some((part) => part.short !== null);
  useLayoutEffect(() => {
    const measured = full.current;
    const box = room.current;
    if (measured === null || box === null || !hasShort) return;
    // The line's room is its own width and the top bar's spacer after it.
    const spacer = box
      .closest("[data-game-topbar]")
      ?.querySelector<HTMLElement>("[data-topbar-spacer]");
    const check = () =>
      setShort(
        measured.scrollWidth > box.clientWidth + Math.max(0, (spacer?.clientWidth ?? 0) - 8) + 1,
      );
    check();
    // The unseen full line resizes when its words change, so it re-measures then too.
    return observeResize([box, measured, ...(spacer == null ? [] : [spacer])], check);
  }, [hasShort]);
  const parts = (shortForm: boolean) =>
    status.map((part, index) => (
      <span key={part.text} className="flex min-w-0 items-center gap-1.5">
        {/* A thin rule between what plays and the work under way: a phrase's own dots join
            its words, the rule parts two phrases. */}
        {index > 0 ? (
          <span aria-hidden="true" className="mx-0.5 h-3 w-px shrink-0 bg-border" />
        ) : null}
        {part.dot === "live" ? (
          <StatusDot tone="live" pulse />
        ) : part.dot === "failed" ? (
          // The mark the strip, the Stage and the Inspector give a build that does not start.
          <TriangleAlertIcon className="size-3 shrink-0 text-destructive" aria-hidden="true" />
        ) : null}
        <Text variant="meta" tone={part.strong ? "default" : "muted"} truncate>
          {shortForm ? (part.short ?? part.text) : part.text}
        </Text>
        {part.since === null ? null : (
          <Text variant="meta" tone="muted" numeric>
            <GameElapsed since={part.since} prefix="· " />
          </Text>
        )}
      </span>
    ));
  const line = (
    <span
      ref={room}
      role="status"
      className="relative flex min-w-0 shrink items-center gap-1.5 overflow-hidden whitespace-nowrap"
    >
      {parts(short && hasShort)}
      {hasShort ? (
        <span
          ref={full}
          aria-hidden="true"
          className="invisible absolute top-0 left-0 flex w-max items-center gap-1.5"
        >
          {parts(false)}
        </span>
      ) : null}
    </span>
  );
  if (hints.length === 0) return line;
  // The line is the app's most compressed sentence: hovering it says it in full.
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex min-w-0 shrink" />}>{line}</TooltipTrigger>
      <TooltipPopup side="bottom" align="start" className="max-w-sm">
        <span className="flex flex-col gap-1">
          {hints.map((hint) => (
            <span key={hint}>{hint}</span>
          ))}
        </span>
      </TooltipPopup>
    </Tooltip>
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
