import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CircleStopIcon,
  CrosshairIcon,
  ChevronDownIcon,
  DownloadIcon,
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
import { useQuietThreadShell, useThreadCheckpointSummaries } from "../../state/entities";
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
import { Skeleton } from "../ui/skeleton";
import { StatusDot } from "../ui/status-dot";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameBuildCompare } from "./GameBuildCompare";
import { GameBuildStill } from "./GameBuildStill";
import { GameBuildStrip, type GameBuildSlot, type GameStripRequest } from "./GameBuildStrip";
import { GameExports } from "./GameExports";
import { GameNameInput, useGameName, useRenameGame } from "./GameName";
import { GameStageOverlay } from "./GameStageOverlay";
import {
  clearStageSelection,
  toggleStageFreeze,
  useStageAwayFreeze,
  useStageBridge,
  useStageStill,
  keepBuildFrame,
  useBuildFrame,
  captureStageFrame,
  useGameFreezeKey,
  useThreadStageBridge,
} from "./gameStageBridge";
import { useKeepGoing } from "./useKeepGoing";
import { buildName, buildPhrase, checksLine } from "./gameBuilds.logic";
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

/** The folder's build's picture, for the Stage to show faintly while the game loads. */
const folderBuildStill = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result)) return null;
  return result.value.builds.find((each) => each.id === result.value.current)?.still ?? null;
};

const hasAnyBuild = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) =>
  AsyncResult.isSuccess(result) && result.value.builds.length > 0;

/** The build the folder holds, unchanged since; null while it is edited or unknown. */
const folderBuildIdOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) =>
  AsyncResult.isSuccess(result) && result.value.folderEdited === false
    ? result.value.current
    : null;

/** The checks of the build the folder holds, in the words every surface uses. */
const folderChecksOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result) || result.value.folderEdited !== false) return null;
  const build = result.value.builds.find((each) => each.id === result.value.current);
  return build === undefined ? null : checksLine(build.facts);
};

/** The build the folder holds, as a sentence names it ("build 7"), unless edited since. */
const folderBuildPhrase = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result) || result.value.folderEdited === true) return null;
  const build = result.value.builds.find((each) => each.id === result.value.current);
  return build === undefined ? null : buildPhrase(buildName(build));
};

/** The folder's last build, as a sentence names it, when the folder changed since it. */
const changedSincePhrase = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result) || result.value.folderEdited !== true) return null;
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

/**
 * A build card's picture height bounds: its 160px floor, and a cap so the Stage stays the star.
 * Past the cap the cards stop growing: on a wide window they become a lane under the Stage
 * rather than three posters competing with it.
 */
const BUILD_CARD_PICTURE = { min: 90, max: 150 } as const;
/** The strip's gap between cards (gap-3), so three cards are sized to fit side by side. */
const BUILD_CARD_GAP = 12;
/**
 * The height kept under the strip for the rows that come and go above the composer: the
 * agent's note (two lines) and one suggestion. They appear as a turn runs and lands, and the
 * Stage must not shrink and re-centre each time; only rows past this budget take its height.
 */
const TRANSIENT_ROWS_RESERVE = 92;
/** How long a turn's build may take to be listed before the strip stops saying it is saved. */
const LANDING_CAP_MS = 30_000;
const TRANSIENT_ROWS =
  "[data-game-agent-note], [data-game-pointed], [data-game-direction-bar] [data-composer-banner-drawer]";

/**
 * PURE. The Stage's width and its cards' picture height, in a column `width` wide with `height`
 * for the Stage and one row of pictures. The game keeps its shape (`ratio`, height over width),
 * and three cards always span the Stage's width: a height-bound Stage gives up a little height so
 * the strip under it is one row as wide as the game, never a short row and a gap.
 */
