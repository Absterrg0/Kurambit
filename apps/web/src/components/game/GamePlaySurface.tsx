import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  AppWindowIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import * as Option from "effect/Option";
import {
  decodeGameToStageMessage,
  type GamePlay,
  type GameStageToGameMessage,
  type GameToStageMessage,
  type GameViewport,
  type StudioError,
} from "@kurambit/contracts";
import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { GameElapsed } from "./GameElapsed";
import { gamePigment } from "./gameLibrary.logic";
import { useStageBridgeFrame } from "./gameStageBridge";
import type { GameStagePhase } from "./gameStageLogic";
import type { GameStageDevice } from "./gameStageDevice";
import { GameDeviceToolbar, useStageDeviceLayout } from "./GameStageDeviceView";

/**
 * The frame always keeps the game's own shape, so a state card sits exactly
 * where the game will be. Container query units pick the largest size that fits.
 */
const frameStyle = (viewport: GameViewport) => ({
  aspectRatio: `${viewport.width} / ${viewport.height}`,
  width: `min(100cqw, calc(100cqh * ${viewport.width} / ${viewport.height}))`,
});

/**
 * What the app says to every engine's game: the three.js shell
 * pause and mute while hidden, restore when shown again, and answer with `studio-visibility-ack`.
 */
const visibilityMessage = (visible: boolean): GameStageToGameMessage => ({
  type: "studio-visibility",
  visible,
});

/**
 * What the Stage hears of the page itself: its first error, that the game booted, a run it
 * played (`asked`: the run so far, asked for while paused), or that the run on screen is gone.
 */
export type StudioMessage =
  | { readonly type: "studio-error"; readonly message: string }
  | { readonly type: "studio-ready"; readonly blank?: boolean }
  /** Shown again (or let run behind another frame), the page has drawn a frame. */
  | { readonly type: "studio-drawn" }
  | { readonly type: "studio-play"; readonly play: GamePlay; readonly asked?: boolean }
  | { readonly type: "studio-run-reset" };

const errorText = (error: typeof StudioError.Type) => {
  const field = (value: string | number | undefined) =>
    value === undefined ? "" : String(value).slice(0, 500);
  const where = [field(error.source), field(error.line)]
    .filter((part) => part !== "" && part !== "0")
    .join(":");
  const message = error.message.slice(0, 500) || "Unknown error";
  return where === "" ? message : `${message} (${where})`;
};

/**
 * The app's modal surfaces. A person cannot click into the game past one (its backdrop takes
 * the click), so a game that takes the keyboard from one did it from its own script, as a title
 * screen focusing its first button does when it shows.
 */
const MODAL_SURFACES =
  '[data-slot="menu-popup"],[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"],[data-slot="sheet-popup"],[data-slot="command-dialog-popup"],[data-slot="select-popup"]';

/** How long a game may take to load before the Stage says it is slow, and offers a reload. */
const SLOW_START_MS = 15_000;
/** While following saves: how long a newer save waits for the frame that is still starting. */
const START_PATIENCE_MS = 45_000;
/** How long a ready frame may run unseen without saying it drew, before it is shown anyway. */
const RUNNING_PATIENCE_MS = 4_000;
/** One save's frame: the key it is mounted by and the page it loads. */
interface FrameSave {
  readonly key: string;
  readonly url: string;
}

