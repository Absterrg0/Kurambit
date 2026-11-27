import {
  EnvironmentId,
  GameBuildId,
  ProjectId,
  type GameAction,
  type GameStatus,
  type GameBuildPlayResult,
  type GameBuildRef,
  type GameBuildsResult,
  type GameOperationEvent,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
  WS_METHODS,
} from "@kurambit/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@kurambit/client-runtime/state/runtime";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import { type GameEventScope, gameEventScope } from "./gameEventScope";
import { environmentThreadShells } from "./threads";
import { selectTurnBuild, type TurnBuildView } from "./gameTurnBuild";

const gameEvents = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "game:events",
  tag: WS_METHODS.subscribeGameEvents,
  // Game operations are minutes apart; keep the stream warm while a game
  // surface is open without holding it for the life of the app.
  idleTtlMs: 5 * 60_000,
  // A stream atom holds only its last value, and a signal nobody reads (its chat is in the
  // background) reads only that value when it is read again: a run push followed by a builds
  // push was never seen, and the Keep going banner kept saying step 1. Each value is the whole
  // batch after the newest earlier push of every game and scope, so none hides behind another.
  transform: Stream.mapAccumArray(
    () => new Map<string, GameOperationEvent>(),
    (newest, batch) => {
      const value = [...newest.values(), ...batch];
      const next = new Map(newest);
      for (const event of batch) {
        // Oldest first, as pushes came: a reader's newest is the last it finds.
        const key = `${event.root}\0${gameEventScope(event)}`;
        next.delete(key);
        next.set(key, event);
      }
      return [next, [value]];
    },
  ),
});

/** The newest event of the latest batch whose scope is wanted, or undefined. */
const newestOf = (
  result: AsyncResult.AsyncResult<ReadonlyArray<GameOperationEvent>, unknown>,
  wanted: (event: GameOperationEvent) => boolean,
) => (AsyncResult.isSuccess(result) ? result.value.findLast(wanted) : undefined);

/**
 * A value that changes on every push of the given scopes for one thread's
 * game. Its queries read it through `refreshTrigger`, so an idle Stage learns
 * about a later agent build from the push instead of polling, another game's
 * work never refetches it, and a push of another scope (a run step for the
 * status, an export for the run) does not either.
 */
const threadScopeSignal = Atom.family((key: string) => {
  const [environmentId = "", threadId = "", scopes = ""] = key.split("\0");
  const wanted = new Set(scopes.split("|"));
  let last = "";
  return Atom.make((get) => {
    const result = get(
      gameEvents({
        environmentId: EnvironmentId.make(environmentId),
        input: { threadId: ThreadId.make(threadId) },
      }),
    );
    const event = newestOf(result, (each) => wanted.has(gameEventScope(each)));
    if (event !== undefined) last = `${event.at}\0${event.revision ?? ""}`;
    return last;
  }).pipe(Atom.withLabel(`game:thread-signal:${key}`));
});

const threadSignal =
  (...scopes: ReadonlyArray<GameEventScope>) =>
  (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId };
  }) =>
    threadScopeSignal(`${target.environmentId}\0${target.input.threadId}\0${scopes.join("|")}`);

/** The last settled change under a live game's served folder: its count, message and time. */
export interface GameLiveChange {
  readonly revision: number;
  readonly message: string;
  readonly at: string;
}

/** A live push about the serve itself, not a change under the folder. */
const LIVE_SERVE_MESSAGES: ReadonlySet<string> = new Set(["Serving", "Stopped"]);

/**
 * Each live push for one thread's game: files under the served folder
 * changed and settled. Only the Stage's frame reads it; no query rereads on
 * it. `revision` counts pushes seen here, so it starts at 0 with none. The
 * serve opening or closing is the status's news, not a change to show.
 */
