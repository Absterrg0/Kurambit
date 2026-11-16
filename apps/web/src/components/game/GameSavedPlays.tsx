import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import {
  playOutcomeWords,
  type GameSavedPlaySummary,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { Trash2Icon } from "lucide-react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Text } from "../ui/text";

/**
 * The Stage's saved plays: the run just played to its end saved as a test play under a name,
 * and the plays saved so far, each deletable. A saved play is replayed on every build.
 */
export function GameSavedPlaysDialog({
  threadRef,
  open,
  onOpenChange,
  kept,
}: {
  threadRef: ScopedThreadRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The run this Stage last kept, which Save names; null before one ended here. */
  kept: string | null;
}) {
  const environmentId = threadRef.environmentId;
  const savePlay = useAtomCommand(gameEnvironment.savePlay, { reportFailure: false });
  const listPlays = useAtomCommand(gameEnvironment.savedPlays, { reportFailure: false });
  const deletePlay = useAtomCommand(gameEnvironment.deletePlay, { reportFailure: false });
  const canSave = useAtomValue(gameEnvironment.savePlay.permissionAtom(environmentId));
  const canDelete = useAtomValue(gameEnvironment.deletePlay.permissionAtom(environmentId));
  const [plays, setPlays] = useState<ReadonlyArray<GameSavedPlaySummary> | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);

  const refresh = useStableCallback(async () => {
    const result = await listPlays({ environmentId, input: { threadId: threadRef.threadId } });
    if (result._tag === "Success") setPlays(result.value);
    else setNote({ text: String(squashAtomCommandFailure(result)), failed: true });
  });
  // Read again each time it opens: the agent saves and deletes plays too.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const save = async () => {
    if (kept === null) return;
    setBusy(true);
    // The save replays the run once on its own build first, which takes a moment.
    setNote({ text: "Checking that the run replays the same…", failed: false });
    const result = await savePlay({
      environmentId,
      input: { threadId: threadRef.threadId, name: name.trim(), kept },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setNote({ text: String(squashAtomCommandFailure(result)), failed: true });
      return;
    }
    setName("");
    setNote({
      text: `${result.value.replaced ? "Replaced" : "Saved"} "${result.value.name}": every build replays it from now on.`,
      failed: false,
    });
    await refresh();
  };

  const remove = async (play: string) => {
    const result = await deletePlay({
      environmentId,
      input: { threadId: threadRef.threadId, name: play },
    });
    if (result._tag === "Failure")
      setNote({ text: String(squashAtomCommandFailure(result)), failed: true });
    await refresh();
  };

  const trimmed = name.trim();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setNote(null);
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Test plays</DialogTitle>
          <DialogDescription>
            A run you save is replayed on every build, and each build says whether it still ends the
            same way.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {canSave ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <Input
                  size="sm"
                  value={name}
                  maxLength={60}
                  disabled={kept === null || busy}
                  placeholder={kept === null ? "Play a run to its end first" : "Name the last run"}
                  aria-label="Name for the last run"
                  onChange={(event) => setName(event.currentTarget.value)}
                />
                <Button
                  size="sm"
                  type="submit"
                  disabled={kept === null || busy || trimmed.length === 0}
                >
                  Save as a test play
                </Button>
              </form>
            ) : null}
            {note === null ? null : (
              <Text
                variant="meta"
                tone={note.failed ? "destructive" : "muted"}
                render={<p role={note.failed ? "alert" : undefined} />}
              >
                {note.text}
              </Text>
            )}
            {plays === null ? null : plays.length === 0 ? (
              <Text variant="meta" tone="muted" render={<p />}>
                No test plays yet.
              </Text>
            ) : (
              <ul className="flex flex-col gap-1">
                {plays.map((play) => (
                  <li key={play.name} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <Text variant="label" truncate render={<span className="block" />}>
                        {play.name}
                      </Text>
                    </span>
                    <Text variant="meta" tone="muted" numeric>
                      {playOutcomeWords(play.outcome)}
                    </Text>
                    {canDelete ? (
                      <Button
                        size="icon-xs"
                        variant="ghost-destructive"
                        aria-label={`Delete ${play.name}`}
                        onClick={() => void remove(play.name)}
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
