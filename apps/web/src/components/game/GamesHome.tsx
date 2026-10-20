import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  FolderOpenIcon,
  Gamepad2Icon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";

import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useAssetUrls } from "../../assets/assetUrls";
import { useThreadShells } from "../../state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, GameSummary, GameTemplateId } from "@t3tools/contracts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useGameDialogStore } from "./gameDialogStore";
import {
  formatGameEditedAt,
  gameInitial,
  gameTemplateAppearance,
  newestThreadByProject,
} from "./gameLibrary.logic";
import { TemplatePreview } from "./TemplatePreview";
import { useGameLibrary } from "./useGameLibrary";

export function GamesHome() {
  const { games, environmentId, isLoading, error } = useGameLibrary();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const newestThreads = newestThreadByProject(
    threads.filter((thread) => thread.archivedAt === null && thread.deletedAt === null),
  );
  const cards = games.map((game) => ({
    game,
    latestThread: newestThreads.get(game.projectId) ?? null,
  }));
  const openGame = (card: (typeof cards)[number]) => {
    if (card.latestThread !== null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: card.latestThread.environmentId,
          threadId: card.latestThread.id,
        },
      });
      return;
    }
    void handleNewThread(scopeProjectRef(card.game.environmentId, card.game.projectId));
  };
  const newGame = () => useGameDialogStore.getState().show("create");
  const openGameFolder = () => useGameDialogStore.getState().show("open");

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[86rem] flex-col gap-8 px-8 py-8">
            <header className="flex flex-wrap items-end justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Gamepad2Icon className="size-3.5" aria-hidden />
                  Game Studio
                </span>
                <h1 className="text-2xl font-semibold tracking-tight">Your games</h1>
                <p className="max-w-xl text-sm text-muted-foreground">
                  {games.length === 0
                    ? "Describe a game and your agent designs and builds it with Blender and Godot."
                    : `${games.length} ${games.length === 1 ? "game" : "games"} on this machine. Open one to keep making it, or start something new.`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" onClick={openGameFolder}>
                  <FolderOpenIcon aria-hidden />
                  Open game
                </Button>
                <Button onClick={newGame}>
                  <PlusIcon aria-hidden />
                  New game
                </Button>
              </div>
            </header>

            {error ? (
              <div className="flex flex-col items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
                <p className="text-sm text-destructive-foreground">Could not load your games.</p>
                <p className="text-xs text-muted-foreground">{error}</p>
              </div>
            ) : null}

            {isLoading ? (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card"
                  >
                    <div className="aspect-[16/10] bg-muted/60" />
                    <div className="flex flex-col gap-2 p-4">
                      <div className="h-4 w-2/3 rounded bg-muted" />
                      <div className="h-3 w-1/2 rounded bg-muted/70" />
                    </div>
                  </div>
                ))}
              </div>
            ) : cards.length === 0 ? (
              <GamesEmptyState onNewGame={newGame} onOpenGame={openGameFolder} />
            ) : environmentId === null ? null : (
              <GameGrid
                environmentId={environmentId}
                cards={cards}
                onOpen={openGame}
                onNewGame={newGame}
              />
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

type GameCard = {
  readonly game: GameSummary & { readonly environmentId: EnvironmentId };
  readonly latestThread: EnvironmentThreadShell | null;
};

function GameGrid({
  environmentId,
  cards,
  onOpen,
  onNewGame,
}: {
  environmentId: EnvironmentId;
  cards: readonly GameCard[];
  onOpen: (card: GameCard) => void;
  onNewGame: () => void;
}) {
  const resources = cards.flatMap((card) =>
    card.game.coverImagePath !== null && card.latestThread !== null
      ? [
          {
            _tag: "workspace-file" as const,
            threadId: card.latestThread.id,
            path: card.game.coverImagePath,
          },
        ]
      : [],
  );
  const urls = useAssetUrls(environmentId, resources);
  const coverUrlByGame = new Map<string, string | null>();
  let urlIndex = 0;
  for (const card of cards) {
    if (card.game.coverImagePath !== null && card.latestThread !== null) {
      coverUrlByGame.set(card.game.projectId, urls[urlIndex] ?? null);
      urlIndex += 1;
    }
  }
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((card) => (
        <GameCard
          key={card.game.projectId}
          card={card}
          coverUrl={coverUrlByGame.get(card.game.projectId) ?? null}
          onOpen={() => onOpen(card)}
        />
      ))}
      <button
        type="button"
        onClick={onNewGame}
        className="group flex min-h-56 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-card/40 p-6 text-center transition-colors hover:border-foreground/25 hover:bg-accent/40"
      >
        <span className="flex size-11 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors group-hover:text-foreground">
          <PlusIcon className="size-5" aria-hidden />
        </span>
        <span className="font-medium text-sm">New game</span>
        <span className="text-xs text-muted-foreground">Start from a real, playable template</span>
      </button>
    </div>
  );
}