const liveSignalAtom = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\0");
  let last: GameLiveChange = { revision: 0, message: "", at: "" };
  let lastEvent = "";
  return Atom.make((get) => {
    const result = get(
      gameEvents({
        environmentId: EnvironmentId.make(environmentId),
        input: { threadId: ThreadId.make(threadId) },
      }),
    );
    if (!AsyncResult.isSuccess(result)) return last;
    for (const event of result.value) {
      if (gameEventScope(event) !== "live" || LIVE_SERVE_MESSAGES.has(event.message)) continue;
      const id = `${event.revision ?? ""}\0${event.at}`;
      if (id !== lastEvent) {
        lastEvent = id;
        last = { revision: last.revision + 1, message: event.message, at: event.at };
      }
    }
    return last;
  }).pipe(Atom.withLabel(`game:live-signal:${key}`));
});
export const liveSignal = (ref: ScopedThreadRef) =>
  liveSignalAtom(`${ref.environmentId}\0${ref.threadId}`);

/**
 * Whether any chat of a game's project has a turn running: someone may be
 * mid-edit in the live folder. A boolean, so a streaming turn re-renders
 * nothing until it starts or ends.
 */
const projectTurnRunningAtom = Atom.family((key: string) => {
  const [environmentId = "", projectId = ""] = key.split("\0");
  const ref: ScopedProjectRef = {
    environmentId: EnvironmentId.make(environmentId),
    projectId: ProjectId.make(projectId),
  };
  return Atom.make((get) =>
    get(environmentThreadShells.threadShellsForProjectRefsAtom([ref])).some((shell) =>
      threadRuntimeIsActive(shell.runtime),
    ),
  ).pipe(Atom.withLabel(`game:project-turn-running:${key}`));
});
const NO_TURN_RUNNING = Atom.make(false);

/**
 * Where a game's chats work and whether each is at work, as one string: changes when a chat
 * starts or ends a turn, or moves into a copy or out of one. Its copies list rereads on it, since
 * a copy's turns push to the copy's folder, never to the game's.
 */
const projectChatsSignalAtom = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\0");
  return Atom.make((get) => {
    const env = EnvironmentId.make(environmentId);
    const threads = get(environmentThreadShells.environmentThreadsAtom(env));
    const projectId = threads.find((thread) => thread.id === threadId)?.projectId;
    return threads
      .filter((thread) => thread.projectId === projectId && thread.archivedAt === null)
      .map(
        (thread) =>
          `${thread.id}:${thread.worktreePath ?? ""}:${thread.activeRunId ?? ""}:${thread.latestRunCompletedAt ?? ""}`,
      )
      .join("|");
  }).pipe(Atom.withLabel(`game:project-chats-signal:${key}`));
});

/** Whether any chat of this chat's game works in a copy: until one does, no copy UI shows. */
const projectHasCopiesAtom = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\0");
  return Atom.make((get) => {
    const threads = get(
      environmentThreadShells.environmentThreadsAtom(EnvironmentId.make(environmentId)),
    );
    const projectId = threads.find((thread) => thread.id === threadId)?.projectId;
    return threads.some(
      (thread) =>
        thread.projectId === projectId &&
        thread.archivedAt === null &&
        thread.worktreePath !== null,
    );
  }).pipe(Atom.withLabel(`game:project-has-copies:${key}`));
});
const NO_COPIES = Atom.make(false);
export const projectHasCopies = (ref: ScopedThreadRef | null) =>
  ref === null ? NO_COPIES : projectHasCopiesAtom(`${ref.environmentId}\0${ref.threadId}`);
export const projectTurnRunning = (ref: ScopedProjectRef | null) =>
  ref === null ? NO_TURN_RUNNING : projectTurnRunningAtom(`${ref.environmentId}\0${ref.projectId}`);

/**
 * What rereads a game's status: its operations and builds, and its live serve
 * opening or closing, from any client, the palette or an agent. A
 * "Changed <path>" push rereads nothing.
 */
const statusSignalAtom = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\0");
  let serve = "";
  return Atom.make((get) => {
    const result = get(
      gameEvents({
        environmentId: EnvironmentId.make(environmentId),
        input: { threadId: ThreadId.make(threadId) },
      }),
    );
    const opened = newestOf(
      result,
      (event) => gameEventScope(event) === "live" && LIVE_SERVE_MESSAGES.has(event.message),
    );
    if (opened !== undefined) serve = `${opened.at}\0${opened.revision ?? ""}`;
    return `${get(threadScopeSignal(`${key}\0operation|builds`))}\0${serve}`;
  }).pipe(Atom.withLabel(`game:status-signal:${key}`));
});

