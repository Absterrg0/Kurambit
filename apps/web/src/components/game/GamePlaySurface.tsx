import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  AppWindowIcon,
  HammerIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import type { GameViewport } from "@kurambit/contracts";
import { Button } from "../ui/button";
import { GameElapsed } from "./GameElapsed";
import { gamePigment } from "./gameLibrary.logic";
import type { GameStagePhase } from "./gameStageLogic";

/**
 * The frame always keeps the game's own shape, so a state card sits exactly
 * where the game will be. Container query units pick the largest size that fits.
 */
const frameStyle = (viewport: GameViewport) => ({
  aspectRatio: `${viewport.width} / ${viewport.height}`,
  width: `min(100cqw, calc(100cqh * ${viewport.width} / ${viewport.height}))`,
});

/**
 * The one bridge message the app sends the game. The Godot side's StudioProbe
 * listens for it, pauses the SceneTree and mutes the master bus while hidden,
 * restores them when shown again, and answers with `studio-visibility-ack`.
 */
const visibilityMessage = (visible: boolean) => ({ type: "studio-visibility" as const, visible });

/**
 * What the template's bridge (`shell/studio.js`) says about the page (D3): its
 * first error, bounded, or that the game booted. Older games never send them.
 */
export type StudioMessage =
  | { readonly type: "studio-error"; readonly message: string }
  | { readonly type: "studio-ready" };

const readStudioMessage = (data: unknown): StudioMessage | null => {
  if (typeof data !== "object" || data === null || !("type" in data)) return null;
  if (data.type === "studio-ready") return { type: "studio-ready" };
  if (data.type !== "studio-error") return null;
  const field = (key: string) => {
    const value = (data as Record<string, unknown>)[key];
    return typeof value === "string" || typeof value === "number"
      ? String(value).slice(0, 500)
      : "";
  };
  const where = [field("source"), field("line")].filter((part) => part !== "").join(":");
  const message = field("message") || "Unknown error";
  return { type: "studio-error", message: where === "" ? message : `${message} (${where})` };
};

/** The game's answer, so the stage knows whether hidden playback really stopped. */
interface VisibilityAck {
  readonly type: "studio-visibility-ack";
  readonly visible: boolean;
  readonly paused: boolean;
  readonly muted: boolean;
}