export function GamePlaySurface({
  phase,
  viewport,
  gameName,
  previewUrl,
  frameKey,
  follow = false,
  hidden,
  canOperate,
  operation,
  onPlay,
  onRebuild,
  onStop,
  onAskAgent,
  onOpenTools,
  held,
  onTakeHeld,
  onStudioMessage,
  focusRequest,
  bridge,
  overlay,
  device = null,
}: {
  phase: GameStagePhase;
  /** The operation running on the game: its name, and whether it is this thread's own (Stop ends only those). */
  operation: { readonly name: string; readonly own: boolean } | null;
  viewport: GameViewport;
  gameName: string;
  previewUrl: string | null;
  /** Changes when a new web build appears, which reloads a playing game. */
  frameKey: string;
  /**
   * The turn making the game's first build: every save's frame loads unseen and takes the Stage
   * only once it has drawn, so the person sees the game from its first frame and never a blank or
   * broken save in between. The frame that last drew stays until then.
   */
  follow?: boolean;
  /** The play tab is not open, so the game should pause and mute itself. */
  hidden: boolean;
  canOperate: boolean;
  onPlay: () => void;
  onRebuild: () => void;
  onStop: () => void;
  onAskAgent: (error: string) => void;
  onOpenTools: () => void;
  /** A newer game waits while the person plays: the chip's words and its button. */
  held: { readonly label: string; readonly action: string } | null;
  onTakeHeld: () => void;
  onStudioMessage: (message: StudioMessage) => void;
  /** Changes when something asks for the game to have the keyboard. */
  focusRequest: number;
  /**
   * The Stage bridge this frame owns while it plays: its thread's key and whether its engine
   * speaks it.
   */
  bridge: {
    readonly threadKey: string;
    readonly enabled: boolean;
  };
  /** Drawn over the playing game: the frozen game's pointer layer, names and path. */
  overlay?: ReactNode;
  /** The responsive view: the frame at a device's size under its toolbar; null: the game's shape. */
  device?: {
    readonly value: GameStageDevice;
    readonly onChange: (next: GameStageDevice | null) => void;
    readonly shortcut: string | null;
  } | null;
}) {
  const playing = phase.kind === "playing" && previewUrl !== null;
  // Under the first build's card the game's frame already loads, to say when it draws.
  const probing = follow && phase.kind === "first-build" && previewUrl !== null;
  const latest = previewUrl === null ? null : { key: frameKey, url: previewUrl };
  // While following, the frame that last drew: it stays on the Stage until a later save's has.
  const [drawn, setDrawn] = useState<FrameSave | null>(null);
  // The save whose frame is starting unseen. A newer save waits for it to draw, to fail or to run
  // out of patience: where a game takes longer to start than its saves are apart (a slow
  // machine, a burst of saves), replacing a frame that is still starting means none ever draws.
  // It starts held and silent. Once its page is ready it is let run, still unseen (`running`),
  // and it takes the Stage when it says it drew a frame that way: a held page's first frame is
  // from before its run moved (a camera not placed yet), and is not the game to show.
  const [starting, setStarting] = useState<
    (FrameSave & { readonly settled: boolean; readonly running: boolean }) | null
  >(null);
  const pending =
    follow && starting !== null && !starting.settled && drawn?.key !== starting.key
      ? starting
      : null;
  if (!follow) {
    if (starting !== null) setStarting(null);
  } else if (latest !== null && pending === null && starting?.key !== latest.key)
    setStarting({ ...latest, settled: false, running: false });
  const settle = (key: string) =>
    setStarting((now) => (now?.key === key ? { ...now, settled: true } : now));
  const overdue = pending !== null && latest !== null && pending.key !== latest.key;
  const pendingKey = pending?.key ?? null;
  useEffect(() => {
    if (!overdue || pendingKey === null) return;
    const timer = window.setTimeout(
      () => setStarting((now) => (now?.key === pendingKey ? { ...now, settled: true } : now)),
      START_PATIENCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [overdue, pendingKey]);
  // The frame that loads now: the one still starting, else the latest save's.
  const next = pending ?? latest;
  const kept =
    follow && playing && drawn !== null && next !== null && drawn.key !== next.key ? drawn : null;
  // Unseen only behind something: the card, or the kept frame. With neither, it starts as any game does.
  const unseen = follow && next !== null && drawn?.key !== next.key && (probing || kept !== null);
  const running = unseen && starting !== null && starting.key === next?.key && starting.running;
  const frames = [
    ...(kept === null ? [] : [{ ...kept, role: "kept" as const }]),
    ...((playing || probing) && next !== null
      ? [{ ...next, role: unseen ? ("unseen" as const) : ("shown" as const) }]
      : []),
  ];
  // What an unseen frame threw: said once that frame is on the Stage, never over the one that drew.
  const [threw, setThrew] = useState<{
    readonly key: string;
    readonly message: StudioMessage;
  } | null>(null);
  /** The frame takes the Stage, and the Stage hears that its game is up. */
  const show = (save: FrameSave) => {
    setDrawn(save);
    onStudioMessage({ type: "studio-ready" });
  };
  const onFrameMessage = (message: StudioMessage) => {
    if (next === null) return;
    if (unseen && message.type === "studio-error") {
      setThrew({ key: next.key, message });
      // Broken: a newer save does not wait for it.
      settle(next.key);
      return;
    }
    if (follow && message.type === "studio-ready") {
      // A game with no main.js yet boots and draws nothing: the Stage waits for one that does.
      if (message.blank === true) settle(next.key);
      else if (unseen)
        setStarting((now) => (now?.key === next.key ? { ...now, running: true } : now));
      else show(next);
      return;
    }
    if (message.type === "studio-drawn") {
      if (running) show(next);
      return;
    }
    onStudioMessage(message);
  };
  // A page that never says it drew (its run does not move, an older runtime) is shown all the same.
  const runningKey = running ? (next?.key ?? null) : null;
  const showRunning = useStableCallback(() => {
    if (running && next !== null) show(next);
  });
  useEffect(() => {
    if (runningKey === null) return;
    const timer = window.setTimeout(showRunning, RUNNING_PATIENCE_MS);
    return () => window.clearTimeout(timer);
  }, [runningKey, showRunning]);
  // The kept frame said ready long ago, and what it throws is about to be replaced: only the
  // runs played on it are still heard.
  const onKeptMessage = (message: StudioMessage) => {
    if (message.type === "studio-play" || message.type === "studio-run-reset")
      onStudioMessage(message);
  };
  const shownThrew = !unseen && threw !== null && threw.key === next?.key ? threw.message : null;
  useEffect(() => {
    if (shownThrew !== null) onStudioMessage(shownThrew);
  }, [shownThrew, onStudioMessage]);
  const { setWell, shown, scale, frameStyle, handles } = useStageDeviceLayout(
    device?.value ?? null,
    (next) => device?.onChange(next),
  );
  // One tree in either view, so the frame (and the game in it) is never remounted by the switch.
  return (
    <>
      {device === null ? null : (
        <GameDeviceToolbar
          device={device.value}
          shown={shown}
          scale={scale}
          shortcut={device.shortcut}
          onChange={device.onChange}
        />
      )}
      <div
        ref={setWell}
        data-game-play-surface="true"
        className="group/stage relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-t-xl bg-stage-well ring-1 ring-border [container-type:size]"
      >
        <div
          data-game-device-frame={device === null ? undefined : ""}
          className={
            frameStyle === null
              ? "contents"
              : "absolute origin-top-left overflow-hidden [container-type:size]"
          }
          style={frameStyle ?? undefined}
        >
          <GameFrameBox
            viewport={frameStyle === null ? viewport : shown}
            gameName={gameName}
            playing={playing}
          >
            {/* Keyed siblings in one place: a frame keeps its page as it goes from unseen to shown
                to kept, and only the newest one talks to the Stage. */}
            {frames.map((each) => (
              <div
                key={each.key}
                inert={each.role === "unseen"}
                className={
                  each.role === "unseen"
                    ? // One percent, not none: a frame the browser does not draw at all keeps no
                      // picture to show at the moment it takes the Stage. Under two steps of
                      // 255, it cannot be seen over what covers it.
                      "pointer-events-none absolute inset-0 opacity-1"
                    : "contents"
                }
              >
                <GameFrame
                  url={each.url}
                  title={`${gameName} on the Stage`}
                  gameName={gameName}
                  // An unseen frame holds and stays silent until its page is ready; then it runs
                  // for the moment it takes to draw, and takes the Stage.
                  hidden={hidden || (each.role === "unseen" && !running)}
                  drawsReady={bridge.enabled}
                  onStudioMessage={each.role === "kept" ? onKeptMessage : onFrameMessage}
                  // The bridge is the frame on the Stage's: Tune and Art act on the game the
                  // person sees, never on a save still loading behind it.
                  bridgeOwner={
                    bridge.enabled && (kept === null || each.role === "kept")
                      ? `${bridge.threadKey}\0${each.key}`
                      : null
                  }
                  focusRequest={focusRequest}
                />
              </div>
            ))}
            {playing ? null : (
              <StageStateCard
                gameName={gameName}
                phase={phase}
                canOperate={canOperate}
                operation={operation}
                onPlay={onPlay}
                onRebuild={onRebuild}
                onStop={onStop}
                onAskAgent={onAskAgent}
                onOpenTools={onOpenTools}
              />
            )}
            {playing ? overlay : null}
            {playing && held !== null ? (
              <div className="absolute inset-x-0 top-2 z-20 flex justify-center px-2">
                <div className="flex items-center gap-2 rounded-full bg-black/75 py-1 ps-3 pe-1 text-caption text-stage-foreground ring-1 ring-white/15">
                  <span className="min-w-0 truncate">{held.label}</span>
                  <Button size="xs" variant="secondary" onClick={onTakeHeld}>
                    <RefreshCwIcon aria-hidden="true" />
                    {held.action}
                  </Button>
                </div>
              </div>
            ) : null}
          </GameFrameBox>
        </div>
        {handles}
        {/* The well's edge drawn above the game, so its rounded corners read the same all round. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-30 rounded-t-xl ring-1 ring-white/6 ring-inset"
        />
      </div>
    </>
  );
}

/**
 * The game's frame in its own shape, letterboxed in the Stage's black well
 * like an engine's viewport, so the Stage keeps the column's edges at any
 * window size. Before there is a game to show, it is the game's poster
 * across the whole Stage. Its parent must be a size container.
 */
export function GameFrameBox({
  viewport,
  gameName,
  playing,
  children,
}: {
  viewport: GameViewport;
  gameName: string;
  playing: boolean;
  children: ReactNode;
}) {
  const [pigment, pigmentInk] = gamePigment(gameName);
  return (
    <div
      className={
        playing ? "relative overflow-hidden bg-stage" : "relative size-full overflow-hidden"
      }
      style={
        playing
          ? frameStyle(viewport)
          : // The game's own colour as a faint light from above on the Stage's dark, never a
            // full-bleed wash that reads as an error or a loading screen.
            {
              background: `radial-gradient(90% 70% at 50% 0%, color-mix(in srgb, ${pigment} 26%, transparent), transparent), ${pigmentInk}`,
            }
      }
    >
      {children}
    </div>
  );
}

/**
 * A playing game: the iframe, the pause-and-mute bridge while hidden, and the
 * click that gives it focus. Mount it with a key that changes when the served
 * build does; a remount reloads the game.
 */
export function GameFrame({
  url,
  title,
  hidden,
  onStudioMessage,
  bridgeOwner = null,
  focusRequest = 0,
  onFrame,
  gameName,
  drawsReady = false,
}: {
  url: string;
  title: string;
  /**
   * The page runs Kurambit's runtime, which says studio-ready once its first frame is drawn: the
   * wait lasts until then, not just until the page loads, since the game boots after its load
   * (tuning, assets, shader warm-up) and its frame is black meanwhile. A boot error ends it too.
   */
  drawsReady?: boolean;
  /** Said while the game's page loads, so the wait names what it waits for. */
  gameName: string;
  /** The game should pause and mute itself: another tab is open, or another frame has focus. */
  hidden: boolean;
  /** Hears the page's error and ready messages from this frame only. */
  onStudioMessage?: ((message: StudioMessage) => void) | undefined;
  /** The Stage bridge's name for this frame while it owns the bridge (`thread\0frame key`). */
  bridgeOwner?: string | null;
  focusRequest?: number;
  /** Hands the iframe to its owner: a copy's frame, which the Stage reads itself. */
  onFrame?: ((frame: HTMLIFrameElement | null) => void) | undefined;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [element, setElement] = useState<HTMLIFrameElement | null>(null);
  const pauseWhenAway = useGameWorkspaceStore((state) => state.pauseWhenAway);
  const setFrameRef = (node: HTMLIFrameElement | null) => {
    frameRef.current = node;
    setElement(node);
    onFrame?.(node);
  };
  // The page's studio-ready, kept for a bridge that takes this frame after it was said.
  const hello = useRef<GameToStageMessage | null>(null);
  const onBridgeMessage = useStageBridgeFrame(
    bridgeOwner ?? "",
    bridgeOwner === null ? null : element,
    bridgeOwner !== null,
    hello,
  );
  const [frameFocused, setFrameFocused] = useState(false);
  // Reached by Tab: the game shows the app's focus ring, which an iframe's own outline cannot.
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  // The game has the keyboard only when the person gave it: a click on it (the pointer is over
  // it), a Tab into it, or Focus game. A page that focuses itself as it loads (a title screen
  // focusing its first button) would otherwise take the keyboard from wherever the person is.
  const pointerOver = useRef(false);
  const invitedAt = useRef(0);
  const tabbedAt = useRef(0);
  useEffect(() => {
    // Where the keyboard was before the game took it, to hand it back.
    let before: HTMLElement | null =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== frameRef.current)
        before = event.target;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        invitedAt.current = performance.now();
        tabbedAt.current = invitedAt.current;
      }
    };
    // A page that focuses itself sends no focus event to its frame: the app's window only blurs.
    let check = 0;
    const onBlur = () => {
      window.clearTimeout(check);
      check = window.setTimeout(() => {
        const frame = frameRef.current;
        if (frame === null || document.activeElement !== frame) return;
        if (performance.now() - invitedAt.current < 1000) {
          // The ring is Tab's alone: a control handing the game the keys back draws none.
          setKeyboardFocused(performance.now() - tabbedAt.current < 1000);
          return;
        }
        // A click in the frame activates this window too (user activation reaches ancestor
        // frames), also when no pointerenter came: a frame swapped in under a resting pointer.
        if (pointerOver.current || navigator.userActivation?.isActive === true) return;
        // Nothing held it (the page had just loaded): the Stage itself takes it, as a click would.
        const back =
          before !== null && before.isConnected && before !== document.body
            ? before
            : frame.closest<HTMLElement>("[data-game-stage]");
        back?.focus({ preventScroll: true });
      });
    };
    const onFocus = () => setKeyboardFocused(false);
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearTimeout(check);
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  // Until the game's page loads, and with the runtime until it draws, the frame is blank; it says
  // the game is starting instead.
  const [loaded, setLoaded] = useState(false);
  const [drawn, setDrawn] = useState(false);
  // A reload remounts the iframe in place, for a start that is taking too long.
  const [attempt, setAttempt] = useState(0);
  const reload = () => {
    setLoaded(false);
    setDrawn(false);
    hello.current = null;
    setAttempt(attempt + 1);
  };
  const started = loaded && (!drawsReady || drawn);
  // Track the hide request the game never answered: without StudioProbe or when
  // a hidden page is too throttled to pump the engine, the pause/mute request is
  // lost and the game may quietly keep running while another tab is open.
  const pendingAck = useRef(false);
  // The person played, then clicked away (the chat, the composer, Tune): the game holds the way
  // a hidden Stage does, so a run is never lost to typing, and plays on when they click back.
  // Read from the window's blur and the active element: a click into the frame sends the frame
  // element no focus event. A page that focused itself as it loaded was never played.
  const [inGame, setInGame] = useState(false);
  const [played, setPlayed] = useState(false);
  useEffect(() => {
    let settle = 0;
    const read = () => {
      const inside = frameRef.current !== null && document.activeElement === frameRef.current;
      setInGame(inside);
      if (
        inside &&
        (pointerOver.current ||
          navigator.userActivation?.isActive === true ||
          performance.now() - invitedAt.current < 1000)
      )
        setPlayed(true);
    };
    const onBlur = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(read);
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", read);
    document.addEventListener("focusin", read);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", read);
      document.removeEventListener("focusin", read);
    };
  }, []);
  const away = pauseWhenAway && played && !inGame && !frameFocused && !hidden;
  const visible = !hidden && !away;
  // The hint is exactly "an unconfirmed pause is outstanding".
  const [unacknowledged, setUnacknowledged] = useState(false);

  // The one listener for what this frame's page says; every other window is ignored.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const decoded = decodeGameToStageMessage(event.data);
      if (Option.isNone(decoded)) return;
      const message = decoded.value;
      if (message.type === "studio-visibility-ack") {
        if (message.visible && message.drawn === true) onStudioMessage?.({ type: "studio-drawn" });
        // Only a hide the game actually applied retires the warning. A resumed
        // ack, or one that admits the tree is still running or the bus is
        // audible, does not: that is exactly the state the hint names.
        if (message.visible || !message.paused || !message.muted) return;
        pendingAck.current = false;
        setUnacknowledged(false);
        return;
      }
      if (message.type === "studio-error") {
        setDrawn(true);
        onStudioMessage?.({ type: "studio-error", message: errorText(message) });
      }
      if (message.type === "studio-ready") {
        setDrawn(true);
        hello.current = message;
        onStudioMessage?.({
          type: "studio-ready",
          ...(message.blank === true ? { blank: true } : {}),
        });
      }
      if (message.type === "studio-play")
        onStudioMessage?.({
          type: "studio-play",
          play: message.play,
          ...(message.asked === true ? { asked: true } : {}),
        });
      if (message.type === "studio-run-reset") onStudioMessage?.({ type: "studio-run-reset" });
      onBridgeMessage?.(message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onStudioMessage, onBridgeMessage]);

  // A request is consumed by the frame on screen when it came: a frame mounted
  // later (a live reload, a copy, Back to the current game) never takes the
  // keyboard from the composer for an old one.
  const [mountFocusRequest] = useState(focusRequest);
  useEffect(() => {
    if (focusRequest === 0 || focusRequest === mountFocusRequest) return;
    // The frame's own focus event takes the "Click to play" cover down.
    invitedAt.current = performance.now();
    frameRef.current?.focus();
    frameRef.current?.contentWindow?.focus();
  }, [focusRequest, mountFocusRequest]);

  useEffect(() => {
    // The outstanding-hide accounting IS the hint: a hide request is in flight
    // until the game answers it. Shown again, the game runs where it is seen, so
    // there is nothing left to warn about.
    pendingAck.current = !visible;
    setUnacknowledged(pendingAck.current);
    frameRef.current?.contentWindow?.postMessage(visibilityMessage(visible), "*");
    // A remount does not need a repost here: onLoad restates the current state
    // to the fresh document.
  }, [visible]);
  return (
    <>
      <iframe
        key={attempt}
        ref={setFrameRef}
        src={url}
        // Not title: Chromium shows an iframe's title as a tooltip over the
        // game wherever the pointer rests, and keyboard games leave it resting.
        aria-label={title}
        data-game-frame=""
        allow="autoplay; fullscreen; gamepad"
        // The game is served from its own loopback origin, so the sandbox
        // keeps it out of the app's origin. It needs allow-same-origin to
        // keep that loopback origin for its own wasm and pack fetches, and
        // pointer lock so 3D games can capture the pointer.
        // oxlint-disable-next-line react/iframe-missing-sandbox -- allow-same-origin is this iframe's own loopback origin, not the app's.
        sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-popups allow-downloads"
        // A game page that sets no colour scheme is light: the frame says so too, so its canvas
        // stays transparent over the black instead of painting white in the dark theme.
        // Its keyboard focus is the ring drawn over it when Tab brought it there (keyboardFocused):
        // focus handed back after a control is no keyboard visit, so the frame draws none itself.
        className="size-full border-0 bg-black [color-scheme:light] outline-none"
        onPointerEnter={() => {
          pointerOver.current = true;
        }}
        onPointerLeave={() => {
          pointerOver.current = false;
        }}
        onLoad={() => {
          setLoaded(true);
          setFrameFocused(false);
          setPlayed(false);
          // The game's listener may have come up after the last message;
          // a fresh document needs the current state restated.
          frameRef.current?.contentWindow?.postMessage(visibilityMessage(visible), "*");
        }}
        onFocus={(event) => {
          const from = event.relatedTarget;
          if (from instanceof HTMLElement && from.isConnected && from.closest(MODAL_SURFACES)) {
            // Handed straight back, so Escape and the arrows keep working in the open menu.
            from.focus({ preventScroll: true });
            return;
          }
          setFrameFocused(true);
        }}
        onBlur={() => setFrameFocused(false)}
      />
      {started ? null : <StartingCard name={gameName} loaded={loaded} onReload={reload} />}
      {keyboardFocused ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-30 ring-3 ring-ring ring-inset"
        />
      ) : null}
      {/* The frame belongs to the game: the bar's Play says it is paused, and a click on the
          frame plays on. The one hint left is a hide the game never confirmed. */}
      {unacknowledged ? (
        <Text
          variant="caption"
          tone="inherit"
          render={
            <span className="pointer-events-none absolute bottom-3 left-3 z-20 flex h-6 items-center gap-1.5 rounded-md bg-black/60 px-2 text-warning-foreground backdrop-blur-sm" />
          }
        >
          <TriangleAlertIcon className="size-3 shrink-0" aria-hidden="true" />
          Game may still be running
        </Text>
      ) : null}
    </>
  );
}

/**
 * The wait before the game's own page answers: the game's name over its last picture, dimmed,
 * so the Stage says what is coming. A start that runs long says so and offers a reload; it never
 * claims progress it cannot see, and nothing spins.
 */
function StartingCard({
  name,
  loaded,
  onReload,
}: {
  name: string;
  /** The page has loaded and the game is booting in it. */
  loaded: boolean;
  onReload: () => void;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_START_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    // The Stage's own well, the loading skeleton's colour, and nothing under the words: from
    // first paint to the game the Stage stays one near-black, in both themes.
    <div className="absolute inset-0 z-10 grid place-items-center overflow-hidden bg-stage-well">
      <div className="relative flex max-w-sm flex-col items-center gap-2 p-6 text-center">
        <Text variant="title" tone="inherit" render={<p className="text-stage-foreground" />}>
          {name}
        </Text>
        <Text variant="meta" tone="inherit" render={<p className="text-stage-muted" />}>
          {slow
            ? loaded
              ? "The game is taking longer than usual to start."
              : "The game is taking longer than usual to start. Its page has not answered yet."
            : "Starting the game…"}
        </Text>
        {slow ? (
          <Button size="sm" variant="outline" className="mt-2" onClick={onReload}>
            <RefreshCwIcon aria-hidden="true" />
            Reload the game
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function StageStateCard({
  gameName,
  phase,
  canOperate,
  operation,
  onPlay,
  onRebuild,
  onStop,
  onAskAgent,
  onOpenTools,
}: {
  gameName: string;
  phase: GameStagePhase;
  canOperate: boolean;
  operation: { readonly name: string; readonly own: boolean } | null;
  onPlay: () => void;
  onRebuild: () => void;
  onStop: () => void;
  onAskAgent: (error: string) => void;
  onOpenTools: () => void;
}) {
  if (phase.kind === "playing") return null;
  return (
    <div className="relative isolate size-full">
      {/* The Stage with no game on it is an empty state, under the app's one atmosphere. */}
      <span aria-hidden className="atmosphere-stage -z-10" />
      <div className="flex size-full flex-col items-center justify-center gap-5 overflow-y-auto p-6 text-center scrollbar-gutter-both">
        <Text
          variant="title"
          tone="inherit"
          render={<h2 className="text-stage-foreground text-balance" />}
        >
          {gameName}
        </Text>
        {phase.kind === "unsupported" ? (
          <>
            <StageIcon tone="quiet">
              <PauseIcon className="size-5" aria-hidden="true" />
            </StageIcon>
            <StageCopy
              title={phase.message}
              body="Its chat, builds and history stay here; Kurambit does not build or play it for now."
            />
          </>
        ) : null}
        {phase.kind === "tools-missing" ? (
          <>
            <StageIcon tone="quiet">
              <WrenchIcon className="size-5" aria-hidden="true" />
            </StageIcon>
            <StageCopy
              title="This game's engine is not ready"
              body="Kurambit builds and plays this game with the engine installed on this computer. Game tools shows what is missing and where to get it."
            />
            <Button size="sm" variant="outline" onClick={onOpenTools}>
              Open game tools settings
            </Button>
          </>
        ) : null}
        {phase.kind === "never-built" ? (
          <>
            <StageCopy
              title="No web build yet"
              body="Build the game for the browser and play it right here in this window."
            />
            <Button size="lg" disabled={!canOperate} onClick={onPlay}>
              <PlayIcon className="size-4 fill-current" aria-hidden="true" />
              Build & play
            </Button>
          </>
        ) : null}
        {phase.kind === "first-build" ? (
          // The top bar says "Making build 1" with the turn's one clock, and the chat under the
          // Stage shows the agent at work: the Stage only says where the game will appear.
          <div className="flex max-w-md flex-col items-center gap-3">
            <Text variant="caption" tone="inherit" render={<p className="text-stage-muted" />}>
              The game plays here as soon as your agent has it running.
            </Text>
          </div>
        ) : null}
        {phase.kind === "building" ? (
          <>
            <StageIcon tone="quiet">
              <RefreshCwIcon className="size-5" aria-hidden="true" />
            </StageIcon>
            <StageCopy
              title={operation === null ? "Starting" : operation.name}
              body={
                <span className="inline-flex items-center gap-1.5">
                  <span className="truncate">{phase.message}</span>
                  {phase.startedAt === null ? null : (
                    <GameElapsed since={phase.startedAt} className="shrink-0 text-stage-muted" />
                  )}
                </span>
              }
            />
            {/* Stop ends only this chat's own work; a run's capture or check is the run's. */}
            {operation === null || operation.own ? (
              <Button size="sm" variant="outline" disabled={!canOperate} onClick={onStop}>
                <SquareIcon className="size-3.5" aria-hidden="true" />
                Stop
              </Button>
            ) : null}
          </>
        ) : null}
        {phase.kind === "ready" ? (
          <>
            <StageCopy
              title="Web build ready"
              body={
                phase.stale
                  ? "This build is older than the game's latest changes."
                  : "Play the current build without leaving this window."
              }
            />
            <div className="flex items-center gap-2">
              <Button size="lg" disabled={!canOperate} onClick={onPlay}>
                <PlayIcon className="size-4 fill-current" aria-hidden="true" />
                Play
              </Button>
              {phase.stale ? (
                <Button size="sm" variant="outline" disabled={!canOperate} onClick={onRebuild}>
                  Rebuild first
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
        {phase.kind === "stopped" ? (
          <>
            <StageCopy
              title="The game is stopped"
              body="Play serves the game folder here again, live as your agent changes it."
            />
            <Button size="lg" disabled={!canOperate} onClick={onPlay}>
              <PlayIcon className="size-4 fill-current" aria-hidden="true" />
              Play
            </Button>
          </>
        ) : null}
        {phase.kind === "window" ? (
          <>
            <StageIcon tone="quiet">
              <AppWindowIcon className="size-5" aria-hidden="true" />
            </StageIcon>
            <StageCopy
              title="This game plays in its own window"
              body="Its engine makes no Web build to play here. Export a Linux or Windows release from More, Export…."
            />
          </>
        ) : null}
        {phase.kind === "failed" ? (
          <>
            <StageIcon tone="danger">
              <TriangleAlertIcon className="size-5" aria-hidden="true" />
            </StageIcon>
            <StageCopy
              title={phase.what === "open" ? "The game could not be opened" : "The build failed"}
              body={
                phase.what === "open"
                  ? "Kurambit could not serve the game folder here."
                  : "The game did not build, so there is nothing to play yet."
              }
            />
            <pre className="max-h-40 w-full max-w-xl overflow-auto rounded-md bg-white/5 p-3 text-left font-mono text-caption whitespace-pre-wrap text-stage-muted">
              {phase.message}
            </pre>
            <div className="flex items-center gap-2">
              {phase.what === "build" ? (
                <Button size="sm" onClick={() => onAskAgent(phase.message)}>
                  Ask agent to fix
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={!canOperate} onClick={onPlay}>
                Try again
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Only the state card needs the number to sit still: the running action is
 * already described by the status strip, which ticks on its own.
 */
function StageIcon({ tone, children }: { tone: "quiet" | "danger"; children: ReactNode }) {
  return (
    <div
      className={
        tone === "danger"
          ? "relative flex size-11 items-center justify-center rounded-full bg-destructive/25 text-destructive-foreground"
          : "relative flex size-11 items-center justify-center rounded-full bg-washi/10 text-stage-foreground backdrop-blur-sm"
      }
    >
      {children}
    </div>
  );
}

function StageCopy({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="relative flex max-w-sm flex-col gap-1">
      <Text variant="label" tone="inherit" render={<p className="text-stage-foreground" />}>
        {title}
      </Text>
      <Text variant="meta" tone="inherit" render={<p className="text-stage-muted" />}>
        {body}
      </Text>
    </div>
  );
}
