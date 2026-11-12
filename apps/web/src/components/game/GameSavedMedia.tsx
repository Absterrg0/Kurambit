import type { ReactNode } from "react";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  BookmarkCheckIcon,
  BookmarkIcon,
  FolderOpenIcon,
  ExternalLinkIcon,
  Trash2Icon,
} from "lucide-react";
import type { GameSavedMedia, ScopedThreadRef } from "@kurambit/contracts";

import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { requestConfirmDialog } from "../../confirmDialog";
import { useRightPanelStore } from "../../rightPanelStore";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { MenuItem } from "../ui/menu";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Open and Show in folder for a file in the game: the system's own apps
 * through the server's file manager when it has one, else the app's file panel.
 */
export function GameFileActions({
  threadRef,
  path,
  relativePath,
}: {
  threadRef: ScopedThreadRef;
  /** Absolute, for the system's file manager. */
  path: string;
  /** Game-relative, for the app's file panel. */
  relativePath: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const system = config?.availableEditors.includes("file-manager") === true;
  const canReveal = system && config?.shellRevealInFileManager === true;
  const open = async (reveal: boolean) => {
    if (!system || (reveal && !canReveal))
      return useRightPanelStore
        .getState()
        .openFile(threadRef, reveal ? relativePath.replace(/\/[^/]*$/, "") : relativePath);
    const result = await openInEditor({
      environmentId: threadRef.environmentId,
      input: { cwd: path, editor: "file-manager", ...(reveal ? { reveal: true } : {}) },
    });
    setError(result._tag === "Failure" ? String(squashAtomCommandFailure(result)) : null);
  };
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => void open(false)}>
        <ExternalLinkIcon aria-hidden="true" />
        Open
      </Button>
      <Button size="xs" variant="ghost" onClick={() => void open(true)}>
        <FolderOpenIcon aria-hidden="true" />
        Show in folder
      </Button>
      {error ? (
        <span role="alert" className="text-2xs text-destructive-foreground">
          {error}
        </span>
      ) : null}
    </>
  );
}

const SavedFileActions = ({
  threadRef,
  media,
}: {
  threadRef: ScopedThreadRef;
  media: Pick<GameSavedMedia, "name" | "path">;
}) => (
  <GameFileActions threadRef={threadRef} path={media.path} relativePath={`saved/${media.name}`} />
);

