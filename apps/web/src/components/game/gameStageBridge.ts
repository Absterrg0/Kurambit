import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { create } from "zustand";
import {
  decodeGameToStageMessage,
  type GameStageCapability,
  type GameStageRect,
  type GameStageToGameMessage,
  type GameStageTrace,
  type GameThing,
} from "@kurambit/contracts";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";

/**
 * The Stage end of the bridge (packages/contracts/src/gameStageBridge.ts):
 * what the game on the Stage said about itself, and the way to talk back. One
 * game frame owns it at a time, so the Stage's overlay and the dock's
 * Inspector and Things read the same state without threading props through
 * ChatView. Nothing here is persisted: a reload starts from the game again.
 */
export type StageBridgeStatus =
  /** The frame has not said yet. */
  | "waiting"
  /** A game from before the bridge (its bare `studio-ready`), so Freeze only holds it. */
  | "none"
  | "ready";

export interface StageSelection {
  readonly thing: GameThing;
  readonly rect?: GameStageRect | undefined;
  readonly trace?: GameStageTrace | undefined;
}

interface StageBridgeState {
  /** The frame this state describes: `${threadKey}\0${frameKey}`, null with none on screen. */
  readonly owner: string | null;
  readonly status: StageBridgeStatus;
  readonly capabilities: ReadonlyArray<GameStageCapability>;
  readonly things: ReadonlyArray<GameThing>;
  readonly frozen: boolean;
  /** The last freeze was asked for because the Stage lost focus (useStageAwayFreeze), not by the person. */
  readonly autoFrozen: boolean;
  readonly hover: { readonly id: string; readonly rect?: GameStageRect | undefined } | null;
  readonly selected: StageSelection | null;
  /** What each value was before the person tuned it here and has not kept: id → key → value. */
  readonly tunedFrom: Readonly<Record<string, Readonly<Record<string, number | boolean>>>>;
  readonly post: ((message: GameStageToGameMessage) => void) | null;
  /** Holds or resumes a game with no bridge through the visibility message every shell knows. */
  readonly hold: ((on: boolean) => void) | null;
}

const EMPTY: Omit<StageBridgeState, "owner" | "post" | "hold"> = {
  status: "waiting",
  capabilities: [],
  things: [],
  frozen: false,
  autoFrozen: false,
  hover: null,
  selected: null,
  tunedFrom: {},
};

export const useStageBridge = create<StageBridgeState>()(() => ({
  ...EMPTY,
  owner: null,
  post: null,
  hold: null,
}));

/**
 * The last frame the folder's game showed, per thread: what the strip's Now stands for, so
 * Now shows the game itself instead of a blank. Taken when the game freezes (the Stage lost
 * focus, or the person froze it), so capturing never costs a frame of play. In memory only:
 * a reload takes a new one as the game comes up and is held.
 */
export const useStageStills = create<Readonly<Record<string, string>>>()(() => ({}));

/**
 * A title or menu drawn in the page, not the canvas, leaves the canvas one flat colour: that
 * is not what the Stage shows, so it is no still. Sampled, since a card needs no exact answer.
 */
const isBlank = (pixels: Uint8ClampedArray) => {
  let low = 255 * 4;
  let high = 0;
  for (let index = 0; index < pixels.length; index += 4 * 97) {
    const sum = pixels[index]! + pixels[index + 1]! + pixels[index + 2]! + pixels[index + 3]!;
    low = Math.min(low, sum);
    high = Math.max(high, sum);
  }
  return high - low < 24;
};

/** The PNG the game sends is the canvas at full size; a card needs a few hundred pixels. */
const STILL_WIDTH = 480;
const shrinkStill = (png: string): Promise<string | null> => {
  const image = new Image();
  image.src = png;
  return image.decode().then(
    () => {
      const canvas = document.createElement("canvas");
      canvas.width = STILL_WIDTH;
      canvas.height = Math.max(
        1,
        Math.round((STILL_WIDTH * image.naturalHeight) / Math.max(1, image.naturalWidth)),
      );
      const context = canvas.getContext("2d");
      if (context === null) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return isBlank(context.getImageData(0, 0, canvas.width, canvas.height).data)
        ? null
        : canvas.toDataURL("image/webp", 0.82);
    },
    () => null,
  );
};
const keepStill = (owner: string, png: string) => {
  const threadKey = owner.slice(0, owner.indexOf("\0"));
  void shrinkStill(png).then((still) => {
    // A frame that arrives after its game left the Stage is still that game's last frame.
    if (still !== null) useStageStills.setState({ [threadKey]: still });
  });
};

