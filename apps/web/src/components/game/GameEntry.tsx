import { useGameDialogStore } from "./gameDialogStore";
import { ensureLocalApi } from "../../localApi";
import { isElectron } from "../../env";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import * as Schema from "effect/Schema";
import { useNavigate } from "@tanstack/react-router";
import { ModelSelection, type EnvironmentId, type GameEngineId } from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { FolderIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { usePrimaryEnvironmentId, useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  deriveProviderInstanceEntries,
  applyProviderInstanceSettings,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  resolveAppModelSelectionState,
  getCustomModelOptionsByInstance,
} from "../../modelSelection";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { gameSlug } from "./gameLibrary.logic";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useGameLibraryRefresh } from "./useGameLibrary";

const BRIEF_PLACEHOLDER =
  "Describe what the player does, what makes it fun, and what winning looks like. A few sentences is enough.";

const ART_DIRECTION_PLACEHOLDER =
  "Optional. Painterly low-poly, warm sunset light, chunky pixel art, no text on screen…";

export function GameEntry() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId ? <GameEntryButtons environmentId={environmentId} /> : null;
}

function GameEntryButtons({ environmentId }: { environmentId: EnvironmentId }) {
  const canCreate = useAtomValue(gameEnvironment.create.permissionAtom(environmentId));
  const canOpen = useAtomValue(gameEnvironment.open.permissionAtom(environmentId));
  return (
    <div className="flex flex-wrap justify-center gap-2 p-2">
      <Button
        size="sm"
        variant="outline"
        disabled={!canCreate}
        onClick={() => useGameDialogStore.getState().show("create")}
      >
        New game
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!canOpen}
        onClick={() => useGameDialogStore.getState().show("open")}
      >
        Open game
      </Button>
    </div>
  );
}

export function GameDialogHost() {
  const environmentId = usePrimaryEnvironmentId();
  const dialog = useGameDialogStore((state) => state.dialog);
  return environmentId && dialog ? (
    <GameEntryForEnvironment key={`${environmentId}:${dialog}`} environmentId={environmentId} />
  ) : null;
}

const lastGameModelSchema = Schema.NullOr(ModelSelection);

