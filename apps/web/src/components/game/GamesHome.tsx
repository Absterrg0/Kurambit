import { scopeProjectRef } from "@kurambit/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ArrowRightIcon, ArrowUpRightIcon, FolderOpenIcon } from "lucide-react";

import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadShells } from "../../state/entities";
import type { EnvironmentThreadShell } from "@kurambit/client-runtime/state/models";
import { isNestedUnderLiveParent, type EnvironmentId, type GameSummary } from "@kurambit/contracts";
import { KurambitMark } from "../brand/KurambitBrand";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useGameDialogStore, type GameDraft } from "./gameDialogStore";
import {
  formatGameEditedAt,
  gameInitial,
  gamePigment,
  gameTemplateAppearance,
  newestThreadByProject,
} from "./gameLibrary.logic";
import { gameProgress } from "./gameProgress";
import { useGameLibrary } from "./useGameLibrary";

const BRIEF_IDEAS = [
  "A cozy fishing game on a floating island at dusk",
  "A top-down roguelike in a flooded cathedral",
  "A racing game with paper boats down a rainy street",
  "A puzzle platformer where shadows are solid",
] as const;

export function GamesHome() {
  const { games, isLoading, error } = useGameLibrary();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const liveThreadIds = new Set<string>(
    threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
  );
  const newestThreads = newestThreadByProject(
    threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        !isNestedUnderLiveParent(thread, liveThreadIds),
    ),
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
  const openGame = (card: GameCard) => {
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
  const openGameFolder = () => useGameDialogStore.getState().show("open");
  const startGame = (draft: GameDraft) => useGameDialogStore.getState().startCreate(draft);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-8 pt-24 pb-16 lg:pt-32">
            <BriefComposer onStart={startGame} onOpenFolder={openGameFolder} />

            {error ? (
              <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-1 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
                <p className="text-sm text-destructive-foreground">Could not load your games.</p>
                <p className="text-xs text-muted-foreground">{error}</p>
              </div>
            ) : null}

            {isLoading ? (
              <GameGridSkeleton />
            ) : cards.length === 0 ? null : (
              <section aria-labelledby="your-games" className="flex flex-col gap-5">
                <div className="flex items-baseline justify-between gap-4">
                  <h2 id="your-games" className="font-display text-3xl">
                    Your games
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    {cards.length} {cards.length === 1 ? "game" : "games"} on this machine
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
                  {cards.map((card) => (
                    <GameCard key={card.game.projectId} card={card} onOpen={() => openGame(card)} />
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function BriefComposer({
  onStart,
  onOpenFolder,
}: {
  onStart: (draft: GameDraft) => void;
  onOpenFolder: () => void;
}) {
  const [brief, setBrief] = useState("");
  const [engine, setEngine] = useState<GameDraft["engine"]>("godot");
  const ready = brief.trim().length > 0;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (ready) onStart({ brief: brief.trim(), engine });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-8 text-center">
      <div className="flex flex-col items-center gap-4">
        <KurambitMark className="size-14" />
        <h1 className="font-display text-6xl leading-none tracking-tight text-balance">
          What are we making today?
        </h1>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground text-balance">
          Describe a game in a sentence or two. Your agent builds it, plays every build, and keeps
          only the changes that make it better.
        </p>
      </div>

      <form
        onSubmit={submit}
        className="group flex w-full flex-col gap-3 rounded-2xl border border-border bg-card p-3 text-left shadow-lg/5 transition-colors focus-within:border-primary/50"
      >
        <label htmlFor="game-brief" className="sr-only">
          Game brief
        </label>
        <textarea
          id="game-brief"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="A cozy fishing game on a floating island at dusk, with a day-night cycle and a rival fisher…"
          className="w-full resize-none bg-transparent px-2 pt-1.5 text-base leading-relaxed outline-none placeholder:text-placeholder"
        />
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label="Engine"
            variant="segmented"
            value={[engine]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "godot" || next === "three" || next === "unity") setEngine(next);
            }}
          >
            <Toggle value="godot">Godot · native</Toggle>
            <Toggle value="three">three.js · browser</Toggle>
            <Toggle value="unity">Unity · native</Toggle>
          </ToggleGroup>
          <Button type="button" variant="ghost" size="sm" onClick={onOpenFolder}>
            <FolderOpenIcon aria-hidden />
            Open a game
          </Button>
          <Button type="submit" className="ms-auto" disabled={!ready}>
            Start building
            <ArrowRightIcon aria-hidden />
          </Button>
        </div>
      </form>

      <div className="flex flex-wrap justify-center gap-2">
        {BRIEF_IDEAS.map((idea) => (
          <Button
            key={idea}
            type="button"
            variant="outline"
            size="compact"
            onClick={() => setBrief(idea)}
          >
            {idea}
          </Button>
        ))}
      </div>
    </section>
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

function GameGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex flex-col overflow-hidden rounded-2xl border border-border">
          <div className="aspect-[16/9] bg-muted/60" />
          <div className="flex flex-col gap-2 p-4">
            <div className="h-4 w-2/3 rounded bg-muted" />
            <div className="h-3 w-1/2 rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

function GameCard({ card, onOpen }: { card: GameCard; onOpen: () => void }) {
  const appearance = gameTemplateAppearance(card.game.template);
  const initial = gameInitial(card.game.name);
  const progress = gameProgress(card.game);
  const [pigment, ink] = gamePigment(card.game.name);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-border bg-card text-left transition-[border-color,box-shadow,translate] hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-xl/10"
    >
      <span
        className="relative block aspect-[16/9] overflow-hidden"
        style={{ background: `radial-gradient(120% 95% at 18% 8%, ${pigment}, ${ink})` }}
      >
        <span aria-hidden className="surface-grain absolute inset-0 mix-blend-overlay" />
        <span
          aria-hidden
          className="absolute -right-2 -bottom-7 font-display text-9xl leading-none text-washi/85 transition-transform duration-300 group-hover:-translate-y-1"
        >
          {initial}
        </span>
        {progress.kind === "building" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="absolute left-3 top-3 rounded-full border border-washi/20 bg-sumi/60 px-2 py-0.5 text-2xs font-medium text-washi shadow-sm backdrop-blur-sm" />
              }
            >
              {progress.label}
            </TooltipTrigger>
            <TooltipPopup>{progress.detail}</TooltipPopup>
          </Tooltip>
        ) : null}
        <span className="absolute bottom-3 left-3 rounded-full bg-sumi/50 px-2 py-0.5 text-2xs font-medium text-washi/90 backdrop-blur-sm">
          {appearance.label}
        </span>
      </span>
      <span className="flex items-center justify-between gap-3 px-4 py-3.5">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-sm">{card.game.name}</span>
          <span className="text-xs text-muted-foreground">
            {formatGameEditedAt(gameActivityTimestamp(card))}
          </span>
        </span>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-foreground">
          <ArrowUpRightIcon className="size-4" aria-hidden />
        </span>
      </span>
    </button>
  );
}
