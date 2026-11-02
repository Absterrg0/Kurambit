import { scopeProjectRef } from "@kurambit/client-runtime/environment";
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
import { useThreadShells } from "../../state/entities";
import type { EnvironmentThreadShell } from "@kurambit/client-runtime/state/models";
import type { EnvironmentId, GameSummary } from "@kurambit/contracts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useGameDialogStore } from "./gameDialogStore";
import {
  formatGameEditedAt,
  gameInitial,
  gameTemplateAppearance,
  newestThreadByProject,
} from "./gameLibrary.logic";
import { gameProgress } from "./gameProgress";
import { useGameLibrary } from "./useGameLibrary";

export function GamesHome() {
  const { games, environmentId, isLoading, error } = useGameLibrary();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const newestThreads = newestThreadByProject(
    threads.filter((thread) => thread.archivedAt === null && thread.deletedAt === null),
  );
  const cards = games
    .map((game) => ({
      game,
      latestThread: newestThreads.get(game.projectId) ?? null,
    }))
    .sort(
      (left, right) =>
        gameActivityMs(right) - gameActivityMs(left) ||
        left.game.name.localeCompare(right.game.name),
    );
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
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="mx-auto flex w-full max-w-[86rem] flex-col gap-8 px-8 py-8">
            <header className="flex flex-wrap items-end justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Gamepad2Icon className="size-3.5" aria-hidden />
                  Kurambit
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
                <Button onClick={() => newGame()}>
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
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
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

const gameActivityTimestamp = (card: GameCard): string => {
  if (
    card.latestThread !== null &&
    Date.parse(card.latestThread.updatedAt) > Date.parse(card.game.updatedAt)
  )
    return card.latestThread.updatedAt;
  return card.game.updatedAt;
};

const gameActivityMs = (card: GameCard): number => {
  const time = Date.parse(gameActivityTimestamp(card));
  return Number.isNaN(time) ? 0 : time;
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
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <GameCard key={card.game.projectId} card={card} onOpen={() => onOpen(card)} />
      ))}
      <button
        type="button"
        onClick={() => onNewGame()}
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

function GameCard({ card, onOpen }: { card: GameCard; onOpen: () => void }) {
  const appearance = gameTemplateAppearance(card.game.template);
  const initial = gameInitial(card.game.name);
  const progress = gameProgress(card.game);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-border bg-card text-left shadow-xs transition-[border-color,box-shadow,transform] hover:border-foreground/20 hover:shadow-md"
    >
      <span className="relative block aspect-[16/10] overflow-hidden bg-muted">
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
        <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-black/0 to-black/0" />
        {progress.kind === "building" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="absolute left-3 top-3 rounded-full border border-info/40 bg-black/60 px-2 py-0.5 text-2xs font-medium text-stage-foreground shadow-sm backdrop-blur-sm" />
              }
            >
              {progress.label}
            </TooltipTrigger>
            <TooltipPopup>{progress.detail}</TooltipPopup>
          </Tooltip>
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
          {appearance.label} · {formatGameEditedAt(gameActivityTimestamp(card))}
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
  return (
    <div className="grid items-center gap-10 py-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:py-10">
      <div className="flex min-w-0 flex-col items-start gap-4">
        <Badge variant="outline">
          <SparklesIcon className="size-3" aria-hidden />
          Your first game is one sentence away
        </Badge>
        <h2 className="max-w-md text-3xl font-semibold tracking-tight text-balance">
          Describe it. Your agent builds it. Then you play it.
        </h2>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          Kurambit turns a brief into a real game — a Godot native project with Blender-made art, or
          a quick three.js browser game. Watch the agent work, and play every revision right here.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" onClick={() => onNewGame()}>
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
            "Describe your game in a few sentences.",
            "Start a production run and watch the agent build.",
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
      <div className="hidden items-center justify-center lg:flex">
        <span className="flex size-40 items-center justify-center rounded-3xl bg-gradient-to-br from-stage-subtle/20 via-stage-muted/10 to-transparent">
          <Gamepad2Icon className="size-16 text-muted-foreground" aria-hidden />
        </span>
      </div>
    </div>
  );
}
