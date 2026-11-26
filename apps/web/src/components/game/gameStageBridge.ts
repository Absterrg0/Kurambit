import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  gameLookId,
  type GamePlay,
  type GameStageCapability,
  type GameStageControl,
  type GameStageRect,
  type GameStageToGameMessage,
  type GameStageTrace,
  type GameThing,
  type GameThingFacts,
  type GameToStageMessage,
  type StudioLook,
  type StudioReplay,
  type StudioReplayed,
} from "@kurambit/contracts";

import { resolveStorage } from "../../lib/storage";
import { clearStageConsole, watchLog } from "./gameStageWatch";

const LOOK_ID_PREFIX = gameLookId("");

/**
 * The Stage end of the bridge (packages/contracts/src/gameStageBridge.ts):
 * what the game on the Stage said about itself, and the way to talk back. One
 * game frame owns it at a time, so the Stage's overlay and the right panel's
 * Tune read the same state without threading props through
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
  /** The Stage silenced the game. */
  readonly muted: boolean;
  /** The game's actions and their keys, once asked for; null before. */
  readonly controls: ReadonlyArray<GameStageControl> | null;
  /** What the last rebind or reset did, in the game's words. */
  readonly controlsNote: string | null;
  /** Each thing's look as the game last said it, by thing id (null: it has none to edit). */
  readonly looks: Readonly<Record<string, StudioLook["look"]>>;
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
  muted: false,
  controls: null,
  controlsNote: null,
  looks: {},
};

export const useStageBridge = create<StageBridgeState>()(() => ({
  ...EMPTY,
  owner: null,
  post: null,
  hold: null,
}));

/**
 * The last frame the folder's game showed, per thread: what the strip's Now stands for, and
 * the game's Home card before any build has a measured picture. Taken when the game freezes
 * (the Stage lost focus, or the person froze it), so capturing never costs a frame of play.
 * Kept on this device across reloads, for the most recent games only: a card keeps the face
 * the game last showed instead of falling back to a plate. A small webp per thread.
 */
const STAGE_STILLS_KEPT = 24;
const useStageStills = create<Readonly<Record<string, string>>>()(
  persist(() => ({}), {
    name: "kurambit:stage-stills:v1",
    version: 1,
    storage: createJSONStorage(() => resolveStorage(globalThis.localStorage)),
  }),
);
/** The newest still for a thread goes last; the oldest beyond the cap are dropped. */
const rememberStill = (threadKey: string, still: string) =>
  useStageStills.setState((stills) => {
    const { [threadKey]: _previous, ...rest } = stills;
    return Object.fromEntries(
      [...Object.entries(rest), [threadKey, still] as const].slice(-STAGE_STILLS_KEPT),
    );
  }, true);

/**
 * A build's picture taken from the Stage while it played, by build id: what its card shows
 * until a measured play gives it one, so a new build has a face from its first play. In memory
 * only, like the Stage's own still.
 */
const useBuildFrames = create<Readonly<Record<string, string>>>()(() => ({}));
/** The first frame kept for a build stays its picture: a picture never swaps once a build has one. */
export const keepBuildFrame = (build: string, still: string) => {
  if (useBuildFrames.getState()[build] === undefined) useBuildFrames.setState({ [build]: still });
};
export const useBuildFrame = (build: string | null): string | null =>
  useBuildFrames((frames) => (build === null ? null : (frames[build] ?? null)));

/** How long after a game comes up its first frame is taken: past its first paint and fade-in. */
const FIRST_FRAME_MS = 2500;

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
    if (still !== null) rememberStill(threadKey, still);
  });
};

// The one capture in flight: a second Ask waits for the same frame.
let captureWaiters: Array<(png: string | null) => void> = [];
const settleCapture = (png: string | null) => {
  const waiters = captureWaiters;
  captureWaiters = [];
  for (const resolve of waiters) resolve(png);
};

/** The page each thread's console holds lines of, by its bridge owner. */
const consoleOwners = new Map<string, string>();