/**
 * Changes only when a game's run or operation changes state, which is all a
 * library card shows; progress messages within one state do not reread the list.
 */
const gameListSignal = Atom.family((environmentId: string) => {
  const states = new Map<string, string>();
  let changes = 0;
  return Atom.make((get) => {
    const result = get(gameEvents({ environmentId: EnvironmentId.make(environmentId), input: {} }));
    // The server sends the library only games' own folders (never its build copies).
    // A card shows no saved media, builds, facts or live serve, so their pushes
    // never reread the list: an agent's saves on a live game are many.
    if (!AsyncResult.isSuccess(result)) return changes;
    for (const event of result.value) {
      const scope = gameEventScope(event);
      if (scope === "saved" || scope === "builds" || scope === "facts" || scope === "live")
        continue;
      // A run event's message is its current step, which the card shows.
      const state =
        event.name === "run"
          ? `run\0${event.state}\0${event.message}`
          : `${event.name}\0${event.state}`;
      // Per game and scope: each value restates the newest of both, which changes nothing.
      const key = `${event.root}\0${scope}`;
      if (states.get(key) !== state) {
        states.set(key, state);
        changes += 1;
      }
    }
    return changes;
  }).pipe(Atom.withLabel(`game:list-signal:${environmentId}`));
});

/**
 * Changes when the server pushes a change to one thread's game's saved/
 * folder: a save or delete from this client, another one, or an agent's tool.
 */
const savedMediaSignal = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\0");
  let changes = 0;
  let last = "";
  return Atom.make((get) => {
    const result = get(
      gameEvents({
        environmentId: EnvironmentId.make(environmentId),
        input: { threadId: ThreadId.make(threadId) },
      }),
    );
    const event = newestOf(result, (each) => gameEventScope(each) === "saved");
    if (event === undefined) return changes;
    const seen = `${event.at}\0${event.revision ?? ""}`;
    if (seen !== last) {
      last = seen;
      changes += 1;
    }
    return changes;
  }).pipe(Atom.withLabel(`game:saved-media:${key}`));
});

/**
 * A build restore this client is sending for one thread's game: which build,
 * and the game's latest restore when it was sent. Every restore button of the
 * game (the rail, the undo, a round card) reads it, so none can send a second
 * one before the Builds list shows the first.
 */
export interface BuildRestoreSending {
  readonly target: string;
  readonly since: string | null;
}
const buildRestoreSendingAtom = Atom.family((key: string) =>
  Atom.make<BuildRestoreSending | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`game:build-restore-sending:${key}`),
  ),
);
export const buildRestoreSending = (ref: ScopedThreadRef) =>
  buildRestoreSendingAtom(`${ref.environmentId}\0${ref.threadId}`);
export const setBuildRestoreSending = (ref: ScopedThreadRef, value: BuildRestoreSending | null) =>
  appAtomRegistry.set(buildRestoreSending(ref), value);

/**
 * The keep-going budget a person picked in one chat for its next start or
 * resume; undefined keeps the run's own. The control and its overflow copy
 * share it, and it outlives a remount of either.
 */
const keepGoingBudgetAtom = Atom.family((key: string) =>
  Atom.make<number | null | undefined>(undefined).pipe(
    Atom.keepAlive,
    Atom.withLabel(`game:keep-going-budget:${key}`),
  ),
);
export const keepGoingBudget = (ref: ScopedThreadRef) =>
  keepGoingBudgetAtom(`${ref.environmentId}\0${ref.threadId}`);
export const setKeepGoingBudget = (ref: ScopedThreadRef, minutes: number | null) =>
  appAtomRegistry.set(keepGoingBudget(ref), minutes);

/**
 * An earlier build the Stage is playing instead of the game folder's own
 * preview. Session state: after a reload Play asks again, and the server
 * reuses the build's running copy.
 */
export interface StagePlayTarget {
  readonly build: GameBuildId;
  readonly label: string;
  readonly result: GameBuildPlayResult;
}
const stagePlayTargetAtom = Atom.family((key: string) =>
  Atom.make<StagePlayTarget | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`game:stage-play-target:${key}`),
  ),
);
export const stagePlayTarget = (ref: ScopedThreadRef) =>
  stagePlayTargetAtom(`${ref.environmentId}\0${ref.threadId}`);
