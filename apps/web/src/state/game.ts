import { WS_METHODS, type EnvironmentId } from "@kurambit/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@kurambit/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";

const gameEvents = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "game:events",
  tag: WS_METHODS.subscribeGameEvents,
  // Game operations are minutes apart; keep the stream warm while a game
  // surface is open without holding it for the life of the app.
  idleTtlMs: 5 * 60_000,
});

/**
 * A value that changes on every game operation event. Queries read it through
 * `refreshTrigger`, so an idle Stage learns about a later agent build from the
 * push instead of polling the whole project on a timer.
 */
const gameEventSignal = Atom.family((environmentId: string) =>
  Atom.make((get) => {
    const result = get(gameEvents({ environmentId: environmentId as EnvironmentId, input: {} }));
    return AsyncResult.isSuccess(result)
      ? `${result.value.root}\0${result.value.at}\0${result.value.revision ?? ""}`
      : "";
  }).pipe(Atom.withLabel(`game:event-signal:${environmentId}`)),
);

export const gameEnvironment = {
  toolchain: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:toolchain",
    tag: WS_METHODS.gameToolchainStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  }),
  verify: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:verify",
    tag: WS_METHODS.gameVerify,
  }),
  status: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:status",
    tag: WS_METHODS.gameStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: ({ environmentId }) => gameEventSignal(environmentId),
  }),
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:list",
    tag: WS_METHODS.gameList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: ({ environmentId }) => gameEventSignal(environmentId),
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
    refreshTrigger: ({ environmentId }) => gameEventSignal(environmentId),
  }),
  runStop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:runStop",
    tag: WS_METHODS.gameRunStop,
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
  install: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:install",
    tag: WS_METHODS.gameInstall,
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
