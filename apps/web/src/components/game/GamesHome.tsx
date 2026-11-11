import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@kurambit/client-runtime/environment";
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
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { ensureLocalApi } from "../../localApi";
import { useThreadShells, waitForThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { gameEnvironment } from "../../state/game";
import { useAtomCommand } from "../../state/use-atom-command";
import { KurambitMark } from "../brand/KurambitBrand";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import {
  gameMainThread,
  partitionGameChats,
  resolveGameSidebarStatus,
  useSidebarRowSubscriptionLease,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Text } from "../ui/text";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { GamePicture } from "./GameBuildStill";
import {
  CHARACTER_ROUTES,
  useCharacterRouteBlockers,
  useGeneratedRouteNote,
} from "./GameCharacterRoute";
import { showOpenGameDialog, useGameEntryStore } from "./gameEntryStore";
import { GameLibraryStatusText, useGameLibraryLine } from "./GameLibraryStatus";
import { draftGameName, gameSlug, sortGameThreadsByActivity } from "./gameLibrary.logic";
import { engineToolFor } from "./gameStageLogic";
import { GameToolLink } from "./GameToolLink";
import { useGameLibrary, useGameLibraryRefresh, type GameLibraryEntry } from "./useGameLibrary";
import { chooseEngine, useEngineReadiness } from "./useEngineReadiness";
import { useGameModelChoice } from "./useGameModelChoice";

// Short enough to sit on one line under the box with Open a game.
const BRIEF_IDEAS = ["A cozy fishing game at dusk", "A roguelike in a flooded cathedral"] as const;

const lastGameFolderSchema = Schema.String;

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
  const cards = games.map((game) => {
    const list = threadsByProject.get(game.projectId) ?? [];
    const chats = partitionGameChats(list, liveThreadIds);
    // A game opens on its main chat, as its sidebar row does.
    const main = chats.main ?? gameMainThread(list) ?? sortGameThreadsByActivity(list)[0] ?? null;
    return {
      game,
      main,
      chats: list.length === 0 ? null : resolveGameSidebarStatus(chats),
    } satisfies GameCover;
  });
  const openGame = (card: GameCover) => {
    if (card.main !== null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: card.main.environmentId, threadId: card.main.id },
      });
      return;
    }
    void handleNewThread(scopeProjectRef(card.game.environmentId, card.game.projectId));
  };
  const hasGames = !isLoading && cards.length > 0;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-14 px-6 pt-20 pb-16 lg:pt-28">
            {environmentId ? (
              <BriefBox environmentId={environmentId} hasGames={hasGames || isLoading} />
            ) : null}

            {error ? (
              <div className="flex w-full max-w-160 flex-col gap-1 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
                <Text variant="label" tone="destructive">
                  Could not load your games.
                </Text>
                <Text variant="meta" tone="muted">
                  {error}
                </Text>
              </div>
            ) : null}

            {isLoading ? (
              <GameCoversSkeleton />
            ) : hasGames ? (
              <section
                aria-labelledby="your-games"
                className="flex w-full max-w-205 flex-col gap-2.5"
              >
                <Text variant="meta" tone="muted" render={<h2 id="your-games" />}>
                  Your games
                </Text>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {cards.map((card) => (
                    <GameCoverCard
                      key={card.game.projectId}
                      card={card}
                      onOpen={() => openGame(card)}
                    />
                  ))}
                  {environmentId ? <OpenGameCard environmentId={environmentId} /> : null}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function OpenGameCard({ environmentId }: { environmentId: EnvironmentId }) {
  const canOpen = useAtomValue(gameEnvironment.open.permissionAtom(environmentId));
  if (!canOpen) return null;
  return (
    <button
      type="button"
      onClick={showOpenGameDialog}
      className="flex min-h-36 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
    >
      <FolderOpenIcon className="size-3.5" aria-hidden />
      <Text variant="meta" tone="inherit">
        Open a game
      </Text>
    </button>
  );
}

/** The new-game form: the brief, today's defaults as chips, and the name it will take. */
function BriefBox({
  environmentId,
  hasGames,
}: {
  environmentId: EnvironmentId;
  hasGames: boolean;
}) {
  const navigate = useNavigate();
  const choice = useGameModelChoice(environmentId);
  const canCreate = useAtomValue(gameEnvironment.create.permissionAtom(environmentId));
  const canOpen = useAtomValue(gameEnvironment.open.permissionAtom(environmentId));
  const create = useAtomCommand(gameEnvironment.create, { reportFailure: false });
  const refreshLibrary = useGameLibraryRefresh(environmentId);
  const { toolchain, ready: engineReady } = useEngineReadiness(environmentId);
  const routeBlocker = useCharacterRouteBlockers(environmentId);
  const generatedNote = useGeneratedRouteNote(environmentId);
  const [brief, setBrief] = useState("");
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [artOpen, setArtOpen] = useState(false);
  const [artDirection, setArtDirection] = useState("");
  const [characters, setCharacters] = useState<GameCharacterRoute>("library");
  const [chosenEngine, setEngine] = useState<GameEngineId | null>(null);
  const engine = chooseEngine(chosenEngine, engineReady);
  // The folder the person's last new game went in.
  const [parentFolder, setParentFolder] = useLocalStorage(
    `game-entry-parent-folder:${environmentId}`,
    "~/Games",
    lastGameFolderSchema,
  );
  const [editingFolder, setEditingFolder] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A request from New game anywhere: take its brief while rendering, focus once mounted.
  const request = useGameEntryStore((state) => state.boxRequest);
  const [seenRequest, setSeenRequest] = useState<number | null>(null);
  if (request !== null && request.id !== seenRequest) {
    setSeenRequest(request.id);
    if (request.brief !== null) {
      setBrief(request.brief);
      setNameOverride(null);
    }
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
  const nameField = nameOverride ?? draftGameName(trimmedBrief);
  const name = nameField.trim() || "Untitled Game";
  const parent = parentFolder.replace(/\/+$/, "");
  // Until the brief names the game, the chip shows where games go.
  const folder = trimmedBrief.length === 0 ? parent : `${parent}/${gameSlug(name) || "your-game"}`;
  const engineTool = toolchain === null ? null : engineToolFor(toolchain, engine);
  const ffmpeg = toolchain?.tools.find((tool) => tool.tool === "ffmpeg") ?? null;
  const canStart =
    canCreate &&
    choice.ready &&
    engineReady(engine) &&
    trimmedBrief.length > 0 &&
    parentFolder.trim().length > 0 &&
    !busy &&
    !pickingFolder;

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    const result = await create({
      environmentId,
      input: {
        name,
        parentDirectory: parentFolder.trim(),
        brief: trimmedBrief,
        artDirection: artDirection.trim(),
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
      .dialogs.pickFolder({ initialPath: parentFolder })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      });
    setPickingFolder(false);
    if (picked) setParentFolder(picked);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void start();
    }
  };

  const characterLabel =
    CHARACTER_ROUTES.find((option) => option.route === characters)?.label ?? "Library";

  return (
    <section className="flex w-full max-w-200 flex-col items-center gap-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <KurambitMark className="size-14" />
        {/* The one place Instrument Serif stays: the board keeps this headline as it is. */}
        <h1 className="font-display text-6xl leading-none tracking-tight text-balance text-strong-foreground">
          What are we making today?
        </h1>
        <Text variant="body" tone="muted" render={<p />}>
          Describe a game. Your agent builds a playable version in a few minutes, then you direct it
          build by build.
        </Text>
      </div>

      <div className="flex w-full flex-col gap-2 text-left">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
          className="flex w-full flex-col rounded-2xl border border-border bg-card shadow-lg/5 transition-colors focus-within:border-primary/50"
        >
          <label htmlFor="game-brief" className="sr-only">
            Game brief
          </label>
          <textarea
            id="game-brief"
            ref={textareaRef}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            disabled={busy}
            placeholder="A cozy fishing game on a floating island at dusk, with a day-night cycle and a rival fisher…"
            className="text-prompt w-full resize-none bg-transparent px-4 pt-3.5 outline-none placeholder:text-placeholder"
          />
          {artOpen ? (
            <div className="mx-3 flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Text variant="meta" tone="muted" render={<label htmlFor="game-art-direction" />}>
                  Art direction
                </Text>
                <textarea
                  id="game-art-direction"
                  value={artDirection}
                  onChange={(event) => setArtDirection(event.target.value)}
                  rows={2}
                  autoFocus
                  disabled={busy}
                  placeholder="Painterly low-poly, warm sunset light, chunky pixel art, no text on screen…"
                  className="text-body w-full resize-none bg-transparent outline-none placeholder:text-placeholder"
                />
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Remove the art direction"
                onClick={() => {
                  setArtOpen(false);
                  setArtDirection("");
                }}
              >
                <XIcon />
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-1 px-2.5 py-2.5">
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
            <Menu>
              <MenuTrigger
                render={<Button type="button" size="sm" variant="ghost-muted" disabled={busy} />}
              >
                <UserIcon aria-hidden />
                {characterLabel} characters
                <ChevronDownIcon aria-hidden className="size-3.5 opacity-60" />
              </MenuTrigger>
              <MenuPopup align="start" className="w-72">
                <MenuRadioGroup
                  value={characters}
                  onValueChange={(value: GameCharacterRoute) => setCharacters(value)}
                >
                  {CHARACTER_ROUTES.map((option) => {
                    const blocked = routeBlocker(option.route);
                    return (
                      <MenuRadioItem
                        key={option.route}
                        value={option.route}
                        disabled={blocked !== null}
                      >
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
                {routeBlocker("generated") !== null ? (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      onClick={() =>
                        void navigate({ to: "/settings/general", hash: "art-providers" })
                      }
                    >
                      Set up an art provider…
                    </MenuItem>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
            <Button
              type="button"
              size="sm"
              variant="ghost-muted"
              disabled={busy || pickingFolder}
              onClick={() => void chooseFolder()}
              className="min-w-0 max-w-44"
            >
              <FolderIcon aria-hidden />
              <span className="min-w-0 truncate">{pickingFolder ? "Choosing…" : folder}</span>
            </Button>
            {artOpen ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost-muted"
                disabled={busy}
                onClick={() => setArtOpen(true)}
              >
                <PlusIcon aria-hidden />
                Art direction
              </Button>
            )}
            <Button type="submit" className="ms-auto" disabled={!canStart}>
              {busy ? "Starting…" : "Start building"}
            </Button>
          </div>
        </form>

        {editingFolder ? (
          <div className="flex items-center gap-2 px-1">
            <Text variant="meta" tone="muted" render={<label htmlFor="game-parent-folder" />}>
              Games folder
            </Text>
            <Input
              id="game-parent-folder"
              value={parentFolder}
              onChange={(event) => setParentFolder(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "Escape") setEditingFolder(false);
              }}
              onBlur={() => setEditingFolder(false)}
              placeholder="~/Games"
              autoFocus
              size="sm"
              className="max-w-80"
            />
          </div>
        ) : null}

        {trimmedBrief.length > 0 ? (
          <div className="flex min-h-8 items-center gap-1.5 px-1">
            <Text variant="meta" tone="muted">
              Name:
            </Text>
            {editingName ? (
              <Input
                aria-label="Game name"
                value={nameField}
                maxLength={100}
                onChange={(event) => setNameOverride(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === "Escape") {
                    event.preventDefault();
                    setEditingName(false);
                  }
                }}
                onBlur={() => setEditingName(false)}
                autoFocus
                size="sm"
                className="max-w-80"
              />
            ) : (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={`Name: ${name}. Click to change it.`}
                onClick={() => setEditingName(true)}
              >
                {name}
              </Button>
            )}
            {editingName ? null : (
              <Text variant="meta" tone="dim">
                You can't rename it later.
              </Text>
            )}
          </div>
        ) : null}

        <BriefNotes
          notes={[
            error === null ? null : { text: error, tone: "destructive" },
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
            characters === "generated" && generatedNote !== null ? { text: generatedNote } : null,
          ]}
        />
      </div>

      {hasGames ? null : (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {BRIEF_IDEAS.map((idea) => (
            <Button
              key={idea}
              type="button"
              variant="outline"
              size="compact"
              onClick={() => {
                setBrief(idea);
                setNameOverride(null);
                textareaRef.current?.focus();
              }}
            >
              {idea}
            </Button>
          ))}
          {canOpen ? (
            <Button type="button" variant="ghost" size="compact" onClick={showOpenGameDialog}>
              <FolderOpenIcon aria-hidden />
              Open a game
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function BriefNotes({
  notes,
}: {
  notes: ReadonlyArray<{
    readonly text: string;
    readonly tone?: "destructive";
    readonly action?: ReactNode;
  } | null>;
}) {
  const shown = notes.filter((note) => note !== null);
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 px-1">
      {shown.map((note) => (
        <li key={note.text} className="flex flex-wrap items-center gap-2">
          <Text
            variant="meta"
            tone={note.tone ?? "muted"}
            render={<p className="whitespace-pre-wrap" role={note.tone ? "alert" : undefined} />}
          >
            {note.text}
          </Text>
          {note.action}
        </li>
      ))}
    </ul>
  );
}

type GameCover = {
  readonly game: GameLibraryEntry;
  readonly main: EnvironmentThreadShell | null;
  readonly chats: SidebarThreadStatus | null;
};

function GameCoverCard({ card, onOpen }: { card: GameCover; onOpen: () => void }) {
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(false);
  const { status, build } = useGameLibraryLine({
    game: card.game,
    main: card.main,
    chats: card.chats,
    read: leaseLiveStatus,
  });
  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onOpen}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-xl bg-card text-left ring-1 ring-border transition-[box-shadow] hover:ring-foreground/20"
    >
      <GamePicture
        environmentId={card.game.environmentId}
        root={card.game.root}
        path={build?.still ?? card.game.keyArt}
        gameName={card.game.name}
        className="aspect-[16/10] w-full"
      />
      <span className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
        <Text variant="label" tone="strong" truncate>
          {card.game.name}
        </Text>
        <GameLibraryStatusText status={status} />
      </span>
    </button>
  );
}

function GameCoversSkeleton() {
  return (
    <div className="grid w-full max-w-205 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex flex-col overflow-hidden rounded-xl bg-card">
          <div className="aspect-[16/10] bg-muted/60" />
          <div className="flex flex-col gap-1.5 p-2.5">
            <div className="h-3.5 w-2/3 rounded bg-muted" />
            <div className="h-3 w-1/2 rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}
