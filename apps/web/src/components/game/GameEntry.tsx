import { useGameDialogStore } from "./gameDialogStore";
import { ensureLocalApi } from "../../localApi";
import { isElectron } from "../../env";
import { useAtomValue } from "@effect/atom-react";
import { useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  DEFAULT_GAME_TEMPLATE,
  GAME_TEMPLATES,
  type EnvironmentId,
  type GameTemplateId,
  type ModelSelection,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ArrowLeftIcon, CheckIcon, FolderIcon, PencilIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RadioGroup, Radio } from "../ui/radio-group";
import { Switch } from "../ui/switch";
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
import { TemplatePreview } from "./TemplatePreview";
import { useGameLibraryRefresh } from "./useGameLibrary";

const BRIEF_PLACEHOLDERS: Record<GameTemplateId, string> = {
  "3d-explorer":
    "A small island in a rising storm. Collect three relics from the cliffs, cross the lava, and reach the boat before the tide turns.",
  "2d-platformer":
    "A side-scrolling run across a mossy ridge. Collect coins, stomp the slimes, and reach the flag at the top.",
  "2d-screen":
    "A night help desk with five callers. Listen, choose replies, and keep trust above three until the shift ends.",
  blank:
    "Describe what the player does, what makes it fun, and what winning looks like. A few sentences is enough.",
};

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
  const initialTemplate = useGameDialogStore((state) => state.template);
  return environmentId && dialog ? (
    <GameEntryForEnvironment
      key={`${environmentId}:${dialog}`}
      environmentId={environmentId}
      initialTemplate={initialTemplate}
    />
  ) : null;
}

