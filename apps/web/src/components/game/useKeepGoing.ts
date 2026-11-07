import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import type { GameKeepGoingInput, GameKeepGoingMode, ScopedThreadRef } from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";

import { randomUUID } from "../../lib/utils";
import { gameEnvironment, keepGoingBudget, setKeepGoingBudget } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { keepGoingRequest } from "./keepGoing.logic";

const NO_PERMISSION = Atom.make(false);
const NO_BUDGET = Atom.make<number | null | undefined>(undefined);

const reportFailure = (title: string, failure: unknown) =>
  toastManager.add({ type: "error", title, description: String(failure) });

/**
 * Keep going for one chat: the run's status, reread on run pushes only, and
 * its two commands. The control, the banner and the palette share it; the
 * server decides every request, so a refused one shows its reason.
 */
export function useKeepGoing(threadRef: ScopedThreadRef | null) {
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : gameEnvironment.keepGoingStatus({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  const canOperate = useAtomValue(
    threadRef === null
      ? NO_PERMISSION
      : gameEnvironment.keepGoing.permissionAtom(threadRef.environmentId),
  );
  const canDecide = useAtomValue(
    threadRef === null
      ? NO_PERMISSION
      : gameEnvironment.keepGoingDecide.permissionAtom(threadRef.environmentId),
  );
  const setCommand = useAtomCommand(gameEnvironment.keepGoing, { reportFailure: false });
  const decideCommand = useAtomCommand(gameEnvironment.keepGoingDecide, { reportFailure: false });
  const chosenBudget = useAtomValue(threadRef === null ? NO_BUDGET : keepGoingBudget(threadRef));
  const [sending, setSending] = useState(false);

  const set = async (request: Pick<GameKeepGoingInput, "mode" | "budgetMinutes">) => {
    if (threadRef === null || sending) return;
    setSending(true);
    const result = await setCommand({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, commandId: randomUUID(), ...request },
    });
    setSending(false);
    if (result._tag === "Failure")
      reportFailure(
        request.mode === "off" ? "Keep going did not stop" : "Keep going did not start",
        squashAtomCommandFailure(result),
      );
  };

  /** A mode from the control or the palette: the picked budget goes with a start or resume. */
  const choose = async (mode: GameKeepGoingMode) => {
    if (threadRef === null) return;
    const request = keepGoingRequest(query.data, threadRef.threadId, mode, chosenBudget);
    if (request !== null) await set(request);
  };

  const decide = async (stepId: string, answer: "start" | "skip" | "hold") => {
    if (threadRef === null || sending) return;
    setSending(true);
    const result = await decideCommand({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, commandId: randomUUID(), stepId, answer },
    });
    setSending(false);
    if (result._tag === "Failure")
      reportFailure("Keep going did not take that answer", squashAtomCommandFailure(result));
  };

  return {
    status: query.data,
    error: query.error,
    canOperate,
    canDecide,
    sending,
    chosenBudget,
    setBudget: (minutes: number | null) => {
      if (threadRef !== null) setKeepGoingBudget(threadRef, minutes);
    },
    set,
    choose,
    decide,
  };
}