/** One file's save into the game's saved/: whether it is there yet, and the way to put it there. */
function useSaveMedia(threadRef: ScopedThreadRef, source: string, label: string) {
  const canSave = useAtomValue(gameEnvironment.saveMedia.permissionAtom(threadRef.environmentId));
  const save = useAtomCommand(gameEnvironment.saveMedia, { reportFailure: false });
  // One read of saved/ for every button of the game: a save is shown as saved
  // once the folder holds it, after a remount, a delete or a save elsewhere too.
  const list = useEnvironmentQuery(
    gameEnvironment.savedList({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const [saving, setSaving] = useState(false);
  // This button's save until the list is read again after it.
  const [justSaved, setJustSaved] = useState<{
    readonly media: GameSavedMedia;
    readonly listAt: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saved =
    list.data?.find((media) => media.source === source && media.label === label) ??
    (justSaved !== null && justSaved.listAt === list.dataUpdatedAt ? justSaved.media : null);
  const run = async () => {
    if (saving) return;
    setSaving(true);
    const result = await save({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, source, label },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setError(null);
    setJustSaved({ media: result.value, listAt: list.dataUpdatedAt });
  };
  return { canSave, saving, saved, error, run };
}

/** A menu's Save row for one file: "Save the video", then "Video saved" once it is kept. */
export function SaveMediaMenuItem({
  threadRef,
  source,
  label,
  text,
  icon,
}: {
  threadRef: ScopedThreadRef;
  source: string;
  label: string;
  /** What the file is, in a word: "Video". */
  text: string;
  icon: ReactNode;
}) {
  const { canSave, saving, saved, error, run } = useSaveMedia(threadRef, source, label);
  return (
    <MenuItem
      disabled={saved !== null || !canSave || saving}
      closeOnClick={false}
      onClick={() => void run()}
    >
      {saved !== null ? <BookmarkCheckIcon aria-hidden="true" /> : icon}
      <span className="flex min-w-0 flex-col">
        {saved !== null ? `${text} saved` : saving ? "Saving…" : `Save the ${text.toLowerCase()}`}
        {error === null ? null : (
          <Text variant="caption" tone="destructive">
            {error}
          </Text>
        )}
      </span>
    </MenuItem>
  );
}

/** Keeps a generated video or image past the log cleanup, as a copy in the game's saved/. */
export function SaveMediaButton({
  threadRef,
  source,
  label,
  text = "Save",
  icon,
}: {
  threadRef: ScopedThreadRef;
  /** Game-relative path of the generated file. */
  source: string;
  /** The words after the date in the saved name. */
  label: string;
  /** The button's words, when several files share a row. */
  text?: string;
  /** Shown alone, with the words in its tooltip, where a row has no room for words. */
  icon?: ReactNode;
}) {
  const { canSave, saving, saved, error, run } = useSaveMedia(threadRef, source, label);
  if (icon !== undefined) {
    const label =
      saved !== null ? `${text} saved` : saving ? "Saving…" : `Save the ${text.toLowerCase()}`;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={label}
              disabled={saved !== null || !canSave || saving}
              onClick={() => void run()}
            />
          }
        >
          {saved !== null ? <BookmarkCheckIcon aria-hidden="true" /> : icon}
        </TooltipTrigger>
        <TooltipPopup side="top">{error ?? label}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {saved === null ? (
        <Button size="xs" variant="ghost" disabled={!canSave || saving} onClick={() => void run()}>
          <BookmarkIcon aria-hidden="true" />
          {saving ? "Saving…" : text}
        </Button>
      ) : (
        <>
          <span className="text-2xs text-muted-foreground">
            {text === "Save" ? "Saved" : `${text} saved`}
          </span>
          <SavedFileActions threadRef={threadRef} media={saved} />
        </>
      )}
      {error ? (
        <span role="alert" className="text-2xs text-destructive-foreground">
          {error}
        </span>
      ) : null}
    </div>
  );
}

const sizeLabel = (bytes: number) =>
  bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The game's saved/ folder: what the creator kept, with the way to open and delete each. */
export function GameSavedList({ threadRef }: { threadRef: ScopedThreadRef }) {
  const query = useEnvironmentQuery(
    gameEnvironment.savedList({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const canDelete = useAtomValue(
    gameEnvironment.deleteSaved.permissionAtom(threadRef.environmentId),
  );
  const remove = useAtomCommand(gameEnvironment.deleteSaved, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const saved = query.data ?? [];
  const deleteOne = async (name: string) => {
    const confirmed = await requestConfirmDialog(
      `Delete ${name}?\nThe saved copy is removed from the game's saved/ folder.`,
    );
    if (confirmed !== true) return;
    const result = await remove({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, name },
    });
    setError(result._tag === "Failure" ? String(squashAtomCommandFailure(result)) : null);
  };
  return (
    // The same card as an export target's: icon tile, then the words, so the two read as one list.
    <section className="flex items-start gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <BookmarkIcon className="size-4.5" aria-hidden="true" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="text-sm font-medium">Saved</h3>
        {saved.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {query.error ??
              "Nothing saved yet. Save a recording from a build's Recordings to keep it after the logs are cleaned up."}
          </p>
        ) : (
          <ul className="space-y-1">
            {saved.map((media) => (
              <li key={media.name} className="flex flex-wrap items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-xs">{media.name}</span>
                <span className="text-2xs text-muted-foreground">{sizeLabel(media.bytes)}</span>
                <SavedFileActions threadRef={threadRef} media={media} />
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  disabled={!canDelete}
                  aria-label={`Delete ${media.name}`}
                  onClick={() => void deleteOne(media.name)}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
        <p className="text-2xs text-muted-foreground">
          Saved files stay in the game's saved folder, out of its history.
        </p>
      </div>
    </section>
  );
}
