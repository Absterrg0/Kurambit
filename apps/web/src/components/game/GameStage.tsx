import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { showWorkbench, toggleWorkbench, useWorkbenchShown } from "./gameWorkbenchPanel";
import { GameStageBar } from "./GameStageControls";
import {
  CircleStopIcon,
  ChevronDownIcon,
  PaletteIcon,
  DownloadIcon,
  FilmIcon,
  StepForwardIcon,
  FolderOpenIcon,
  PanelRightIcon,
  PanelTopCloseIcon,
  PanelTopOpenIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
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
import { type ChatWidth, gameEngineEntry, unavailableEngineMessage } from "@kurambit/contracts";
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
import { useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useStageRuns } from "./useStageRuns";
import { useStageRewind } from "./GameRunTimeline";
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
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Text } from "../ui/text";
import { Tooltip, TooltipLabel, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameBuildCompare } from "./GameBuildCompare";
import { GameBuildStill } from "./GameBuildStill";
import { GameHistory, type GameBuildSlot, type GameStripRequest } from "./GameHistory";
import { GameExports } from "./GameExports";
import { GameNameInput, useGameName, useRenameGame } from "./GameName";
import { GameStageOverlay } from "./GameStageOverlay";
import { CODE_MODEL_PREFIX } from "./gameArt.logic";
import {
  clearStageSelection,
  toggleStageFreeze,
  useStageBridge,
  useStageStill,
  keepBuildFrame,
  useBuildFrame,
  captureStageFrame,
  useThreadStageBridge,
  setStageDevView,
  stepStageFrame,
  useStageDevViews,
} from "./gameStageBridge";
import { useKeepGoing } from "./useKeepGoing";
import { clockTime } from "./keepGoing.logic";
import { buildName, buildPhrase, doesNotStart, undoOutcome } from "./gameBuilds.logic";
import { nextBuildOf } from "./GameLibraryStatus";
import { useBuildPlay, useBuildStop, useTurnUndo } from "./useBuildActions";
import { useTurnLanding } from "./useTurnLanding";
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

// The build the folder holds as the header's History button names it: "Build 4".
const folderBuildShort = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result)) return null;
  const build = result.value.builds.find((each) => each.id === result.value.current);
  return build === undefined
    ? null
    : build.number === null
      ? buildName(build)
      : `Build ${build.number}`;
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

/** The build the folder holds (its newest when edited since): the hidden game's picture. */
const currentBuildOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) =>
  AsyncResult.isSuccess(result)
    ? (result.value.builds.find((build) => build.id === result.value.current) ?? null)
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

/**
 * The widest the game's column grows: the chat's readable width from the Chat width setting, the
 * --chat-content-max-width index.css gives each choice, so its chat never reads as one long line.
 * Read from the setting, not the root's variable, which follows the setting a commit later.
 */
const readableColumn = (chatWidth: ChatWidth) =>
  chatWidth === "full"
    ? Number.POSITIVE_INFINITY
    : (chatWidth === "wide" ? 72 : 46) *
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
/** The least the chat under the game keeps, whatever its share: its composer and a reply. */
const CHAT_ROOM_MIN = 220;
/**
 * The game's size on the column it shares with the chat: its own shape, as wide as the column's
 * lane allows, as tall as the room left once the chat keeps its share below. `taken` is the
 * height of the Stage's own rows (its top bar and controls).
 */
const gameColumnFit = (
  centre: HTMLElement,
  taken: number,
  ratio: number,
  chatShare: number,
  chatWidth: ChatWidth,
) => {
  // The chat lane's own gutter (index.css .chat-composer-lane): 3rem from a 640px window, so the
  // game shares the chat's edges at every width.
  const gutter = window.matchMedia("(min-width: 640px)").matches ? 48 : 12;
  const lane = Math.min(readableColumn(chatWidth), centre.clientWidth - 2 * gutter);
  const chat = Math.max(CHAT_ROOM_MIN, chatShare * centre.clientHeight);
  const height = Math.floor(
    Math.max(0, Math.min(lane * ratio, centre.clientHeight - taken - chat)),
  );
  return { width: Math.floor(height / ratio), height };
};

/** The 12px between the Stage's bar and what is under it (its own spacer row). */
const BAR_GAP = 12;
/** The hero's side margin: the column's edges are the game's own, not the chat lane's 48px. */
const HERO_GUTTER = 24;
/** The top bar's one line of text: what of its height is not empty. */
const HEADER_LINE = 14;

/**
 * The hero's shapes, wide to tall. A three.js game draws at whatever size its frame has (the
 * shell's resize; the Screens check proves it from phone to 21:9 widescreen), so the empty chat's
 * Stage takes the free rectangle's own shape within these, and only past them leaves bands.
 */
const HERO_WIDEST = 21 / 9;
const HERO_TALLEST = 1;

