import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@kurambit/contracts";
import { scopeThreadRef } from "@kurambit/client-runtime/environment";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";

import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { waitForThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Text } from "../ui/text";
import { showOpenGameDialog, useGameEntryStore, useNewGame } from "./gameEntryStore";
import { useGameLibraryRefresh } from "./useGameLibrary";
import { useGameModelChoice } from "./useGameModelChoice";

/** New game and Open game, for the legacy sidebar's empty state and header. */
export function GameEntry() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId ? <GameEntryButtons environmentId={environmentId} /> : null;
}

function GameEntryButtons({ environmentId }: { environmentId: EnvironmentId }) {
  const newGame = useNewGame();
  const canOpen = useAtomValue(gameEnvironment.open.permissionAtom(environmentId));
  return (
    <div className="flex flex-wrap justify-center gap-2 p-2">
      <Button size="sm" variant="outline" onClick={() => newGame()}>
        New game
      </Button>
      <Button size="sm" variant="ghost" disabled={!canOpen} onClick={showOpenGameDialog}>
        Open game
      </Button>
    </div>
  );
}

export function GameOpenDialogHost() {
  const environmentId = usePrimaryEnvironmentId();
  const open = useGameEntryStore((state) => state.openDialog);
  return environmentId && open ? <GameOpenDialog environmentId={environmentId} /> : null;
}

/** Opens a game folder that already lives on this machine. */
function GameOpenDialog({ environmentId }: { environmentId: EnvironmentId }) {
  const choice = useGameModelChoice(environmentId);
  const canOpen = useAtomValue(gameEnvironment.open.permissionAtom(environmentId));
  const open = useAtomCommand(gameEnvironment.open, { reportFailure: false });
  const refreshLibrary = useGameLibraryRefresh(environmentId);
  const navigate = useNavigate();
  const close = () => useGameEntryStore.getState().showOpenDialog(false);
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = canOpen && choice.ready && directory.trim().length > 0;

  const chooseFolder = async () => {
    if (busy || pickingFolder) return;
    setPickingFolder(true);
    setError(null);
    // No try/finally: React Compiler cannot analyse a finalizer, and the picker
    // either answers or throws once, so cleanup follows the await.
    const picked = await ensureLocalApi()
      .dialogs.pickFolder({ initialPath: directory })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      });
    setPickingFolder(false);
    if (picked) setDirectory(picked);
  };

  const submit = async () => {
    if (busy || pickingFolder || !canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await open({
      environmentId,
      input: { path: directory, modelSelection: choice.model },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    choice.remember();
    refreshLibrary();
    close();
    // The thread route sends a thread this client has not received yet back
    // home, so open the game only once its shell has arrived.
    await waitForThreadShell(scopeThreadRef(environmentId, result.value.threadId));
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: result.value.threadId },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy && !pickingFolder) close();
      }}
    >
      <DialogPopup>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Open a game</DialogTitle>
            <DialogDescription>
              Pick a game folder that holds a game.json. Opening it continues its latest session.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <Text variant="label" render={<label htmlFor="game-directory" />}>
                  Game folder
                </Text>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      id="game-directory"
                      value={directory}
                      onChange={(event) => setDirectory(event.target.value)}
                      placeholder="~/Games/my-game"
                      required
                      autoFocus
                      disabled={busy || pickingFolder}
                    />
                  </div>
                  {isElectron ? (
                    <div className="shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy || pickingFolder}
                        onClick={() => void chooseFolder()}
                      >
                        {pickingFolder ? "Choosing folder…" : "Choose folder"}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={choice.model.instanceId}
                model={choice.model.model}
                lockedProvider={null}
                instanceEntries={choice.entries}
                modelOptionsByInstance={choice.options}
                disabled={busy}
                onInstanceModelChange={(instanceId, model) => choice.choose({ instanceId, model })}
              />
            </div>
            {error ? (
              <Text variant="body" tone="destructive" render={<p role="alert" />}>
                {error}
              </Text>
            ) : null}
            {choice.notReadyReason === null ? null : (
              <Text variant="body" tone="muted" render={<p />}>
                {choice.notReadyReason}
              </Text>
            )}
          </DialogPanel>
          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="ghost" disabled={busy || pickingFolder} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || pickingFolder || !canSubmit}>
              {busy ? "Opening game…" : "Open game"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
