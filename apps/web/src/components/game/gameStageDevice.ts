import {
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
} from "@kurambit/contracts";

/**
 * The Stage's responsive view, the way Chrome DevTools' device toolbar works: the game's frame
 * takes a device's CSS size, live, and is scaled to fit the Stage. The game keeps running, so its
 * own resize handler is what is tested. The shapes a game is played on, wide to tall.
 */
export const GAME_STAGE_DEVICES = [
  { id: "phone", label: "Phone", width: 390, height: 844 },
  { id: "phone-landscape", label: "Phone landscape", width: 844, height: 390 },
  { id: "tablet", label: "Tablet", width: 820, height: 1180 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
  { id: "desktop", label: "Desktop", width: 1920, height: 1080 },
  { id: "ultrawide", label: "Ultrawide", width: 2560, height: 1080 },
] as const;

export type GameStageDeviceId = (typeof GAME_STAGE_DEVICES)[number]["id"] | "responsive";

/** Fit scales the frame down to the Stage's room; a percentage is that scale, or less to fit. */
export const GAME_STAGE_ZOOMS = ["fit", 0.5, 0.75, 1] as const;
export type GameStageZoom = (typeof GAME_STAGE_ZOOMS)[number];

export interface GameStageDevice {
  readonly device: GameStageDeviceId;
  readonly width: number;
  readonly height: number;
  readonly zoom: GameStageZoom;
}

const clampSide = (side: number) =>
  Math.min(
    PREVIEW_VIEWPORT_MAX_DIMENSION,
    Math.max(PREVIEW_VIEWPORT_MIN_DIMENSION, Math.round(side)),
  );

/** A size as the view takes it: the device it is, else Responsive at that size. */
export const stageDeviceAt = (
  size: { readonly width: number; readonly height: number },
  zoom: GameStageZoom = "fit",
): GameStageDevice => {
  const width = clampSide(size.width);
  const height = clampSide(size.height);
  const preset = GAME_STAGE_DEVICES.find(
    (device) => device.width === width && device.height === height,
  );
  return { device: preset?.id ?? "responsive", width, height, zoom };
};

/** The view opened with no size asked for. */
export const DEFAULT_STAGE_DEVICE: GameStageDevice = stageDeviceAt(GAME_STAGE_DEVICES[0]);

/** Turned on its side: a phone becomes the landscape phone and back; any other keeps its name. */
export const rotateStageDevice = (device: GameStageDevice): GameStageDevice => {
  const turned = { width: device.height, height: device.width };
  const preset = GAME_STAGE_DEVICES.find(
    (each) => each.width === turned.width && each.height === turned.height,
  );
  return { ...device, ...turned, device: preset?.id ?? device.device };
};

export const stageDeviceLabel = (device: GameStageDeviceId) =>
  device === "responsive"
    ? "Responsive"
    : (GAME_STAGE_DEVICES.find((each) => each.id === device)?.label ?? "Responsive");

/** Whether two sizes are the same shape, within a pixel's rounding at the Stage's sizes. */
export const sameShape = (
  a: { readonly width: number; readonly height: number },
  b: { readonly width: number; readonly height: number },
) => Math.abs(a.width / a.height - b.width / b.height) < 0.02;
