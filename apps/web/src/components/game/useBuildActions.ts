import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  type GameBuildId,
  type GameBuildPlayResult,
  type GameBuildRef,
  type ScopedThreadRef,
} from "@kurambit/contracts";

import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { requestConfirmDialog } from "../../confirmDialog";
import { randomUUID } from "../../lib/utils";
import { buildRestoreSending, gameEnvironment, setBuildRestoreSending } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import type { GameBuildRestore } from "./gameBuilds.logic";

const isGameOperationError = Schema.is(GameOperationError);

export const restoreQuestion = (name: string) =>
  `Go back to ${name}?\nThe engine project, art/ and ASSETS.md become this build; what the folder holds now is saved as a build first, so you can undo this. Notes, PLAN.md, VISION.md, bots and run records stay as they are.`;

/**
 * Asks for a build back and follows it through the Builds list: the call
 * returns once the restore is recorded, and the push that lands its outcome
 * rereads the list. Asking again after a lost answer is a retry of the same
 * request, so it never restores twice; the server's refusal is its answer, so
 * asking after one is a new request.
 */
export function useBuildRestore(threadRef: ScopedThreadRef, latest: GameBuildRestore | null) {
  const canRestore = useAtomValue(
    gameEnvironment.buildRestore.permissionAtom(threadRef.environmentId),
  );
  const restore = useAtomCommand(gameEnvironment.buildRestore, { reportFailure: false });
  const key = useRef<{ readonly target: string; readonly id: string } | null>(null);
  const shared = useAtomValue(buildRestoreSending(threadRef));
  const [error, setError] = useState<{ readonly target: string; readonly text: string } | null>(
    null,
  );
  // Sent by this client and not yet in the list, which moves past `since` once it is.
  const waiting = shared !== null && (latest?.requestId ?? null) === shared.since;
  const pending = waiting || (latest !== null && latest.outcome === null);
  const send = async (target: GameBuildId, question: string) => {
    if (pending) return;
    if ((await requestConfirmDialog(question)) !== true) return;
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
      return;
    }
    key.current = null;
    // A request answered earlier is already in the list; a new one makes it move.
    if (result.value.done || result.value.requestId === since)
      setBuildRestoreSending(threadRef, null);
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
  const [error, setError] = useState<{ readonly build: string; readonly text: string } | null>(
    null,
  );
  const send = async (build: GameBuildId, again = false) => {
    if (!canMeasure || (!again && asked.current.has(build))) return;
    asked.current.add(build);
    const result = await measure({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, build: { _tag: "build", build } },
    });
    setError(
      result._tag === "Failure" ? { build, text: String(squashAtomCommandFailure(result)) } : null,
    );
  };
  return {
    canMeasure,
    error: (build: GameBuildId) => (error?.build === build ? error.text : null),
    send,
  };
}
