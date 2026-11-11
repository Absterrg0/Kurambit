import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { BookmarkIcon, FolderOpenIcon, ExternalLinkIcon, Trash2Icon } from "lucide-react";
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

/** Keeps a generated video or image past the log cleanup, as a copy in the game's saved/. */
export function SaveMediaButton({
  threadRef,
  source,
  label,
}: {
  threadRef: ScopedThreadRef;
  /** Game-relative path of the generated file. */
  source: string;
  /** The words after the date in the saved name. */
  label: string;
}) {
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
  return (
    <div className="flex flex-wrap items-center gap-1">
      {saved === null ? (
        <Button size="xs" variant="ghost" disabled={!canSave || saving} onClick={() => void run()}>
          <BookmarkIcon aria-hidden="true" />
          {saving ? "Saving…" : "Save"}
        </Button>
      ) : (
        <>
          <span className="text-2xs text-muted-foreground">Saved</span>
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
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-medium">Saved</h3>
      {saved.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {query.error ??
            "Nothing saved yet. Open a build on the timeline and save its bot video or frame sheet to keep it after the game logs are cleaned up."}
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
        Saved files live in <span className="font-mono">saved/</span>, which is not committed to the
        game repository.
      </p>
    </section>
  );
}