function GameEntryForEnvironment({
  environmentId,
  initialTemplate,
}: {
  environmentId: EnvironmentId;
  initialTemplate: GameTemplateId | null;
}) {
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
  const refreshLibrary = useGameLibraryRefresh(environmentId);
  const navigate = useNavigate();
  const dialog = useGameDialogStore((state) => state.dialog);
  const setDialog = useGameDialogStore((state) => state.show);
  const [step, setStep] = useState<"template" | "details">("template");
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState(dialog === "create" ? "~/Games" : "");
  const [template, setTemplate] = useState<GameTemplateId>(
    initialTemplate ?? DEFAULT_GAME_TEMPLATE,
  );
  const [brief, setBrief] = useState("");
  const [artDirection, setArtDirection] = useState("");
  const [planFirst, setPlanFirst] = useState(true);
  const [reviewDesign, setReviewDesign] = useState(false);
  const [editingFolder, setEditingFolder] = useState(false);
  const planFirstId = useId();
  const reviewDesignId = useId();
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
    if (isCreate && step === "template") {
      setStep("details");
      return;
    }
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = isCreate
      ? await create({
          environmentId,
          input: {
            name,
            parentDirectory: directory,
            template,
            brief,
            artDirection,
            planFirst,
            ...(planFirst && reviewDesign ? { reviewDesign: true } : {}),
            modelSelection: model,
          },
        })
      : await open({ environmentId, input: { path: directory, modelSelection: model } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
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
              {isCreate ? (
                <>
                  <span className={cn(step === "template" && "font-medium text-foreground")}>
                    1. Choose a start
                  </span>
                  <span aria-hidden>·</span>
                  <span className={cn(step === "details" && "font-medium text-foreground")}>
                    2. Describe it
                  </span>
                </>
              ) : (
                "Continue a game that already lives on this machine."
              )}
            </div>
            <DialogTitle>
              {isCreate
                ? step === "template"
                  ? "What should we make?"
                  : "Name your game"
                : "Open game"}
            </DialogTitle>
            <DialogDescription>
              {isCreate
                ? step === "template"
                  ? "Every start is a real, playable Godot project — the agent builds on top of it."
                  : "Your agent writes a design first, then builds in Blender and Godot."
                : "Open a game folder containing game.json."}
            </DialogDescription>
            {isCreate && step === "details" ? (
              <button
                type="button"
                onClick={() => setStep("template")}
                className="mt-0.5 inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="h-5 w-9 shrink-0 overflow-hidden rounded-sm border border-border bg-muted">
                  <TemplatePreview template={template} />
                </span>
                Starting from{" "}
                <span className="font-medium text-foreground">
                  {GAME_TEMPLATES.find((entry) => entry.id === template)?.name ?? "Blank"}
                </span>
                <PencilIcon className="size-3" aria-hidden />
              </button>
            ) : null}
          </DialogHeader>
          <DialogPanel>
            {isCreate ? (
              step === "template" ? (
                <div className="flex flex-col gap-4">
                  <RadioGroup
                    aria-label="Starter template"
                    value={template}
                    disabled={busy}
                    onValueChange={(value) => {
                      const picked = GAME_TEMPLATES.find((entry) => entry.id === value);
                      if (picked) setTemplate(picked.id);
                    }}
                    className="grid grid-cols-1 sm:grid-cols-2"
                  >
                    {GAME_TEMPLATES.map((entry) => {
                      const selected = template === entry.id;
                      return (
                        <label
                          key={entry.id}
                          className={cn(
                            "group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-card text-left transition-[border-color,box-shadow]",
                            selected
                              ? "border-primary ring-2 ring-primary/20"
                              : "border-border hover:border-foreground/25",
                          )}
                        >
                          <Radio value={entry.id} className="sr-only" />
                          <span className="relative block aspect-video overflow-hidden border-b border-border bg-muted">
                            <TemplatePreview template={entry.id} />
                            {selected ? (
                              <span className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
                                <CheckIcon className="size-3" aria-hidden />
                              </span>
                            ) : null}
                          </span>
                          <span className="flex min-w-0 flex-col gap-1 p-3">
                            <span className="flex items-center justify-between gap-2">
                              <span className="font-medium text-sm text-foreground">
                                {entry.name}
                              </span>
                              <Badge variant="outline" size="sm">
                                {entry.dimension.toUpperCase()}
                              </Badge>
                            </span>
                            <span className="text-xs leading-snug text-muted-foreground">
                              {entry.description}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </RadioGroup>
                  <p className="text-xs text-muted-foreground">
                    Not sure yet? Start with 3D Explorer — the design step lets you change anything
                    before the build begins.
                  </p>
                </div>
              ) : (
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
                      placeholder={BRIEF_PLACEHOLDERS[template]}
                      disabled={busy}
                    />
                  </label>
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
                  <label
                    htmlFor={planFirstId}
                    className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-border/70 px-3 py-2.5"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium">Plan the design first</span>
                      <span className="text-xs text-muted-foreground">
                        The agent writes a one-page design, then builds it.
                      </span>
                    </span>
                    <Switch
                      id={planFirstId}
                      className="mt-0.5"
                      checked={planFirst}
                      disabled={busy}
                      onCheckedChange={(checked) => setPlanFirst(Boolean(checked))}
                    />
                  </label>
                  {planFirst ? (
                    <label
                      htmlFor={reviewDesignId}
                      className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-border/70 px-3 py-2.5"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-medium">Approve the design before building</span>
                        <span className="text-xs text-muted-foreground">
                          For developers: the build waits until you approve DESIGN.md on the Design
                          tab.
                        </span>
                      </span>
                      <Switch
                        id={reviewDesignId}
                        className="mt-0.5"
                        checked={reviewDesign}
                        disabled={busy}
                        onCheckedChange={(checked) => setReviewDesign(Boolean(checked))}
                      />
                    </label>
                  ) : null}
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
              )
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
              {isCreate && step === "details" ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setStep("template")}
                >
                  <ArrowLeftIcon aria-hidden />
                  Back
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || pickingFolder}
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </Button>
              )}
            </div>
            <Button
              type="submit"
              disabled={
                busy || pickingFolder || (isCreate ? step === "details" && !canSubmit : !canSubmit)
              }
            >
              {busy
                ? isCreate
                  ? "Creating game…"
                  : "Opening game…"
                : isCreate
                  ? step === "template"
                    ? "Continue"
                    : "Create game"
                  : "Open game"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
