import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  type GameBuildId,
  type GameBuildPlayResult,
  type GameBuildRef,
  type ScopedThreadRef,
} from "@kurambit/contracts";

import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import { requestConfirmDialog } from "../../confirmDialog";
import { randomUUID } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import {
  buildRestoreSending,
  gameEnvironment,
  setBuildRestoreSending,
  setStagePlayTarget,
  turnBuild,
} from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildName, type GameBuildRestore } from "./gameBuilds.logic";
import { turnStripRestore } from "./gameTurnBuild.logic";

const NO_PERMISSION = Atom.make(false);
const NOT_SENDING = Atom.make(null);

const isGameOperationError = Schema.is(GameOperationError);

export const restoreQuestion = (name: string) =>
  `Go back to ${name}?\nThe engine project, art/ and ASSETS.md become this build; what the folder holds now is saved as a build first, so you can undo this. Notes, PLAN.md, VISION.md, bots and run records stay as they are.`;

/**
 * Asks for a build back and follows it through the Builds list: the call
 * returns once the restore is recorded, and the push that lands its outcome
 * rereads the list. Asking again after a lost answer is a retry of the same
 * request, so it never restores twice; the server's refusal is its answer, so
 * asking after one is a new request. With no thread there is nothing to restore.
 */
export function useBuildRestore(
  threadRef: ScopedThreadRef | null,
  latest: GameBuildRestore | null,
) {
  const canRestore = useAtomValue(
    threadRef === null
      ? NO_PERMISSION
      : gameEnvironment.buildRestore.permissionAtom(threadRef.environmentId),
  );
  const restore = useAtomCommand(gameEnvironment.buildRestore, { reportFailure: false });
  const key = useRef<{ readonly target: string; readonly id: string } | null>(null);
  const shared = useAtomValue(threadRef === null ? NOT_SENDING : buildRestoreSending(threadRef));
  const [error, setError] = useState<{ readonly target: string; readonly text: string } | null>(
    null,
  );
  // Sent by this client and not yet in the list, which moves past `since` once it is.
  const waiting = shared !== null && (latest?.requestId ?? null) === shared.since;
  const pending = waiting || (latest !== null && latest.outcome === null);
  /**
   * A null question sends at once: Undo and Redo are each other's way back.
   * Answers the failure's text, or null.
   */
  const send = async (target: GameBuildId, question: string | null): Promise<string | null> => {
    if (threadRef === null || pending) return null;
    if (question !== null && (await requestConfirmDialog(question)) !== true) return null;
    if (key.current?.target !== target) key.current = { target, id: randomUUID() };
    const since = latest?.requestId ?? null;
    setBuildRestoreSending(threadRef, { target, since });
    setError(null);
    const result = await restore({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        build: { _tag: "build", build: target },
        commandId: key.current.id,
      },
    });
    if (result._tag === "Failure") {
      setBuildRestoreSending(threadRef, null);
      const failure = squashAtomCommandFailure(result);
      if (isGameOperationError(failure)) key.current = null;
      setError({ target, text: String(failure) });
      return String(failure);
    }
    key.current = null;
    // A request answered earlier is already in the list; a new one makes it move.
    if (result.value.done || result.value.requestId === since)
      setBuildRestoreSending(threadRef, null);
    return null;
  };
  return {
    canRestore,
    pending,
    restoring: (target: GameBuildId) =>
      (waiting && shared?.target === target) ||
      (latest !== null && latest.outcome === null && latest.target === target),
    error: (target: GameBuildId) => (error?.target === target ? error.text : null),
    send,
  };
}

/**
 * One chat turn's Undo, Redo or Go back (B4), or the game's latest turn's when
 * `runId` is null: the strip and the palette offer the same restore. It is
 * Kurambit's build restore, never T3's conversation revert, so the agent keeps
 * the turn in its context and the undo has its own way back.
 */