/**
 * Wires one game frame to the bridge while it is mounted and shown, and returns what to do
 * with each message the frame posts (GameFrame owns the one listener). `enabled` is false for
 * engines whose shells have no bridge: their frame never owns it. `hello` holds the page's
 * studio-ready when it came before the frame owned the bridge (a save's frame that drew behind
 * the one on the Stage): the bridge hears it as it takes the frame.
 */
export function useStageBridgeFrame(
  owner: string,
  frame: HTMLIFrameElement | null,
  enabled: boolean,
  hello: { readonly current: GameToStageMessage | null },
): ((message: GameToStageMessage) => void) | undefined {
  const target = enabled ? (frame?.contentWindow ?? null) : null;
  useEffect(() => {
    if (target === null || frame === null) return;
    const post = (message: GameStageToGameMessage) => target.postMessage(message, "*");
    const hold = (on: boolean) => {
      post({ type: "studio-visibility", visible: !on });
      useStageBridge.setState({ frozen: on });
    };
    useStageBridge.setState({ ...EMPTY, owner, post, hold });
    // Another page on the Stage is a new console, as a browser's is on a reload: what an earlier
    // page logged (the template before the game existed, an older build) is not this one's. The
    // same page shown again keeps its lines.
    const threadKey = owner.slice(0, owner.indexOf("\0"));
    if (consoleOwners.get(threadKey) !== owner) {
      consoleOwners.set(threadKey, owner);
      clearStageConsole(threadKey);
    }
    if (hello.current !== null) receive(owner, frame, hello.current);
    return () => {
      settleCapture(null);
      settleRun(null);
      settleReplay(null);
      if (useStageBridge.getState().owner === owner)
        useStageBridge.setState({ ...EMPTY, owner: null, post: null, hold: null });
    };
  }, [owner, target, frame, hello]);
  return target === null || frame === null
    ? undefined
    : (message: GameToStageMessage) => receive(owner, frame, message);
}

