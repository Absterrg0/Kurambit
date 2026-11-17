import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import type {
  GameBringInResult,
  GameChatPlace,
  GameCopy,
  GameCopyPlace,
  ScopedThreadRef,
  ThreadId,
} from "@kurambit/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useGameArrivalStore } from "../../gameArrivalStore";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { gameEnvironment, projectHasCopies } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/** What this client is sending for one copy, so every button of it agrees. */
export type CopySending = "bring-in" | "update" | "throw-away" | "run-in-copy";

const sendingAtom = Atom.family((key: string) =>
  Atom.make<CopySending | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`game:copy-sending:${key}`),
  ),
);
const copyKey = (environmentId: string, threadId: string) => `${environmentId}\0${threadId}`;
const NOT_SENDING = Atom.make<CopySending | null>(null);
export const copySending = (ref: ScopedThreadRef | null) =>
  ref === null ? NOT_SENDING : sendingAtom(copyKey(ref.environmentId, ref.threadId));

/**
 * Per binary file of a copy's conflict, whose file the person picked: the next Bring in of that
 * copy, from any place, takes these.
 */
const keepsAtom = Atom.family((key: string) =>
  Atom.make<Readonly<Record<string, "game" | "copy">>>({}).pipe(
    Atom.keepAlive,
    Atom.withLabel(`game:copy-keeps:${key}`),
  ),
);
export const copyKeeps = (ref: ScopedThreadRef) =>
  keepsAtom(copyKey(ref.environmentId, ref.threadId));

const EMPTY: ReadonlyArray<GameCopy> = [];
const NO_PERMISSION = Atom.make(false);
const IN_THE_GAME: GameChatPlace = { _tag: "game" };

/**
 * The game's copies and this chat's place. Read only once a chat of the game works in a copy:
 * a person who never makes one never asks for them.
 */
