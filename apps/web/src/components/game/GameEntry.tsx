import { useGameDialogStore } from "./gameDialogStore";
import { ComposerFooterModeControls } from "../chat/ComposerFooterModeControls";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { ensureLocalApi } from "../../localApi";
import { isElectron } from "../../env";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { type EnvironmentId, type ModelSelection, type RuntimeMode } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
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
import { useRightPanelStore } from "../../rightPanelStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

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
function GameEntryForEnvironment({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const defaultSelection = resolveAppModelSelectionState(settings, providers);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const model = selection ?? defaultSelection;
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
  const navigate = useNavigate();
  const dialog = useGameDialogStore((state) => state.dialog);
  const setDialog = useGameDialogStore((state) => state.show);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("full-access");
  const supportedModes = entries.find((entry) => entry.instanceId === model.instanceId)?.snapshot
    .supportedRuntimeModes;
  const compatibleModes = runtimeModeOptions.filter(
    (mode) => !supportedModes?.length || supportedModes.includes(mode),
  );
  const chosenMode = compatibleModes.includes(runtimeMode)
    ? runtimeMode
    : (compatibleModes[0] ?? "full-access");
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState(dialog === "create" ? "~/Games" : "");
  const [brief, setBrief] = useState("");
  const [artDirection, setArtDirection] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chooseFolder = async () => {
    if (busy || pickingFolder) return;
    setPickingFolder(true);
    setError(null);
    try {
      const picked = await ensureLocalApi().dialogs.pickFolder({ initialPath: directory });
      if (picked) setDirectory(picked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPickingFolder(false);
    }
  };
  const submit = async () => {
    if (busy || pickingFolder || dialog === null) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        dialog === "create"
          ? await create({
              environmentId,
              input: {
                name,
                parentDirectory: directory,
                brief,
                artDirection,
                modelSelection: model,
                runtimeMode: chosenMode,
              },
            })
          : await open({ environmentId, input: { path: directory, modelSelection: model } });
      if (result._tag === "Failure") {
        setError(String(squashAtomCommandFailure(result)));
        return;
      }
      setDialog(null);
      const threadRef = scopeThreadRef(environmentId, result.value.threadId);
      useRightPanelStore.getState().open(threadRef, "game");
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: result.value.threadId },
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open={dialog !== null}
        onOpenChange={(value) => {
          if (!value && !busy && !pickingFolder) setDialog(null);
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
              <DialogTitle>{dialog === "create" ? "New game" : "Open game"}</DialogTitle>
              <DialogDescription>
                {dialog === "create"
                  ? "Describe a game. Your selected agent will build it with Blender and Godot."
                  : "Open a game folder containing game.json."}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-4">
                {dialog === "create" ? (
                  <label className="flex flex-col gap-1 text-sm">
                    Name
                    <Input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                      maxLength={100}
                      disabled={busy}
                    />
                  </label>
                ) : null}
                <label className="flex flex-col gap-1 text-sm">
                  {dialog === "create" ? "Parent folder" : "Game folder"}
                  <Input
                    value={directory}
                    onChange={(event) => setDirectory(event.target.value)}
                    placeholder={dialog === "create" ? "~/Games" : "/path/to/game"}
                    required={dialog === "open"}
                    disabled={busy || pickingFolder}
                  />
                </label>
                {dialog === "create" ? (
                  <>
                    <label className="flex flex-col gap-1 text-sm">
                      Game brief
                      <Textarea
                        value={brief}
                        onChange={(event) => setBrief(event.target.value)}
                        required
                        disabled={busy}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      Art direction, optional
                      <Textarea
                        value={artDirection}
                        onChange={(event) => setArtDirection(event.target.value)}
                        disabled={busy}
                      />
                    </label>
                  </>
                ) : null}
                {isElectron ? (
                  <div>
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
                {dialog === "create" ? (
                  <div className="flex items-center">
                    <span className="text-sm">Runtime mode</span>
                    <ComposerFooterModeControls
                      interactionMode="default"
                      showInteractionModeToggle={false}
                      runtimeMode={chosenMode}
                      runtimeModeOptions={compatibleModes.map((mode) => ({
                        mode,
                        ...runtimeModeConfig[mode],
                      }))}
                      onRuntimeModeChange={setRuntimeMode}
                      onToggleInteractionMode={() => {}}
                    />
                  </div>
                ) : null}
                {error ? (
                  <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button
                type="submit"
                disabled={
                  busy ||
                  pickingFolder ||
                  !entries.some(
                    (entry) =>
                      entry.instanceId === model.instanceId && entry.enabled && entry.isAvailable,
                  ) ||
                  (dialog === "create" ? !canCreate : !canOpen)
                }
              >
                {busy
                  ? dialog === "create"
                    ? "Creating game…"
                    : "Opening game…"
                  : dialog === "create"
                    ? "Create game"
                    : "Open game"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