// The one capture in flight: a second Ask waits for the same frame.
let captureWaiters: Array<(png: string | null) => void> = [];
const settleCapture = (png: string | null) => {
  const waiters = captureWaiters;
  captureWaiters = [];
  for (const resolve of waiters) resolve(png);
};

const isLegacyReady = (data: unknown) =>
  typeof data === "object" && data !== null && (data as { type?: unknown }).type === "studio-ready";

/**
 * Wires one game frame to the bridge while it is mounted and shown. `enabled`
 * is false for engines whose shells have no bridge: their frame never owns it.
 */
export function useStageBridgeFrame(
  owner: string,
  frame: HTMLIFrameElement | null,
  enabled: boolean,
) {
  useEffect(() => {
    const target = frame?.contentWindow ?? null;
    if (!enabled || frame === null || target === null) return;
    const post = (message: GameStageToGameMessage) => target.postMessage(message, "*");
    const hold = (on: boolean) => {
      target.postMessage({ type: "studio-visibility", visible: !on }, "*");
      useStageBridge.setState({ frozen: on });
    };
    useStageBridge.setState({ ...EMPTY, owner, post, hold });
    const onMessage = (event: MessageEvent) => {
      if (event.source !== target) return;
      const decoded = decodeGameToStageMessage(event.data);
      if (Option.isNone(decoded)) {
        // An old shell's boot signal: the game has no bridge, and says so only once.
        if (isLegacyReady(event.data) && useStageBridge.getState().status === "waiting")
          useStageBridge.setState({ status: "none" });
        return;
      }
      const message = decoded.value;
      switch (message.type) {
        case "studio-ready":
          useStageBridge.setState({ status: "ready", capabilities: message.capabilities });
          post({ type: "studio-things-request" });
          return;
        case "studio-things":
          useStageBridge.setState({ things: message.things });
          return;
        case "studio-hover":
          useStageBridge.setState({
            hover: message.id === null ? null : { id: message.id, rect: message.rect },
          });
          return;
        case "studio-selected":
          useStageBridge.setState({
            selected:
              message.thing === null
                ? null
                : { thing: message.thing, rect: message.rect, trace: message.trace },
          });
          return;
        case "studio-frozen":
          // Playing on keeps the selection, so its values can be tuned while playing.
          useStageBridge.setState(message.on ? { frozen: true } : { frozen: false, hover: null });
          if (message.on) void captureStageFrame();
          return;
        case "studio-frame":
          settleCapture(message.png);
          keepStill(owner, message.png);
          return;
        case "studio-key":
          // A focused game keeps every key from the app, so the shell sends Tab up: it moves
          // on past the Stage, as Tab does everywhere else. Escape clears what was pointed at,
          // else plays on. Freezing is its own key, so Tab never traps anyone in the game.
          if (message.key === "Tab") focusPastFrame(frame);
          else if (useStageBridge.getState().selected !== null) clearStageSelection();
          else toggleStageFreeze();
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      settleCapture(null);
      if (useStageBridge.getState().owner === owner)
        useStageBridge.setState({ ...EMPTY, owner: null, post: null, hold: null });
    };
  }, [owner, frame, enabled]);
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe,[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

/**
 * Moves focus to the first stop after the game's frame in the document, as the browser's own
 * Tab would had the game not kept the key. Positive tab indexes are not used in this app.
 */
function focusPastFrame(frame: HTMLIFrameElement) {
  const next = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
    (element) =>
      element !== frame &&
      frame.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING &&
      !frame.contains(element) &&
      element.closest("[inert]") === null &&
      element.checkVisibility(),
  );
  if (next === undefined) frame.blur();
  else next.focus();
}

/** The key that freezes the game to point at things, as the person's keybindings say it. */
export function useGameFreezeKey(): string | null {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return shortcutLabelForCommand(keybindings, "game.freeze", { context: { gameThread: true } });
}

/** The folder's game's last frame on this thread's Stage, or null before it has shown one. */
export const useStageStill = (threadKey: string): string | null =>
  useStageStills((stills) => stills[threadKey] ?? null);

/** The bridge state, only when it describes this thread's frame. */
export const useThreadStageBridge = <T>(
  threadKey: string,
  select: (state: StageBridgeState) => T,
  fallback: T,
): T =>
  useStageBridge((state) =>
    state.owner !== null && state.owner.startsWith(`${threadKey}\0`) ? select(state) : fallback,
  );

/** Freeze or play on: the game's own pause with a bridge, the visibility hold without one. */
const setStageFrozen = (on: boolean, auto: boolean) => {
  const state = useStageBridge.getState();
  if (state.owner === null) return;
  // Recorded as asked, before the game answers: a focus that leaves while a
  // play-on is still in flight must see it and hold the game again.
  useStageBridge.setState({ autoFrozen: on && auto, frozen: on });
  if (state.frozen === on) return;
  if (state.status === "ready" && state.capabilities.includes("freeze") && state.post !== null)
    state.post({ type: "studio-freeze", on });
  else state.hold?.(on);
};

/** A game held because the Stage lost focus counts as playing: the toggle freezes it for the person. */
export const toggleStageFreeze = () => {
  const { frozen, autoFrozen } = useStageBridge.getState();
  setStageFrozen(!(frozen && !autoFrozen), false);
};

/**
 * Holds the game, as Freeze does, while the Stage has no focus, so nothing
 * plays on unwatched while the person reads the chat; a frame that comes up
 * meanwhile (a live reload) is held as it says it is ready. The Stage's
 * focus coming back plays on, unless the person froze it themselves.
 */
export function useStageAwayFreeze(threadKey: string, away: boolean) {
  const owner = useThreadStageBridge(threadKey, (state) => state.owner, null);
  const status = useThreadStageBridge(threadKey, (state) => state.status, "waiting");
  useEffect(() => {
    if (owner === null || status === "waiting") return;
    const state = useStageBridge.getState();
    if (away && !state.frozen) setStageFrozen(true, true);
    else if (!away && state.frozen && state.autoFrozen) setStageFrozen(false, false);
  }, [away, owner, status]);
}

/** The thing pointed at on this thread's Stage, read outside render (a send). */
export const readThreadStageSelection = (threadKey: string): StageSelection | null => {
  const state = useStageBridge.getState();
  return state.owner !== null && state.owner.startsWith(`${threadKey}\0`) ? state.selected : null;
};

export const clearStageSelection = () => {
  const { post, selected } = useStageBridge.getState();
  if (selected !== null) post?.({ type: "studio-select", id: null });
  useStageBridge.setState({ selected: null });
};

export const selectStageThing = (id: string) =>
  useStageBridge.getState().post?.({ type: "studio-select", id });

/** Outlines a thing from the Things list while frozen; null clears. */
export const hoverStageThing = (id: string | null) =>
  useStageBridge.getState().post?.({ type: "studio-hover-thing", id });

export const pointStage = (x: number, y: number, action: "hover" | "select") =>
  useStageBridge.getState().post?.({ type: "studio-pointer", x, y, action });

/** A live value change; the first change of a value remembers what it was, for Reset. */
export const tuneStageValue = (
  id: string,
  key: string,
  value: number | boolean,
  before: number | boolean,
) => {
  const state = useStageBridge.getState();
  if (state.post === null) return;
  const thing = state.tunedFrom[id] ?? {};
  if (!(key in thing))
    useStageBridge.setState({
      tunedFrom: { ...state.tunedFrom, [id]: { ...thing, [key]: before } },
    });
  state.post({ type: "studio-tune", id, key, value });
};

/** Puts one thing's tuned values back as they were. */
export const resetStageValues = (id: string) => {
  const state = useStageBridge.getState();
  const before = state.tunedFrom[id];
  if (before === undefined) return;
  for (const [key, value] of Object.entries(before))
    state.post?.({ type: "studio-tune", id, key, value });
  const { [id]: _reset, ...rest } = state.tunedFrom;
  useStageBridge.setState({ tunedFrom: rest });
};

/** After Keep as a build: the kept values are the new baseline. */
export const forgetStageTuning = (id: string) => {
  const { [id]: _kept, ...rest } = useStageBridge.getState().tunedFrom;
  useStageBridge.setState({ tunedFrom: rest });
};

/** The canvas as a PNG data URL with no outline drawn, or null when the game cannot give one. */
export const captureStageFrame = (timeoutMs = 4000): Promise<string | null> => {
  const { post } = useStageBridge.getState();
  if (post === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      captureWaiters = captureWaiters.filter((waiter) => waiter !== done);
      resolve(null);
    }, timeoutMs);
    const done = (png: string | null) => {
      window.clearTimeout(timeout);
      resolve(png);
    };
    captureWaiters.push(done);
    if (captureWaiters.length === 1) post({ type: "studio-capture" });
  });
};