export const setStagePlayTarget = (ref: ScopedThreadRef, value: StagePlayTarget | null) =>
  appAtomRegistry.set(stagePlayTarget(ref), value);
/**
 * The stage after a game action, from any entry point (the stage, the
 * palette): Play shows the folder's own game, and Stop, which ends the
 * copies too, leaves no copy to show.
 */
export const stageAfterGameAction = (ref: ScopedThreadRef, action: GameAction) => {
  if (action === "preview" || action === "stop") setStagePlayTarget(ref, null);
};

// A page of the game's builds, newest first. A new build, a restore and a
// facts change push; nothing polls.
const buildsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "game:builds",
  tag: WS_METHODS.gameBuilds,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
  refreshTrigger: threadSignal("builds", "facts"),
});

const refKey = (ref: GameBuildRef): string =>
  ref._tag === "build" ? ref.build : `turn:${ref.threadId}:${ref.runId}`;

/**
 * Changes when one build's facts moved, or a pair's: read from the first page
 * of the Builds list, which every facts push rereads, as the listed builds'
 * facts summaries. A push for another build leaves the summary as it was, so
 * a build's facts are not reread for it, and a stale or incomplete reading
 * is not reread forever. A build the first page does not list (an old one, a
 * chat turn named by its run) falls back to every facts push.
 */
const buildFactsSignal = Atom.family((key: string): Atom.Atom<string> => {
  const [environmentId = "", threadId = "", ...refs] = key.split("\0");
  return Atom.make((get) => {
    const list = get(
      buildsQuery({
        environmentId: EnvironmentId.make(environmentId),
        input: { threadId: ThreadId.make(threadId) },
      }),
    );
    const listed = AsyncResult.isSuccess(list) ? list.value.builds : [];
    const parts = refs.map((ref) => {
      const build = listed.find((entry) => entry.id === ref);
      return build === undefined
        ? null
        : `${build.facts.state}:${build.facts.notMeasured}:${build.facts.good}:${build.facts.bad}:${build.facts.chips.map((chip) => chip.text).join(",")}`;
    });
    if (parts.every((part) => part !== null)) return parts.join("|");
    return get(threadScopeSignal(`${environmentId}\0${threadId}\0facts`));
  }).pipe(Atom.withLabel(`game:build-facts-signal:${key}`));
});

/**
 * The Builds list past its first page: `count` pages chained from the first
 * page's current `next`, so a new build shifting the first page never leaves
 * a row between two pages.
 */
const olderBuildPagesAtom = Atom.family((key: string) => {
  const [environmentId = "", threadId = "", count = "0"] = key.split("\0");
  return Atom.make((get) => {
    const target = (before?: string) =>
      buildsQuery({
        environmentId: EnvironmentId.make(environmentId),
        input:
          before === undefined
            ? { threadId: ThreadId.make(threadId) }
            : { threadId: ThreadId.make(threadId), before },
      });
    const first = get(target());
    const pages: Array<AsyncResult.AsyncResult<GameBuildsResult, unknown>> = [];
    let next = AsyncResult.isSuccess(first) ? first.value.next : null;
    for (let index = 0; index < Number(count) && next !== null; index += 1) {
      const page = get(target(next));
      pages.push(page);
      next = AsyncResult.isSuccess(page) ? page.value.next : null;
    }
    return pages;
  }).pipe(Atom.withLabel(`game:older-build-pages:${key}`));
});
export const olderBuildPages = (ref: ScopedThreadRef, count: number) =>
  olderBuildPagesAtom(`${ref.environmentId}\0${ref.threadId}\0${count}`);

const NO_TURN_BUILD = Atom.make<TurnBuildView | null>(null);

/**
 * One turn's build from the first page of the Builds list (selectTurnBuild).
 * Null until the list is read, and for a turn the first page does not hold,
 * which keeps its plain link. It moves only when what the strip draws moved, so a facts push
 * for another build re-renders no turn's card.
 */