function receive(owner: string, frame: HTMLIFrameElement, message: GameToStageMessage) {
  if (useStageBridge.getState().owner !== owner) return;
  switch (message.type) {
    case "studio-ready":
      // An old shell's boot signal carries no bridge: Freeze only holds that game.
      if (message.bridge === undefined) {
        if (useStageBridge.getState().status === "waiting")
          useStageBridge.setState({ status: "none" });
        return;
      }
      useStageBridge.setState({ status: "ready", capabilities: message.capabilities ?? [] });
      useStageBridge.getState().post?.({ type: "studio-things-request" });
      // Can't lose and the dev views outlive a Restart: the game that comes up is told again.
      if (cannotLose.has(owner.slice(0, owner.indexOf("\0"))))
        useStageBridge.getState().post?.({ type: "studio-cannot-lose", on: true });
      postDevViews(owner.slice(0, owner.indexOf("\0")));
      // One frame of the game as it comes up, so the build it plays has a picture at once.
      window.setTimeout(() => {
        if (useStageBridge.getState().owner === owner) void captureStageFrame();
      }, FIRST_FRAME_MS);
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
    case "studio-picture":
      settlePortrait(
        message.request,
        message.png === null ? null : { png: message.png, facts: message.facts },
      );
      return;
    case "studio-key":
      // Escape on a frozen game: it clears what was pointed at, else plays on. Every other key
      // stays the game's; Focus game's chord hands the keyboard back.
      if (useStageBridge.getState().selected !== null) clearStageSelection();
      else toggleStageFreeze();
      return;
    case "studio-shortcut":
      // The app's keys read the window's keydowns, so the chord is pressed there as if the
      // app had focus.
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: message.key,
          code: message.code,
          ctrlKey: message.ctrlKey,
          metaKey: message.metaKey,
          shiftKey: message.shiftKey,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      return;
    case "studio-controls":
      useStageBridge.setState({ controls: message.controls, controlsNote: message.note ?? null });
      return;
    case "studio-look":
      useStageBridge.setState({
        looks: { ...useStageBridge.getState().looks, [message.id]: message.look },
      });
      return;
    case "studio-run":
      settleRun(message.play);
      return;
    case "studio-replayed":
      if (replayWaiter?.id === message.id) settleReplay(message);
      return;
    case "studio-log":
      watchLog(owner.slice(0, owner.indexOf("\0")), message.lines, message.dropped ?? 0);
      return;
    // The once-a-second marks reach the server with the run; nothing here shows them live.
    case "studio-mark":
    case "studio-run-reset":
    case "studio-error":
    case "studio-visibility-ack":
    case "studio-play":
      return;
  }
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
const setStageFrozen = (on: boolean) => {
  const state = useStageBridge.getState();
  if (state.owner === null) return;
  // Recorded as asked, before the game answers, so a second press reads the new state.
  useStageBridge.setState({ frozen: on });
  if (state.frozen === on) return;
  if (state.status === "ready" && state.capabilities.includes("freeze") && state.post !== null)
    state.post({ type: "studio-freeze", on });
  else state.hold?.(on);
};

/**
 * Freezes or plays on, to point at things. Clicking away from the game holds it separately
 * (GameFrame's pause when away), so a freeze is always the person's own.
 */
export const toggleStageFreeze = () => setStageFrozen(!useStageBridge.getState().frozen);
export const freezeStage = () => setStageFrozen(true);

export const clearStageSelection = () => {
  const { post, selected } = useStageBridge.getState();
  if (selected !== null) post?.({ type: "studio-select", id: null });
  useStageBridge.setState({ selected: null });
};

/** Points at a thing from Tune's list, as a click on the Stage does: one selection for both. */
export const selectStageThing = (id: string) =>
  useStageBridge.getState().post?.({ type: "studio-select", id });

/** Freezes the game and points at a thing there: its outline and name show on the Stage. */
export const pointAtStageThing = (id: string) => {
  setStageFrozen(true);
  selectStageThing(id);
};

/** Outlines a thing from the Things list while frozen; null clears. */
export const hoverStageThing = (id: string | null) =>
  useStageBridge.getState().post?.({ type: "studio-hover-thing", id });

export const pointStage = (x: number, y: number, action: "hover" | "select" | "select-inner") =>
  useStageBridge.getState().post?.({ type: "studio-pointer", x, y, action });

/** A live value change: the game plays it at once; saving it is Tune's. */
export const tuneStageValue = (id: string, key: string, value: number | boolean) => {
  const state = useStageBridge.getState();
  if (state.post === null) return;
  state.post({ type: "studio-tune", id, key, value });
  withValue(id, key, value);
};

/**
 * A name the person gave a part (`key` "name") or a look's material ("2:roof/name") of the look
 * id; null takes it back. The game shows it at once; the saver keeps it in tune.json.
 */
export const nameStageThing = (lookId: string, key: string, name: string | null) =>
  useStageBridge.getState().post?.({ type: "studio-name", id: lookId, key, name });

/** Asks the game for a thing's look (its scale, shadows and materials): studio-look answers. */
export const requestStageLook = (id: string) =>
  useStageBridge.getState().post?.({ type: "studio-look-request", id });

/** The list and the pointed thing show a tuned value at once; the game's next report confirms it. */
const withValue = (id: string, key: string, value: number | boolean) => {
  const state = useStageBridge.getState();
  const lookOf = id.startsWith(LOOK_ID_PREFIX) ? id.slice(LOOK_ID_PREFIX.length) : null;
  const look = lookOf === null ? null : (state.looks[lookOf] ?? null);
  if (lookOf !== null && look !== null) {
    useStageBridge.setState({
      looks: {
        ...state.looks,
        [lookOf]: {
          ...look,
          values: look.values.map((entry) => (entry.key === key ? { ...entry, value } : entry)),
        },
      },
    });
    return;
  }
  const tuned = (thing: GameThing): GameThing =>
    thing.id !== id || thing.values === undefined
      ? thing
      : {
          ...thing,
          values: thing.values.map((entry) => (entry.key === key ? { ...entry, value } : entry)),
        };
  useStageBridge.setState({
    things: state.things.map(tuned),
    selected:
      state.selected === null ? null : { ...state.selected, thing: tuned(state.selected.thing) },
  });
};

/** The threads whose Stage has Can't lose on, for the session: told to each game that comes up. */
const cannotLose = new Set<string>();
const useCannotLose = create<Readonly<Record<string, boolean>>>()(() => ({}));
export const useStageCannotLose = (threadKey: string) =>
  useCannotLose((all) => all[threadKey] ?? false);
export const stageCannotLose = (threadKey: string) => useCannotLose.getState()[threadKey] ?? false;

/** Can't lose, for tuning a fight without the round ending; the measures never see it. */
const setStageCannotLose = (threadKey: string, on: boolean) => {
  if (on) cannotLose.add(threadKey);
  else cannotLose.delete(threadKey);
  useCannotLose.setState({ [threadKey]: on });
  const state = useStageBridge.getState();
  if (state.owner?.startsWith(`${threadKey}\0`) && state.capabilities.includes("cannot-lose"))
    state.post?.({ type: "studio-cannot-lose", on });
};

/** Whether this thread's game is up on the Stage and answers `capability`. */
const stageCan = (threadKey: string, capability: GameStageCapability) => {
  const state = useStageBridge.getState();
  return (
    state.status === "ready" &&
    state.owner?.startsWith(`${threadKey}\0`) === true &&
    state.capabilities.includes(capability)
  );
};

/** Can't lose flipped, for the palette and its key; false when the game on the Stage has none. */
export const toggleStageCannotLose = (threadKey: string): boolean => {
  if (!stageCan(threadKey, "cannot-lose")) return false;
  setStageCannotLose(threadKey, !stageCannotLose(threadKey));
  return true;
};

export interface StageDevViews {
  /** The named things' bounds, drawn over the game. */
  readonly bounds: boolean;
  /** Frame rate, frame time, draws and triangles in the game's corner. */
  readonly perf: boolean;
  /** While frozen, drag to orbit and wheel to zoom around the frame. */
  readonly freeCamera: boolean;
}
const NO_DEV_VIEWS: StageDevViews = { bounds: false, perf: false, freeCamera: false };
/** Each thread's dev views for the session: told to each game that comes up, as Can't lose is. */
const useDevViews = create<Readonly<Record<string, StageDevViews>>>()(() => ({}));
export const useStageDevViews = (threadKey: string) =>
  useDevViews((all) => all[threadKey] ?? NO_DEV_VIEWS);
const postDevViews = (threadKey: string) => {
  const state = useStageBridge.getState();
  if (state.owner?.startsWith(`${threadKey}\0`) && state.capabilities.includes("dev"))
    state.post?.({ type: "studio-dev", ...(useDevViews.getState()[threadKey] ?? NO_DEV_VIEWS) });
};
/** A dev view flipped, for the palette and its keys; false when the game on the Stage has none. */
export const toggleStageDevView = (threadKey: string, view: keyof StageDevViews): boolean => {
  if (!stageCan(threadKey, "dev")) return false;
  const now = useDevViews.getState()[threadKey] ?? NO_DEV_VIEWS;
  useDevViews.setState({ [threadKey]: { ...now, [view]: !now[view] } });
  postDevViews(threadKey);
  return true;
};
/** One fixed step of the frozen game; false when nothing is frozen to step. */
export const stepStageFrame = (threadKey: string): boolean => {
  const state = useStageBridge.getState();
  if (!state.frozen || !stageCan(threadKey, "dev")) return false;
  state.post?.({ type: "studio-step" });
  return true;
};
/** The free camera's drag and wheel, from the frozen Stage's pointer layer. */
export const orbitStage = (dx: number, dy: number, zoom: number) =>
  useStageBridge.getState().post?.({ type: "studio-orbit", dx, dy, zoom });

/** Asks the game for its actions; a game without the capability never answers. */
export const requestStageControls = () => {
  const state = useStageBridge.getState();
  if (state.post === null || !state.capabilities.includes("controls")) return;
  useStageBridge.setState({ controlsNote: null });
  state.post({ type: "studio-controls-request" });
};

/** Puts `code` first on an action, as the game's own Controls screen does; it saves it. */
export const rebindStageControl = (name: string, code: string) =>
  useStageBridge.getState().post?.({ type: "studio-rebind", name, code });

export const resetStageControls = () =>
  useStageBridge.getState().post?.({ type: "studio-controls-reset" });

export const setStageMuted = (muted: boolean) => {
  const state = useStageBridge.getState();
  if (state.post === null || !state.capabilities.includes("mute")) return;
  state.post({ type: "studio-mute", on: muted });
  useStageBridge.setState({ muted });
};

/**
 * Asks the game for its run so far, which it answers as a studio-play with `asked` set; false
 * when the game on the Stage cannot (an older shell).
 */
export const requestStageRun = (): boolean => {
  const state = useStageBridge.getState();
  if (state.post === null || !state.capabilities.includes("runs")) return false;
  state.post({ type: "studio-run-request" });
  return true;
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

export interface StagePortrait {
  readonly png: string;
  readonly facts?: GameThingFacts | undefined;
}
const portraitWaiters = new Map<number, (portrait: StagePortrait | null) => void>();
let portraitCount = 0;
const settlePortrait = (request: number, portrait: StagePortrait | null) => {
  portraitWaiters.get(request)?.(portrait);
  portraitWaiters.delete(request);
};

/**
 * One named thing drawn alone by the game on the Stage, framed and seen from `yaw` and `pitch`
 * (stage-bridge.js portrait), with what it is made of; null when the game cannot draw it.
 */
export const portraitStageThing = (
  id: string,
  view: { readonly size: number; readonly yaw: number; readonly pitch: number },
  timeoutMs = 6000,
): Promise<StagePortrait | null> => {
  const { post, capabilities, status } = useStageBridge.getState();
  if (post === null || status !== "ready" || !capabilities.includes("portrait"))
    return Promise.resolve(null);
  portraitCount += 1;
  const request = portraitCount;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => settlePortrait(request, null), timeoutMs);
    portraitWaiters.set(request, (portrait) => {
      window.clearTimeout(timeout);
      resolve(portrait);
    });
    post({ type: "studio-portrait", request, id, ...view });
  });
};

