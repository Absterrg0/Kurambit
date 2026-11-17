import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@kurambit/contracts";

import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  checkingStep,
  copySending,
  notInGameLine,
  unresolvedText,
  useCopyActions,
  useCopyPlace,
} from "./useGameCopies";

/** The header's quiet line in a copy's chat: "Copy · 3 builds not in the game". */
export function GameCopyLabel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const place = useCopyPlace(threadRef);
  if (place === null) return null;
  return (
    <Text
      variant="caption"
      tone="muted"
      numeric
      truncate
      data-game-copy-label=""
      render={<span className="min-w-0 shrink" />}
    >
      {`Copy · ${notInGameLine(place)}`}
    </Text>
  );
}

/**
 * The header's right side in a copy's chat: Update when the game is ahead, then Bring in. While a
 * bring-in's check runs, Bring in says how far it is, and Bring in now ends the wait.
 */
export function GameCopyActions({ threadRef }: { threadRef: ScopedThreadRef }) {
  const place = useCopyPlace(threadRef);
  const actions = useCopyActions(threadRef);
  const sending = useAtomValue(copySending(threadRef));
  if (place === null) return null;
  const step = checkingStep(place.state);
  const unresolved = unresolvedText(place);
  const why =
    place.noBringIn ??
    (place.state._tag === "working"
      ? "Bring it in once its turn ends"
      : unresolved.length > 0
        ? `Resolve ${unresolved.length === 1 ? unresolved[0]!.path : `${unresolved.length} files`} first`
        : null);
  const busy = sending !== null && sending !== "bring-in";
  return (
    <span className="flex shrink-0 items-center gap-1" data-game-copy-actions="">
      {place.ahead > 0 && step === null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="ghost"
                disabled={!actions.canAct || busy || place.state._tag === "working"}
                onClick={() => void actions.update(threadRef.threadId)}
              />
            }
          >
            {sending === "update" ? "Updating…" : "Update"}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {`Take the game's ${place.ahead} newer build${place.ahead === 1 ? "" : "s"} into this copy`}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {step !== null ? (
        <>
          <Button size="sm" variant="default" disabled aria-live="polite">
            <span className="tabular-nums">{`Checking… ${step}`}</span>
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!actions.canAct}
                  onClick={() => void actions.bringIn(threadRef.threadId, { anyway: true })}
                />
              }
            >
              Bring in now
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              Skip the check and bring it in; Undo takes it out again
            </TooltipPopup>
          </Tooltip>
        </>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="flex" />}>
            <Button
              size="sm"
              variant="default"
              disabled={!actions.canAct || busy || why !== null || sending === "bring-in"}
              onClick={() => void actions.bringIn(threadRef.threadId)}
            >
              {sending === "bring-in" ? "Bringing in…" : "Bring in"}
            </Button>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {why ?? "Bring this copy's work into the game, after a check that it still plays"}
          </TooltipPopup>
        </Tooltip>
      )}
    </span>
  );
}