export function useGameCopies(threadRef: ScopedThreadRef | null): {
  readonly copies: ReadonlyArray<GameCopy>;
  readonly place: GameChatPlace;
} {
  const has = useAtomValue(projectHasCopies(threadRef));
  const met = useGameArrivalStore((state) => state.met.includes("copies"));
  useEffect(() => {
    if (has && !met) useGameArrivalStore.getState().meet("copies");
  }, [has, met]);
  const query = useEnvironmentQuery(
    has && threadRef !== null
      ? gameEnvironment.copies({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  return {
    copies: has ? (query.data?.copies ?? EMPTY) : EMPTY,
    place: has ? (query.data?.place ?? IN_THE_GAME) : IN_THE_GAME,
  };
}

/** This chat's copy, or null while it works in the game. */
export function useCopyPlace(threadRef: ScopedThreadRef | null): GameCopyPlace | null {
  const { place } = useGameCopies(threadRef);
  return place._tag === "copy" ? place : null;
}

/** "Copy of Build 12", or "Copy" for a copy whose seat is no numbered build. */
export const copyName = (place: GameCopyPlace) =>
  place.seatNumber === null ? "Copy" : `Copy of Build ${place.seatNumber}`;

/** "3 builds not in the game", or "Not in the game yet" with none counted. */
export const notInGameLine = (place: GameCopyPlace) =>
  place.builds === 0
    ? place.state._tag === "same"
      ? "Everything is in the game"
      : "Not in the game yet"
    : `${place.builds} build${place.builds === 1 ? "" : "s"} not in the game`;

/** The check's step, "boots" or "test play 2 of 3", while a bring-in is being checked. */
export const checkingStep = (state: GameCopyPlace["state"]) =>
  state._tag !== "checking"
    ? null
    : state.play === 0
      ? state.plays === 0
        ? "boots"
        : `boots, then ${state.plays} test play${state.plays === 1 ? "" : "s"}`
      : `test play ${state.play} of ${state.plays}`;

/** A hold's reason in the product's words: "the test play "x" now ends "y"". */
export const heldWords = (reason: string) => reason.replace(/ \(it ended "[^"]*"\)/g, "");

/** Text files still holding both sides: Bring in waits for them to be resolved. */
export const unresolvedText = (place: GameCopyPlace) =>
  place.state._tag === "conflicts" ? place.state.files.filter((file) => !file.binary) : [];

const failed = (title: string, cause: unknown) =>
  toastManager.add({ type: "error", title, description: String(cause) });

/**
 * The person's moves of work between a copy and the game: Bring in, Update, Throw away and Run
 * in a copy. `asking` is the chat they act from (the copy itself, or a chat in the game).
 */
export function useCopyActions(asking: ScopedThreadRef | null) {
  const bringInCommand = useAtomCommand(gameEnvironment.bringIn, { reportFailure: false });
  const updateCommand = useAtomCommand(gameEnvironment.copyUpdate, { reportFailure: false });
  const throwAwayCommand = useAtomCommand(gameEnvironment.copyThrowAway, {
    reportFailure: false,
  });
  const runInCopyCommand = useAtomCommand(gameEnvironment.runInCopy, { reportFailure: false });
  const canAct = useAtomValue(
    asking === null ? NO_PERMISSION : gameEnvironment.bringIn.permissionAtom(asking.environmentId),
  );

  const withSending = async <A>(
    copy: ScopedThreadRef,
    what: CopySending,
    run: () => Promise<A>,
  ): Promise<A | null> => {
    const atom = copySending(copy);
    // Bring in now joins the bring-in already running: only one other send waits.
    if (appAtomRegistry.get(atom) !== null && what !== "bring-in") return null;
    appAtomRegistry.set(atom, what);
    try {
      return await run();
    } finally {
      appAtomRegistry.set(atom, null);
    }
  };

  /** Brings the copy's work in and closes the copy; `anyway` lands it through a hold or a check. */
  const bringIn = (copy: ThreadId, options: { readonly anyway?: boolean } = {}) => {
    if (asking === null) return Promise.resolve(null);
    const ref = { environmentId: asking.environmentId, threadId: copy };
    const keep = appAtomRegistry.get(copyKeeps(ref));
    return withSending(ref, "bring-in", async (): Promise<GameBringInResult | null> => {
      const result = await bringInCommand({
        environmentId: asking.environmentId,
        input: {
          threadId: asking.threadId,
          chat: copy,
          close: true,
          ...(options.anyway === true ? { anyway: true } : {}),
          ...(Object.keys(keep).length === 0 ? {} : { keep }),
          commandId: randomUUID(),
        },
      });
      if (result._tag === "Failure") {
        failed("Could not bring it in", squashAtomCommandFailure(result));
        return null;
      }
      if (result.value._tag === "landed") appAtomRegistry.set(copyKeeps(ref), {});
      if (result.value._tag === "same")
        toastManager.add({ type: "info", title: result.value.message });
      return result.value;
    });
  };

  const update = (copy: ThreadId) => {
    if (asking === null) return Promise.resolve(null);
    const ref = { environmentId: asking.environmentId, threadId: copy };
    return withSending(ref, "update", async () => {
      const result = await updateCommand({
        environmentId: asking.environmentId,
        input: { threadId: copy, commandId: randomUUID() },
      });
      if (result._tag === "Failure") failed("Could not update", squashAtomCommandFailure(result));
      return result._tag === "Success" ? result.value : null;
    });
  };

  /** Asks first, naming the builds it discards; they stay in History. */
  const throwAway = async (copy: ThreadId, builds: number) => {
    if (asking === null) return null;
    const what =
      builds === 0
        ? "The copy has nothing the game does not."
        : `Its ${builds} build${builds === 1 ? "" : "s"} not in the game ${builds === 1 ? "is" : "are"} discarded; History keeps ${builds === 1 ? "it" : "them"}.`;
    const confirmed = await requestConfirmDialog(
      `Throw away this copy?\n${what} The chat works in the game again.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return null;
    const ref = { environmentId: asking.environmentId, threadId: copy };
    return withSending(ref, "throw-away", async () => {
      const result = await throwAwayCommand({
        environmentId: asking.environmentId,
        input: { threadId: copy, commandId: randomUUID() },
      });
      if (result._tag === "Failure")
        failed("Could not throw it away", squashAtomCommandFailure(result));
      return result._tag === "Success" ? result.value : null;
    });
  };

  /** This chat works in a copy of the game's newest build from now on; its waiting turn starts there. */
  const runInCopy = (thread: ScopedThreadRef) =>
    withSending(thread, "run-in-copy", async () => {
      const result = await runInCopyCommand({
        environmentId: thread.environmentId,
        input: { threadId: thread.threadId, commandId: randomUUID() },
      });
      if (result._tag === "Failure")
        failed("Could not run it in a copy", squashAtomCommandFailure(result));
      return result._tag === "Success" ? result.value : null;
    });

  return { canAct, bringIn, update, throwAway, runInCopy };
}