// The one take of the run in flight: a second asker waits for the same answer.
let runWaiters: Array<(play: GamePlay | null) => void> = [];
const settleRun = (play: GamePlay | null) => {
  const waiters = runWaiters;
  runWaiters = [];
  for (const resolve of waiters) resolve(play);
};

/**
 * The run in play so far, or null with none (a title, an ending, a game that cannot say). With
 * `leave`, the page is about to go away: the game stops recording the run, which is the
 * Stage's to keep and to resume on the page that comes up.
 */
export const takeStageRun = (leave: boolean, timeoutMs = 400): Promise<GamePlay | null> => {
  const { post, capabilities, status } = useStageBridge.getState();
  if (post === null || status !== "ready" || !capabilities.includes("rewind"))
    return Promise.resolve(null);
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      runWaiters = runWaiters.filter((waiter) => waiter !== done);
      resolve(null);
    }, timeoutMs);
    const done = (play: GamePlay | null) => {
      window.clearTimeout(timeout);
      resolve(play);
    };
    runWaiters.push(done);
    if (runWaiters.length === 1) post({ type: "studio-run-take", leave });
  });
};

let replayWaiter: {
  readonly id: number;
  readonly resolve: (result: StudioReplayed | null) => void;
} | null = null;
let replayCount = 0;
const settleReplay = (result: StudioReplayed | null) => {
  const waiter = replayWaiter;
  replayWaiter = null;
  waiter?.resolve(result);
};
/** The game gives up on getting back after 20 s of real time; past this the frame is gone. */
const REPLAY_ANSWER_MS = 30_000;

/**
 * Replays a run to a moment on the Stage's game and hands it over there, frozen
 * (packages/contracts StudioReplay). Null when the game cannot, when a newer replay was asked for
 * first, or when its frame went away.
 */
export const replayStageRun = (
  request: Omit<StudioReplay, "type" | "id">,
): Promise<StudioReplayed | null> => {
  const { post, capabilities, status } = useStageBridge.getState();
  if (post === null || status !== "ready" || !capabilities.includes("rewind"))
    return Promise.resolve(null);
  settleReplay(null);
  replayCount += 1;
  const id = replayCount;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      if (replayWaiter?.id === id) settleReplay(null);
    }, REPLAY_ANSWER_MS);
    replayWaiter = {
      id,
      resolve: (result) => {
        window.clearTimeout(timeout);
        resolve(result);
      },
    };
    post({ type: "studio-replay", id, ...request });
  });
};