const fitStage = (width: number, height: number, ratio: number) => {
  const picture = (stage: number) => (((stage - 2 * BUILD_CARD_GAP) / 3) * 9) / 16;
  const clamp = (value: number) =>
    Math.min(BUILD_CARD_PICTURE.max, Math.max(BUILD_CARD_PICTURE.min, value));
  let stage = width;
  if (stage * ratio + clamp(picture(stage)) > height) {
    // Where the game and three spanning cards exactly fill the height.
    stage = (height + (2 * BUILD_CARD_GAP * 9) / (3 * 16)) / (ratio + 9 / (3 * 16));
    const wanted = picture(stage);
    if (wanted !== clamp(wanted)) stage = (height - clamp(wanted)) / ratio;
  }
  const stageHeight = Math.floor(Math.max(0, Math.min(stage, width) * ratio));
  const stageWidth = Math.floor(stageHeight / ratio);
  return {
    width: stageWidth,
    height: stageHeight,
    cardWidth: Math.max(
      0,
      Math.floor(
        Math.min((stageWidth - 2 * BUILD_CARD_GAP) / 3, (BUILD_CARD_PICTURE.max * 16) / 9),
      ),
    ),
  };
};

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
  // Which live change the frame shows: held while this chat's turn runs, the latest otherwise.
  const [liveShown, setLiveShown] = useState<number | null>(null);
  const liveRevision = liveToShow({ latest: live.revision, shown: liveShown, turnRunning });
  if (liveRevision !== liveShown) setLiveShown(liveRevision);
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
  // Between a turn's end and its build being listed, the build is being saved: the strip keeps
  // its slot and the top bar says so, so nothing steps back to the build before. The turn's
  // checkpoint settles it: one with no changed files makes no build. Capped, so a save that
  // never reports cannot hold the slot for ever.
  const checkpoints = useThreadCheckpointSummaries(threadRef);
  const latestCheckpoint =
    latestRun === null ? undefined : checkpoints.find((entry) => entry.runId === latestRun.runId);
  const buildComing =
    latestCheckpoint === undefined ||
    (latestCheckpoint.status === "ready" && latestCheckpoint.files.length > 0);
  const [landingGaveUp, setLandingGaveUp] = useState<string | null>(null);
  const landingRun =
    !turnRunning &&
    sawTurnEnd &&
    latestRun !== null &&
    !endedTurnBuilt &&
    buildComing &&
    landingGaveUp !== latestRun.runId
      ? latestRun.runId
      : null;
  useEffect(() => {
    if (landingRun === null) return;
    const timeout = window.setTimeout(() => setLandingGaveUp(landingRun), LANDING_CAP_MS);
    return () => window.clearTimeout(timeout);
  }, [landingRun]);
  const landing = landingRun !== null;
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
  const changedSince = useEnvironmentQuerySelector(buildsAtom, changedSincePhrase);
  const nextBuildNumber = useEnvironmentQuerySelector(buildsAtom, nextBuildOf);
  const hasSteps = useEnvironmentQuerySelector(buildsAtom, hasStepsOf);
  const buildsRead = useEnvironmentQuerySelector(buildsAtom, AsyncResult.isSuccess);
  const posterStill = useEnvironmentQuerySelector(buildsAtom, folderBuildStill) ?? null;
  const stageStill = useStageStill(threadKey);
  // A frame the folder's game showed is the picture of the build the folder holds, unless a
  // turn is changing the folder under it. Only a new frame is kept, never one from before.
  const folderBuild = useEnvironmentQuerySelector(buildsAtom, folderBuildIdOf) ?? null;
  // One pane at a time, the Inspector's way in carries what it would show first.
  const folderChecks = useEnvironmentQuerySelector(buildsAtom, folderChecksOf) ?? null;
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
  } | null>(null);
  // The column the strip and composer share: the Stage's width, less any growth of the message
  // being written, so a longer message shrinks the Stage but never the composer under it.
  const [column, setColumn] = useState<number | null>(null);
  const comparing = compare !== null;
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
    const measure = () => {
      const strip = section.querySelector<HTMLElement>("[data-game-build-strip]");
      let taken = 0;
      for (const child of section.children)
        if (
          child instanceof HTMLElement &&
          child.dataset.stageFit === undefined &&
          child.dataset.stageSpacer === undefined &&
          child !== strip
        )
          taken += child.offsetHeight;
      // The strip less its pictures: they grow with what the Stage leaves over, so measuring
      // them in would chase their own growth. Both sides as rendered, unrounded: a rounded
      // picture height would move the chrome by a pixel per fit and never settle.
      const picture =
        strip
          ?.querySelector("[data-game-build-card], [data-game-build-slot]")
          ?.firstElementChild?.getBoundingClientRect().height ?? BUILD_CARD_PICTURE.min;
      const stripChrome =
        strip === null ? 0 : Math.max(0, strip.getBoundingClientRect().height - picture);
      // The rows that come and go under the strip are measured against their fixed budget,
      // so the Stage's height does not follow them.
      const transient = [
        ...(section.parentElement?.querySelectorAll<HTMLElement>(TRANSIENT_ROWS) ?? []),
      ].reduce((sum, row) => sum + row.offsetHeight, 0);
      const height = section.clientHeight + transient - TRANSIENT_ROWS_RESERVE;
      // The surface's side insets (mx-3) and a breath above the strip.
      const next = fitStage(
        section.clientWidth - 24,
        height - taken - stripChrome - 8,
        viewportHeight / viewportWidth,
      );
      // The strip's measured chrome rounds with its pictures' size, so a fit can flip by a
      // pixel and back on every measure: a pixel's change is no change.
      setStageFit((previous) =>
        previous !== null &&
        Math.abs(previous.width - next.width) <= 1 &&
        Math.abs(previous.height - next.height) <= 1 &&
        Math.abs(previous.cardWidth - next.cardWidth) <= 1
          ? previous
          : next,
      );
      const editor = section.parentElement?.querySelector<HTMLElement>(
        "[data-game-direction-bar] .composer-tiptap",
      );
      // Past one line (a focused composer's taller well, more lines), the editor's height is
      // the message's, not the window's.
      const style = editor == null ? null : getComputedStyle(editor);
      const growth =
        editor == null || style === null
          ? 0
          : Math.max(
              0,
              editor.offsetHeight -
                (Number.parseFloat(style.lineHeight) || 0) -
                (Number.parseFloat(style.paddingTop) || 0) -
                (Number.parseFloat(style.paddingBottom) || 0),
            );
      const columnWidth =
        growth === 0
          ? next.width
          : fitStage(
              section.clientWidth - 24,
              height - taken - stripChrome - 8 + growth,
              viewportHeight / viewportWidth,
            ).width;
      setColumn((previous) =>
        previous !== null && Math.abs(previous - columnWidth) <= 1 ? previous : columnWidth,
      );
    };
    measure();
    return observeResize(
      [
        section,
        ...[...section.children].filter(
          (child) => !(child instanceof HTMLElement && child.dataset.stageFit !== undefined),
        ),
      ],
      measure,
    );
  }, [viewportWidth, viewportHeight, comparing]);
  const stageFitStyle =
    stageFit === null ? undefined : { height: stageFit.height, width: stageFit.width + 24 };
  // The strip and the composer under it end where the fitted Stage ends, so a height-bound
  // game on a wide window has one right edge. They live in other components, so the
  // column's width goes up as a CSS variable on the centre they share.
  const stageColumn = column === null ? null : column + 24;
  useLayoutEffect(() => {
    const centre = stageRef.current?.closest<HTMLElement>("[data-game-centre]");
    if (centre == null || stageColumn === null) return;
    centre.style.setProperty("--game-stage-column", `${stageColumn}px`);
    return () => {
      centre.style.removeProperty("--game-stage-column");
    };
  }, [stageColumn]);
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
          void stageRef.current.requestFullscreen();
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
    ) : query.error === null ? (
      // Read but not answered yet: the Stage's own shape, so nothing moves when it lands.
      <section
        aria-busy="true"
        aria-label="Loading the game"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      >
        <div className="flex h-(--workspace-topbar-height) shrink-0 items-center px-3">
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="mx-3 min-h-0 flex-1 rounded-xl bg-stage-well" />
        <div className="grid shrink-0 grid-cols-3 gap-3 px-3 pt-9 pb-8">
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} shape="card" className="aspect-video max-h-40 w-full" />
          ))}
        </div>
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
      ? liveServe(data.previewUrl, liveRevision)
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
    copy: playTarget !== null,
    known: buildsRead,
    needsChoice:
      quietShell !== null && (quietShell.hasPendingApprovals || quietShell.hasPendingUserInput),
    keepGoingStep: keepGoingHere ? keepGoingStatus.step : null,
    keepGoingLive: keepGoingHere,
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
        caption: keepGoingStatus.proposal?.summary ?? null,
        keepGoing: true,
      }
    : turnRunning || landing
      ? {
          label: landing ? `Saving build ${nextBuildNumber}` : `Making build ${nextBuildNumber}`,
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
        "relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background outline-none",
        hidden ? "hidden" : "flex",
      )}
    >
      <header className="@container/stage-header flex shrink-0 flex-col bg-background">
        <div
          data-game-topbar=""
          className={cn(
            // The name's text, not its button, starts on the column's one text edge (the
            // Stage, the strip's label and captions, the tray), so the button hangs left. A
            // height-bound Stage's column is centred, and the row spans it: its right group
            // ends on the Stage's edge, over the game rather than an empty margin.
            "mx-auto flex h-(--workspace-topbar-height) w-full max-w-(--game-stage-column) min-w-0 items-center gap-1.5 px-2 pl-3",
            // The window is dragged by its top bar; its buttons stay clickable.
            isElectron && "drag-region",
            // With the sidebar collapsed, its toggle (and macOS's traffic lights) sit over this
            // corner, but only a column that starts under them steps aside: a centred one keeps
            // its title on the Stage's edge.
            titleUnderControls && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            // With the Inspector hidden, the top bar runs under the desktop window controls.
            (compact || inspectorCollapsed) && "wco:pr-(--workspace-native-controls-inset)",
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
            <Button
              size="xs"
              variant="outline"
              className="shrink-0"
              onClick={() => void stopBuild(playTarget.build)}
            >
              <HistoryIcon aria-hidden="true" />
              Back to the current game
            </Button>
          ) : null}
          <span className="min-w-2 flex-1" />
          <IconAction
            label="Undo the last build"
            shortcut={undoKey}
            disabled={!turnUndoAllowed("undo")}
            onClick={() => handleRequest({ kind: "undo" }, 0)}
          >
            <Undo2Icon className="size-3.5" aria-hidden="true" />
          </IconAction>
          <IconAction
            label="Redo the build you undid"
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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  // Compact, the Inspector is a whole other view, so its way in says its name.
                  size={compact ? "sm" : "icon-sm"}
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
              {compact ? (playTarget === null ? (folderChecks ?? "Inspector") : "Inspector") : null}
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {compact || inspectorCollapsed ? "Show the Inspector" : "Hide the Inspector"}
              {inspectorKey === null ? null : ` (${inspectorKey})`}
            </TooltipPopup>
          </Tooltip>
        </div>
        {statusBanner}
      </header>
      {compare !== null ? (
        <GameBuildCompare
          threadRef={threadRef}
          pair={compare}
          viewport={data.viewport}
          gameName={gameName}
          hidden={hidden}
          onPair={setCompare}
          onClose={() => setCompare(null)}
        />
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
                  "group/stage relative mx-3 flex min-h-0 items-center justify-center self-center overflow-hidden rounded-xl bg-stage-well [container-type:size]",
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
        data-stage-fit=""
        className={
          playTarget === null && compare === null
            ? cn(
                "relative flex min-h-0 flex-col self-center px-3",
                stageFit === null ? "flex-1 self-stretch" : "shrink-0",
              )
            : "hidden"
        }
        style={playTarget === null && compare === null ? stageFitStyle : undefined}
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
          onOpenTools={() => void navigate({ to: "/settings/game-tools" })}
          held={held}
          onTakeHeld={() => setFrameFold(playHeldFrame(frame))}
          onStudioMessage={onStudioMessage}
          focusRequest={focusRequest?.frame === "folder" ? focusRequest.n : 0}
          bridge={{ threadKey, enabled: engine.stageBridge, freezeKey }}
          overlay={<GameStageOverlay threadKey={threadKey} />}
          note={note}
          poster={
            stageStill !== null ? (
              <img src={stageStill} alt="" className="size-full object-cover" />
            ) : posterStill !== null ? (
              <GameBuildStill
                threadRef={threadRef}
                gameName={gameName}
                build={{ still: posterStill }}
                mark="none"
                className="size-full"
              />
            ) : null
          }
        />
      </div>
      <GameBuildStrip
        // A compare takes the strip's place too: hidden, never squeezed, so its picks and pages stay.
        hidden={compare !== null}
        cardWidth={stageFit?.cardWidth ?? 160}
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
          if (useGameWorkspaceStore.getState().inspectorTab !== "build") showInspectorTab("build");
        }}
      />
      {/* What the Stage's fitted height leaves over, kept under the strip, never as bands round the game. */}
      {compare === null ? (
        <div aria-hidden="true" data-stage-spacer="" className="min-h-0 flex-1" />
      ) : null}
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
  shortcut = null,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  /** Its key, said in the tooltip as every icon button's is: "Label (Ctrl+Z)". */
  shortcut?: string | null;
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
      <TooltipPopup side="bottom">
        {shortcut === null ? label : `${label} (${shortcut})`}
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
  const line = (
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
        </span>
      ))}
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