/**
 * The Stage's size and place. A chat with messages shares the column (gameColumnFit) at the game's
 * own shape. An empty chat makes the game the hero, as Home does: the Stage fills the rectangle
 * inside the margins above the composer exactly, its shape clamped to 1:1 to 21:9, and only a
 * shape past the clamp is centred there (`pad`, above the game). `column` is the chat's lane either
 * way, so the composer stays where it sits in a chat with messages and never jumps.
 */
const stageFitOf = (
  centre: HTMLElement,
  taken: number,
  ratio: number,
  chatShare: number,
  chatWidth: ChatWidth,
  hero: boolean,
  device: boolean,
) => {
  const shared = gameColumnFit(centre, taken, ratio, chatShare, chatWidth);
  // The responsive view takes the column's width and all the height the chat can give, the same
  // for every device, so switching one or dragging its size never moves the chat.
  if (device)
    return {
      width: shared.width,
      height: Math.floor(Math.max(shared.height, centre.clientHeight - taken - CHAT_ROOM_MIN)),
      pad: 0,
      column: shared.width,
    };
  if (!hero) return { ...shared, pad: 0, column: shared.width };
  const overlay = centre.querySelector<HTMLElement>("[data-chat-composer-overlay]");
  const room = overlay?.offsetHeight ?? 0;
  const available = Math.max(0, centre.clientHeight - taken - room);
  const across = Math.max(0, centre.clientWidth - 2 * HERO_GUTTER);
  const shape = Math.min(HERO_WIDEST, Math.max(HERO_TALLEST, across / Math.max(1, available)));
  const height = Math.floor(Math.min(available, across / shape));
  const width = Math.floor(height * shape);
  // A shape past the clamp leaves free height: split so the two empty bands look even. Above,
  // the top bar's empty lower half (its one line of text is centred) and `pad`; below, the rest
  // of `available`, the bar's 12px and the composer's own top padding.
  const topbar = centre.querySelector<HTMLElement>("[data-game-topbar]");
  const above = topbar === null ? 0 : Math.max(0, (topbar.offsetHeight - HEADER_LINE) / 2);
  const below =
    BAR_GAP + (overlay === null ? 0 : Number.parseFloat(getComputedStyle(overlay).paddingTop) || 0);
  const free = available - height;
  const pad = free <= 0 ? 0 : Math.max(0, Math.min(free, Math.round((free + below - above) / 2)));
  return { width, height, pad, column: shared.width };
};

/** The folder's own game frame, not a build copy's. */
const isFolderGameFrame = (target: EventTarget | null) =>
  target instanceof HTMLIFrameElement && target.closest('[data-game-play-surface="true"]') !== null;

/** How long after leaving the game the person still counts as playing it. */
const PLAYER_GRACE_MS = 4000;

/**
 * The person is playing: the Stage's game frame has the keyboard, or had it a moment ago. A click
 * into the frame sends no focus event to it, the app's window only blurs, so the frame is read
 * as the document's focused element whenever focus moves.
 */
function usePlayerInGame(stageRef: { readonly current: HTMLElement | null }): boolean {
  const [playerIn, setPlayerIn] = useState(false);
  useEffect(() => {
    let grace = 0;
    let settle = 0;
    const read = () => {
      const active = document.activeElement;
      window.clearTimeout(grace);
      if (isFolderGameFrame(active) && stageRef.current?.contains(active) === true)
        setPlayerIn(true);
      else grace = window.setTimeout(() => setPlayerIn(false), PLAYER_GRACE_MS);
    };
    // The frame is the focused element only once the blur has settled.
    const onBlur = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(read);
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", read);
    document.addEventListener("focusin", read);
    return () => {
      window.clearTimeout(grace);
      window.clearTimeout(settle);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", read);
      document.removeEventListener("focusin", read);
    };
  }, [stageRef]);
  return playerIn;
}

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
export function GameStageLoading({ hero = false }: { hero?: boolean } = {}) {
  const chatShare = useGameWorkspaceStore((state) => state.chatShare);
  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  const sectionRef = useRef<HTMLElement>(null);
  const [fit, setFit] = useState<{ width: number; height: number; marginTop: number } | null>(null);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const centre = section?.closest<HTMLElement>("[data-game-centre]");
    if (section == null || centre == null) return;
    const measure = () => {
      let taken = 0;
      for (const child of section.children)
        if (child instanceof HTMLElement && child.dataset.stageFit === undefined)
          taken += child.offsetHeight;
      const next = stageFitOf(centre, taken, 9 / 16, chatShare, chatWidth, hero, false);
      setFit({ width: next.width, height: next.height, marginTop: next.pad });
      // The composer under it already ends where the chat's lane will.
      centre.style.setProperty("--chat-content-max-width", `${next.column}px`);
    };
    measure();
    const stop = observeResize([centre], measure);
    return () => {
      stop();
      centre.style.removeProperty("--chat-content-max-width");
    };
  }, [chatShare, chatWidth, hero]);
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
  /** The chat has no messages: the game takes the column but for the composer. */
  hero?: boolean;
}

