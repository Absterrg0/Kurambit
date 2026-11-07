import { useEffect } from "react";
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
          return;
        case "studio-frame":
          settleCapture(message.png);
          return;
        case "studio-key":
          // The same keys as on the Stage itself, from a game that has focus.
          if (message.key === "Tab") toggleStageFreeze();
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
export const toggleStageFreeze = () => {
  const state = useStageBridge.getState();
  if (state.owner === null) return;
  const on = !state.frozen;
  if (state.status === "ready" && state.capabilities.includes("freeze") && state.post !== null)
    state.post({ type: "studio-freeze", on });
  else state.hold?.(on);
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
