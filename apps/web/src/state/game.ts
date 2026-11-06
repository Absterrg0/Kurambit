import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  GameBuildId,
  type GameAction,
  type GameStatus,
  type GameBuildPlayResult,
  type GameBuildRef,
  type GameBuildsResult,
  type GameRunRoundRef,
  type ScopedThreadRef,
  ThreadId,
  WS_METHODS,
  type GameRunRoundsResult,
} from "@kurambit/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@kurambit/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { type GameEventScope, gameEventScope } from "./gameEventScope";

const gameEvents = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "game:events",
  tag: WS_METHODS.subscribeGameEvents,
  // Game operations are minutes apart; keep the stream warm while a game
  // surface is open without holding it for the life of the app.
  idleTtlMs: 5 * 60_000,
});

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
    if (AsyncResult.isSuccess(result) && wanted.has(gameEventScope(result.value)))
      last = `${result.value.at}\0${result.value.revision ?? ""}`;
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

/**
 * Changes only when a game's run or operation changes state, which is all a
 * library card shows; progress messages within one state do not reread the list.
 */
const gameListSignal = Atom.family((environmentId: string) => {
  const states = new Map<string, string>();
  let changes = 0;
  return Atom.make((get) => {
    const result = get(gameEvents({ environmentId: EnvironmentId.make(environmentId), input: {} }));
    // The server sends the library only games' own folders (never a run's sample copies).
    // A card shows no saved media, builds or facts, so their pushes never reread the list.
    if (!AsyncResult.isSuccess(result)) return changes;
    const scope = gameEventScope(result.value);
    if (scope === "saved" || scope === "builds" || scope === "facts") return changes;
    const event = result.value;
    // A run event's message is its current step, which the card shows.
    const state =
      event.name === "run"
        ? `run\0${event.state}\0${event.message}`
        : `${event.name}\0${event.state}`;
    if (states.get(event.root) !== state) {
      states.set(event.root, state);
      changes += 1;
    }
    return changes;
  }).pipe(Atom.withLabel(`game:list-signal:${environmentId}`));
});

/**
 * Changes when an ended run's record changes on one thread's game: a restore
 * requested or landed (from any client or an agent), a note, its finish. Each
 * may change which round is the game's current build. A live run's step
 * pushes leave it as it is, so an open round is never reread mid-run.
 */
const endedRunGameSignal = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\0");
  let last = "";
  return Atom.make((get) => {
    const result = get(
      gameEvents({
        environmentId: EnvironmentId.make(environmentId),
        input: { threadId: ThreadId.make(threadId) },
      }),
    );
    if (
      AsyncResult.isSuccess(result) &&
      result.value.name === "run" &&
      result.value.state === "succeeded"
    )
      last = `${result.value.at}\0${result.value.revision ?? ""}`;
    return last;
  }).pipe(Atom.withLabel(`game:ended-run-signal:${key}`));
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
    if (!AsyncResult.isSuccess(result) || gameEventScope(result.value) !== "saved") return changes;
    const seen = `${result.value.at}\0${result.value.revision ?? ""}`;
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
        : `${build.facts.state}:${build.facts.notMeasured}:${build.facts.chips.map((chip) => chip.text).join(",")}`;
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

/** The build copies the server is playing for this game (CONTRACT A3). */
export type GameBuildPlaying = GameStatus["buildPlays"][number];
export const buildPlaysOf = (status: GameStatus): ReadonlyArray<GameBuildPlaying> =>
  status.buildPlays;

/** Every run whose chat is this thread, newest first (CONTRACT A4, `game.runRounds`). */
export type GameChatRun = GameRunRoundsResult["runs"][number];
const chatRunsAtom = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\0");
  return Atom.make((get) =>
    AsyncResult.map(
      get(
        gameEnvironment.runRounds({
          environmentId: EnvironmentId.make(environmentId),
          input: { threadId: ThreadId.make(threadId) },
        }),
      ),
      (result): ReadonlyArray<GameChatRun> => result.runs,
    ),
  ).pipe(Atom.withLabel(`game:chat-runs:${key}`));
});
export const chatRuns = (ref: ScopedThreadRef) =>
  chatRunsAtom(`${ref.environmentId}\0${ref.threadId}`);

export const gameEnvironment = {
  toolchain: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:toolchain",
    tag: WS_METHODS.gameToolchainStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  }),
  status: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:status",
    tag: WS_METHODS.gameStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    // A build copy starting or stopping (A3) is a builds push; the status lists the copies.
    refreshTrigger: threadSignal("operation", "builds"),
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
  runStart: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:runStart",
    tag: WS_METHODS.gameRunStart,
  }),
  runStatus: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:runStatus",
    tag: WS_METHODS.gameRunStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: threadSignal("run"),
  }),
  // Read when a round row opens, never for every round; a finished round's
  // evidence does not change, so an open row is not polled, only reread when
  // an ended run's record changes (a restore makes another round current).
  runRound: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:runRound",
    tag: WS_METHODS.gameRunRound,
    staleTimeMs: 60_000,
    idleTtlMs: 60_000,
    refreshTrigger: (target) =>
      endedRunGameSignal(`${target.environmentId}\0${target.input.threadId}`),
  }),
  // Read when the pick row opens; reread on the run's step pushes while the pick is open.
  runPick: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:runPick",
    tag: WS_METHODS.gameRunPick,
    staleTimeMs: 60_000,
    idleTtlMs: 60_000,
    refreshTrigger: threadSignal("run"),
  }),
  builds: buildsQuery,
  // A measured build's facts never change, so they are read once; others
  // reread only when that build's own facts moved (see buildFactsSignal).
  buildFacts: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:buildFacts",
    tag: WS_METHODS.gameBuildFacts,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
    refreshTrigger: ({ environmentId, input }) =>
      buildFactsSignal(`${environmentId}\0${input.threadId}\0${refKey(input.build)}`),
    isFinal: (facts) => facts.state === "measured",
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
  buildStop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:buildStop",
    tag: WS_METHODS.gameBuildStop,
  }),
  // Every run whose chat is this thread, for the round cards: reread on run pushes only.
  runRounds: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:runRounds",
    tag: WS_METHODS.gameRunRounds,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: threadSignal("run"),
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
  runStop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:runStop",
    tag: WS_METHODS.gameRunStop,
  }),
  runSteer: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:runSteer",
    tag: WS_METHODS.gameRunSteer,
  }),
  runProfile: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:runProfile",
    tag: WS_METHODS.gameRunProfile,
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
  packageWindows: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:packageWindows",
    tag: WS_METHODS.gameWindowsPackage,
  }),
  packageWeb: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:packageWeb",
    tag: WS_METHODS.gameWebPackage,
  }),
};
