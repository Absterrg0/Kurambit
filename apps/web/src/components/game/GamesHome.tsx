import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@kurambit/client-runtime/environment";
import type { EnvironmentThreadShell } from "@kurambit/client-runtime/state/models";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import {
  ACTIVE_GAME_ENGINES,
  GAME_ENGINES,
  isNestedUnderLiveParent,
  type EnvironmentId,
  type GameCharacterRoute,
  type GameEngineId,
} from "@kurambit/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderOpenIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { useThreadShells, waitForThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  gameMainThread,
  partitionGameChats,
  resolveGameSidebarStatus,
  useSidebarRowSubscriptionLease,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
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
import { Kbd } from "../ui/kbd";
import { Text } from "../ui/text";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { GamePicture } from "./GameBuildStill";
import { useStageStill } from "./gameStageBridge";
import {
  CHARACTER_ROUTES,
  characterRouteLabel,
  useCharacterRouteBlockers,
  useGeneratedRouteNote,
} from "./GameCharacterRoute";
import { showOpenGameDialog, useGameEntryStore } from "./gameEntryStore";
import { GameLibraryStatusText, useGameLibraryLine } from "./GameLibraryStatus";
import { useGameName } from "./GameName";
import { draftGameName, sortGameThreadsByActivity } from "./gameLibrary.logic";
import { engineToolFor } from "./gameStageLogic";
import { GameToolLink } from "./GameToolLink";
import { useGameLibrary, useGameLibraryRefresh, type GameLibraryEntry } from "./useGameLibrary";
import { chooseEngine, useEngineReadiness } from "./useEngineReadiness";
import { useGameModelChoice } from "./useGameModelChoice";

const BRIEF_IDEAS = [
  "A cozy fishing game at dusk",
  "A roguelike in a flooded cathedral",
  "A paper boat racing down a storm drain",
] as const;

// Home continues the latest few; the sidebar already lists every game.
const SHELF_CARDS = 3;

type GameCover = {
  readonly game: GameLibraryEntry;
  readonly main: EnvironmentThreadShell | null;
  readonly chats: SidebarThreadStatus | null;
};

const activityOf = (cover: GameCover) =>
  [cover.game.updatedAt, cover.main?.updatedAt ?? ""].toSorted().at(-1) ?? "";