export function useTurnUndo(threadRef: ScopedThreadRef | null, runId: string | null) {
  const view = useAtomValue(turnBuild(threadRef, runId));
  // The quiet shell: a streaming turn does not re-render every card.
  const shell = useQuietThreadShell(threadRef);
  const restores = useBuildRestore(threadRef, view?.restore ?? null);
  const action =
    view === null ? null : turnStripRestore(view, threadRuntimeIsActive(shell?.runtime));
  const send = async (): Promise<string | null> => {
    if (view === null || action === null) return null;
    return restores.send(
      action.target,
      action.kind === "go-back" ? restoreQuestion(buildName(view.build)) : null,
    );
  };
  return {
    view,
    action,
    /** A run's role thread sees the builds but never restores beside the run. */
    writer: shell?.lineage.relationshipToParent !== "role",
    canRestore: restores.canRestore,
    pending: restores.pending,
    restoring: action !== null && restores.restoring(action.target),
    error: action === null ? null : restores.error(action.target),
    send,
  };
}

/** Plays one build from a copy: the play's answer, or why it did not play. */
export function useBuildPlay(threadRef: ScopedThreadRef) {
  const canPlay = useAtomValue(gameEnvironment.buildPlay.permissionAtom(threadRef.environmentId));
  const play = useAtomCommand(gameEnvironment.buildPlay, { reportFailure: false });
  const [state, setState] = useState<
    | { readonly ref: string; readonly playing: true }
    | { readonly ref: string; readonly playing: false; readonly error: string }
    | null
  >(null);
  const refKey = (ref: GameBuildRef) =>
    ref._tag === "build" ? ref.build : `${ref.threadId}:${ref.runId}`;
  const send = async (ref: GameBuildRef): Promise<GameBuildPlayResult | null> => {
    setState({ ref: refKey(ref), playing: true });
    const result = await play({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, build: ref },
    });
    if (result._tag === "Failure") {
      setState({
        ref: refKey(ref),
        playing: false,
        error: String(squashAtomCommandFailure(result)),
      });
      return null;
    }
    setState(null);
    return result.value;
  };
  return {
    canPlay,
    playing: (ref: GameBuildRef) => state?.playing === true && state.ref === refKey(ref),
    error: (ref: GameBuildRef) =>
      state !== null && !state.playing && state.ref === refKey(ref) ? state.error : null,
    send,
  };
}

/**
 * Measures a build the first time it is opened or played, once per build per
 * view: the server dedups and queues, and its answer arrives as facts pushes.
 */
export function useMeasureOnOpen(threadRef: ScopedThreadRef) {
  const canMeasure = useAtomValue(
    gameEnvironment.buildMeasure.permissionAtom(threadRef.environmentId),
  );
  const measure = useAtomCommand(gameEnvironment.buildMeasure, { reportFailure: false });
  const asked = useRef(new Set<string>());
  // The server's answer to the last ask: its refusal, or its word on the queue.
  const [answer, setAnswer] = useState<{
    readonly build: string;
    readonly text: string;
    readonly failed: boolean;
  } | null>(null);
  const send = async (build: GameBuildId, again = false) => {
    if (!canMeasure || (!again && asked.current.has(build))) return;
    asked.current.add(build);
    const result = await measure({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, build: { _tag: "build", build } },
    });
    if (result._tag === "Failure") {
      // Only the Measure button asks again: an open never retries a refusal.
      setAnswer({ build, text: String(squashAtomCommandFailure(result)), failed: true });
    } else
      setAnswer(
        result.value.message.trim() === ""
          ? null
          : { build, text: result.value.message, failed: false },
      );
  };
  return {
    canMeasure,
    answer: (build: GameBuildId) => (answer?.build === build ? answer : null),
    send,
  };
}

/** Stops one build's copy, never the folder's own preview (CONTRACT A3, `game.buildStop`). */
export function useBuildStop(threadRef: ScopedThreadRef) {
  const stop = useAtomCommand(gameEnvironment.buildStop, { reportFailure: true });
  return async (build: GameBuildId) => {
    setStagePlayTarget(threadRef, null);
    await stop({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, build: { _tag: "build", build } },
    });
  };
}