export function GamePlaySurface({
  phase,
  viewport,
  gameName,
  previewUrl,
  frameKey,
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
}: {
  phase: GameStagePhase;
  /** The operation running on the game: its name, and whether it is this thread's own (Stop ends only those). */
  operation: { readonly name: string; readonly own: boolean } | null;
  viewport: GameViewport;
  gameName: string;
  previewUrl: string | null;
  /** Changes when a new web build appears, which reloads a playing game. */
  frameKey: string;
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
}) {
  const playing = phase.kind === "playing" && previewUrl !== null;
  return (
    <div
      data-game-play-surface="true"
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-stage p-3 [container-type:size]"
    >
      <GameFrameBox viewport={viewport} gameName={gameName} playing={playing}>
        {playing ? (
          <GameFrame
            key={frameKey}
            url={previewUrl}
            title={`${gameName} preview`}
            hidden={hidden}
            onStudioMessage={onStudioMessage}
            focusRequest={focusRequest}
          />
        ) : (
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
        {playing && held !== null ? (
          <div className="absolute inset-x-0 top-2 z-20 flex justify-center px-2">
            <div className="flex items-center gap-2 rounded-full bg-black/75 py-1 ps-3 pe-1 text-xs text-stage-foreground ring-1 ring-white/15">
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
  );
}

/**
 * The game's frame in its own shape. Before there is a game to show, it is the
 * game's poster. Its parent must be a size container.
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
      className="relative overflow-hidden rounded-xl bg-frame shadow-2xl shadow-black/60 ring-1 ring-washi/10"
      style={
        playing
          ? frameStyle(viewport)
          : {
              ...frameStyle(viewport),
              background: `radial-gradient(120% 95% at 18% 8%, ${pigment}, ${pigmentInk})`,
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
  focusRequest = 0,
}: {
  url: string;
  title: string;
  /** The game should pause and mute itself: another tab is open, or another frame has focus. */
  hidden: boolean;
  /** Hears the bridge's error and ready messages from this frame only. */
  onStudioMessage?: ((message: StudioMessage) => void) | undefined;
  focusRequest?: number;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameFocused, setFrameFocused] = useState(false);
  // Track the hide request the game never answered: without StudioProbe or when
  // a hidden page is too throttled to pump the engine, the pause/mute request is
  // lost and the game may quietly keep running while another tab is open.
  const pendingAck = useRef(false);
  const visible = !hidden;
  // The hint is exactly "an unconfirmed pause is outstanding".
  const [unacknowledged, setUnacknowledged] = useState(false);

  useEffect(() => {
    const onAck = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const ack = event.data as Partial<VisibilityAck> | null;
      if (ack?.type !== "studio-visibility-ack") return;
      // Only a hide the game actually applied retires the warning. A resumed
      // ack, or one that admits the tree is still running or the bus is
      // audible, does not: that is exactly the state the hint names.
      if (ack.visible !== false || ack.paused !== true || ack.muted !== true) return;
      pendingAck.current = false;
      setUnacknowledged(false);
    };
    window.addEventListener("message", onAck);
    return () => window.removeEventListener("message", onAck);
  }, []);

  useEffect(() => {
    if (onStudioMessage === undefined) return;
    const onMessage = (event: MessageEvent) => {
      // Only this frame's own window speaks for the game on screen.
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = readStudioMessage(event.data);
      if (message !== null) onStudioMessage(message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onStudioMessage]);

  // A request is consumed by the frame on screen when it came: a frame mounted
  // later (a live reload, a copy, Back to the current game) never takes the
  // keyboard from the composer for an old one.
  const [mountFocusRequest] = useState(focusRequest);
  useEffect(() => {
    if (focusRequest === 0 || focusRequest === mountFocusRequest) return;
    // The frame's own focus event takes the "Click to play" cover down.
    frameRef.current?.focus();
    frameRef.current?.contentWindow?.focus();
  }, [focusRequest, mountFocusRequest]);

  useEffect(() => {
    // The outstanding-hide accounting IS the hint: a hide request is in flight
    // until the game answers either way, and only an unmount or an ack retires it.
    pendingAck.current = pendingAck.current || !visible;
    setUnacknowledged(pendingAck.current);
    frameRef.current?.contentWindow?.postMessage(visibilityMessage(visible), "*");
    // A remount does not need a repost here: onLoad restates the current state
    // to the fresh document.
  }, [visible]);
  const focusFrame = () => {
    frameRef.current?.focus();
    frameRef.current?.contentWindow?.focus();
    setFrameFocused(true);
  };
  return (
    <>
      <iframe
        ref={frameRef}
        src={url}
        title={title}
        allow="autoplay; fullscreen; gamepad"
        // The game is served from its own loopback origin, so the sandbox
        // keeps it out of the app's origin. It needs allow-same-origin to
        // keep that loopback origin for its own wasm and pack fetches, and
        // pointer lock so 3D games can capture the pointer.
        // oxlint-disable-next-line react/iframe-missing-sandbox -- allow-same-origin is this iframe's own loopback origin, not the app's.
        sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-popups allow-downloads"
        className="size-full border-0 bg-black"
        onLoad={() => {
          setFrameFocused(false);
          // The game's listener may have come up after the last message;
          // a fresh document needs the current state restated.
          frameRef.current?.contentWindow?.postMessage(visibilityMessage(visible), "*");
        }}
        onFocus={() => setFrameFocused(true)}
        onBlur={() => setFrameFocused(false)}
      />
      {unacknowledged ? (
        <div className="pointer-events-none absolute bottom-2 left-2 z-20 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs text-stage-muted ring-1 ring-white/10">
          <TriangleAlertIcon className="size-3 shrink-0" aria-hidden="true" />
          Game may still be running
        </div>
      ) : null}
      {frameFocused ? null : (
        <button
          type="button"
          className="absolute inset-0 z-10 flex cursor-pointer items-center justify-center bg-black/35"
          onClick={focusFrame}
        >
          <span className="flex items-center gap-2 rounded-full bg-black/75 px-4 py-2 text-sm font-medium text-stage-foreground shadow-lg ring-1 ring-white/15">
            <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
            Click to play
          </span>
        </button>
      )}
    </>
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
      <span
        aria-hidden
        className="surface-grain pointer-events-none absolute inset-0 -z-10 mix-blend-overlay"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-radial from-transparent to-black/45"
      />
      <div className="flex size-full flex-col items-center justify-center gap-5 overflow-y-auto p-6 text-center scrollbar-gutter-both">
        <h2 className="font-display text-5xl leading-none text-washi text-balance @[40rem]:text-6xl">
          {gameName}
        </h2>
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
          <>
            <StageIcon tone="quiet">
              <HammerIcon className="size-5" aria-hidden="true" />
            </StageIcon>
            <StageCopy
              title="Your agent is making the first playable build"
              body={
                <span className="inline-flex items-center gap-1.5">
                  <span>It plays here as soon as the turn ends.</span>
                  {phase.startedAt === null ? null : (
                    <GameElapsed since={phase.startedAt} className="shrink-0 text-stage-muted" />
                  )}
                </span>
              }
            />
          </>
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
            <pre className="max-h-40 w-full max-w-xl overflow-auto rounded-md bg-white/5 p-3 text-left font-mono text-2xs leading-relaxed whitespace-pre-wrap text-stage-muted">
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
    <div className="relative max-w-sm space-y-1">
      <p className="text-sm font-medium text-stage-foreground">{title}</p>
      <p className="text-xs leading-relaxed text-washi/70">{body}</p>
    </div>
  );
}