function ThreadGameStage({
  threadRef,
  turnRunning,
  onAskAgent,
  hidden = false,
  turnRequest = null,
  hero = false,
}: GameStageProps) {
  const navigate = useNavigate();
  // Hidden by the person: the chat takes the column, and the game pauses and mutes.
  const collapsed = useGameWorkspaceStore((state) => state.gameHidden);
  const setGameHidden = useGameWorkspaceStore((state) => state.setGameHidden);
  const pauseWhenAway = useGameWorkspaceStore((state) => state.pauseWhenAway);
  const setPauseWhenAway = useGameWorkspaceStore((state) => state.setPauseWhenAway);
  const workbenchShown = useWorkbenchShown();
  // A panel to the column's right takes the title bar's end, under the desktop window controls.
  const panelOpen =
    useRightPanelStore((state) => state.byThreadKey[scopedThreadKey(threadRef)]?.isOpen === true) ||
    workbenchShown;
  const workbenchTab = useGameWorkspaceStore((state) => state.workbenchTab);
  const query = useIsGameThreadStatus(threadRef);
  const canAct = useAtomValue(gameEnvironment.action.permissionAtom(threadRef.environmentId));
  const action = useAtomCommand(gameEnvironment.action, { reportFailure: false });
  const runs = useStageRuns(threadRef);
  const rewind = useStageRewind(threadRef, runs.receive);
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [compare, setCompare] = useState<readonly [GameBuildRef, GameBuildRef] | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const threadKey = scopedThreadKey(threadRef);
  // Paused by the person, to point at things.
  const frozen = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const devCapable = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("dev"),
    false,
  );
  const devViews = useStageDevViews(threadKey);
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
  // The fold of what the play surface runs across reads; state, so the render
  // below can pin this serve without touching refs.
  const [frameFold, setFrameFold] = useState<GameFrameFold | null>(null);
  // A reload into play waiting while the page hands over its run, so the next one resumes it.
  const [leavingFold, setLeavingFold] = useState<GameFrameFold | null>(null);
  // The build the mounted frame plays, for telling a new build from a live edit of the same one.
  const [frameBuild, setFrameBuild] = useState<string | null>(null);
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
  const [liveShown, setLiveShown] = useState<number | null>(null);
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
  const buildsAtom = gameEnvironment.builds({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const hasBuild = useEnvironmentQuerySelector(buildsAtom, hasAnyBuild) === true;
  const folderShort = useEnvironmentQuerySelector(buildsAtom, folderBuildShort);
  const stageBuildName = useEnvironmentQuerySelector(buildsAtom, folderBuildPhrase);
  const changedSince = useEnvironmentQuerySelector(buildsAtom, changedSincePhrase);
  const folderDoesNotStart = useEnvironmentQuerySelector(buildsAtom, folderDoesNotStartOf) === true;
  const undoName = turnUndo.view === null ? null : buildPhrase(buildName(turnUndo.view.build));
  // On a game changed since its build, the restore keeps those changes as a build of their own.
  // The control names the build; the sentences under it are the build menu's own.
  // A control that cannot act names nothing: after an undo, "Undo build 6" would name a build
  // the folder no longer holds.
  const undoNamed = undoName !== null && turnUndoAllowed("undo");
  const undoLabel = undoNamed ? `Undo ${undoName}` : "Undo";
  const undoDetail = undoNamed ? undoOutcome(undoBaseName ?? null, changedSince != null) : null;
  const redoLabel = undoName !== null && turnUndoAllowed("redo") ? `Redo ${undoName}` : "Redo";
  const nextBuildNumber = useEnvironmentQuerySelector(buildsAtom, nextBuildOf);
  const hasSteps = useEnvironmentQuerySelector(buildsAtom, hasStepsOf);
  const buildsRead = useEnvironmentQuerySelector(buildsAtom, AsyncResult.isSuccess);
  // Which live change the frame shows: held while this chat's turn runs and its build is saved,
  // so the Stage switches games together with its label; the latest otherwise.
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
  // The turn making the first build passed a clean check: from then its game plays here while
  // the turn goes on, said "First playable"; the turn's end swaps build 1 in like any new build.
  const cleanCheckAt = query.data?.cleanCheckAt ?? null;
  const [firstPlayableTurn, setFirstPlayableTurn] = useState<string | null>(null);
  const firstPlayableReady =
    buildsRead &&
    !hasBuild &&
    turnRunning &&
    turnStartedAt !== null &&
    cleanCheckAt !== null &&
    Date.parse(cleanCheckAt) >= Date.parse(turnStartedAt);
  if (firstPlayableReady && firstPlayableTurn !== turnStartedAt) {
    setFirstPlayableTurn(turnStartedAt);
    setLiveShown(live.revision);
  }
  const firstPlayable =
    firstPlayableTurn !== null && firstPlayableTurn === turnStartedAt && buildsRead && !hasBuild;
  const stageStill = useStageStill(threadKey);
  // A frame the folder's game showed is the picture of the build the folder holds, unless a
  // turn is changing the folder under it. Only a new frame is kept, never one from before.
  const folderBuild = useEnvironmentQuerySelector(buildsAtom, folderBuildIdOf) ?? null;
  const currentBuild = useEnvironmentQuerySelector(buildsAtom, currentBuildOf) ?? null;
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
  const playerIn = usePlayerInGame(stageRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
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
  const liveStaged =
    data != null &&
    data.unsupported === undefined &&
    gameEngineEntry(data.manifest.engine.name)?.stage === "live";
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
    pad: number;
  } | null>(null);
  // The column the game shares with its chat and composer: the fitted game's width.
  const [column, setColumn] = useState<number | null>(null);
  const comparing = compare !== null;
  // The responsive view: the game's frame at a device's size, under the device toolbar.
  const stageDevice = useGameWorkspaceStore((state) => state.stageDevice[threadKey] ?? null);
  const setStageDevice = useGameWorkspaceStore((state) => state.setStageDevice);
  const toggleStageDevice = useGameWorkspaceStore((state) => state.toggleStageDevice);
  const deviceOn = stageDevice !== null;
  const chatShare = useGameWorkspaceStore((state) => state.chatShare);
  const chatWidth = useClientSettings((settings) => settings.chatWidth);
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
      const fit = stageFitOf(
        centre,
        taken,
        viewportHeight / viewportWidth,
        chatShare,
        chatWidth,
        hero,
        deviceOn,
      );
      const next = { width: fit.width, height: fit.height, pad: fit.pad };
      setStageFit((previous) =>
        previous !== null &&
        Math.abs(previous.width - next.width) <= 1 &&
        Math.abs(previous.height - next.height) <= 1 &&
        Math.abs(previous.pad - next.pad) <= 1
          ? previous
          : next,
      );
      setColumn((previous) =>
        previous !== null && Math.abs(previous - fit.column) <= 1 ? previous : fit.column,
      );
    };
    measure();
    if (centre === null) return;
    // The composer's own height is the hero's room: it is watched too.
    const overlay = centre.querySelector<HTMLElement>("[data-chat-composer-overlay]");
    return observeResize(
      [
        centre,
        ...(hero && overlay !== null ? [overlay] : []),
        ...[...section.children].filter(
          (child) => !(child instanceof HTMLElement && child.dataset.stageFit !== undefined),
        ),
      ],
      measure,
    );
  }, [viewportWidth, viewportHeight, comparing, chatShare, chatWidth, hero, deviceOn]);
  // The empty chat's Stage has its own shape, and the game takes it; else the game's viewport.
  const frameViewport =
    hero && stageFit !== null && stageFit.height > 0
      ? { width: stageFit.width, height: stageFit.height }
      : data?.viewport;
  const stageFitStyle =
    stageFit === null
      ? undefined
      : { height: stageFit.height, width: stageFit.width, marginTop: stageFit.pad };
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
      case "history":
        setHistoryOpen(true);
        return;
      case "generated-art":
        showWorkbench("art");
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
  // A build's copy: its runs are kept on that build, as the folder's are on its own. Its bridge
  // wakes on the Stage's first message, and only plays are taken from it.
  const [copyFrame, setCopyFrame] = useState<HTMLIFrameElement | null>(null);
  const onCopyStudioMessage = useStableCallback((studio: StudioMessage) => {
    if (studio.type === "studio-ready")
      copyFrame?.contentWindow?.postMessage({ type: "studio-things-request" }, "*");
    if (asked !== null && (studio.type === "studio-play" || studio.type === "studio-run-reset"))
      runs.receive(studio, asked.build);
  });
  const onStudioMessage = useStableCallback((studio: StudioMessage) => {
    // A run, ended or left: kept, so the agent hears of it, a later build can play it again,
    // and the person can save it as a test play.
    if (studio.type === "studio-play" || studio.type === "studio-run-reset") {
      runs.receive(studio);
      rewind.receive(studio);
      return;
    }
    const key = frameFold?.key ?? "";
    // Only an error sets it: the page's ready can follow an error its own start threw, and a
    // reload clears it by its frame key.
    if (studio.type === "studio-error") setStudioError({ key, text: studio.message });
  });
  // Pointing at a thing on the Stage opens it in the Workbench: in Art (its inspector) when Art
  // is showing or it has no values to tune (a part, a model), else its values in Tune.
  const selectedThing = useThreadStageBridge(
    threadKey,
    (state) => state.selected?.thing.id ?? null,
    null,
  );
  useEffect(() => {
    if (selectedThing === null) return;
    const thing = useStageBridge.getState().selected?.thing;
    const workspace = useGameWorkspaceStore.getState();
    const inArt = workspace.workbenchOpen && workspace.workbenchTab === "art";
    if (thing !== undefined && (inArt || (thing.values?.length ?? 0) === 0)) {
      workspace.setArtAsset(thing.asset?.path ?? `${CODE_MODEL_PREFIX}${thing.id}`);
      showWorkbench("art");
    } else showWorkbench("tune");
  }, [selectedThing]);
  const takesRuns = useThreadStageBridge(
    threadKey,
    (state) => state.status === "ready" && state.capabilities.includes("rewind"),
    false,
  );
  const applyFold = useStableCallback((next: GameFrameFold) => {
    if (next.key !== frameFold?.key) {
      setFrameBuild(folderBuild);
      setHeldBuild(false);
    }
    setFrameFold(next);
  });
  /** The held game the person asked for: into play, so its run is taken first. */
  const showFold = (next: GameFrameFold) => {
    if (frameFold !== null && next.key !== frameFold.key && next.intoPlay && takesRuns)
      setLeavingFold(next);
    else applyFold(next);
  };
  const leavingKey = leavingFold?.key ?? null;
  const applyLeaving = useStableCallback(() => {
    if (leavingFold === null) return;
    setLeavingFold(null);
    applyFold(leavingFold);
  });
  const leaveStage = rewind.leave;
  useEffect(() => {
    if (leavingKey !== null) void leaveStage().then(applyLeaving);
  }, [leavingKey, leaveStage, applyLeaving]);

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
      <GameStageLoading hero={hero} />
    ) : null;
  // Null for a game in an engine this version does not have, or one it no longer plays (made on
  // the older demo shell): it opens and plays nothing.
  const engine = data.unsupported === undefined ? gameEngineEntry(data.manifest.engine.name) : null;
  const stageKind = engine?.stage ?? null;
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
    parked:
      engine === null
        ? (data.unsupported ?? unavailableEngineMessage(data.manifest.engine.name))
        : null,
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
    turnLoop: engine?.turnLoop === true,
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
  // A game in an engine this version does not have builds and plays nothing here.
  const webPlay = engine !== null && data.exportTargets.includes("Web");
  const playEnabled =
    !awaitingTurnBuild && webPlay && canAct && (data.previewUrl !== null || !building);
  const stagingEnabled = canAct && !building;
  const rebuildEnabled = stagingEnabled && webPlay && !awaitingTurnBuild;
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
  // An Undo or Redo changes the folder before its build list says so.
  const newBuild =
    turnUndo.restoring ||
    heldBuild ||
    (frameBuild !== null && folderBuild !== null && frameBuild !== folderBuild);
  const computed = remountOrHold(
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
      focused: playerIn && !frameHidden,
      hidden: frameHidden,
      newBuild,
    },
  );
  // A reload into play first takes the run in play from the page, which the page that comes up
  // replays to where it was (useStageRewind); the old page stays until it answered.
  const leaving =
    frameFold !== null &&
    computed.key !== frameFold.key &&
    computed.intoPlay &&
    takesRuns &&
    !frameHidden;
  if (leaving) {
    if (leavingFold?.key !== computed.key) setLeavingFold(computed);
  } else if (computed !== frameFold) {
    setFrameFold(computed);
    if (computed.key !== frameFold?.key) {
      setFrameBuild(folderBuild);
      setHeldBuild(false);
    }
  } else if (frameBuild === null && folderBuild !== null) setFrameBuild(folderBuild);
  const frame = leaving && frameFold !== null ? frameFold : computed;
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
      : stageKind === "live" && !newBuild
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
  const inspectorKey = shortcutLabelForCommand(keybindings, "game.workbench.toggle", {
    context: { gameThread: true },
  });
  const devKey = (
    command: "game.stepFrame" | `game.${"freeCamera" | "bounds" | "frameRate"}.toggle`,
  ) => shortcutLabelForCommand(keybindings, command, { context: { gameThread: true } });
  const stepKey = devKey("game.stepFrame");
  const freeCameraKey = devKey("game.freeCamera.toggle");
  const boundsKey = devKey("game.bounds.toggle");
  const frameRateKey = devKey("game.frameRate.toggle");
  const responsiveKey = shortcutLabelForCommand(keybindings, "game.responsive.toggle", {
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
  const dismissNotice = () => {
    setError(null);
    setMessage(null);
    setPlayRef(null);
    setDismissedRevision(operation?.revision ?? null);
    setStudioError(null);
  };
  // The Stage's one small line, at its bottom-left: an error while playing, else the last thing
  // said (a save, an action's answer), else a stale export. Each can be dismissed.
  const stageToast =
    failureVisible !== null ? (
      <StageToast tone="error" onDismiss={dismissNotice} detail={failureVisible}>
        <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <span className="truncate">{errorWhere(failureVisible)}</span>
        <Button size="xs" variant="link" onClick={() => onAskAgent(failurePrompt)}>
          Ask the agent
        </Button>
      </StageToast>
    ) : liveError !== null && !noWebGl ? (
      // Mid-turn, a save may be half-written: the error is named, not alarmed.
      <StageToast tone="muted" onDismiss={dismissNotice} detail={liveError}>
        <span className="truncate">The game threw while your agent edits it</span>
      </StageToast>
    ) : noticeVisible !== null ? (
      <StageToast tone="muted" onDismiss={dismissNotice} detail={noticeVisible}>
        <span className="truncate">{noticeVisible}</span>
      </StageToast>
    ) : staleChipVisible ? (
      <StageToast tone="muted" detail="This web export is older than the latest changes">
        <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
        <span className="truncate">Web export is older than the changes</span>
        <Button
          size="xs"
          variant="link"
          disabled={!rebuildEnabled}
          onClick={() => void perform("rebuild")}
        >
          Rebuild
        </Button>
      </StageToast>
    ) : null;
  // A live game's folder plays an empty page until the first build lands;
  // the Stage says what is being made instead of showing a game that is not yet one.
  const shownPhase: typeof phase =
    stageKind === "live" &&
    buildsRead &&
    !hasBuild &&
    !firstPlayable &&
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
  // The header names what plays: a copy by its own name, else the folder's build.
  const historyLabel = playTarget?.label ?? folderShort ?? (hasBuild ? "History" : "No builds yet");
  const keepGoingMaking =
    keepGoingHere && (keepGoingStatus.phase === "turn" || keepGoingStatus.phase === "waiting");
  const buildSlot: GameBuildSlot | null = keepGoingMaking
    ? {
        label: `Making build ${nextBuildNumber}`,
        name: `Build ${nextBuildNumber} · Keep going`,
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
      onKeyDown={(event) => {
        // Esc clears the selection when the Stage itself has focus; a focused game sends it up
        // as studio-key.
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey)
          return;
        if (event.key === "Escape" && useStageBridge.getState().selected !== null) {
          event.preventDefault();
          clearStageSelection();
          return;
        }
        if (event.key === "Escape" && stageDevice !== null) {
          event.preventDefault();
          setStageDevice(threadKey, null);
          return;
        }
        // Any other key on the Stage itself is meant for the game: no app key reads it (a
        // waiting question's number keys, Tab moving on), and the game takes the keyboard.
        event.stopPropagation();
        if (event.key === "Tab") event.preventDefault();
        handleRequest({ kind: "focus" }, Date.now());
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
          {/* Hidden, the game folds into this row: its picture beside its name. */}
          {collapsed && currentBuild !== null ? (
            <GameBuildStill
              threadRef={threadRef}
              gameName={gameName}
              build={currentBuild}
              mark="blank"
              className="me-2 h-6 w-10 shrink-0 rounded-sm"
            />
          ) : null}
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
                <MenuItem disabled={engine === null} onClick={() => setExportOpen(true)}>
                  <DownloadIcon />
                  Export…
                </MenuItem>
                <MenuItem onClick={() => showWorkbench("art")}>
                  <PaletteIcon />
                  Art…
                </MenuItem>
                <MenuSeparator />
                <MenuItem onClick={() => void navigate({ to: "/settings/game-tools" })}>
                  <WrenchIcon />
                  Game tools…
                </MenuItem>
              </MenuPopup>
            </Menu>
          )}
          {/* What plays on the Stage, as a button that opens the game's History. */}
          <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
            <PopoverTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost-muted"
                  className="min-w-0 shrink"
                  aria-label={`${historyLabel}: History`}
                />
              }
            >
              <Text variant="label" tone="inherit" truncate>
                {historyLabel}
              </Text>
              <ChevronDownIcon aria-hidden="true" />
            </PopoverTrigger>
            {/* Kept mounted: the chat's cards, the palette and the keys reach History's requests
                while it is closed. */}
            <PopoverPopup
              side="bottom"
              align="start"
              padding="compact"
              keepMounted
              className="w-[34rem]"
            >
              <GameHistory
                threadRef={threadRef}
                gameName={gameName}
                playing={playTarget?.build ?? null}
                slot={buildSlot}
                request={timelineRequest}
                reelOpen={reelOpen}
                open={historyOpen}
                onOpen={() => setHistoryOpen(true)}
                undo={{
                  canUndo: turnUndoAllowed("undo"),
                  canRedo: turnUndoAllowed("redo"),
                  undoLabel,
                  redoLabel,
                  undoDetail,
                  undoKey,
                  redoKey,
                  onUndo: () => handleRequest({ kind: "undo" }, 0),
                  onRedo: () => handleRequest({ kind: "redo" }, 0),
                }}
                onPlay={(build) => void playBuild(build)}
                onPlayUnlisted={(ref) => void playBuild(ref)}
                onLive={backToLive}
                onCompare={(pair) => {
                  setHistoryOpen(false);
                  setCompare(pair);
                }}
                // Checks follows the build picked here.
                onInspect={(build) => inspectBuild({ threadKey, build: build.id, snapshot: build })}
              />
            </PopoverPopup>
          </Popover>
          <span data-topbar-spacer="" className="min-w-2 flex-1" />
          {collapsed ? (
            <Button size="sm" variant="ghost" onClick={() => setGameHidden(false)}>
              <PanelTopOpenIcon aria-hidden="true" />
              Show the game
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={workbenchShown ? "Hide the Workbench" : "Show the Workbench"}
                  aria-pressed={workbenchShown}
                  onClick={() => toggleWorkbench()}
                />
              }
            >
              <PanelRightIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <TooltipLabel shortcut={inspectorKey}>Workbench</TooltipLabel>
            </TooltipPopup>
          </Tooltip>
        </div>
      </header>
      {/* Hidden, the game stays mounted out of sight, so showing it again keeps its progress. */}
      <div className={collapsed ? "hidden" : "contents"}>
        {compare !== null ? (
          // In the game's own place and size, so the chat under it never moves.
          <div
            className="mx-auto flex w-full flex-col"
            style={
              stageFit === null
                ? undefined
                : { height: stageFit.height, maxWidth: stageFit.width, marginTop: stageFit.pad }
            }
          >
            <GameBuildCompare
              threadRef={threadRef}
              pair={compare}
              viewport={data.viewport}
              gameName={gameName}
              hidden={hidden}
              inspectorOpen={workbenchShown && workbenchTab === "checks"}
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
            style={compare === null && stageFit !== null ? stageFitStyle : undefined}
          >
            <GameFrameBox viewport={frameViewport ?? data.viewport} gameName={gameName} playing>
              {playTarget.result._tag === "web" ? (
                <GameFrame
                  key={`${playTarget.build}\0${playTarget.result.url}`}
                  url={playTarget.result.url}
                  title={`${gameName}, ${playTarget.label}`}
                  gameName={gameName}
                  hidden={hidden || collapsed || compare !== null}
                  focusRequest={focusRequest?.frame === "copy" ? focusRequest.n : 0}
                  onFrame={setCopyFrame}
                  onStudioMessage={onCopyStudioMessage}
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
            middle, with the way to fix it and the way back; anything else is one small line at
            its bottom-left. Neither takes a row, so the Stage keeps its size. */}
          {folderDoesNotStart && failureVisible !== null && stageBuildName !== null ? (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6">
              {/* Its own dark backing: the words never depend on what the dead game painted. */}
              <div className="pointer-events-auto flex max-w-lg min-w-0 flex-col items-center gap-3 rounded-xl bg-stage-well px-6 py-5 text-center text-stage-foreground shadow-lg">
                <Text variant="label" tone="inherit" render={<p role="alert" />}>
                  {`${stageBuildName.charAt(0).toUpperCase()}${stageBuildName.slice(1)} doesn't start`}
                </Text>
                <Text
                  variant="caption"
                  tone="inherit"
                  mono
                  render={<p className="line-clamp-3 max-w-full break-words opacity-75" />}
                >
                  {failureVisible.split("\n")[0] ?? failureVisible}
                </Text>
                <div className="flex items-center gap-2">
                  {keepGoingStartsAt === null ? (
                    <Button size="sm" onClick={() => onAskAgent(failurePrompt)}>
                      Ask the agent to fix it
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
                      Undo
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            stageToast
          )}
          <GamePlaySurface
            phase={shownPhase}
            viewport={frameViewport ?? data.viewport}
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
            onTakeHeld={() => showFold(playHeldFrame(frame))}
            onStudioMessage={onStudioMessage}
            focusRequest={focusRequest?.frame === "folder" ? focusRequest.n : 0}
            bridge={{ threadKey, enabled: engine?.stageBridge === true }}
            overlay={<GameStageOverlay threadKey={threadKey} />}
            device={
              stageDevice === null || stageKind !== "live"
                ? null
                : {
                    value: stageDevice,
                    onChange: (next) => setStageDevice(threadKey, next),
                    shortcut: responsiveKey,
                  }
            }
          />
        </div>
      </div>
      <div
        data-game-controls=""
        className={cn("mx-auto h-9 w-full shrink-0 items-center", collapsed ? "hidden" : "flex")}
        // The bar spans the game, which is wider than the chat's lane while the chat is empty.
        style={{ maxWidth: stageFit?.width ?? column ?? undefined }}
      >
        {collapsed ? null : (
          <GameStageBar
            threadRef={threadRef}
            canLose={data.canLose !== false}
            playing={phase.kind === "playing" && compare === null && stageKind !== "window"}
            live={stageKind === "live" && playTarget === null && compare === null}
            stopped={folderDoesNotStart && failureVisible !== null && playTarget === null}
            canReload={
              stageKind === "live" &&
              playTarget === null &&
              compare === null &&
              data.previewUrl !== null
            }
            rewind={rewind}
            runs={runs}
            onRestart={() => setFrameFold(reloadFrame(frame, Date.now()))}
            onFullscreen={toggleFullscreen}
            viewItems={
              stageKind === "live" ? (
                <>
                  <MenuCheckboxItem
                    variant="switch"
                    checked={deviceOn}
                    onCheckedChange={() => toggleStageDevice(threadKey)}
                  >
                    Responsive view
                    {responsiveKey === null ? null : <MenuShortcut>{responsiveKey}</MenuShortcut>}
                  </MenuCheckboxItem>
                  {devCapable ? (
                    <>
                      <MenuCheckboxItem
                        variant="switch"
                        closeOnClick={false}
                        checked={devViews.bounds}
                        onCheckedChange={(on) => setStageDevView(threadKey, "bounds", on)}
                      >
                        Bounds
                        {boundsKey === null ? null : <MenuShortcut>{boundsKey}</MenuShortcut>}
                      </MenuCheckboxItem>
                      <MenuCheckboxItem
                        variant="switch"
                        closeOnClick={false}
                        checked={devViews.perf}
                        onCheckedChange={(on) => setStageDevView(threadKey, "perf", on)}
                      >
                        Frame rate
                        {frameRateKey === null ? null : <MenuShortcut>{frameRateKey}</MenuShortcut>}
                      </MenuCheckboxItem>
                      <MenuCheckboxItem
                        variant="switch"
                        closeOnClick={false}
                        checked={devViews.freeCamera}
                        onCheckedChange={(on) => setStageDevView(threadKey, "freeCamera", on)}
                      >
                        Free camera while frozen
                        {freeCameraKey === null ? null : (
                          <MenuShortcut>{freeCameraKey}</MenuShortcut>
                        )}
                      </MenuCheckboxItem>
                      <MenuItem
                        disabled={!frozen}
                        closeOnClick={false}
                        onClick={() => stepStageFrame(threadKey)}
                      >
                        <StepForwardIcon />
                        Step one frame
                        {stepKey === null ? null : <MenuShortcut>{stepKey}</MenuShortcut>}
                      </MenuItem>
                    </>
                  ) : null}
                </>
              ) : null
            }
            stageItems={
              <>
                {stageKind !== "window" ? (
                  <MenuCheckboxItem
                    variant="switch"
                    closeOnClick={false}
                    checked={pauseWhenAway}
                    onCheckedChange={setPauseWhenAway}
                  >
                    Pause when I click away
                  </MenuCheckboxItem>
                ) : null}
                {stageKind === "export" ? (
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
                {hasSteps ? (
                  <MenuItem onClick={() => setReelOpen(!reelOpen)}>
                    <FilmIcon />
                    {reelOpen ? "Close keep going's reel" : "Keep going's reel"}
                  </MenuItem>
                ) : null}
                <MenuItem onClick={() => setGameHidden(true)}>
                  <PanelTopCloseIcon />
                  Hide the game
                </MenuItem>
                <MenuItem
                  disabled={!canAct || !runningSomething}
                  onClick={() => void perform("stop")}
                >
                  <CircleStopIcon />
                  Stop the game
                </MenuItem>
              </>
            }
            onFocus={() => handleRequest({ kind: "focus" }, Date.now())}
            onNote={setMessage}
          />
        )}
      </div>
      {/* The 12px between the bar and the chat: no message starts against the controls. */}
      <div aria-hidden="true" className="h-3 shrink-0" />
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

/** Where an error happened, as its first line names it: "Error · main.js:85". */
const errorWhere = (error: string) => {
  const line = error.split("\n")[0] ?? error;
  const at = /([\w./-]+\.\w+:\d+)(?::\d+)?\)?\s*$/.exec(line)?.[1] ?? null;
  return at === null
    ? `Error · ${line.length > 48 ? `${line.slice(0, 47)}…` : line}`
    : `Error · ${at.split("/").at(-1)}`;
};

/** The Stage's one small line, over its bottom-left corner: what it says, in full on hover. */
function StageToast({
  tone,
  detail,
  onDismiss,
  children,
}: {
  tone: "error" | "muted";
  detail: string;
  onDismiss?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex max-w-[calc(100%-1.5rem)]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Text
              variant="caption"
              tone="inherit"
              role={tone === "error" ? "alert" : "status"}
              render={
                <div className="pointer-events-auto flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-black/70 ps-2 pe-1 text-stage-foreground backdrop-blur-sm" />
              }
            />
          }
        >
          {children}
          {onDismiss === undefined ? null : (
            <Button size="icon-micro" variant="overlay" aria-label="Dismiss" onClick={onDismiss}>
              <XIcon aria-hidden="true" />
            </Button>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top" align="start" className="max-w-sm whitespace-pre-wrap">
          {detail}
        </TooltipPopup>
      </Tooltip>
    </div>
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
