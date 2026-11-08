import { useGameDialogStore } from "./gameDialogStore";
import { ensureLocalApi } from "../../localApi";
import { isElectron } from "../../env";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import * as Schema from "effect/Schema";
import { useNavigate } from "@tanstack/react-router";
import {
  GAME_CHARACTER_ROUTE_UNAVAILABLE,
  ACTIVE_GAME_ENGINES,
  GAME_ENGINES,
  ModelSelection,
  type EnvironmentId,
  type GameCharacterRoute,
  type GameEngineId,
  type GameToolStatus,
} from "@kurambit/contracts";
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
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  resolveAppModelSelectionState,
  getCustomModelOptionsByInstance,
} from "../../modelSelection";
import { gameEnvironment } from "../../state/game";
import { waitForThreadShell } from "../../state/entities";
import { scopeThreadRef } from "@kurambit/client-runtime/environment";
import { engineToolFor } from "./gameStageLogic";
import { chooseEngine, useEngineReadiness } from "./useEngineReadiness";
import { GameToolLink } from "./GameToolLink";
import {
  CHARACTER_ROUTES,
  useCharacterRouteBlockers,
  useGeneratedRouteNote,
} from "./GameCharacterRoute";
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
  // A game's first turn builds the whole game, so it gets the provider's own chat default (its
  // flagship) at the provider's default effort: never the cheap model and low effort the app
  // summarises text with, which gave up on every brief of the first-ten-minutes benchmark.
  const textDefault = resolveAppModelSelectionState(settings, providers);
  const defaultSelection: ModelSelection = {
    instanceId: textDefault.instanceId,
    model: getDefaultProviderInstanceModel(providers, textDefault.instanceId) ?? textDefault.model,
  };
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  // The model the person last picked for a game, while its provider is usable; otherwise the
  // default above. The key moved once: the old one also kept an untouched cheap default.
  const [lastGameModel, setLastGameModel] = useLocalStorage(
    `game-entry-picked-model:${environmentId}`,
    null,
    lastGameModelSchema,
  );
  // A game's first turn starts the moment it is created, so only an agent that
  // can work now (installed and signed in) may make it.
  const isReady = (instanceId: string) =>
    entries.some(
      (entry) => entry.instanceId === instanceId && isProviderInstancePickerReady(entry),
    );
  const remembered =
    lastGameModel !== null && isReady(lastGameModel.instanceId) ? lastGameModel : null;
  const firstReady = entries.find(isProviderInstancePickerReady);
  const readyFallback =
    firstReady === undefined || isReady(defaultSelection.instanceId)
      ? null
      : {
          instanceId: firstReady.instanceId,
          model:
            getDefaultProviderInstanceModel(providers, firstReady.instanceId) ??
            defaultSelection.model,
        };
  const model = selection ?? remembered ?? readyFallback ?? defaultSelection;
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
  const { toolchain, ready: engineReady } = useEngineReadiness(environmentId);
  const [chosenEngine, setEngine] = useState<GameEngineId | null>(draft?.engine ?? null);
  const engine = chooseEngine(chosenEngine, engineReady);
  const [characters, setCharacters] = useState<GameCharacterRoute>("library");
  // Read only while the New game dialog is open: it asks the server about every provider.
  const routeBlocker = useCharacterRouteBlockers(dialog === "create" ? environmentId : null);
  const generatedNote = useGeneratedRouteNote(dialog === "create" ? environmentId : null);
  const [editingFolder, setEditingFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isCreate = dialog === "create";
  const slug = gameSlug(name) || "your-game";
  const folder = `${directory.replace(/\/+$/, "")}/${slug}`;
  const providerReady = isReady(model.instanceId);
  const modelEntry = entries.find((entry) => entry.instanceId === model.instanceId);
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
            characters,
            modelSelection: model,
          },
        })
      : await open({ environmentId, input: { path: directory, modelSelection: model } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    if (selection !== null) setLastGameModel(selection);
    refreshLibrary();
    setDialog(null);
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
                ? "Your agent builds a first playable version in a few minutes; every message after that makes it better."
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
                {/* One active engine is no choice, so no picker shows. */}
                {ENGINE_OPTIONS.length > 1 ? (
                  <fieldset className="flex flex-col gap-2 text-sm">
                    <legend className="font-medium">Engine</legend>
                    {ENGINE_OPTIONS.map((option) => (
                      <EngineOption
                        key={option.id}
                        {...option}
                        tool={toolchain === null ? null : engineToolFor(toolchain, option.id)}
                        ready={engineReady(option.id)}
                        checked={engine === option.id}
                        onPick={() => setEngine(option.id)}
                        disabled={busy}
                      />
                    ))}
                  </fieldset>
                ) : null}
                <fieldset className="flex flex-col gap-2 text-sm">
                  <legend className="font-medium">Make characters with</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {CHARACTER_ROUTES.map((option) => {
                      const blocked = routeBlocker(option.route);
                      return (
                        <label
                          key={option.route}
                          className={
                            blocked === null
                              ? "flex cursor-pointer items-start gap-2 rounded-lg border border-border/70 px-3 py-2 has-checked:border-primary has-checked:bg-primary/5"
                              : "flex items-start gap-2 rounded-lg border border-border/70 px-3 py-2 opacity-64"
                          }
                        >
                          <input
                            type="radio"
                            name="game-characters"
                            value={option.route}
                            checked={characters === option.route}
                            onChange={() => setCharacters(option.route)}
                            disabled={busy || blocked !== null}
                            className="mt-1"
                          />
                          <span>
                            <span className="font-medium">{option.label}</span>
                            <span className="block text-xs text-muted-foreground">
                              {blocked ?? option.description}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {GAME_CHARACTER_ROUTE_UNAVAILABLE.generated === undefined &&
                  routeBlocker("generated") !== null ? (
                    <p className="text-xs text-muted-foreground">
                      Generated characters need an art provider: a Tripo or Meshy key, or Codex.{" "}
                      <Button
                        type="button"
                        size="xs"
                        variant="link"
                        disabled={busy}
                        onClick={() => {
                          setDialog(null);
                          void navigate({ to: "/settings/general", hash: "art-providers" });
                        }}
                      >
                        Set up in Settings
                      </Button>
                    </p>
                  ) : null}
                  {characters === "generated" && generatedNote !== null ? (
                    <p className="text-xs text-muted-foreground">{generatedNote}</p>
                  ) : null}
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
            {providerReady ? null : (
              <p className="text-sm text-muted-foreground">
                {modelEntry === undefined
                  ? "No agent is ready."
                  : `${modelEntry.displayName} is not ready: ${modelEntry.snapshot.message ?? "it is not signed in."}`}{" "}
                Sign in, or add an agent in Settings → Providers, then choose its model here.
              </p>
            )}
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

const ENGINE_OPTIONS = ACTIVE_GAME_ENGINES.map((id) => ({
  id,
  ...GAME_ENGINES[id].picker,
}));

/** An engine that is not ready cannot be picked; it shows what is wrong and where to get it. */
function EngineOption({
  id,
  title,
  description,
  tool,
  ready,
  checked,
  onPick,
  disabled,
}: {
  id: GameEngineId;
  title: string;
  description: string;
  tool: GameToolStatus | null;
  ready: boolean;
  checked: boolean;
  onPick: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 px-3 py-2 has-checked:border-primary has-checked:bg-primary/5">
      <label
        className={
          ready ? "flex cursor-pointer items-start gap-2" : "flex items-start gap-2 opacity-64"
        }
      >
        <input
          type="radio"
          name="game-engine"
          value={id}
          checked={checked}
          onChange={onPick}
          disabled={disabled || !ready}
          className="mt-1"
        />
        <span>
          <span className="font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{description}</span>
          {tool !== null && tool.status !== "ready" && tool.installed ? (
            <span className="mt-1 block text-xs text-muted-foreground">{tool.message}</span>
          ) : null}
        </span>
      </label>
      {tool !== null && tool.status !== "ready" ? (
        <div className="flex items-center gap-2 pl-5 text-xs text-muted-foreground">
          {tool.installed ? null : <span>Not installed ·</span>}
          <GameToolLink tool={tool} />
        </div>
      ) : null}
    </div>
  );
}
