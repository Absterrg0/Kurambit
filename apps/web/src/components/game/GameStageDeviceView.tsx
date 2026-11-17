import { useLayoutEffect, useState, type CSSProperties } from "react";
import { MonitorSmartphoneIcon } from "lucide-react";

import { BrowserViewportResizeHandles } from "../../browser/BrowserViewportResizeHandles";
import { BROWSER_VIEWPORT_RESIZE_RAIL_SIZE } from "../../browser/browserViewportLayout";
import { ScreenRotationIcon } from "../../browser/ScreenRotationIcon";
import { useBrowserViewportResize } from "../../browser/useBrowserViewportResize";
import { observeResize } from "../../lib/observeResize";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
} from "../ui/select";
import { Text } from "../ui/text";
import { Tooltip, TooltipLabel, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  GAME_STAGE_DEVICES,
  GAME_STAGE_ZOOMS,
  type GameStageDevice,
  type GameStageZoom,
  rotateStageDevice,
  stageDeviceAt,
  stageDeviceLabel,
} from "./gameStageDevice";

/** A stand-in size while the view is off: the hook runs either way, and its layout is unused. */
const OFF_SIZE = { width: 1280, height: 720 };

/**
 * The Stage's responsive view, as the play surface lays it out: the well measured, the frame at
 * the device's CSS size and scaled to fit, and handles to drag its size in Responsive. The frame
 * stays the same element either way, so turning the view on or off never reloads the game; the
 * game's own resize handler is what answers. The browser panel's layout and resize measure it,
 * as they do for its device toolbar.
 */
export function useStageDeviceLayout(
  device: GameStageDevice | null,
  onChange: (next: GameStageDevice | null) => void,
) {
  const [well, setWell] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const on = device !== null;
  useLayoutEffect(() => {
    if (well === null || !on) return;
    const read = () =>
      setRoom((previous) =>
        previous.width === well.clientWidth && previous.height === well.clientHeight
          ? previous
          : { width: well.clientWidth, height: well.clientHeight },
      );
    read();
    return observeResize(well, read);
  }, [well, on]);
  const size = device ?? OFF_SIZE;
  const zoom = device?.zoom ?? "fit";
  const resize = useBrowserViewportResize({
    commit: async (next) => {
      onChange(next._tag === "fill" ? null : stageDeviceAt(next, zoom));
    },
    viewport: { _tag: "freeform", width: size.width, height: size.height },
    zoomFactor: zoom === "fit" ? 1 : zoom,
    containerSize: room,
    deviceToolbarVisible: true,
    aspectRatio: null,
    // The toolbar is its own row above the well: only a rail's room above the frame.
    deviceToolbarHeight: BROWSER_VIEWPORT_RESIZE_RAIL_SIZE,
  });
  const shown =
    resize.effectiveViewport._tag === "fill"
      ? { width: size.width, height: size.height }
      : { width: resize.effectiveViewport.width, height: resize.effectiveViewport.height };
  const { layout } = resize;
  const scale = shown.width > 0 ? layout.viewportWidth / shown.width : 1;
  const measured = on && room.width > 0;
  return {
    setWell,
    /** The live size: the device's, or the dragged one while a handle moves. */
    shown,
    scale,
    /** Where the frame sits in the well; null while the view is off or not yet measured. */
    frameStyle: measured
      ? ({
          left: layout.viewportX,
          top: layout.viewportY,
          width: shown.width,
          height: shown.height,
          transform: `scale(${scale})`,
        } satisfies CSSProperties)
      : null,
    handles:
      measured && device.device === "responsive" ? (
        <BrowserViewportResizeHandles
          layout={layout}
          activeDirection={resize.activeDrag?.direction ?? null}
          onPointerDown={resize.handleResizePointerDown}
          onKeyDown={resize.handleResizeKeyDown}
        />
      ) : null,
  };
}

const RESPONSIVE = "responsive";
const DEVICE_ITEMS = [
  { value: RESPONSIVE, label: "Responsive" },
  ...GAME_STAGE_DEVICES.map((device) => ({ value: device.id, label: device.label })),
];
const zoomValue = (zoom: GameStageZoom) => String(zoom);
const percent = (scale: number) => `${Math.round(scale * 100)}%`;

/**
 * Chrome's device toolbar, in the Stage's words: the device, its width × height (typed, or the
 * live size while a handle drags), rotate, the zoom, and the view's own toggle as the way out.
 */
