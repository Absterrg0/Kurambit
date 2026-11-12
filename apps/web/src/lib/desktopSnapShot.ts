import type { DesktopBridge } from "@kurambit/contracts";

// Anything on screen (a SnapShot capture, the new game's Inspector) asks the open composer
// to take focus; the chat view that owns the composer listens.
const COMPOSER_FOCUS_EVENT = "kurambit:focus-composer";

export function dispatchComposerFocus(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(COMPOSER_FOCUS_EVENT));
}

export function subscribeComposerFocus(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(COMPOSER_FOCUS_EVENT, listener);
  return () => window.removeEventListener(COMPOSER_FOCUS_EVENT, listener);
}

type SnapShotMethods =
  | "requestSnapShotPermissions"
  | "getSnapShotState"
  | "checkSnapShotShortcut"
  | "setSnapShotShortcutSuppressed"
  | "listPendingSnapShots"
  | "readSnapShot"
  | "acknowledgeSnapShot"
  | "onSnapShotEvent";

export type DesktopSnapShotBridge = DesktopBridge & Required<Pick<DesktopBridge, SnapShotMethods>>;

export function getDesktopSnapShotBridge(): DesktopSnapShotBridge | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (
    typeof bridge?.requestSnapShotPermissions !== "function" ||
    typeof bridge?.getSnapShotState !== "function" ||
    typeof bridge.checkSnapShotShortcut !== "function" ||
    typeof bridge.setSnapShotShortcutSuppressed !== "function" ||
    typeof bridge.listPendingSnapShots !== "function" ||
    typeof bridge.readSnapShot !== "function" ||
    typeof bridge.acknowledgeSnapShot !== "function" ||
    typeof bridge.onSnapShotEvent !== "function"
  ) {
    return undefined;
  }

  return bridge as DesktopSnapShotBridge;
}
