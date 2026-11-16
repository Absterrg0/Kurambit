import { Slider } from "@base-ui/react/slider";
import type { EnvironmentId, GameArtAsset } from "@kurambit/contracts";
import {
  BoneIcon,
  BoxIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FocusIcon,
  Grid2x2Icon,
  MinusIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ArrowUpFromLineIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";

import { useAssetUrlState } from "../../assets/assetUrls";
import { cn, randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { bytesWords, clipTime } from "./gameArt.logic";

// ─── The model viewer page's protocol (runtime shell/viewer.js) ─────────────────

export interface ViewerModelInfo {
  readonly triangles: number;
  readonly drawCalls: number;
  readonly size: readonly [number, number, number];
  readonly bounds: readonly [readonly number[], readonly number[]];
  readonly grid: number;
  readonly vertices: number;
  readonly materials: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly color?: string;
  }>;
  readonly textures: ReadonlyArray<{
    readonly name: string;
    readonly slot: string;
    readonly width: number;
    readonly height: number;
  }>;
  readonly clips: ReadonlyArray<{ readonly name: string; readonly duration: number }>;
  readonly bones: number;
}

type ViewerMessage =
  | { readonly type: "ready"; readonly maxNormals: number }
  | { readonly type: "opened"; readonly url: string; readonly info: ViewerModelInfo }
  | { readonly type: "failed"; readonly url: string; readonly message: string }
  | { readonly type: "time"; readonly time: number }
  | { readonly type: "picture"; readonly id: string; readonly png: string | null }
  | { readonly type: "thumbnail"; readonly id: string; readonly png: string | null };

const viewerMessage = (data: unknown): ViewerMessage | null =>
  typeof data === "object" &&
  data !== null &&
  (data as { source?: unknown }).source === "kurambit-viewer" &&
  typeof (data as { type?: unknown }).type === "string"
    ? (data as ViewerMessage)
    : null;

/**
 * One viewer page in a frame: what it said last, and the way to talk to it. The page is the
 * game's own origin, so it is told by origin and heard only from its own window.
 */
function useViewerFrame(src: string, onMessage: (message: ViewerMessage) => void) {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  // The page that said it is ready: a new page (another game's server) starts unready.
  const [readyFrom, setReadyFrom] = useState<Window | null>(null);
  const heard = useStableCallback(onMessage);
  const origin = new URL(src).origin;
  const target = frame?.contentWindow ?? null;
  useEffect(() => {
    if (target === null) return;
    const listen = (event: MessageEvent) => {
      if (event.source !== target || event.origin !== origin) return;
      const message = viewerMessage(event.data);
      if (message === null) return;
      if (message.type === "ready") setReadyFrom(target);
      heard(message);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [target, origin, heard]);
  const post = (message: Record<string, unknown>) =>
    target?.postMessage({ source: "kurambit-art", ...message }, origin);
  return { setFrame, ready: target !== null && readyFrom === target, post };
}

/** Pictures asked of a viewer, answered by id. */
function usePictureWaiters() {
  const waiters = useRef(new Map<string, (png: string | null) => void>());
  const settle = (id: string, png: string | null) => {
    waiters.current.get(id)?.(png);
    waiters.current.delete(id);
  };
  const ask = (post: (message: Record<string, unknown>) => void) =>
    new Promise<string | null>((resolve) => {
      const id = randomUUID();
      waiters.current.set(id, resolve);
      post({ type: "picture", id });
      window.setTimeout(() => settle(id, null), 4_000);
    });
  return { settle, ask };
}

// ─── Model ────────────────────────────────────────────────────────────────────

export interface ModelViewerHandle {
  /** The view as the person left it, for the composer chip. */
  readonly picture: () => Promise<string | null>;
  readonly look: (look: { readonly tint?: number; readonly scale?: number }) => void;
}

/**
 * A model file in the runtime's viewer page: orbit, pan and zoom, a ground grid beside the 1.8 m
 * figure, wireframe, normals, skeleton, bounds and pivot, and its clips with a scrubber. The page
 * draws only while something moves, so an idle viewer costs nothing.
 */
export function ModelViewer({
  viewerUrl,
  asset,
  look,
  onInfo,
  handle,
}: {
  viewerUrl: string;
  asset: GameArtAsset;
  look: { readonly tint: number; readonly scale: number };
  onInfo: (info: ViewerModelInfo | null) => void;
  handle: (handle: ModelViewerHandle | null) => void;
}) {
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "open"; readonly info: ViewerModelInfo }
  >({ kind: "loading" });
  const [toggles, setToggles] = useState({
    wireframe: false,
    normals: false,
    skeleton: false,
    bounds: false,
  });
  const [maxNormals, setMaxNormals] = useState(Number.POSITIVE_INFINITY);
  const [clip, setClip] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const pictures = usePictureWaiters();
  const url = `/${asset.url}`;
  const viewer = useViewerFrame(viewerUrl, (message) => {
    switch (message.type) {
      case "ready":
        setMaxNormals(message.maxNormals);
        return;
      case "opened":
        if (message.url !== url) return;
        setState({ kind: "open", info: message.info });
        onInfo(message.info);
        return;
      case "failed":
        if (message.url !== url) return;
        setState({ kind: "failed", message: message.message });
        onInfo(null);
        return;
      case "time":
        setTime(message.time);
        return;
      case "picture":
        pictures.settle(message.id, message.png);
        return;
      case "thumbnail":
        return;
    }
  });
  const { setFrame, ready, post } = viewer;
  // Mounted per model (its key), so each opens fresh at its first clip's start.
  useEffect(() => {
    if (!ready) return;
    post({ type: "open", url });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `post` reads the frame.
  }, [ready, url]);
  const opened = state.kind === "open";
  useEffect(() => {
    if (ready && opened) post({ type: "view", ...toggles });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `post` reads the frame.
  }, [ready, opened, toggles]);
  useEffect(() => {
    if (ready && opened) post({ type: "look", tint: look.tint, scale: look.scale });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `post` reads the frame.
  }, [ready, opened, look.tint, look.scale]);
  // One handle for the viewer's life: its calls read the page as it is when they run.
  const picture = useStableCallback(() => pictures.ask(post));
  const lookNow = useStableCallback((next: { readonly tint?: number; readonly scale?: number }) =>
    post({ type: "look", ...next }),
  );
  useEffect(() => {
    handle({ picture, look: lookNow });
    return () => handle(null);
  }, [handle, picture, lookNow]);
  const info = state.kind === "open" ? state.info : null;
  const clips = info?.clips ?? [];
  const duration = clips[clip]?.duration ?? 0;
  const at = dragging ?? time;
  const toggle = (key: keyof typeof toggles) => setToggles({ ...toggles, [key]: !toggles[key] });
  return (
    <div className="flex flex-col">
      {/* The viewport is the content, flush with the panel's edges, as the Stage is. */}
      <div className="relative aspect-[4/3] w-full bg-stage-well">
        <iframe
          ref={setFrame}
          src={viewerUrl}
          // The viewer is served from the game's own loopback origin, never the app's.
          // oxlint-disable-next-line react/iframe-missing-sandbox -- allow-same-origin is that loopback origin.
          sandbox="allow-scripts allow-same-origin"
          title={`${asset.path} in 3D`}
          className="absolute inset-0 size-full border-0"
        />
        {state.kind === "open" ? null : (
          <Text
            variant="caption"
            tone="muted"
            render={<span className="pointer-events-none absolute start-4 bottom-3" />}
          >
            {state.kind === "loading" ? "Opening…" : `Did not open: ${state.message}`}
          </Text>
        )}
      </div>
      <div className="flex h-9 items-center gap-0.5 px-2">
        <ViewControl
          label="Frame the model"
          disabled={!opened}
          onClick={() => post({ type: "reset-view" })}
        >
          <FocusIcon aria-hidden="true" />
        </ViewControl>
        <ViewControl
          label="Wireframe"
          pressed={toggles.wireframe}
          disabled={!opened}
          onClick={() => toggle("wireframe")}
        >
          <BoxIcon aria-hidden="true" />
        </ViewControl>
        <ViewControl
          label="Normals"
          detail={
            info !== null && info.vertices > maxNormals
              ? `Too many vertices (${info.vertices.toLocaleString("en-US")}) to draw each normal`
              : null
          }
          pressed={toggles.normals}
          disabled={!opened || (info !== null && info.vertices > maxNormals)}
          onClick={() => toggle("normals")}
        >
          <ArrowUpFromLineIcon aria-hidden="true" />
        </ViewControl>
        <ViewControl
          label="Skeleton"
          detail={info !== null && info.bones === 0 ? "It has no skeleton" : null}
          pressed={toggles.skeleton}
          disabled={!opened || info?.bones === 0}
          onClick={() => toggle("skeleton")}
        >
          <BoneIcon aria-hidden="true" />
        </ViewControl>
        <ViewControl
          label="Bounds and pivot"
          pressed={toggles.bounds}
          disabled={!opened}
          onClick={() => toggle("bounds")}
        >
          <BoundsIcon />
        </ViewControl>
        <span className="flex-1" />
        {info === null ? null : (
          <Text variant="caption" tone="muted" numeric render={<span className="pe-2" />}>
            Grid {info.grid} m · figure 1.8 m
          </Text>
        )}
      </div>
      {clips.length === 0 ? null : (
        <div className="flex h-9 min-w-0 items-center gap-2 ps-2 pe-4">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={playing ? "Pause the clip" : "Play the clip"}
                  onClick={() => {
                    const next = !playing;
                    setPlaying(next);
                    post({ type: "clip", index: clip, play: next, time: at >= duration ? 0 : at });
                  }}
                />
              }
            >
              {playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{playing ? "Pause" : "Play"}</TooltipPopup>
          </Tooltip>
          <Select
            value={String(clip)}
            onValueChange={(next) => {
              const index = Number(next);
              if (!Number.isInteger(index)) return;
              setClip(index);
              setTime(0);
              post({ type: "clip", index, play: playing, time: 0 });
            }}
          >
            <SelectTrigger size="xs" className="max-w-32 min-w-0" aria-label="Clip">
              <SelectValue>{clips[clip]?.name ?? "Clip"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {clips.map((each, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- two clips may share a name; a clip is its place.
                <SelectItem key={`${index}:${each.name}`} hideIndicator value={String(index)}>
                  {each.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Slider.Root
            className="min-w-12 flex-1"
            value={Math.min(at, duration)}
            min={0}
            max={Math.max(duration, 0.01)}
            step={0.01}
            onValueChange={(next) => {
              const single = Array.isArray(next) ? next[0] : next;
              if (typeof single !== "number") return;
              setDragging(single);
              setPlaying(false);
              post({ type: "clip", index: clip, play: false, time: single });
            }}
            onValueCommitted={(next) => {
              const single = Array.isArray(next) ? next[0] : next;
              setDragging(null);
              if (typeof single === "number") setTime(single);
            }}
            aria-label="Clip time: drag to scrub"
          >
            <Slider.Control className="group/scrub flex h-9 w-full touch-none items-center">
              <Slider.Track className="relative h-0.5 w-full rounded-full bg-foreground/12">
                <Slider.Indicator className="rounded-full bg-foreground/40" />
                <Slider.Thumb className="size-2.5 rounded-full bg-foreground outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" />
              </Slider.Track>
            </Slider.Control>
          </Slider.Root>
          <Text variant="caption" tone="muted" numeric render={<span className="shrink-0" />}>
            {clipTime(at)} / {clipTime(duration)}
          </Text>
        </div>
      )}
    </div>
  );
}

/** Bounds and pivot: a box with its origin marked, as the viewer draws them. */
function BoundsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" strokeDasharray="2 1.5" />
      <path d="M8 6v4M6 8h4" />
    </svg>
  );
}

/** A ghost icon button in the viewer's bar, pressed while its view is on: the control bar's look. */
function ViewControl({
  label,
  detail = null,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  detail?: string | null;
  pressed?: boolean;
  disabled: boolean;
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
            {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
            // The ghost button's own pressed look, as a toggle's.
            {...(pressed === true ? { "data-pressed": "" } : {})}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-xs">
        <span className="flex flex-col gap-1">
          <span>{label}</span>
          {detail === null ? null : <span className="text-muted-foreground">{detail}</span>}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

// ─── Thumbnails ─────────────────────────────────────────────────────────────────

/**
 * Draws the list's missing model thumbnails, one at a time, in one hidden viewer page, and hands
 * each to `onDrawn` to be kept by its content. Only models a row asked for are drawn, so a model
 * nobody scrolls to never loads.
 */
export function ArtThumbnailPainter({
  viewerUrl,
  wanted,
  onDrawn,
}: {
  viewerUrl: string;
  wanted: ReadonlyArray<GameArtAsset>;
  onDrawn: (asset: GameArtAsset, png: string | null) => void;
}) {
  const asked = useRef(new Map<string, GameArtAsset>());
  const busy = useRef<string | null>(null);
  const viewer = useViewerFrame(`${viewerUrl}?thumbnails`, (message) => {
    if (message.type !== "thumbnail") return;
    const asset = asked.current.get(message.id);
    asked.current.delete(message.id);
    busy.current = null;
    if (asset !== undefined) onDrawn(asset, message.png);
  });
  const { setFrame, ready, post } = viewer;
  // One at a time: the next asked for once the page is ready and the last one came back.
  useEffect(() => {
    if (!ready || busy.current !== null) return;
    const done = new Set([...asked.current.values()].map((asset) => asset.sha256));
    const next = wanted.find((asset) => !done.has(asset.sha256));
    if (next === undefined) return;
    const id = randomUUID();
    busy.current = id;
    asked.current.set(id, next);
    post({ type: "thumbnail", id, url: `/${next.url}` });
  });
  return (
    <iframe
      ref={setFrame}
      src={`${viewerUrl}?thumbnails`}
      // oxlint-disable-next-line react/iframe-missing-sandbox -- allow-same-origin is the game's loopback origin.
      sandbox="allow-scripts allow-same-origin"
      title="Model thumbnails"
      aria-hidden="true"
      tabIndex={-1}
      className="pointer-events-none fixed -start-[200px] top-0 size-[192px] border-0 opacity-0"
    />
  );
}

// ─── Textures and sprites ──────────────────────────────────────────────────────

const ZOOMS = [0.25, 0.5, 1, 2, 4, 8] as const;
const CHECKER =
  "[background-image:conic-gradient(#2a2c30_25%,#1f2124_0_50%,#2a2c30_0_75%,#1f2124_0)] [background-size:16px_16px]";

/**
 * An image at 1:1 over a checkerboard, so its alpha shows, with zoom steps. A sprite sheet's grid
 * is drawn over it and its frames are stepped through one at a time.
 */
export function TextureViewer({
  environmentId,
  root,
  asset,
}: {
  environmentId: EnvironmentId;
  root: string;
  asset: GameArtAsset;
}) {
  const state = useAssetUrlState(environmentId, {
    _tag: "draft-workspace-file",
    cwd: root,
    path: asset.path,
  });
  const [zoom, setZoom] = useState<number>(1);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [frame, setFrame] = useState<number | null>(null);
  const sheet = asset.sheet;
  const frames = sheet === undefined ? 0 : sheet.columns * sheet.rows;
  const url = state._tag === "Success" ? state.url : null;
  const cell =
    sheet === undefined || size === null
      ? null
      : { width: size.width / sheet.columns, height: size.height / sheet.rows };
  return (
    <div className="flex flex-col">
      <div className={cn("flex aspect-[4/3] w-full overflow-auto scrollbar-gutter-both", CHECKER)}>
        {url === null ? null : frame !== null && cell !== null && sheet !== undefined ? (
          // One frame of the sheet, cut out at its own size and zoomed.
          <div
            className="m-auto shrink-0 [image-rendering:pixelated]"
            role="img"
            aria-label={`Frame ${frame + 1} of ${frames}`}
            style={{
              width: cell.width * zoom,
              height: cell.height * zoom,
              backgroundImage: `url("${url}")`,
              backgroundSize: `${(size?.width ?? 0) * zoom}px ${(size?.height ?? 0) * zoom}px`,
              backgroundPosition: `-${(frame % sheet.columns) * cell.width * zoom}px -${Math.floor(frame / sheet.columns) * cell.height * zoom}px`,
            }}
          />
        ) : (
          <div className="relative m-auto shrink-0">
            <img
              src={url}
              alt={asset.path}
              onLoad={(event) =>
                setSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              className="block max-w-none [image-rendering:pixelated]"
              style={
                size === null ? undefined : { width: size.width * zoom, height: size.height * zoom }
              }
            />
            {sheet === undefined || size === null ? null : (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage:
                    "linear-gradient(to right, rgb(255 255 255 / 0.35) 1px, transparent 1px), linear-gradient(to bottom, rgb(255 255 255 / 0.35) 1px, transparent 1px)",
                  backgroundSize: `${(size.width * zoom) / sheet.columns}px ${(size.height * zoom) / sheet.rows}px`,
                }}
              />
            )}
          </div>
        )}
      </div>
      <div className="flex h-9 items-center gap-0.5 px-2">
        <ViewControl
          label="Zoom out"
          disabled={zoom <= ZOOMS[0]}
          onClick={() => setZoom(ZOOMS.findLast((each) => each < zoom) ?? zoom)}
        >
          <MinusIcon aria-hidden="true" />
        </ViewControl>
        <Button size="xs" variant="ghost" onClick={() => setZoom(1)} aria-label="Actual size">
          <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
        </Button>
        <ViewControl
          label="Zoom in"
          disabled={zoom >= ZOOMS.at(-1)!}
          onClick={() => setZoom(ZOOMS.find((each) => each > zoom) ?? zoom)}
        >
          <PlusIcon aria-hidden="true" />
        </ViewControl>
        <span className="flex-1" />
        {sheet === undefined ? null : (
          <>
            <ViewControl
              label="Step through its frames"
              pressed={frame !== null}
              disabled={false}
              onClick={() => setFrame(frame === null ? 0 : null)}
            >
              <Grid2x2Icon aria-hidden="true" />
            </ViewControl>
            {frame === null ? null : (
              <>
                <ViewControl
                  label="Previous frame"
                  disabled={false}
                  onClick={() => setFrame((frame - 1 + frames) % frames)}
                >
                  <ChevronLeftIcon aria-hidden="true" />
                </ViewControl>
                <Text variant="caption" tone="muted" numeric>
                  {frame + 1} / {frames}
                </Text>
                <ViewControl
                  label="Next frame"
                  disabled={false}
                  onClick={() => setFrame((frame + 1) % frames)}
                >
                  <ChevronRightIcon aria-hidden="true" />
                </ViewControl>
              </>
            )}
          </>
        )}
        {size === null ? null : (
          <Text variant="caption" tone="muted" numeric render={<span className="ps-2 pe-2" />}>
            {size.width} × {size.height}
            {sheet === undefined ? "" : ` · ${sheet.columns} × ${sheet.rows} frames`}
          </Text>
        )}
      </div>
    </div>
  );
}

// ─── Sounds ────────────────────────────────────────────────────────────────────

const PEAKS = 200;

/** The sound's peaks, decoded once from its bytes: one bar per slice of its length. */
async function soundPeaks(url: string) {
  const bytes = await (await fetch(url)).arrayBuffer();
  const context = new OfflineAudioContext(1, 1, 44_100);
  const audio = await context.decodeAudioData(bytes);
  const data = audio.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / PEAKS));
  const peaks: number[] = [];
  for (let start = 0; start < data.length && peaks.length < PEAKS; start += step) {
    let peak = 0;
    for (let i = start; i < Math.min(start + step, data.length); i += 1)
      peak = Math.max(peak, Math.abs(data[i]!));
    peaks.push(peak);
  }
  return {
    peaks,
    seconds: audio.duration,
    channels: audio.numberOfChannels,
    rate: audio.sampleRate,
  };
}

/** A sound's waveform with play: the bars drawn once, the played part shaded as it plays. */
export function AudioViewer({
  environmentId,
  root,
  asset,
}: {
  environmentId: EnvironmentId;
  root: string;
  asset: GameArtAsset;
}) {
  const state = useAssetUrlState(environmentId, {
    _tag: "draft-workspace-file",
    cwd: root,
    path: asset.path,
  });
  const url = state._tag === "Success" ? state.url : null;
  const [wave, setWave] = useState<Awaited<ReturnType<typeof soundPeaks>> | null | "failed">(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (url === null) return;
    let live = true;
    soundPeaks(url).then(
      (read) => live && setWave(read),
      () => live && setWave("failed"),
    );
    return () => {
      live = false;
    };
  }, [url]);
  const seconds = wave !== null && wave !== "failed" ? wave.seconds : 0;
  const share = seconds > 0 ? Math.min(1, at / seconds) : 0;
  return (
    <div className="flex flex-col">
      <div className="relative flex h-32 w-full items-center bg-stage-well px-4">
        {wave === null ? (
          <Text variant="caption" tone="muted">
            Reading the sound…
          </Text>
        ) : wave === "failed" ? (
          <Text variant="caption" tone="muted">
            This browser could not decode it.
          </Text>
        ) : (
          <svg
            viewBox={`0 0 ${wave.peaks.length} 100`}
            preserveAspectRatio="none"
            className="h-24 w-full cursor-pointer"
            role="img"
            aria-label="Waveform: click to play from there"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const time = ((event.clientX - box.left) / box.width) * seconds;
              if (audio.current === null) return;
              audio.current.currentTime = time;
              setAt(time);
              void audio.current.play();
            }}
          >
            {wave.peaks.map((peak, index) => (
              <rect
                // oxlint-disable-next-line react/no-array-index-key -- a peak is its slice.
                key={index}
                x={index + 0.15}
                width={0.7}
                y={50 - Math.max(peak, 0.01) * 48}
                height={Math.max(peak, 0.01) * 96}
                className={
                  index / wave.peaks.length < share ? "fill-foreground" : "fill-foreground/35"
                }
              />
            ))}
          </svg>
        )}
      </div>
      <div className="flex h-9 items-center gap-2 ps-2 pe-4">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={url === null}
                aria-label={playing ? "Pause the sound" : "Play the sound"}
                onClick={() => {
                  if (audio.current === null) return;
                  if (playing) audio.current.pause();
                  else void audio.current.play();
                }}
              />
            }
          >
            {playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
          </TooltipTrigger>
          <TooltipPopup side="top">{playing ? "Pause" : "Play"}</TooltipPopup>
        </Tooltip>
        <Text variant="caption" tone="muted" numeric>
          {clipTime(at)} / {clipTime(seconds)}
        </Text>
        <span className="flex-1" />
        {wave === null || wave === "failed" ? null : (
          <Text variant="caption" tone="muted" numeric>
            {wave.channels === 1 ? "Mono" : `${wave.channels} channels`} ·{" "}
            {Math.round(wave.rate / 100) / 10} kHz · {bytesWords(asset.bytes)}
          </Text>
        )}
        {url === null ? null : (
          // Its time moves the shading a few times a second while it plays, never per frame.
          <audio
            ref={audio}
            src={url}
            preload="none"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              setAt(0);
            }}
            onTimeUpdate={(event) => setAt(event.currentTarget.currentTime)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Fonts ─────────────────────────────────────────────────────────────────────

const SAMPLE = "The quick brown fox jumps over the lazy dog 0123456789";

/** A font's letters at a few sizes, loaded only while it is open. */
export function FontViewer({
  environmentId,
  root,
  asset,
}: {
  environmentId: EnvironmentId;
  root: string;
  asset: GameArtAsset;
}) {
  const state = useAssetUrlState(environmentId, {
    _tag: "draft-workspace-file",
    cwd: root,
    path: asset.path,
  });
  const url = state._tag === "Success" ? state.url : null;
  const [family, setFamily] = useState<string | null | "failed">(null);
  useEffect(() => {
    if (url === null) return;
    const name = `kurambit-art-${asset.sha256.slice(0, 12)}`;
    const face = new FontFace(name, `url("${url}")`);
    let live = true;
    face.load().then(
      (loaded) => {
        if (!live) return;
        document.fonts.add(loaded);
        setFamily(name);
      },
      () => live && setFamily("failed"),
    );
    return () => {
      live = false;
      document.fonts.delete(face);
    };
  }, [url, asset.sha256]);
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      {family === null ? (
        <Text variant="caption" tone="muted">
          Loading the font…
        </Text>
      ) : family === "failed" ? (
        <Text variant="caption" tone="muted">
          This browser could not load it.
        </Text>
      ) : (
        [32, 20, 14].map((px) => (
          <p
            key={px}
            className="text-foreground"
            style={{ fontFamily: family, fontSize: px, lineHeight: 1.25 }}
          >
            {SAMPLE}
          </p>
        ))
      )}
    </div>
  );
}