export function GameDeviceToolbar({
  device,
  shown,
  scale,
  shortcut,
  onChange,
}: {
  device: GameStageDevice;
  shown: { readonly width: number; readonly height: number };
  scale: number;
  shortcut: string | null;
  onChange: (next: GameStageDevice | null) => void;
}) {
  // Typed sides wait for Enter or leaving the field; a drag's live size shows otherwise.
  const [typed, setTyped] = useState<{ width: string; height: string } | null>(null);
  const sides = typed ?? { width: String(shown.width), height: String(shown.height) };
  const applyTyped = () => {
    if (typed === null) return;
    setTyped(null);
    const width = Number(typed.width);
    const height = Number(typed.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    if (width === device.width && height === device.height) return;
    onChange(stageDeviceAt({ width, height }, device.zoom));
  };
  const side = (axis: "width" | "height") => (
    <Input
      nativeInput
      type="number"
      inputMode="numeric"
      size="compact"
      value={sides[axis]}
      aria-label={axis === "width" ? "Width" : "Height"}
      onChange={(event) => setTyped({ ...sides, [axis]: event.target.value })}
      onKeyDown={(event) => {
        if (event.key === "Enter") applyTyped();
        if (event.key === "Escape" && typed !== null) {
          event.stopPropagation();
          setTyped(null);
        }
      }}
      onBlur={applyTyped}
      className="w-16"
    />
  );
  const fitScale = device.zoom === "fit" ? scale : null;
  return (
    <div
      role="toolbar"
      aria-label="Responsive view"
      data-game-device-toolbar=""
      className="flex h-9 shrink-0 items-center justify-center gap-1 px-2"
      onKeyDown={(event) => {
        // Esc leaves the view from anywhere on its toolbar; an open menu takes its own first.
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onChange(null);
        }
      }}
    >
      <Select
        modal={false}
        value={device.device}
        items={DEVICE_ITEMS}
        onValueChange={(value) => {
          if (value === null || value === device.device) return;
          if (value === RESPONSIVE) {
            onChange({ ...device, device: "responsive" });
            return;
          }
          const preset = GAME_STAGE_DEVICES.find((each) => each.id === value);
          if (preset !== undefined) onChange(stageDeviceAt(preset, device.zoom));
        }}
      >
        <SelectTrigger variant="ghost" size="xs" aria-label="Device" className="w-36">
          <Text variant="meta" tone="inherit" truncate>
            {stageDeviceLabel(device.device)}
          </Text>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          <SelectItem value={RESPONSIVE}>Responsive</SelectItem>
          <SelectGroup>
            <SelectGroupLabel>Devices</SelectGroupLabel>
            {GAME_STAGE_DEVICES.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                <span className="flex w-full items-center justify-between gap-6">
                  <span>{preset.label}</span>
                  <Text variant="caption" tone="muted" numeric>
                    {preset.width} × {preset.height}
                  </Text>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>
      <form
        className="flex items-center gap-1"
        aria-label="Viewport size"
        onSubmit={(event) => {
          event.preventDefault();
          applyTyped();
        }}
      >
        {side("width")}
        <Text variant="caption" tone="muted">
          ×
        </Text>
        {side("height")}
      </form>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Rotate"
              onClick={() => onChange(rotateStageDevice(device))}
            />
          }
        >
          <ScreenRotationIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Rotate</TooltipPopup>
      </Tooltip>
      <Select
        modal={false}
        value={zoomValue(device.zoom)}
        onValueChange={(value) => {
          const zoom = GAME_STAGE_ZOOMS.find((each) => zoomValue(each) === value);
          if (zoom !== undefined) onChange({ ...device, zoom });
        }}
      >
        <SelectTrigger variant="ghost" size="xs" aria-label="Zoom" className="w-24">
          <Text variant="meta" tone="inherit" numeric>
            {fitScale === null ? percent(scale) : `Fit ${percent(fitScale)}`}
          </Text>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          {GAME_STAGE_ZOOMS.map((zoom) => (
            <SelectItem key={zoomValue(zoom)} value={zoomValue(zoom)}>
              {zoom === "fit" ? "Fit to the Stage" : percent(zoom)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Leave responsive view"
              aria-pressed
              onClick={() => onChange(null)}
            />
          }
        >
          <MonitorSmartphoneIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          <TooltipLabel shortcut={shortcut}>Leave responsive view</TooltipLabel>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
