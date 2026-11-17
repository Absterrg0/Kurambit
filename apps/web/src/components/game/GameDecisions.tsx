import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import type { GameDecideInput, GameDecision, ScopedThreadRef } from "@kurambit/contracts";
import { XIcon } from "lucide-react";
import { create } from "zustand";

import { useStableCallback } from "../../hooks/useStableCallback";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Workbench } from "./GameWorkbenchParts";

/** Counts changes sent from here (the composer's /remember, a line removed), so a shown list reads again. */
const useDecisionsChanged = create<number>()(() => 0);

/**
 * Sends one change to the game's decisions: a note to remember, or a line edited or deleted.
 * Answers the decisions after it, or why it was refused.
 */
export function useGameDecide(threadRef: ScopedThreadRef | null) {
  const decide = useAtomCommand(gameEnvironment.decide, { reportFailure: false });
  return async (
    change: GameDecideInput["change"],
  ): Promise<
    | { readonly ok: true; readonly decisions: ReadonlyArray<GameDecision> }
    | { readonly ok: false; readonly error: string }
  > => {
    if (threadRef === null) return { ok: false, error: "There is no game here." };
    const result = await decide({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, change },
    });
    if (result._tag !== "Success")
      return { ok: false, error: String(squashAtomCommandFailure(result)) };
    useDecisionsChanged.setState((count) => count + 1);
    return { ok: true, decisions: result.value };
  };
}

/**
 * Checks' last section: the game's decisions (`.studio/decisions.md`), which every new agent
 * session reads, one line each, newest first, removed from the row's hover. Added from the
 * composer's /remember, an undo, kept values or a skipped step. Hidden while there are none.
 */
export function GameDecisionsSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const environmentId = threadRef.environmentId;
  const listDecisions = useAtomCommand(gameEnvironment.decisions, { reportFailure: false });
  const decide = useGameDecide(threadRef);
  const canDecide = useAtomValue(gameEnvironment.decide.permissionAtom(environmentId));
  const [decisions, setDecisions] = useState<ReadonlyArray<GameDecision>>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useStableCallback(async () => {
    const result = await listDecisions({ environmentId, input: { threadId: threadRef.threadId } });
    if (result._tag === "Success") setDecisions(result.value);
  });
  // Read when shown and again after each change sent from here: undos and skips add lines too.
  useEffect(() => {
    void refresh();
    return useDecisionsChanged.subscribe(() => void refresh());
  }, [refresh]);
  if (decisions.length === 0 && error === null) return null;
  return (
    <Workbench.Section title="Decisions" detail={String(decisions.length)}>
      {decisions.toReversed().map((decision) => (
        <div
          key={`${decision.line}:${decision.text}`}
          className="group/decision flex min-h-7 min-w-0 items-start gap-2 py-1 ps-4 pe-2"
        >
          <Text variant="meta" tone="default" render={<p className="min-w-0 flex-1 leading-5" />}>
            {decision.text}
          </Text>
          {canDecide ? (
            <span className="flex h-5 w-6 shrink-0 items-center justify-end opacity-0 group-hover/decision:opacity-100 focus-within:opacity-100">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Forget "${decision.text}"`}
                      onClick={async () => {
                        setError(null);
                        const result = await decide({
                          _tag: "remove",
                          line: decision.line,
                          was: decision.text,
                        });
                        if (!result.ok) setError(result.error);
                      }}
                    />
                  }
                >
                  <XIcon aria-hidden="true" />
                </TooltipTrigger>
                <TooltipPopup side="left">Forget this</TooltipPopup>
              </Tooltip>
            </span>
          ) : null}
        </div>
      ))}
      {error === null ? null : (
        <Text variant="caption" tone="destructive" render={<p role="alert" className="px-4" />}>
          {error}
        </Text>
      )}
    </Workbench.Section>
  );
}