const turnBuildAtom = Atom.family((key: string) => {
  const [environmentId = "", threadId = "", runId = ""] = key.split("\0");
  let last: { readonly key: string; readonly view: TurnBuildView | null } = {
    key: "",
    view: null,
  };
  return Atom.make((get) => {
    const list = get(
      buildsQuery({
        environmentId: EnvironmentId.make(environmentId),
        input: { threadId: ThreadId.make(threadId) },
      }),
    );
    if (!AsyncResult.isSuccess(list)) return last.view;
    const view = selectTurnBuild(list.value, runId === "" ? null : runId);
    const seen = view === null ? "" : JSON.stringify(view);
    if (seen !== last.key) last = { key: seen, view };
    return last.view;
  }).pipe(Atom.withLabel(`game:turn-build:${key}`));
});
export const turnBuild = (ref: ScopedThreadRef | null, runId: string | null) =>
  ref === null
    ? NO_TURN_BUILD
    : turnBuildAtom(`${ref.environmentId}\0${ref.threadId}\0${runId ?? ""}`);

/** The build copies the server is playing for this game. */
export type GameBuildPlaying = GameStatus["buildPlays"][number];
export const buildPlaysOf = (status: GameStatus): ReadonlyArray<GameBuildPlaying> =>
  status.buildPlays;

