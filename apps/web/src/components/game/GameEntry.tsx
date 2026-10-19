import { useGameDialogStore } from "./gameDialogStore";
import { ensureLocalApi } from "../../localApi";
import { isElectron } from "../../env";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  DEFAULT_GAME_TEMPLATE,
  GAME_TEMPLATES,
  type EnvironmentId,
  type GameTemplateId,
  type ModelSelection,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RadioGroup, Radio } from "../ui/radio-group";
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
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState(dialog === "create" ? "~/Games" : "");
  const [template, setTemplate] = useState<GameTemplateId>(DEFAULT_GAME_TEMPLATE);
  const [brief, setBrief] = useState("");
  const [artDirection, setArtDirection] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    if (busy || pickingFolder || dialog === null) return;
    setBusy(true);
    setError(null);
    const result =
      dialog === "create"
        ? await create({
            environmentId,
            input: {
              name,
              parentDirectory: directory,
              template,
              brief,
              artDirection,
              modelSelection: model,
            },
          })
        : await open({ environmentId, input: { path: directory, modelSelection: model } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    setDialog(null);
    // The thread's own game stage takes over the workspace once its status
    // resolves; there is no panel to open here any more.
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: result.value.threadId },
    });
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
                {dialog === "create" ? (
                  <div className="flex flex-col gap-1 text-sm">
                    <span id="game-template-label">Starter template</span>
                    <RadioGroup
                      aria-labelledby="game-template-label"
                      value={template}
                      disabled={busy}
                      onValueChange={(value) => {
                        const picked = GAME_TEMPLATES.find((entry) => entry.id === value);
                        if (picked) setTemplate(picked.id);
                      }}
                      className="grid grid-cols-1 sm:grid-cols-2"
                    >
                      {GAME_TEMPLATES.map((entry) => (
                        <label
                          key={entry.id}
                          className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 px-3 py-3 hover:bg-accent/40"
                        >
                          <Radio value={entry.id} className="mt-0.5" />
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex items-center gap-2">
                              <span className="font-medium text-foreground">{entry.name}</span>
                              <Badge variant="outline" size="sm">
                                {entry.dimension.toUpperCase()}
                              </Badge>
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {entry.description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </RadioGroup>
                  </div>
                ) : null}
                <div className="flex flex-col gap-1 text-sm">
                  <label htmlFor="game-directory">
                    {dialog === "create" ? "Parent folder" : "Game folder"}
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <Input
                        id="game-directory"
                        value={directory}
                        onChange={(event) => setDirectory(event.target.value)}
                        placeholder={dialog === "create" ? "~/Games" : "/path/to/game"}
                        required={dialog === "open"}
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
