import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@kurambit/client-runtime/environment";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import {
  GAME_ENGINES,
  GameEngineId,
  GAME_STYLE_DEFAULT_CHARACTERS,
  GAME_REFERENCE_MAX_DATA_URL_CHARS,
  GAME_STYLE_DEFAULT_LIBRARY,
  type EnvironmentId,
  type GameCharacterRoute,
} from "@kurambit/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowUpIcon,
  CopyIcon,
  EllipsisIcon,
  FolderOpenIcon,
  PencilIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";

import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { waitForThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { useSidebarRowSubscriptionLease } from "../Sidebar.logic";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { StatusDot } from "../ui/status-dot";
import { Tabs, TabsList, TabsTab } from "../ui/tabs";
import { Tooltip, TooltipLabel, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Skeleton } from "../ui/skeleton";
import { Atmosphere } from "../brand/Atmosphere";
import { Text } from "../ui/text";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { GamePicture } from "./GameBuildStill";
import { useStageStill } from "./gameStageBridge";
import {
  CHARACTER_ROUTES,
  characterRouteBlocker,
  LibraryChoice,
  modelChoiceLabel,
} from "./GameCharacterRoute";
import { showOpenGameDialog, useGameEntryStore } from "./gameEntryStore";
import { GameLibraryStatusText, useGameLibraryLine } from "./GameLibraryStatus";
import { GameNameInput, useGameName, useGameRenameStore, useRenameGame } from "./GameName";
import { draftGameName } from "./gameLibrary.logic";
import { engineToolFor } from "./gameStageLogic";
import { GameToolLink } from "./GameToolLink";
import { useGameActions } from "./useGameActions";
import { useGameLibraryRefresh } from "./useGameLibrary";
import { type GameCover, useGameCovers } from "./useGameCovers";
import { chooseEngine, useEngineReadiness } from "./useEngineReadiness";
import { useGameModelChoice } from "./useGameModelChoice";

const BRIEF_IDEAS = [
  "A cozy fishing game at dusk",
  "A roguelike in a flooded cathedral",
  "A paper boat racing down a storm drain",
] as const;

// Home is where every game is: the sidebar lists chats, and a game whose chats are all settled
// has no row there. The latest few show; the rest are one press away.
const SHELF_CARDS = 8;

export function GamesHome() {
  const { covers: every, isLoading, error } = useGameCovers();
  // A game put away waits under the Archived filter; the page counts the rest.
  const covers = every.filter((cover) => !cover.archived);
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const openGame = (cover: GameCover) => {
    if (cover.opens !== null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: cover.opens.environmentId, threadId: cover.opens.id },
      });
      return;
    }
    void handleNewThread(scopeProjectRef(cover.game.environmentId, cover.game.projectId));
  };
  const firstRun = !isLoading && covers.length === 0;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Atmosphere />
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="relative min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div
            className={cn(
              // As T3's new-thread page: the composer at the reading width, a little above the
              // middle under the atmosphere; your games are a quiet list under it.
              "mx-auto flex w-full max-w-(--chat-content-max-width) flex-col px-6",
              firstRun ? "min-h-full justify-center pb-32" : "gap-12 pt-72 pb-24",
            )}
          >
            {environmentId ? <BriefBox environmentId={environmentId} firstRun={firstRun} /> : null}

            {error ? (
              <div className="flex flex-col gap-1 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
                <Text variant="label" tone="destructive">
                  Could not load your games.
                </Text>
                <Text variant="meta" tone="muted">
                  {error}
                </Text>
              </div>
            ) : null}

            {covers.length > 0 && environmentId ? (
              <ContinueShelf covers={every} onOpen={openGame} />
            ) : isLoading ? (
              // The shelf's room is kept while the games load, so the brief does not jump up.
              <ShelfPlaceholder />
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

/** The long side a reference is kept at: the size a model is shown pictures at. */
const REFERENCE_MAX_EDGE = 1568;

/**
 * Any image the browser can decode, as the PNG the game keeps (art/reference.png), no larger than
 * a model is shown. Null when it does not decode or is still too large.
 */
const referencePng = async (file: File): Promise<{ name: string; dataUrl: string } | null> => {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (bitmap === null) return null;
  const scale = Math.min(1, REFERENCE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.length <= GAME_REFERENCE_MAX_DATA_URL_CHARS ? { name: file.name, dataUrl } : null;
};

/** The new-game form: the brief, the model, Start. Everything else has a sensible default. */
function BriefBox({
  environmentId,
  firstRun,
}: {
  environmentId: EnvironmentId;
  firstRun: boolean;
}) {
  const navigate = useNavigate();
  const choice = useGameModelChoice(environmentId);
  const canCreate = useAtomValue(gameEnvironment.create.permissionAtom(environmentId));
  const canOpen = useAtomValue(gameEnvironment.open.permissionAtom(environmentId));
  const create = useAtomCommand(gameEnvironment.create, { reportFailure: false });
  const refreshLibrary = useGameLibraryRefresh(environmentId);
  const { toolchain, ready: engineReady } = useEngineReadiness(environmentId);
  const [brief, setBrief] = useState("");
  const [characters, setCharacters] = useState<GameCharacterRoute>(GAME_STYLE_DEFAULT_CHARACTERS);
  const [library, setLibrary] = useState(GAME_STYLE_DEFAULT_LIBRARY);
  const [chosenEngine, setEngine] = useState<GameEngineId | null>(null);
  const engine = chooseEngine(chosenEngine, engineReady);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A picture to aim for, which the game keeps as its reference.
  const [picture, setPicture] = useState<{ name: string; dataUrl: string } | null>(null);
  const pictureInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const takePicture = async (file: File) => {
    const png = await referencePng(file);
    if (png === null) setError(`${file.name} could not be read as a picture.`);
    else {
      setError(null);
      setPicture(png);
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = [...event.clipboardData.files].find((each) => each.type.startsWith("image/"));
    if (file === undefined) return;
    event.preventDefault();
    void takePicture(file);
  };

  // A request from New game anywhere: take its brief while rendering, focus once mounted.
  const request = useGameEntryStore((state) => state.boxRequest);
  const [seenRequest, setSeenRequest] = useState<number | null>(null);
  if (request !== null && request.id !== seenRequest) {
    setSeenRequest(request.id);
    if (request.brief !== null) setBrief(request.brief);
  }
  const requestId = request?.id ?? null;
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    if (requestId !== null) useGameEntryStore.getState().takeBoxRequest();
    else if (document.activeElement !== null && document.activeElement !== document.body) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [requestId]);

  const trimmedBrief = brief.trim();
  const engineTool = toolchain === null ? null : engineToolFor(toolchain, engine);
  const ffmpeg = toolchain?.tools.find((tool) => tool.tool === "ffmpeg") ?? null;
  const ready = canCreate && choice.ready && engineReady(engine);

  const start = async () => {
    if (busy) return;
    if (trimmedBrief.length === 0 || !ready) {
      textareaRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const result = await create({
      environmentId,
      input: {
        // The server names the game from the brief before it makes it; this draft stands only
        // when that model is slow or fails.
        name: draftGameName(trimmedBrief) || "Untitled Game",
        nameFromBrief: true,
        // Empty: the server's default games folder.
        parentDirectory: "",
        brief: trimmedBrief,
        engine,
        characters,
        library,
        ...(picture === null ? {} : { reference: picture }),
        modelSelection: choice.model,
      },
    });
    if (result._tag === "Failure") {
      setBusy(false);
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    choice.remember();
    refreshLibrary();
    // The thread route sends a thread this client has not received yet back
    // home, so open the game only once its shell has arrived.
    await waitForThreadShell(scopeThreadRef(environmentId, result.value.threadId));
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: result.value.threadId },
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void start();
    }
  };

  const notes = [
    error === null ? null : { text: error, tone: "destructive" as const },
    canCreate ? null : { text: "This connection cannot make games here." },
    choice.notReadyReason === null ? null : { text: choice.notReadyReason },
    engineTool !== null && engineTool.status !== "ready"
      ? {
          text: `${GAME_ENGINES[engine].name} needs ${engineTool.message}`,
          action: <GameToolLink tool={engineTool} />,
        }
      : null,
    ffmpeg !== null && ffmpeg.status !== "ready"
      ? {
          text: "Without ffmpeg, builds are only checked for starting: no videos of their plays, so no play checks.",
          action: <GameToolLink tool={ffmpeg} />,
        }
      : null,
  ].filter((note) => note !== null);

  // From the press of Enter the person sees what they sent and that it is being made, as the
  // game's chat will show it, while the game is made and its chat opens.
  if (busy)
    return (
      <section
        aria-busy="true"
        aria-label="Making your game"
        className="flex w-full flex-col gap-3"
      >
        <div className="flex justify-end">
          <p
            data-starting-message=""
            className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-message p-3 text-message-foreground"
          >
            {trimmedBrief}
          </p>
        </div>
        <Text variant="body" tone="muted" render={<p className="flex items-center gap-2 px-1" />}>
          <Spinner size="sm" aria-hidden="true" />
          Making your game…
        </Text>
      </section>
    );

  return (
    <section className="mx-auto flex w-full flex-col gap-2">
      <h1 className="sr-only">{firstRun ? "Make a game you want to play" : "Make a new game"}</h1>
      {/* The context row over the box, as T3's: what the brief will make, and the way to open
          a game that already exists. */}
      <div className="flex h-7 min-w-0 items-center gap-1 px-1 text-muted-foreground">
        <Text
          variant="label"
          tone="inherit"
          render={<span className="flex items-center gap-1.5" />}
        >
          <SquarePenIcon className="size-3.5" aria-hidden />
          New {GAME_ENGINES[engine].name} game
        </Text>
        {canOpen ? <OpenGameLink className="ms-auto" /> : null}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
        // One calm card: the raised composer fill and its soft drop, a quiet rim while typing.
        className="flex w-full flex-col rounded-xl surface-composer transition-shadow focus-within:surface-composer-focus"
      >
        <label htmlFor="game-brief" className="sr-only">
          Describe the game you want to make
        </label>
        <textarea
          id="game-brief"
          ref={textareaRef}
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={3}
          disabled={busy}
          placeholder="Describe the game you want to play, or paste a picture to aim for"
          // Grows with what is typed up to a cap, then scrolls, as ui/textarea does.
          className="field-sizing-content max-h-64 min-h-18 w-full resize-none overflow-y-auto bg-transparent px-4 pt-3 text-base/6 text-foreground outline-none placeholder:text-placeholder"
        />
        {picture === null ? null : (
          <div className="px-4 pt-1">
            <div className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80">
              <img
                src={picture.dataUrl}
                alt={picture.name}
                className="h-full w-full object-cover"
              />
              <span className="absolute top-1 right-1 flex">
                <Button
                  variant="media-close"
                  size="icon-xs"
                  disabled={busy}
                  onClick={() => setPicture(null)}
                  aria-label={`Remove ${picture.name}`}
                >
                  <XIcon />
                </Button>
              </span>
            </div>
          </div>
        )}
        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          <input
            ref={pictureInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) void takePicture(file);
            }}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-sm"
                  disabled={busy}
                  onClick={() => pictureInputRef.current?.click()}
                  aria-label="Attach a picture to aim for"
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Attach a picture to aim for</TooltipPopup>
          </Tooltip>
          <BriefOptions
            characters={characters}
            onCharacters={setCharacters}
            library={library}
            onLibrary={setLibrary}
            disabled={busy}
          />
          {/* One engine is no choice, so no picker shows. */}
          {GameEngineId.literals.length > 1 ? (
            <ToggleGroup
              aria-label="Engine"
              variant="segmented"
              value={[engine]}
              onValueChange={(value) => {
                const next = GameEngineId.literals.find((id) => id === value[0]);
                if (next !== undefined) setEngine(next);
              }}
            >
              {GameEngineId.literals.map((id) => (
                <Toggle key={id} value={id} disabled={!engineReady(id)}>
                  {GAME_ENGINES[id].picker.short}
                </Toggle>
              ))}
            </ToggleGroup>
          ) : null}
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
          {/* The same model and effort pair as a game's own composer, so the first build is
              asked for in the words every later one is. */}
          {choice.modelEntry === undefined ? null : (
            <TraitsPicker
              provider={choice.modelEntry.driverKind}
              instanceId={choice.model.instanceId}
              models={choice.modelEntry.models}
              model={choice.model.model}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={choice.model.options}
              allowPromptInjectedEffort={false}
              planModeEnabled={false}
              disabled={busy}
              onModelOptionsChange={(options) =>
                choice.choose({
                  instanceId: choice.model.instanceId,
                  model: choice.model.model,
                  ...(options === undefined ? {} : { options }),
                })
              }
            />
          )}
          <span className="flex-1" />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="submit"
                  aria-label={busy ? "Starting" : "Start building"}
                  // The box's one accent: lit even while empty, where Start just focuses the box.
                  disabled={busy || !ready}
                  className="relative isolate flex size-8 items-center justify-center overflow-hidden rounded-md surface-lit text-primary-foreground enabled:cursor-pointer hover:surface-lit-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none"
                />
              }
            >
              {busy ? (
                <Spinner size="sm" aria-hidden="true" />
              ) : (
                <ArrowUpIcon className="size-4" aria-hidden="true" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              <TooltipLabel shortcut="⏎">Start building</TooltipLabel>
            </TooltipPopup>
          </Tooltip>
        </div>
      </form>

      {notes.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {notes.map((note) => (
            <li key={note.text} className="flex flex-wrap items-center gap-2">
              <Text
                variant="meta"
                tone={"tone" in note ? note.tone : "muted"}
                render={
                  <p className="whitespace-pre-wrap" role={"tone" in note ? "alert" : undefined} />
                }
              >
                {note.text}
              </Text>
              {"action" in note ? note.action : null}
            </li>
          ))}
        </ul>
      ) : null}

      {firstRun ? (
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
          <Text variant="meta" tone="dim">
            Try
          </Text>
          {BRIEF_IDEAS.map((idea) => (
            <button
              key={idea}
              type="button"
              onClick={() => {
                setBrief(idea);
                textareaRef.current?.focus();
              }}
              className="cursor-pointer text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground/40"
            >
              <Text variant="meta" tone="inherit">
                {idea}
              </Text>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The few choices that shape the first build but have a good default. One quiet
 * button, so the box stays a place to write; a changed choice names itself.
 */
function BriefOptions({
  characters,
  onCharacters,
  library,
  onLibrary,
  disabled,
}: {
  characters: GameCharacterRoute;
  onCharacters: (route: GameCharacterRoute) => void;
  library: boolean;
  onLibrary: (library: boolean) => void;
  disabled: boolean;
}) {
  // At its default the choice is a quiet icon with a tooltip; once changed it names its value,
  // so a brief never goes out on a setting the box hides.
  const changed =
    characters !== GAME_STYLE_DEFAULT_CHARACTERS || library !== GAME_STYLE_DEFAULT_LIBRARY;
  const label = `Models: ${modelChoiceLabel(characters, library)}`;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size={changed ? "compact" : "icon-sm"}
                  variant="ghost-muted"
                  disabled={disabled}
                  aria-label={`First build options: ${label}`}
                />
              }
            />
          }
        >
          <SlidersHorizontalIcon aria-hidden />
          {changed ? label : null}
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="w-72">
        <MenuGroup>
          <MenuGroupLabel>Make models with</MenuGroupLabel>
          <MenuRadioGroup
            value={characters}
            onValueChange={(value: GameCharacterRoute) => onCharacters(value)}
          >
            {CHARACTER_ROUTES.map((option) => {
              const blocked = characterRouteBlocker(option.route);
              return (
                <MenuRadioItem key={option.route} value={option.route} disabled={blocked !== null}>
                  <span className="flex flex-col">
                    <Text variant="label">{option.label}</Text>
                    <Text variant="meta" tone="muted">
                      {blocked ?? option.description}
                    </Text>
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
          <MenuSeparator />
          <LibraryChoice checked={library} onChange={onLibrary} />
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function OpenGameLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={showOpenGameDialog}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      <FolderOpenIcon className="size-3.5" aria-hidden />
      <Text variant="meta" tone="inherit">
        Open a game folder
      </Text>
    </button>
  );
}

/** The list's shape while the games load: its filter row and a few quiet rows. */
function ShelfPlaceholder() {
  return (
    <section aria-hidden className="flex flex-col gap-2">
      <Skeleton className="mx-1 my-2.5 h-3 w-24" />
      <div className="flex flex-col">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-1 py-1.5">
            <Skeleton shape="card" className="aspect-video w-16" />
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

type ShelfFilter = "all" | "working" | "published" | "archived";

/** A game at work right now: a turn running, Keep going, or an operation such as a build. */
const isWorking = (cover: GameCover) =>
  cover.chats === "working" || cover.game.run !== null || cover.game.operation?.state === "running";

/**
 * The page under the brief: every game as a card with its frame, filtered by what it is doing,
 * each filter counted. A filter with nothing in it is not offered.
 */
function ContinueShelf({
  covers,
  onOpen,
}: {
  covers: ReadonlyArray<GameCover>;
  onOpen: (cover: GameCover) => void;
}) {
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState<ShelfFilter>("all");
  const active = covers.filter((cover) => !cover.archived);
  const groups: Record<ShelfFilter, ReadonlyArray<GameCover>> = {
    all: active,
    working: active.filter(isWorking),
    published: active.filter((cover) => cover.game.published !== null),
    archived: covers.filter((cover) => cover.archived),
  };
  const labels: Record<ShelfFilter, string> = {
    all: "All",
    working: "Working",
    published: "Published",
    archived: "Archived",
  };
  // A filter that empties while open (the last game at work settles) falls back to All.
  const shownFilter = groups[filter].length > 0 ? filter : "all";
  const list = groups[shownFilter];
  const shown = all ? list : list.slice(0, SHELF_CARDS);
  return (
    <section aria-labelledby="games" className="flex flex-col gap-2">
      <h2 id="games" className="sr-only">
        Your games
      </h2>
      <div className="flex h-8 items-center gap-4 px-1">
        <Tabs value={shownFilter} onValueChange={(value: ShelfFilter) => setFilter(value)}>
          <TabsList variant="underline" aria-label="Show games" className="h-8">
            {(["all", "working", "published", "archived"] as const).map((key) =>
              key !== "all" && groups[key].length === 0 ? null : (
                <TabsTab key={key} value={key}>
                  {labels[key]}
                  <Text variant="meta" tone="dim" numeric>
                    {groups[key].length}
                  </Text>
                </TabsTab>
              ),
            )}
          </TabsList>
        </Tabs>
      </div>
      <ul role="list" className="-mx-1 flex flex-col">
        {shown.map((cover) => (
          <GameCard key={cover.game.projectId} cover={cover} onOpen={() => onOpen(cover)} />
        ))}
      </ul>
      {list.length > shown.length ? (
        <div className="flex justify-center">
          <Button size="sm" variant="ghost-muted" onClick={() => setAll(true)}>
            Show all {list.length}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function GameCard({ cover, onOpen }: { cover: GameCover; onOpen: () => void }) {
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(false);
  const { game } = cover;
  const { status, still } = useGameLibraryLine({
    game,
    opens: cover.opens,
    chats: cover.chats,
    read: leaseLiveStatus,
  });
  // A game at work says so in its own line (what it is making), so the right side stays quiet.
  const chip =
    status.tone === "live"
      ? null
      : status.tone === "failed"
        ? { tone: "danger" as const, label: "Failed" }
        : status.tone === "broken"
          ? { tone: "danger" as const, label: "Does not start" }
          : game.published !== null
            ? { tone: "success" as const, label: "Published" }
            : null;
  const name = useGameName(game.environmentId, game.projectId, game.name);
  const renaming = useGameRenameStore((state) => state.renaming === game.projectId);
  const rename = useRenameGame(game.environmentId);
  const actions = useGameActions();
  const canOperate = actions.canOperate(game);
  // The card's menu, from its ⋯ and from a right-click anywhere on it.
  const [menuOpen, setMenuOpen] = useState(false);
  // The newest picture any build has, as the sidebar shows: a build being made, or one not
  // pictured yet, never turns the card back into an empty frame.
  const picture = still ?? game.keyArt;
  // Before any build has a still, the frame the Stage last showed of this game, when it
  // played in this session: the game's own title, not a stand-in.
  const shown = useStageStill(
    cover.opens === null
      ? ""
      : scopedThreadKey(scopeThreadRef(cover.opens.environmentId, cover.opens.id)),
  );
  const thumb = (
    <GamePicture
      environmentId={game.environmentId}
      root={game.root}
      path={picture}
      gameName={name}
      mark="monogram"
      className="aspect-video w-16 shrink-0 rounded-md ring-1 ring-foreground/8 ring-inset"
    >
      {picture === null && shown !== null ? (
        <img src={shown} alt="" className="absolute inset-0 size-full object-cover" />
      ) : null}
    </GamePicture>
  );
  // A row in T3's list craft: the thumbnail, the name over one muted line, where it stands and
  // when it last moved at the right; its menu takes the time's place under the pointer.
  const meta =
    status.tone === "live" ? (
      <GameLibraryStatusText status={status} />
    ) : (
      <GameLibraryStatusText
        status={{
          text:
            game.buildCount === 0
              ? "No builds yet"
              : `${game.buildCount} ${game.buildCount === 1 ? "build" : "builds"}`,
          tone: status.tone === "failed" || status.tone === "broken" ? status.tone : "idle",
          since: null,
          at: game.latestBuildAt ?? cover.opens?.updatedAt ?? game.updatedAt,
        }}
      />
    );
  const body = (
    <>
      {thumb}
      <span className="flex min-w-0 flex-1 flex-col">
        {renaming ? (
          <GameNameInput
            name={name}
            onRename={(next) => void rename(game.projectId, next)}
            onDone={() => useGameRenameStore.getState().stop()}
            className="h-6"
          />
        ) : (
          <Text variant="label" truncate>
            {name}
          </Text>
        )}
        {meta}
      </span>
      {chip === null ? null : (
        <span className="flex shrink-0 items-center gap-1.5 pe-8 text-muted-foreground">
          <StatusDot tone={chip.tone} />
          <Text variant="meta" tone="inherit">
            {chip.label}
          </Text>
        </span>
      )}
    </>
  );
  const rowClass =
    "group flex w-full min-w-0 items-center gap-3 rounded-lg px-1 py-1.5 text-left outline-none";
  return (
    <li
      className="group/card relative min-w-0"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {renaming ? (
        // The name becomes its own field, so the row is no button while it is typed in.
        <div ref={rowRef} className={rowClass}>
          {body}
        </div>
      ) : (
        <button
          ref={rowRef}
          type="button"
          onClick={onOpen}
          className={cn(
            rowClass,
            "cursor-pointer hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          )}
        >
          {body}
        </button>
      )}
      {/* The game's own actions: shown to a pointer, the keyboard, and while open. */}
      <span className="absolute end-1.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/card:opacity-100 has-[:focus-visible]:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:opacity-100">
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={<Button size="icon-xs" variant="overlay" aria-label={`${name}, game menu`} />}
          >
            <EllipsisIcon aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem disabled={!canOperate} onClick={() => actions.newChat(game)}>
              <SquarePenIcon />
              New chat
            </MenuItem>
            {actions.offersCopy ? (
              <MenuItem
                disabled={!canOperate}
                onClick={() => actions.newChat(game, { inCopy: true })}
              >
                <CopyIcon />
                New chat in a copy
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem
              disabled={!canOperate}
              onClick={() => useGameRenameStore.getState().start(game.projectId)}
            >
              <PencilIcon />
              Rename
            </MenuItem>
            {actions.canOpenFolder(game) ? (
              <MenuItem onClick={() => actions.openFolder(game)}>
                <FolderOpenIcon />
                Open folder
              </MenuItem>
            ) : null}
            <MenuItem
              disabled={!canOperate || !actions.canArchive(game)}
              onClick={() => void actions.archive(game)}
            >
              <ArchiveIcon />
              Archive
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={!canOperate}
              onClick={() => void actions.remove(game)}
            >
              <Trash2Icon />
              Delete…
            </MenuItem>
          </MenuPopup>
        </Menu>
      </span>
    </li>
  );
}
