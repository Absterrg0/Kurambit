import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import type { GameDecideInput, GameDecision, ScopedThreadRef } from "@kurambit/contracts";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Text } from "../ui/text";
import { Workbench } from "./GameWorkbenchParts";

const NOTE_MAX = 300;

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
    return result._tag === "Success"
      ? { ok: true, decisions: result.value }
      : { ok: false, error: String(squashAtomCommandFailure(result)) };
  };
}

/**
 * The Workbench's Decisions tab: the game's decisions (`.studio/decisions.md`), what the person
 * undid, kept or skipped, and their own notes, which every new agent session reads. Each line can
 * be edited or deleted, and a note added.
 */
export function GameDecisionsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const environmentId = threadRef.environmentId;
  const listDecisions = useAtomCommand(gameEnvironment.decisions, { reportFailure: false });
  const decide = useGameDecide(threadRef);
  const canDecide = useAtomValue(gameEnvironment.decide.permissionAtom(environmentId));
  const [decisions, setDecisions] = useState<ReadonlyArray<GameDecision> | null>(null);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<{ line: number; was: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useStableCallback(async () => {
    const result = await listDecisions({ environmentId, input: { threadId: threadRef.threadId } });
    if (result._tag === "Success") setDecisions(result.value);
    else setError(String(squashAtomCommandFailure(result)));
  });
  // Read again each time the tab is shown: undos, kept values and skips add lines meanwhile.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const send = async (change: GameDecideInput["change"]) => {
    setBusy(true);
    setError(null);
    const result = await decide(change);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      await refresh();
      return false;
    }
    setDecisions(result.decisions);
    return true;
  };

  const trimmed = note.trim();
  return (
    <Workbench.Body>
      <Workbench.Section
        title="Decisions"
        detail="What you undid, kept or skipped, and what you asked to be remembered. Every new agent session on this game reads it, so it does not bring back what you turned down."
      >
        <div className="flex flex-col gap-4">
          {canDecide ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void send({ _tag: "note", text: trimmed }).then((ok) => ok && setNote(""));
              }}
            >
              <Input
                size="sm"
                value={note}
                maxLength={NOTE_MAX}
                disabled={busy}
                placeholder="No music with lyrics, keep it one-button…"
                aria-label="Something for every session to remember"
                onChange={(event) => setNote(event.currentTarget.value)}
              />
              <Button size="sm" type="submit" disabled={busy || trimmed.length === 0}>
                Remember this
              </Button>
            </form>
          ) : null}
          {error === null ? null : (
            <Text variant="meta" tone="destructive" render={<p role="alert" />}>
              {error}
            </Text>
          )}
          {decisions === null ? null : decisions.length === 0 ? (
            <Text variant="meta" tone="muted" render={<p />}>
              Nothing decided yet. An undo, values kept from the Stage or a skipped step adds a line
              here.
            </Text>
          ) : (
            <ul className="flex flex-col gap-1">
              {decisions.toReversed().map((decision) => (
                <li key={`${decision.line}:${decision.text}`} className="flex items-center gap-2">
                  {editing?.line === decision.line ? (
                    <form
                      className="flex min-w-0 flex-1 items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void send({
                          _tag: "edit",
                          line: editing.line,
                          was: editing.was,
                          text: editing.text.trim(),
                        }).then((ok) => ok && setEditing(null));
                      }}
                    >
                      <Input
                        size="sm"
                        value={editing.text}
                        maxLength={NOTE_MAX}
                        disabled={busy}
                        autoFocus
                        aria-label="Edit this decision"
                        onChange={(event) =>
                          setEditing({ ...editing, text: event.currentTarget.value })
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            setEditing(null);
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        type="submit"
                        disabled={busy || editing.text.trim().length === 0}
                      >
                        Save
                      </Button>
                    </form>
                  ) : (
                    <span className="flex min-w-0 flex-1 flex-col">
                      <Text variant="meta" tone="default" render={<span className="break-words" />}>
                        {decision.text}
                      </Text>
                      {decision.date === "" ? null : (
                        <Text variant="caption" tone="muted" numeric>
                          {decision.date}
                        </Text>
                      )}
                    </span>
                  )}
                  {canDecide && editing?.line !== decision.line ? (
                    <>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Edit "${decision.text}"`}
                        disabled={busy}
                        onClick={() =>
                          setEditing({
                            line: decision.line,
                            was: decision.text,
                            text: decision.text,
                          })
                        }
                      >
                        <PencilIcon aria-hidden="true" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost-destructive"
                        aria-label={`Delete "${decision.text}"`}
                        disabled={busy}
                        onClick={() =>
                          void send({ _tag: "remove", line: decision.line, was: decision.text })
                        }
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Workbench.Section>
    </Workbench.Body>
  );
}