function GameCard({
  card,
  coverUrl,
  onOpen,
}: {
  card: GameCard;
  coverUrl: string | null;
  onOpen: () => void;
}) {
  const appearance = gameTemplateAppearance(card.game.template);
  const initial = gameInitial(card.game.name);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-border bg-card text-left shadow-xs transition-[border-color,box-shadow,transform] hover:border-foreground/20 hover:shadow-md"
    >
      <span className="relative block aspect-[16/10] overflow-hidden bg-muted">
        {coverUrl !== null ? (
          <img
            src={coverUrl}
            alt={`${card.game.name} cover`}
            loading="lazy"
            decoding="async"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.015] motion-reduce:transition-none"
          />
        ) : card.game.template !== null ? (
          <TemplatePreview template={card.game.template} />
        ) : (
          <span
            aria-hidden
            className={`flex size-full items-center justify-center bg-gradient-to-br ${appearance.coverClassName}`}
          >
            <span
              className={`flex size-14 items-center justify-center rounded-2xl text-lg font-semibold ${appearance.initialClassName}`}
            >
              {initial}
            </span>
          </span>
        )}
        <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-black/0 to-black/0" />
        {card.game.designStatus === "draft" ? (
          <Badge variant="warning" className="absolute left-3 top-3 shadow-sm">
            Design draft
          </Badge>
        ) : null}
        <span className="absolute bottom-3 left-3 flex items-center gap-1.5 text-2xs font-medium text-white/90 drop-shadow">
          <Gamepad2Icon className="size-3.5" aria-hidden />
          {appearance.label}
        </span>
      </span>
      <span className="flex flex-col gap-1 p-4">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate font-medium text-sm">{card.game.name}</span>
          <ArrowUpRightIcon
            className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          />
        </span>
        <span className="text-xs text-muted-foreground">
          {appearance.label} · {formatGameEditedAt(card.game.updatedAt)}
        </span>
      </span>
    </button>
  );
}

function GamesEmptyState({
  onNewGame,
  onOpenGame,
}: {
  onNewGame: () => void;
  onOpenGame: () => void;
}) {
  const starters: readonly GameTemplateId[] = ["3d-explorer", "2d-platformer"];
  return (
    <div className="grid items-center gap-10 py-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:py-10">
      <div className="flex min-w-0 flex-col items-start gap-4">
        <Badge variant="outline" className="gap-1.5">
          <SparklesIcon className="size-3" aria-hidden />
          Your first game is one sentence away
        </Badge>
        <h2 className="max-w-md text-3xl font-semibold tracking-tight text-balance">
          Describe it. Your agent builds it. Then you play it.
        </h2>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          Game Studio turns a brief into a real Godot project with Blender-made art. Approve the
          design, watch the agent work, and play every revision right here.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" onClick={onNewGame}>
            <PlusIcon aria-hidden />
            New game
          </Button>
          <Button size="lg" variant="ghost" onClick={onOpenGame}>
            <FolderOpenIcon aria-hidden />
            Open a game folder
          </Button>
        </div>
        <ol className="mt-2 flex flex-col gap-2 text-sm text-muted-foreground">
          {[
            "Pick a playable starter and describe your idea.",
            "Review the design draft, then approve the build.",
            "Play, ask for changes, and export when it feels right.",
          ].map((item, index) => (
            <li key={item} className="flex items-start gap-2.5">
              <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-2xs font-medium text-foreground">
                {index + 1}
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {starters.map((template) => {
          const appearance = gameTemplateAppearance(template);
          return (
            <button
              key={template}
              type="button"
              onClick={onNewGame}
              className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-border bg-card text-left shadow-xs transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-md"
            >
              <span className="block aspect-video overflow-hidden border-b border-border bg-muted">
                <TemplatePreview template={template} />
              </span>
              <span className="flex flex-col gap-1 p-3.5">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">{appearance.label}</span>
                  <ArrowUpRightIcon
                    className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden
                  />
                </span>
                <span className="text-xs leading-snug text-muted-foreground">
                  {template === "3d-explorer"
                    ? "Explore, collect, and reach the goal in a fully playable 3D level."
                    : "Run, jump, stomp slimes, and collect every coin under a starry sky."}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