export const gameEnvironment = {
  toolchain: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:toolchain",
    tag: WS_METHODS.gameToolchainStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  }),
  // The add-ons list's entries (MPFB2): installed here and by the agent's game_blender op addon.
  toolchainInstall: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:toolchainInstall",
    tag: WS_METHODS.gameToolchainInstall,
  }),
  toolchainRemove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:toolchainRemove",
    tag: WS_METHODS.gameToolchainRemove,
  }),
  // The person's choice of how the game's characters are made; the agent never sets it.
  setCharacterRoute: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:setCharacterRoute",
    tag: WS_METHODS.gameSetCharacterRoute,
  }),
  // The game's art files for the Workbench's Art tab: reread when a build lands or an operation
  // moves (a Blender review or export is one, and changes what is being made).
  artAssets: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:artAssets",
    tag: WS_METHODS.gameArtAssets,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: threadSignal("builds", "operation"),
  }),
  // A model's thumbnail, drawn once by the Art tab's viewer and kept by its content.
  artThumbnail: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:artThumbnail",
    tag: WS_METHODS.gameArtThumbnail,
  }),
  status: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:status",
    tag: WS_METHODS.gameStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    // A build copy starting or stopping is a builds push; the status lists the copies.
    refreshTrigger: (target) =>
      statusSignalAtom(`${target.environmentId}\0${target.input.threadId}`),
  }),
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:list",
    tag: WS_METHODS.gameList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: ({ environmentId }) => gameListSignal(environmentId),
  }),
  checkSources: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:checkSources",
    tag: WS_METHODS.gameStatus,
  }),
  builds: buildsQuery,
  // Reread only when that build's own facts moved (see buildFactsSignal): a measured build
  // still gains readings, as a test play saved after it was measured replays on it.
  buildFacts: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:buildFacts",
    tag: WS_METHODS.gameBuildFacts,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
    refreshTrigger: ({ environmentId, input }) =>
      buildFactsSignal(`${environmentId}\0${input.threadId}\0${refKey(input.build)}`),
  }),
  // What one build changed: read once, since a build's change never does.
  buildChanges: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:buildChanges",
    tag: WS_METHODS.gameBuildChanges,
    staleTimeMs: 5 * 60_000,
    idleTtlMs: 5 * 60_000,
  }),
  buildCompare: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:buildCompare",
    tag: WS_METHODS.gameBuildCompare,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
    refreshTrigger: ({ environmentId, input }) =>
      buildFactsSignal(
        `${environmentId}\0${input.threadId}\0${refKey(input.a)}\0${refKey(input.b)}`,
      ),
    isFinal: (comparison) =>
      comparison.factsA.state === "measured" && comparison.factsB.state === "measured",
  }),
  buildMeasure: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:buildMeasure",
    tag: WS_METHODS.gameBuildMeasure,
  }),
  buildPlay: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:buildPlay",
    tag: WS_METHODS.gameBuildPlay,
  }),
  buildRestore: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:buildRestore",
    tag: WS_METHODS.gameBuildRestore,
  }),
  // The game's copies and the asking chat's place: reread on the game's builds pushes (a landing,
  // a bring-in's check, an outcome) and when any of its chats starts, ends or moves.
  copies: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:copies",
    tag: WS_METHODS.gameCopies,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: (target) =>
      Atom.make(
        (get) =>
          `${get(threadSignal("builds")(target))}\0${get(projectChatsSignalAtom(`${target.environmentId}\0${target.input.threadId}`))}`,
      ),
  }),
  bringIn: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:bringIn",
    tag: WS_METHODS.gameBringIn,
  }),
  copyUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:copyUpdate",
    tag: WS_METHODS.gameCopyUpdate,
  }),
  copyThrowAway: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:copyThrowAway",
    tag: WS_METHODS.gameCopyThrowAway,
  }),
  runInCopy: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:runInCopy",
    tag: WS_METHODS.gameRunInCopy,
  }),
  buildUndo: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:buildUndo",
    tag: WS_METHODS.gameBuildUndo,
  }),
  buildStop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:buildStop",
    tag: WS_METHODS.gameBuildStop,
  }),
  // The Stage's Keep as a build: the live values written and kept as a build Undo takes back.
  keepValues: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:keepValues",
    tag: WS_METHODS.gameKeepValues,
  }),
  // A person's run on the Stage, played to its end: kept for replays on later builds.
  keepPlay: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:keepPlay",
    tag: WS_METHODS.gameKeepPlay,
  }),
  replay: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:replay",
    tag: WS_METHODS.gameReplay,
  }),
  // A kept run named as a test play, replayed on every build; read and deleted from the Stage.
  savePlay: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:savePlay",
    tag: WS_METHODS.gameSavePlay,
  }),
  savedPlays: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:savedPlays",
    tag: WS_METHODS.gameSavedPlays,
  }),
  savedPlay: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:savedPlay",
    tag: WS_METHODS.gameSavedPlay,
  }),
  deletePlay: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:deletePlay",
    tag: WS_METHODS.gameDeletePlay,
  }),
  // What the person decided about the game (.studio/decisions.md): read, and changed from the
  // Stage's Decisions and the composer's /remember.
  decisions: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:decisions",
    tag: WS_METHODS.gameDecisions,
  }),
  decide: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:decide",
    tag: WS_METHODS.gameDecide,
  }),
  // Keep going's status for one chat: reread on run pushes only, so a step's
  // progress re-renders the control and the banner once per change, never on a timer.
  keepGoingStatus: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:keepGoingStatus",
    tag: WS_METHODS.gameKeepGoingStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: threadSignal("run"),
  }),
  keepGoing: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:keepGoing",
    tag: WS_METHODS.gameKeepGoing,
  }),
  saveMedia: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:saveMedia",
    tag: WS_METHODS.gameMediaSave,
  }),
  savedList: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:savedList",
    tag: WS_METHODS.gameSavedList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: (target) =>
      savedMediaSignal(`${target.environmentId}\0${target.input.threadId}`),
  }),
  deleteSaved: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:deleteSaved",
    tag: WS_METHODS.gameSavedDelete,
  }),
  events: gameEvents,
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:create",
    tag: WS_METHODS.gameCreate,
  }),
  open: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:open",
    tag: WS_METHODS.gameOpen,
  }),
  action: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:action",
    tag: WS_METHODS.gameAction,
  }),
  packageWeb: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:packageWeb",
    tag: WS_METHODS.gameWebPackage,
  }),
  webExportUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:webExportUrl",
    tag: WS_METHODS.gameWebExportUrl,
  }),
  // Where the game is published on kurambit.com, and whether this Kurambit may publish.
  publishStatus: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:publishStatus",
    tag: WS_METHODS.gamePublishStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  }),
  publishConnect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:publishConnect",
    tag: WS_METHODS.gamePublishConnect,
  }),
  publishDisconnect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:publishDisconnect",
    tag: WS_METHODS.gamePublishDisconnect,
  }),
  publish: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:publish",
    tag: WS_METHODS.gamePublish,
  }),
  unpublish: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:unpublish",
    tag: WS_METHODS.gameUnpublish,
  }),
};