export function GamesHome() {
  const { games, isLoading, error } = useGameLibrary();
  const environmentId = usePrimaryEnvironmentId();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const liveThreadIds = new Set<string>(
    threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
  );
  const threadsByProject = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    if (isNestedUnderLiveParent(thread, liveThreadIds)) continue;
    const list = threadsByProject.get(thread.projectId);
    if (list === undefined) threadsByProject.set(thread.projectId, [thread]);
    else list.push(thread);
  }
  const covers = games
    .map((game) => {
      const list = threadsByProject.get(game.projectId) ?? [];
      const chats = partitionGameChats(list, liveThreadIds);
      // A game opens on its main chat, as its sidebar row does.
      const main = chats.main ?? gameMainThread(list) ?? sortGameThreadsByActivity(list)[0] ?? null;
      return {
        game,
        main,
        chats: list.length === 0 ? null : resolveGameSidebarStatus(chats),
      } satisfies GameCover;
    })
    // Latest work first, by the game's own chat rather than its project row, so
    // home continues the game a turn last touched.
    .toSorted((a, b) => activityOf(b).localeCompare(activityOf(a)));
  const openGame = (cover: GameCover) => {
    if (cover.main !== null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: cover.main.environmentId, threadId: cover.main.id },
      });
      return;
    }
    void handleNewThread(scopeProjectRef(cover.game.environmentId, cover.game.projectId));
  };
  const firstRun = !isLoading && covers.length === 0;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div
            className={cn(
              "mx-auto flex w-full max-w-200 flex-col px-8",
              // The stack sits in the middle of the page, so a short shelf leaves no void below.
              "min-h-full justify-center",
              // A little above the middle, where a centred block reads as centred.
              firstRun ? "pb-32" : "gap-14 pt-12 pb-24",
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
              <ContinueShelf covers={covers} environmentId={environmentId} onOpen={openGame} />
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

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
  const [characters, setCharacters] = useState<GameCharacterRoute>("library");
  const [chosenEngine, setEngine] = useState<GameEngineId | null>(null);
  const engine = chooseEngine(chosenEngine, engineReady);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
        // A working title the person renames whenever they like; the folder takes it too.
        name: draftGameName(trimmedBrief) || "Untitled Game",
        // Empty: the server's default games folder.
        parentDirectory: "",
        brief: trimmedBrief,
        engine,
        characters,
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

  const generatedNote = useGeneratedRouteNote(environmentId);
  const notes = [
    error === null ? null : { text: error, tone: "destructive" as const },
    characters === "generated" && generatedNote !== null ? { text: generatedNote } : null,
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
          text: "Without ffmpeg, builds are only checked for starting: no recordings, so no play checks.",
          action: <GameToolLink tool={ffmpeg} />,
        }
      : null,
  ].filter((note) => note !== null);

  return (
    <section className="flex w-full flex-col gap-3">
      {/* The page's one display line, in the same face as the covers below. */}
      <h1 className="mb-2 font-display text-4xl/10 text-strong-foreground">
        {firstRun ? "Make a game you want to play" : "What should we make next?"}
      </h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
        className="flex w-full flex-col rounded-3xl border border-border bg-card shadow-composer transition-colors focus-within:border-foreground/20 dark:shadow-none"
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
          rows={2}
          disabled={busy}
          placeholder="Describe the game you want to play…"
          className="min-h-22 w-full resize-none bg-transparent px-5 pt-4.5 text-base/6 text-strong-foreground outline-none placeholder:text-placeholder"
        />
        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          {/* One active engine is no choice, so no picker shows. */}
          {ACTIVE_GAME_ENGINES.length > 1 ? (
            <ToggleGroup
              aria-label="Engine"
              variant="segmented"
              value={[engine]}
              onValueChange={(value) => {
                const next = ACTIVE_GAME_ENGINES.find((id) => id === value[0]);
                if (next !== undefined) setEngine(next);
              }}
            >
              {ACTIVE_GAME_ENGINES.map((id) => (
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
          <BriefOptions
            environmentId={environmentId}
            characters={characters}
            onCharacters={setCharacters}
            disabled={busy}
          />
          <span className="flex-1" />
          {/* Lit only once there is a brief to build: an empty box's Enter just focuses it. */}
          <Button
            type="submit"
            size="sm"
            variant={trimmedBrief.length === 0 ? "secondary" : "default"}
            disabled={busy || !ready}
          >
            {busy ? "Starting…" : "Start building"}
            {busy ? null : <Kbd>⏎</Kbd>}
          </Button>
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
      ) : (
        <Text variant="meta" tone="muted" render={<p />}>
          A playable first version in a few minutes. Rename, restyle and change it any time.
        </Text>
      )}

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
          {canOpen ? <OpenGameLink className="ms-auto" /> : null}
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
  environmentId,
  characters,
  onCharacters,
  disabled,
}: {
  environmentId: EnvironmentId;
  characters: GameCharacterRoute;
  onCharacters: (route: GameCharacterRoute) => void;
  disabled: boolean;
}) {
  const navigate = useNavigate();
  const blocker = useCharacterRouteBlockers(environmentId);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost-muted"
            disabled={disabled}
            aria-label={`First build options: characters from ${characterRouteLabel(characters)}`}
          />
        }
      >
        <SlidersHorizontalIcon aria-hidden />
        {/* The one choice it holds, named with its value, so the icon is never a riddle. */}
        Characters: {characterRouteLabel(characters)}
      </MenuTrigger>
      <MenuPopup align="start" className="w-72">
        <MenuGroup>
          <MenuGroupLabel>Make characters with</MenuGroupLabel>
          <MenuRadioGroup
            value={characters}
            onValueChange={(value: GameCharacterRoute) => onCharacters(value)}
          >
            {CHARACTER_ROUTES.map((option) => {
              const blocked = blocker(option.route);
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
        </MenuGroup>
        {blocker("generated") !== null ? (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => void navigate({ to: "/settings/general", hash: "art-providers" })}
            >
              Set up an art provider…
            </MenuItem>
          </>
        ) : null}
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

/** Every game as an even card, latest first: the pictures are the colour on the page. */
function ContinueShelf({
  covers,
  environmentId,
  onOpen,
}: {
  covers: ReadonlyArray<GameCover>;
  environmentId: EnvironmentId;
  onOpen: (cover: GameCover) => void;
}) {
  const canOpen = useAtomValue(gameEnvironment.open.permissionAtom(environmentId));
  const shown = covers.slice(0, SHELF_CARDS);
  return (
    <section aria-labelledby="games" className="@container flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Text variant="label" tone="muted" render={<h2 id="games" />}>
          Continue
        </Text>
        {canOpen ? <OpenGameLink /> : null}
      </div>
      <ul role="list" className="grid grid-cols-2 gap-x-5 gap-y-6 @xl:grid-cols-3">
        {shown.map((cover) => (
          <GameCard key={cover.game.projectId} cover={cover} onOpen={() => onOpen(cover)} />
        ))}
      </ul>
    </section>
  );
}

function GameCard({ cover, onOpen }: { cover: GameCover; onOpen: () => void }) {
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(false);
  const { status, build } = useGameLibraryLine({
    game: cover.game,
    main: cover.main,
    chats: cover.chats,
    read: leaseLiveStatus,
  });
  const name = useGameName(cover.game.environmentId, cover.game.projectId, cover.game.name);
  const picture = build?.still ?? cover.game.keyArt;
  // Before any build has a still, the frame the Stage last showed of this game, when it
  // played in this session: the game's own title, not a stand-in.
  const shown = useStageStill(
    cover.main === null
      ? ""
      : scopedThreadKey(scopeThreadRef(cover.main.environmentId, cover.main.id)),
  );
  return (
    <li className="min-w-0">
      <button
        ref={rowRef}
        type="button"
        onClick={onOpen}
        className="group flex w-full min-w-0 cursor-pointer flex-col gap-2.5 text-left outline-none"
      >
        <GamePicture
          environmentId={cover.game.environmentId}
          root={cover.game.root}
          path={picture}
          gameName={name}
          mark={shown === null ? "name" : "none"}
          className="aspect-video w-full rounded-xl ring-1 ring-border ring-inset transition-[box-shadow] group-hover:ring-foreground/25 group-focus-visible:ring-2 group-focus-visible:ring-ring"
        >
          {/* Without a picture yet, the Stage's last frame, else the game's name as a title
              card on its own colour. */}
          {picture === null && shown !== null ? (
            <img src={shown} alt="" className="absolute inset-0 size-full object-cover" />
          ) : null}
        </GamePicture>
        <span className="flex min-w-0 flex-col gap-0.5">
          <Text variant="label" tone="strong" truncate>
            {name}
          </Text>
          <GameLibraryStatusText status={status} />
          <CoverSummary build={build} status={status.text} />
        </span>
      </button>
    </li>
  );
}

/** What the latest build was asked to do, in the person's words. */
function CoverSummary({
  build,
  status,
}: {
  build: { readonly summary: string } | null;
  status: string;
}): ReactNode {
  const summary = build?.summary.trim() ?? "";
  // A build named by its summary already says it in the status line.
  if (summary.length === 0 || summary === status) return null;
  return (
    <Text variant="meta" tone="dim" truncate>
      {summary}
    </Text>
  );
}
