import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { PlayIcon, RefreshCwIcon, SquareIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";
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
  onPlay,
  onRebuild,
  onStop,
  onAskAgent,
  onOpenTools,
}: {
  phase: GameStagePhase;
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
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameFocused, setFrameFocused] = useState(false);
  // Track the hide request the game never answered: without StudioProbe or when
  // a hidden page is too throttled to pump the engine, the pause/mute request is
  // lost and the game may quietly keep running while another tab is open.
  const pendingAck = useRef(false);
  const playing = phase.kind === "playing" && previewUrl !== null;
  const [pigment, pigmentInk] = gamePigment(gameName);
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
    // The outstanding-hide accounting IS the hint: a hide request is in flight
    // until the game answers either way, and only a stop or an ack retires it.
    pendingAck.current = playing && (pendingAck.current || !visible);
    setUnacknowledged(pendingAck.current);
    if (playing) {
      frameRef.current?.contentWindow?.postMessage(visibilityMessage(visible), "*");
    }
    // A remount does not need a repost here: onLoad restates the current state
    // to the fresh document.
  }, [playing, visible]);

  const focusFrame = () => {
    frameRef.current?.focus();
    frameRef.current?.contentWindow?.focus();
    setFrameFocused(true);
  };
  return (
    <div
      data-game-play-surface="true"
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-stage p-3 [container-type:size]"
    >
      <div
        className="relative overflow-hidden rounded-xl bg-frame shadow-2xl shadow-black/60 ring-1 ring-washi/10"
        style={
          playing
            ? frameStyle(viewport)
            : {
                ...frameStyle(viewport),
                // Before there is a game to show, the frame is the game's poster.
                background: `radial-gradient(120% 95% at 18% 8%, ${pigment}, ${pigmentInk})`,
              }
        }
      >
        {playing ? (
          <>
            <iframe
              key={frameKey}
              ref={frameRef}
              src={previewUrl}
              title={`${gameName} preview`}
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
        ) : (
          <StageStateCard
            gameName={gameName}
            phase={phase}
            canOperate={canOperate}
            onPlay={onPlay}
            onRebuild={onRebuild}
            onStop={onStop}
            onAskAgent={onAskAgent}
            onOpenTools={onOpenTools}
          />
        )}
      </div>
    </div>
  );
}

function StageStateCard({
  gameName,
  phase,
  canOperate,
  onPlay,
  onRebuild,
  onStop,
  onAskAgent,
  onOpenTools,
}: {
  gameName: string;
  phase: GameStagePhase;
  canOperate: boolean;
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
              title="Game tools are not installed"
              body="Kurambit builds and checks the game with Blender and Godot. Install them once, then come back and press Play."
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
        {phase.kind === "building" ? (
          <>
            <StageIcon tone="quiet">
              <RefreshCwIcon className="size-5" aria-hidden="true" />
            </StageIcon>
            <StageCopy
              title="Building the web game"
              body={
                <span className="inline-flex items-center gap-1.5">
                  <span className="truncate">{phase.message}</span>
                  {phase.startedAt === null ? null : (
                    <GameElapsed since={phase.startedAt} className="shrink-0 text-stage-muted" />
                  )}
                </span>
              }
            />
            <Button size="sm" variant="outline" disabled={!canOperate} onClick={onStop}>
              <SquareIcon className="size-3.5" aria-hidden="true" />
              Stop
            </Button>
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
        {phase.kind === "failed" ? (
          <>
            <StageIcon tone="danger">
              <TriangleAlertIcon className="size-5" aria-hidden="true" />
            </StageIcon>
            <StageCopy
              title="The build failed"
              body="The game did not build, so there is nothing to play yet."
            />
            <pre className="max-h-40 w-full max-w-xl overflow-auto rounded-md bg-white/5 p-3 text-left font-mono text-2xs leading-relaxed whitespace-pre-wrap text-stage-muted">
              {phase.message}
            </pre>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => onAskAgent(phase.message)}>
                Ask agent to fix
              </Button>
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
