import { useAtomValue } from "@effect/atom-react";
import type { GameCopyConflict, ScopedThreadRef } from "@kurambit/contracts";
import { FileDiffIcon, PlayIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { ComposerBanner } from "../chat/ComposerBanner";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useReplayTestPlay } from "./GameWorkbenchChecks";
import { copyKeeps, copySending, useCopyActions, useCopyPlace } from "./useGameCopies";

/** "the test play "a" now ends "b" (it ended "c")" → its name and its new ending. */
const ENDING_CHANGED = /the test play "(.+?)" now ends "(.+?)"/;

/** The message "Ask the agent to resolve" sends: the files, in the person's words. */
const resolveMessage = (files: ReadonlyArray<GameCopyConflict>) =>
  `${files.map((file) => file.path).join(", ")} changed in the game and in this copy, and each now holds both sides. Resolve ${files.length === 1 ? "it" : "them"} so both changes work together.`;

/**
 * The one card a copy's chat gets above its composer when its work did not come in: the files
 * that conflict with the game, or why the game would lose health. It closes once the copy is clean.
 */
export function GameCopyCard({
  threadRef,
  onSend,
  onOpenDiff,
}: {
  threadRef: ScopedThreadRef;
  /** Sends a normal message in this chat. */
  onSend: (text: string) => Promise<void>;
  /** Opens T3's diff on the copy's changes. */
  onOpenDiff: () => void;
}) {
  const place = useCopyPlace(threadRef);
  if (place === null) return null;
  if (place.state._tag === "conflicts")
    return (
      <Conflicts
        threadRef={threadRef}
        files={place.state.files}
        onSend={onSend}
        onOpenDiff={onOpenDiff}
      />
    );
  if (place.state._tag === "held")
    return <Held threadRef={threadRef} reason={place.state.reason} />;
  return null;
}

function Conflicts({
  threadRef,
  files,
  onSend,
  onOpenDiff,
}: {
  threadRef: ScopedThreadRef;
  files: ReadonlyArray<GameCopyConflict>;
  onSend: (text: string) => Promise<void>;
  onOpenDiff: () => void;
}) {
  const actions = useCopyActions(threadRef);
  const keeps = useAtomValue(copyKeeps(threadRef));
  const sending = useAtomValue(copySending(threadRef));
  const [asked, setAsked] = useState(false);
  const text = files.filter((file) => !file.binary);
  const binary = files.filter((file) => file.binary);
  const decided = binary.every((file) => keeps[file.path] !== undefined);
  const pick = (path: string, side: "game" | "copy") =>
    appAtomRegistry.set(copyKeeps(threadRef), { ...keeps, [path]: side });
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label="Files that conflict with the game"
        variant="warning"
        data-game-copy-card="conflicts"
      >
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <TriangleAlertIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            {`${files.length} file${files.length === 1 ? "" : "s"} conflict${files.length === 1 ? "s" : ""} with the game`}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {text.length > 0 ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={asked || !actions.canAct}
                onClick={() => {
                  setAsked(true);
                  void onSend(resolveMessage(text)).catch(() => setAsked(false));
                }}
              >
                Ask the agent to resolve
              </Button>
            ) : (
              <Button
                size="xs"
                variant="secondary"
                disabled={!decided || sending !== null || !actions.canAct}
                onClick={() => void actions.bringIn(threadRef.threadId)}
              >
                {sending === "bring-in" ? "Bringing in…" : "Bring in"}
              </Button>
            )}
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {files.map((file) => (
          <ComposerBanner.Row key={file.path} data-conflict-file={file.path}>
            <ComposerBanner.Icon />
            <ComposerBanner.Content>
              <Text variant="caption" tone="muted" truncate render={<span className="min-w-0" />}>
                {file.values === undefined || file.values.length === 0
                  ? file.path
                  : `${file.path} · ${file.values.join(", ")}`}
              </Text>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              {file.binary ? (
                <>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    aria-pressed={keeps[file.path] === "game"}
                    onClick={() => pick(file.path, "game")}
                  >
                    Keep the game's
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    aria-pressed={keeps[file.path] === "copy"}
                    onClick={() => pick(file.path, "copy")}
                  >
                    Keep the copy's
                  </Button>
                </>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Open the diff of ${file.path}`}
                        onClick={onOpenDiff}
                      />
                    }
                  >
                    <FileDiffIcon />
                  </TooltipTrigger>
                  <TooltipPopup>Open the diff</TooltipPopup>
                </Tooltip>
              )}
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        ))}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

function Held({ threadRef, reason }: { threadRef: ScopedThreadRef; reason: string }) {
  const actions = useCopyActions(threadRef);
  const sending = useAtomValue(copySending(threadRef));
  const replay = useReplayTestPlay(threadRef);
  const [note, setNote] = useState<string | null>(null);
  const changed = ENDING_CHANGED.exec(reason);
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label="Not brought in"
        variant="warning"
        data-game-copy-card="held"
      >
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <TriangleAlertIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                {changed === null ? (
                  `Not brought in: ${reason}`
                ) : (
                  <>
                    {"Not brought in: the test play "}
                    <em>{changed[1]}</em>
                    {" now ends "}
                    <em>{changed[2]}</em>
                  </>
                )}
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-96 break-words">
                {note ?? `Not brought in: ${reason}`}
              </TooltipPopup>
            </Tooltip>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {changed === null ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Play the test play ${changed[1]} on this copy`}
                      onClick={() => {
                        setNote(null);
                        void replay(changed[1]!).then(setNote);
                      }}
                    />
                  }
                >
                  <PlayIcon />
                </TooltipTrigger>
                <TooltipPopup>Play it on this copy's Stage</TooltipPopup>
              </Tooltip>
            )}
            <Button
              size="xs"
              variant="secondary"
              disabled={sending !== null || !actions.canAct}
              onClick={() => void actions.bringIn(threadRef.threadId, { anyway: true })}
            >
              {sending === "bring-in" ? "Bringing in…" : "Bring in anyway"}
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
