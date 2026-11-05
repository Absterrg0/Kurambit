import { EnvironmentId, ThreadId, WS_METHODS } from "@kurambit/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@kurambit/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const gameEvents = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "game:events",
  tag: WS_METHODS.subscribeGameEvents,
  // Game operations are minutes apart; keep the stream warm while a game
  // surface is open without holding it for the life of the app.
  idleTtlMs: 5 * 60_000,
});

/**
 * A value that changes on every push for one thread's game. Its queries read it
 * through `refreshTrigger`, so an idle Stage learns about a later agent build
 * from the push instead of polling, and another game's work never refetches it.
 */
const threadGameSignal = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\0");
  return Atom.make((get) => {
    const result = get(
      gameEvents({
        environmentId: EnvironmentId.make(environmentId),
        input: { threadId: ThreadId.make(threadId) },
      }),
    );
    return AsyncResult.isSuccess(result)
      ? `${result.value.at}\0${result.value.revision ?? ""}`
      : "";
  }).pipe(Atom.withLabel(`game:thread-signal:${key}`));
});

const threadSignal = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly threadId: ThreadId };
}) => threadGameSignal(`${target.environmentId}\0${target.input.threadId}`);

/**
 * Changes only when a game's run or operation changes state, which is all a
 * library card shows; progress messages within one state do not reread the list.
 */
const gameListSignal = Atom.family((environmentId: string) => {
  const states = new Map<string, string>();
  let changes = 0;
  return Atom.make((get) => {
    const result = get(gameEvents({ environmentId: EnvironmentId.make(environmentId), input: {} }));
    if (!AsyncResult.isSuccess(result)) return changes;
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

// Bumped after a restore: every open round's "current build" may have changed.
const runRestoredSignal = Atom.family((environmentId: string) =>
  Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`game:run-restored:${environmentId}`)),
);

export const noteRunRestored = (environmentId: EnvironmentId): void =>
  appAtomRegistry.update(runRestoredSignal(environmentId), (n) => n + 1);

// Bumped after a save or delete here; an agent's game_media_save shows the next time the list is read.
const savedMediaSignal = Atom.family((environmentId: string) =>
  Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`game:saved-media:${environmentId}`)),
);

export const noteSavedMediaChanged = (environmentId: EnvironmentId): void =>
  appAtomRegistry.update(savedMediaSignal(environmentId), (n) => n + 1);

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
    refreshTrigger: threadSignal,
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
    refreshTrigger: threadSignal,
  }),
  // Read when a round row opens, never for every round; a finished round's
  // evidence does not change, so an open row is not polled, only reread after a restore.
  runRound: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:runRound",
    tag: WS_METHODS.gameRunRound,
    staleTimeMs: 60_000,
    idleTtlMs: 60_000,
    refreshTrigger: ({ environmentId }) => runRestoredSignal(environmentId),
  }),
  // Read when the pick row opens; reread on the run's step pushes while the pick is open.
  runPick: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:runPick",
    tag: WS_METHODS.gameRunPick,
    staleTimeMs: 60_000,
    idleTtlMs: 60_000,
    refreshTrigger: threadSignal,
  }),
  runRestore: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:runRestore",
    tag: WS_METHODS.gameRunRestore,
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
    refreshTrigger: ({ environmentId }) => savedMediaSignal(environmentId),
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
  secretsStatus: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:secretsStatus",
    tag: WS_METHODS.gameSecretsStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  }),
  setSecret: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:setSecret",
    tag: WS_METHODS.gameSecretsSet,
  }),
};