function GameEntryForEnvironment({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const defaultSelection = resolveAppModelSelectionState(settings, providers);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  // The model the last game was made or opened with, while its provider is usable;
  // otherwise the app default (the text-generation model).
  const [lastGameModel, setLastGameModel] = useLocalStorage(
    `game-entry-model:${environmentId}`,
    null,
    lastGameModelSchema,
  );
  const remembered =
    lastGameModel !== null &&
    entries.some(
      (entry) =>
        entry.instanceId === lastGameModel.instanceId && entry.enabled && entry.isAvailable,
    )
      ? lastGameModel
      : null;
  const model = selection ?? remembered ?? defaultSelection;
  const options = getCustomModelOptionsByInstance(
    settings,
    providers,
    model.instanceId,
    model.model,
  );
  const canCreate = useAtomValue(gameEnvironment.create.permissionAtom(environmentId));
  const canOpen = useAtomValue(gameEnvironment.open.permissionAtom(environmentId));
  const create = useAtomCommand(gameEnvironment.create, { reportFailure: false });
  const open = useAtomCommand(gameEnvironment.open, { reportFailure: false });
  const refreshLibrary = useGameLibraryRefresh(environmentId);
  const navigate = useNavigate();
  const dialog = useGameDialogStore((state) => state.dialog);
  const setDialog = useGameDialogStore((state) => state.show);
  const draft = useGameDialogStore((state) => state.draft);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState(dialog === "create" ? "~/Games" : "");
  const [brief, setBrief] = useState(draft?.brief ?? "");
  const [artDirection, setArtDirection] = useState("");
  const [engine, setEngine] = useState<GameEngineId>(draft?.engine ?? "godot");
  const [editingFolder, setEditingFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isCreate = dialog === "create";
  const slug = gameSlug(name) || "your-game";
  const folder = `${directory.replace(/\/+$/, "")}/${slug}`;
  const providerReady = entries.some(
    (entry) => entry.instanceId === model.instanceId && entry.enabled && entry.isAvailable,
  );
  const canSubmit = isCreate
    ? canCreate && providerReady && name.trim().length > 0 && brief.trim().length > 0
    : canOpen && providerReady && directory.trim().length > 0;

  const chooseFolder = async () => {
    if (busy || pickingFolder) return;
    if (!isElectron) {
      setEditingFolder(true);
      return;
    }
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
    if (picked) {
      setDirectory(picked);
      setEditingFolder(false);
    }
  };

  const submit = async () => {
    if (busy || pickingFolder || dialog === null) return;
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = isCreate
      ? await create({
          environmentId,
          input: {
            name,
            parentDirectory: directory,
            brief,
            artDirection,
            engine,
            modelSelection: model,
          },
        })
      : await open({ environmentId, input: { path: directory, modelSelection: model } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setLastGameModel(model);
    refreshLibrary();
    setDialog(null);
    // The thread's own game stage takes over the workspace once its status
    // resolves; there is no panel to open here any more.
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: result.value.threadId },
    });
  };

  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(value) => {
        if (!value && !busy && !pickingFolder) setDialog(null);
      }}
    >
      <DialogPopup className={isCreate ? "max-w-4xl" : undefined}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {isCreate
                ? "Describe the game; your agent builds it as a native Godot or Unity game, or a quick three.js browser game."
                : "Continue a game that already lives on this machine."}
            </div>
            <DialogTitle>{isCreate ? "Name your game" : "Open game"}</DialogTitle>
            <DialogDescription>
              {isCreate
                ? "Every game starts from its engine's blank project: Godot, Unity or three.js."
                : "Open a game folder containing game.json."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {isCreate ? (
              <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-1 text-sm">
                  Game name
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={100}
                    autoFocus
                    placeholder="The Sunlit Isle"
                    disabled={busy}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Brief
                  <Textarea
                    value={brief}
                    onChange={(event) => setBrief(event.target.value)}
                    required
                    rows={4}
                    placeholder={BRIEF_PLACEHOLDER}
                    disabled={busy}
                  />
                </label>
                <fieldset className="flex flex-col gap-2 text-sm">
                  <legend className="font-medium">Engine</legend>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/70 px-3 py-2 has-checked:border-primary has-checked:bg-primary/5">
                    <input
                      type="radio"
                      name="game-engine"
                      value="godot"
                      checked={engine === "godot"}
                      onChange={() => setEngine("godot")}
                      disabled={busy}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium">Godot native</span>
                      <span className="block text-xs text-muted-foreground">
                        A real Godot 4.7 project with Blender-made art. The full lane: native play,
                        Windows and Linux exports.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/70 px-3 py-2 has-checked:border-primary has-checked:bg-primary/5">
                    <input
                      type="radio"
                      name="game-engine"
                      value="three"
                      checked={engine === "three"}
                      onChange={() => setEngine("three")}
                      disabled={busy}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium">three.js browser</span>
                      <span className="block text-xs text-muted-foreground">
                        A quick static browser game, no install step. Web export only.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/70 px-3 py-2 has-checked:border-primary has-checked:bg-primary/5">
                    <input
                      type="radio"
                      name="game-engine"
                      value="unity"
                      checked={engine === "unity"}
                      onChange={() => setEngine("unity")}
                      disabled={busy}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium">Unity native</span>
                      <span className="block text-xs text-muted-foreground">
                        A Unity 6 project in C#. Linux and Windows builds. Needs Unity installed
                        from Game tools and a Unity Personal licence from Unity Hub.
                      </span>
                    </span>
                  </label>
                </fieldset>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="flex items-baseline gap-1.5">
                    Art direction
                    <span className="text-xs font-normal text-muted-foreground">optional</span>
                  </span>
                  <Textarea
                    value={artDirection}
                    onChange={(event) => setArtDirection(event.target.value)}
                    rows={2}
                    placeholder={ART_DIRECTION_PLACEHOLDER}
                    disabled={busy}
                  />
                </label>
                <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="text-muted-foreground">Saved in</span>
                    <span className="min-w-0 truncate font-mono text-xs text-foreground">
                      {folder}
                    </span>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="ml-auto"
                      disabled={busy || pickingFolder}
                      onClick={() => void chooseFolder()}
                    >
                      {pickingFolder ? "Choosing…" : "Change"}
                    </Button>
                  </div>
                  {editingFolder ? (
                    <Input
                      aria-label="Games folder"
                      value={directory}
                      onChange={(event) => setDirectory(event.target.value)}
                      placeholder="~/Games"
                      required
                      disabled={busy || pickingFolder}
                      className="h-8"
                    />
                  ) : null}
                </div>
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={model.instanceId}
                  model={model.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={options}
                  disabled={busy}
                  onInstanceModelChange={(instanceId, selectedModel) =>
                    setSelection({ instanceId, model: selectedModel })
                  }
                />
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1 text-sm">
                  <label htmlFor="game-directory">Game folder</label>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <Input
                        id="game-directory"
                        value={directory}
                        onChange={(event) => setDirectory(event.target.value)}
                        placeholder="/path/to/game"
                        required
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
                  <span className="text-xs text-muted-foreground">
                    Opening a game you already made continues its latest session.
                  </span>
                </div>
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={model.instanceId}
                  model={model.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={options}
                  disabled={busy}
                  onInstanceModelChange={(instanceId, selectedModel) =>
                    setSelection({ instanceId, model: selectedModel })
                  }
                />
              </div>
            )}
            {error ? (
              <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter className="sm:justify-between">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={busy || pickingFolder}
                onClick={() => setDialog(null)}
              >
                Cancel
              </Button>
            </div>
            <Button type="submit" disabled={busy || pickingFolder || !canSubmit}>
              {busy
                ? isCreate
                  ? "Creating game…"
                  : "Opening game…"
                : isCreate
                  ? "Create game"
                  : "Open game"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
