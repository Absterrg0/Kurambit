import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  ArrowLeftIcon,
  ColumnsIcon,
  GitCompareIcon,
  HistoryIcon,
  PlayIcon,
  RefreshCwIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  GameBuildId,
  type GameBuild,
  type GameBuildPlayResult,
  type GameBuildRef,
  type GameBuildsResult,
  type GameViewport,
  type ScopedThreadRef,
} from "@kurambit/contracts";

import type { GameBuildRequest } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { gameEnvironment, olderBuildPages, setStagePlayTarget } from "../../state/game";
import { useThreadCheckpointSummaries } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { GameBuildFactChips, GameBuildFactsDiff, GameBuildFactsList } from "./GameBuildFacts";
import { GameFrame, GameFrameBox } from "./GamePlaySurface";
import { buildName, buildSourceLabel, formatBuildTime, restoreLine } from "./gameBuilds.logic";
import {
  restoreQuestion,
  useBuildPlay,
  useBuildRestore,
  useMeasureOnOpen,
} from "./useBuildActions";

const isBuildId = Schema.is(GameBuildId);

type Selection =
  | { readonly kind: "now" }
  | { readonly kind: "build"; readonly build: GameBuild }
  | { readonly kind: "ref"; readonly ref: GameBuildRef };

const refOf = (build: GameBuild): GameBuildRef => ({ _tag: "build", build: build.id });
const sameRef = (a: GameBuildRef, b: GameBuildRef) =>
  a._tag === "build" && b._tag === "build"
    ? a.build === b.build
    : a._tag === "turn" && b._tag === "turn" && a.threadId === b.threadId && a.runId === b.runId;

/**
 * The Builds tab: every build of the game newest first, one build's detail
 * (what changed, its facts, Play, Compare, Restore), and a compare of two.
 * "Now", the folder itself, holds the folder's exports.
 */
export function GameBuildsView({
  threadRef,
  compact,
  writer,
  turnRunning,
  runActive,
  viewport,
  gameName,
  request,
  hidden,
  exports,
  onShowStage,
}: {
  threadRef: ScopedThreadRef;
  compact: boolean;
  /** This view may change the folder (not a run's role thread). */
  writer: boolean;
  turnRunning: boolean;
  runActive: boolean;
  viewport: GameViewport;
  gameName: string;
  /** What another surface asked the tab to open; read once, when the view mounts. */
  request: { readonly build?: GameBuildRequest } | null;
  /** Another tab is open: the view stays mounted, its games paused. */
  hidden: boolean;
  exports: ReactNode;
  onShowStage: () => void;
}) {
  const first = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  // A request (an "Open build" link, the palette) opens the tab on it: the stage
  // remounts this view for each one, so it is read once, at mount.
  const asked = request?.build;
  const [selection, setSelection] = useState<Selection>(() =>
    asked !== undefined && "open" in asked ? { kind: "ref", ref: asked.open } : { kind: "now" },
  );
  const [compare, setCompare] = useState<readonly [GameBuildRef, GameBuildRef] | null>(() =>
    asked !== undefined && "compare" in asked && asked.compare !== "pick" ? asked.compare : null,
  );
  // The build A of a compare waiting for the rail click that picks B.
  const [picking, setPicking] = useState<GameBuildRef | "any" | null>(() =>
    asked !== undefined && "compare" in asked && asked.compare === "pick" ? "any" : null,
  );
  const [olderCount, setOlderCount] = useState(0);
  // A compact workbench shows the list or one detail, never both.
  const [compactDetail, setCompactDetail] = useState(
    () => asked !== undefined && !("compare" in asked && asked.compare === "pick"),
  );
  const list = first.data;
  const olderPages = useAtomValue(olderBuildPages(threadRef, olderCount));
  // Every loaded row, first page and older pages together, each build once.
  const seen = new Set<string>();
  const loaded: Array<GameBuild> = [];
  for (const build of [
    ...(list?.builds ?? []),
    ...olderPages.flatMap((page) => (AsyncResult.isSuccess(page) ? page.value.builds : [])),
  ])
    if (!seen.has(build.id)) {
      seen.add(build.id);
      loaded.push(build);
    }
  const lastPage = olderPages.at(-1);
  const olderNext =
    olderCount === 0
      ? (list?.next ?? null)
      : lastPage !== undefined && AsyncResult.isSuccess(lastPage)
        ? lastPage.value.next
        : null;
  const olderWaiting = lastPage !== undefined && !AsyncResult.isSuccess(lastPage);
  // The tab shown again rereads the list: the folder may have changed without a push.
  const wasHidden = useRef(hidden);
  const refreshList = first.refresh;
  useEffect(() => {
    const before = wasHidden.current;
    wasHidden.current = hidden;
    if (before && !hidden) refreshList();
  }, [hidden, refreshList]);
  // A requested build by id is a loaded row once the list holds it.
  if (selection.kind === "ref" && selection.ref._tag === "build") {
    const id = selection.ref.build;
    const found = loaded.find((build) => build.id === id);
    if (found !== undefined) setSelection({ kind: "build", build: found });
  }
  // Opening a build (a row, a link, the palette) mounts its detail, which
  // measures it once if it never was; hovering or focusing never does.
  const open = (build: GameBuild) => {
    if (picking !== null) {
      if (picking === "any") setPicking(refOf(build));
      else if (!sameRef(picking, refOf(build))) {
        setCompare([picking, refOf(build)]);
        setPicking(null);
        setCompactDetail(true);
      }
      return;
    }
    setSelection({ kind: "build", build });
    setCompare(null);
    setCompactDetail(true);
  };
  // The latest loaded copy of the open build: its play and restore answers can change.
  const fresh = (build: GameBuild) => loaded.find((entry) => entry.id === build.id) ?? build;
  const startCompare = (a: GameBuildRef, b: GameBuildRef | null) => {
    if (b === null) setPicking(a);
    else {
      setCompare([a, b]);
      setPicking(null);
    }
  };
  const showRail = !compact || picking !== null || !compactDetail;
  const showDetail = !compact || (picking === null && compactDetail);

  const detail =
    compare !== null ? (
      // Hidden, the compare unmounts: no game of it keeps running behind another tab.
      hidden ? null : (
        <GameBuildCompare
          threadRef={threadRef}
          pair={compare}
          viewport={viewport}
          gameName={gameName}
          compact={compact}
          onClose={() => setCompare(null)}
        />
      )
    ) : selection.kind === "build" ? (
      <GameBuildDetail
        key={selection.build.id}
        threadRef={threadRef}
        build={fresh(selection.build)}
        list={list}
        loaded={loaded}
        writer={writer}
        turnRunning={turnRunning}
        runActive={runActive}
        onCompare={(b) => startCompare(refOf(selection.build), b)}
        onShowStage={onShowStage}
      />
    ) : selection.kind === "ref" ? (
      <GameBuildRefDetail
        threadRef={threadRef}
        buildRef={selection.ref}
        loaded={loaded}
        onOpen={open}
      />
    ) : (
      <div className="space-y-3">
        <FolderLine list={list} />
        {exports}
      </div>
    );

  return (
    <div aria-hidden={hidden} className={hidden ? "hidden" : "flex min-h-0 flex-1"}>
      {showRail ? (
        <nav
          aria-label="Builds"
          className={cn(
            "flex min-h-0 flex-col overflow-y-auto border-border",
            compact ? "flex-1" : "w-72 shrink-0 border-r",
          )}
        >
          {picking !== null ? (
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
              <GitCompareIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                {picking === "any"
                  ? "Pick the first build to compare."
                  : "Pick the build to compare it with."}
              </span>
              <Button
                size="icon-micro"
                variant="ghost"
                aria-label="Stop picking"
                onClick={() => setPicking(null)}
              >
                <XIcon className="size-3" aria-hidden="true" />
              </Button>
            </div>
          ) : null}
          <button
            type="button"
            data-game-build-row="now"
            aria-current={selection.kind === "now" && compare === null ? "true" : undefined}
            className={cn(
              "border-b border-border px-3 py-2.5 text-left hover:bg-accent/50",
              selection.kind === "now" && compare === null && "bg-accent/60",
            )}
            onClick={() => {
              setSelection({ kind: "now" });
              setCompare(null);
              setPicking(null);
              setCompactDetail(true);
            }}
          >
            <span className="block text-xs font-medium">Now: the game folder</span>
            <span className="block text-2xs text-muted-foreground">
              <FolderState list={list} />
            </span>
          </button>
          {list?.restore != null ? (
            <RestoreLine
              threadRef={threadRef}
              list={list}
              writer={writer}
              runActive={runActive}
              turnRunning={turnRunning}
            />
          ) : null}
          {list === null ? (
            <p className="px-3 py-3 text-2xs text-muted-foreground">
              {first.error ?? "Reading the builds…"}
            </p>
          ) : list.builds.length === 0 ? (
            <p className="px-3 py-3 text-2xs text-muted-foreground">
              No builds yet. Every agent turn that changes the game becomes one.
            </p>
          ) : (
            <BuildRows
              builds={list.builds}
              current={list.current}
              selected={selection.kind === "build" && compare === null ? selection.build.id : null}
              onOpen={open}
            />
          )}
          {olderPages.map((page, index) =>
            AsyncResult.isSuccess(page) ? (
              <BuildRows
                // oxlint-disable-next-line react/no-array-index-key -- pages only grow at the end
                key={index}
                builds={page.value.builds}
                current={list?.current ?? null}
                selected={
                  selection.kind === "build" && compare === null ? selection.build.id : null
                }
                onOpen={open}
              />
            ) : null,
          )}
          {olderWaiting ? (
            <p className="px-3 py-2 text-2xs text-muted-foreground">
              {lastPage !== undefined && AsyncResult.isFailure(lastPage)
                ? "Older builds could not be read."
                : "Reading older builds…"}
            </p>
          ) : olderNext !== null ? (
            <Button
              size="xs"
              variant="ghost"
              className="m-2 self-start"
              onClick={() => setOlderCount(olderCount + 1)}
            >
              Show older
            </Button>
          ) : null}
        </nav>
      ) : null}
      {showDetail ? (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4">
          {compact ? (
            <Button
              size="xs"
              variant="ghost"
              className="mb-2 self-start"
              onClick={() => setCompactDetail(false)}
            >
              <ArrowLeftIcon aria-hidden="true" />
              All builds
            </Button>
          ) : null}
          {detail}
        </section>
      ) : null}
    </div>
  );
}

function BuildRows({
  builds,
  current,
  selected,
  onOpen,
}: {
  builds: ReadonlyArray<GameBuild>;
  current: GameBuildsResult["current"];
  selected: string | null;
  onOpen: (build: GameBuild) => void;
}) {
  return (
    <ul>
      {builds.map((build) => (
        <li key={build.id} className="border-b border-border">
          <button
            type="button"
            data-game-build-row={build.id}
            aria-current={selected === build.id ? "true" : undefined}
            className={cn(
              "flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-accent/50",
              selected === build.id && "bg-accent/60",
              !build.available && "opacity-70",
            )}
            onClick={() => onOpen(build)}
          >
            <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
              {current === build.id ? (
                <>
                  <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
                  <span className="sr-only">The folder's build.</span>
                </>
              ) : null}
              <span className="shrink-0">{formatBuildTime(build.at)}</span>
              <span className="min-w-0 truncate">· {buildSourceLabel(build.source)}</span>
            </span>
            <span className="line-clamp-2 text-xs">{build.summary}</span>
            {build.fileCount !== null || !build.available ? (
              <span className="text-2xs text-muted-foreground">
                {build.fileCount === null
                  ? ""
                  : build.fileCount === 1
                    ? "1 file"
                    : `${build.fileCount} files`}
                {build.available ? "" : `${build.fileCount === null ? "" : " · "}history only`}
              </span>
            ) : null}
            <GameBuildFactChips summary={build.facts} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function FolderState({ list }: { list: GameBuildsResult | null }) {
  if (list === null) return <>…</>;
  const current = list.builds.find((build) => build.id === list.current);
  const name = current === undefined ? "an earlier build" : buildName(current);
  if (list.current === null) return <>Not saved as a build yet</>;
  return list.folderEdited === true ? (
    <>Edited since {name}</>
  ) : list.folderEdited === false ? (
    <>Same as {name}</>
  ) : (
    <>Made from {name}</>
  );
}

function FolderLine({ list }: { list: GameBuildsResult | null }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium">The game folder</h3>
      <p className="text-xs text-muted-foreground">
        <FolderState list={list} />. Play, Rebuild and the exports below work on the folder; earlier
        builds play from a copy and never change it.
      </p>
    </div>
  );
}

/** The game's latest restore, whoever asked for it, with its undo while one is offered. */
function RestoreLine({
  threadRef,
  list,
  writer,
  runActive,
  turnRunning,
}: {
  threadRef: ScopedThreadRef;
  list: GameBuildsResult;
  writer: boolean;
  runActive: boolean;
  turnRunning: boolean;
}) {
  const latest = list.restore;
  const restores = useBuildRestore(threadRef, latest);
  if (latest === null) return null;
  const undo = latest.outcome?.restored === true ? latest.undo : null;
  return (
    <div
      className={cn(
        "space-y-1 border-b border-border px-3 py-2 text-2xs",
        latest.outcome?.restored === false
          ? "text-destructive-foreground"
          : "text-muted-foreground",
      )}
      role={latest.outcome?.restored === false ? "alert" : undefined}
    >
      <p className="flex items-center gap-1.5">
        <HistoryIcon className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{restoreLine(latest)}</span>
      </p>
      {undo !== null && writer ? (
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={!restores.canRestore || restores.pending || runActive || turnRunning}
            onClick={() =>
              void restores.send(
                undo,
                `Undo the restore of ${latest.label}?\nThe folder goes back to what it held before it; what it holds now is saved as a build first.`,
              )
            }
          >
            <Undo2Icon aria-hidden="true" />
            {restores.restoring(undo) ? "Undoing…" : "Undo this restore"}
          </Button>
          {runActive || turnRunning ? (
            <p>
              {runActive
                ? "Stop the run to undo; while it is live, steer it."
                : "Wait for the agent's turn to end to undo."}
            </p>
          ) : null}
          {restores.error(undo) ? (
            <p role="alert" className="text-destructive-foreground">
              {restores.error(undo)}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * A build named by a link (a chat turn's, a round's), resolved through its
 * facts to a loaded row and opened like a row click, so it measures the same way.
 */
function GameBuildRefDetail({
  threadRef,
  buildRef,
  loaded,
  onOpen,
}: {
  threadRef: ScopedThreadRef;
  buildRef: GameBuildRef;
  loaded: ReadonlyArray<GameBuild>;
  onOpen: (build: GameBuild) => void;
}) {
  const facts = useEnvironmentQuery(
    gameEnvironment.buildFacts({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, build: buildRef },
    }),
  );
  const id = facts.data?.build ?? null;
  const found = id === null ? undefined : loaded.find((build) => build.id === id);
  useEffect(() => {
    if (found !== undefined) onOpen(found);
  }, [found, onOpen]);
  return (
    <p className="text-xs text-muted-foreground">
      {facts.error ??
        (id === null
          ? "Finding the build…"
          : found === undefined
            ? "This build is older than the list shows; Show older reaches it."
            : "Opening the build…")}
    </p>
  );
}

function GameBuildDetail({
  threadRef,
  build,
  list,
  loaded,
  writer,
  turnRunning,
  runActive,
  onCompare,
  onShowStage,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult | null;
  /** Every loaded row, older pages too. */
  loaded: ReadonlyArray<GameBuild>;
  writer: boolean;
  turnRunning: boolean;
  runActive: boolean;
  onCompare: (b: GameBuildRef | null) => void;
  onShowStage: () => void;
}) {
  const facts = useEnvironmentQuery(
    build.available
      ? gameEnvironment.buildFacts({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, build: refOf(build) },
        })
      : null,
  );
  const plays = useBuildPlay(threadRef);
  const restores = useBuildRestore(threadRef, list?.restore ?? null);
  const measure = useMeasureOnOpen(threadRef);
  // Opened, by a row or a link: a build that never was measured is, once.
  const neverMeasured = build.available && build.facts.state === "never";
  const sendMeasure = measure.send;
  useEffect(() => {
    if (neverMeasured) void sendMeasure(build.id);
  }, [neverMeasured, build.id, sendMeasure]);
  const [windowMessage, setWindowMessage] = useState<string | null>(null);
  const ref = refOf(build);
  const isCurrent = list?.current === build.id && list.folderEdited === false;
  const play = async () => {
    const result = await plays.send(ref);
    if (result === null) return;
    if (result._tag === "web") {
      setStagePlayTarget(threadRef, { build: build.id, label: buildName(build), result });
      onShowStage();
    } else setWindowMessage(result.message);
  };
  // The server stays authoritative; these say why before the person presses.
  const restoreBlocked =
    build.noRestore ??
    (!writer
      ? "Only the game's own chat can go back to a build."
      : runActive
        ? "Stop the run to go back; while it is live, steer it."
        : turnRunning
          ? "Wait for the agent's turn to end."
          : null);
  const index = loaded.findIndex((entry) => entry.id === build.id);
  const previous = index === -1 ? undefined : loaded[index + 1];
  const best = loaded.find((entry) => entry.source._tag === "round" && entry.source.best) ?? null;
  const factsData = facts.data;
  const measureAnswer = measure.answer(build.id);
  const turnSource = build.source._tag === "turn" ? build.source : null;
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <p className="text-2xs text-muted-foreground">
          {formatBuildTime(build.at)} · {buildSourceLabel(build.source)}
        </p>
        <h3 className="text-sm font-medium">{build.summary}</h3>
      </header>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={
            !build.available || build.noPlay !== null || !plays.canPlay || plays.playing(ref)
          }
          onClick={() => void play()}
        >
          <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
          {plays.playing(ref) ? "Starting…" : "Play"}
        </Button>
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="outline" disabled={!build.available} />}>
            <ColumnsIcon className="size-3.5" aria-hidden="true" />
            Compare with…
          </MenuTrigger>
          <MenuPopup align="start">
            {previous !== undefined ? (
              <MenuItem onClick={() => onCompare(refOf(previous))}>The build before it</MenuItem>
            ) : null}
            {list?.current != null && list.current !== build.id ? (
              <MenuItem
                onClick={() => onCompare({ _tag: "build", build: list.current ?? build.id })}
              >
                The folder's build
              </MenuItem>
            ) : null}
            {best !== null && best.id !== build.id ? (
              <MenuItem onClick={() => onCompare(refOf(best))}>The run's best</MenuItem>
            ) : null}
            <MenuItem onClick={() => onCompare(null)}>Pick in the list…</MenuItem>
          </MenuPopup>
        </Menu>
        {writer ? (
          <Button
            size="sm"
            variant="outline"
            disabled={
              !build.available ||
              restoreBlocked !== null ||
              !restores.canRestore ||
              restores.pending
            }
            onClick={() => void restores.send(build.id, restoreQuestion(buildName(build)))}
          >
            <HistoryIcon className="size-3.5" aria-hidden="true" />
            {restores.restoring(build.id) ? "Going back…" : "Go back to this build"}
          </Button>
        ) : null}
      </div>
      {build.noPlay !== null ? (
        <p className="text-2xs text-muted-foreground">{build.noPlay}</p>
      ) : null}
      {isCurrent ? (
        <p className="text-2xs text-muted-foreground">
          The folder was this build when the list was last read.
        </p>
      ) : null}
      {writer && restoreBlocked !== null ? (
        <p className="text-2xs text-muted-foreground">{restoreBlocked}</p>
      ) : null}
      {plays.error(ref) ? (
        <p role="alert" className="text-2xs text-destructive-foreground">
          {plays.error(ref)}
        </p>
      ) : null}
      {restores.error(build.id) ? (
        <p role="alert" className="text-2xs text-destructive-foreground">
          {restores.error(build.id)}
        </p>
      ) : null}
      {windowMessage !== null ? (
        <p className="text-2xs text-muted-foreground">{windowMessage}</p>
      ) : null}

      <section className="space-y-1.5">
        <h4 className="text-xs font-medium">What changed</h4>
        {build.files.length === 0 ? (
          <p className="text-2xs text-muted-foreground">
            {build.fileCount === null
              ? "Its changes were not counted."
              : "No file list for this build."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {build.files.map((file) => (
              <li key={file.path} className="flex items-baseline gap-2 font-mono text-2xs">
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
                <span className="shrink-0 text-success-foreground">+{file.additions}</span>
                <span className="shrink-0 text-destructive-foreground">−{file.deletions}</span>
              </li>
            ))}
          </ul>
        )}
        {build.fileCount !== null && build.fileCount > build.files.length ? (
          <p className="text-2xs text-muted-foreground">
            and {build.fileCount - build.files.length} more
          </p>
        ) : null}
        {turnSource !== null && turnSource.threadId === threadRef.threadId ? (
          <TurnDiffButton threadRef={threadRef} turn={turnSource.turn} />
        ) : null}
      </section>

      <section className="space-y-1.5">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-medium">Facts</h4>
          {measure.canMeasure &&
          factsData !== null &&
          (factsData.state === "never" ||
            factsData.state === "stale" ||
            factsData.state === "incomplete") ? (
            <Button size="xs" variant="ghost" onClick={() => void measure.send(build.id, true)}>
              <RefreshCwIcon aria-hidden="true" />
              {factsData.state === "never" ? "Measure" : "Measure again"}
            </Button>
          ) : null}
        </div>
        {!build.available ? (
          <p className="text-2xs text-muted-foreground">
            This build's history was pruned; only what the list shows is left.
          </p>
        ) : factsData === null ? (
          <p className="text-2xs text-muted-foreground">{facts.error ?? "Reading the facts…"}</p>
        ) : factsData.state === "never" ? (
          <p className="text-2xs text-muted-foreground">
            {factsData.message.trim() === "" ? "Not measured yet." : factsData.message}
          </p>
        ) : (
          <GameBuildFactsList threadRef={threadRef} facts={factsData} />
        )}
        {measureAnswer !== null && measureAnswer.text !== factsData?.message ? (
          <p
            role={measureAnswer.failed ? "alert" : undefined}
            className={cn(
              "text-2xs",
              measureAnswer.failed ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {measureAnswer.text}
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** A turn of this same chat opens T3's own diff of that turn. */
function TurnDiffButton({ threadRef, turn }: { threadRef: ScopedThreadRef; turn: number }) {
  const runId =
    useThreadCheckpointSummaries(threadRef).find((entry) => entry.checkpointTurnCount === turn)
      ?.runId ?? null;
  if (runId === null) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => {
        useDiffPanelStore.getState().selectTurn(threadRef, runId);
        useRightPanelStore.getState().open(threadRef, "diff");
      }}
    >
      View changes
    </Button>
  );
}

function GameBuildCompare({
  threadRef,
  pair,
  viewport,
  gameName,
  compact,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  pair: readonly [GameBuildRef, GameBuildRef];
  viewport: GameViewport;
  gameName: string;
  compact: boolean;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    gameEnvironment.buildCompare({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, a: pair[0], b: pair[1] },
    }),
  );
  const measure = useMeasureOnOpen(threadRef);
  // Only one side runs: the other is paused and muted, so two engines never draw at once.
  const [focused, setFocused] = useState<0 | 1>(0);
  const comparison = query.data;
  // Opening a compare measures a side that never was; the hook asks once per build.
  const unmeasuredKey =
    comparison === null
      ? ""
      : [
          comparison.a.available && comparison.factsA.state === "never" ? comparison.a.id : "",
          comparison.b.available && comparison.factsB.state === "never" ? comparison.b.id : "",
        ].join(" ");
  useEffect(() => {
    for (const id of unmeasuredKey.split(" ")) if (isBuildId(id)) void measure.send(id);
  }, [unmeasuredKey, measure]);
  if (comparison === null)
    return <p className="text-xs text-muted-foreground">{query.error ?? "Reading both builds…"}</p>;
  const sides = [comparison.a, comparison.b] as const;
  const labels = [`A · ${buildName(comparison.a)}`, `B · ${buildName(comparison.b)}`] as const;
  return (
    <div className="space-y-4">
      <header className="flex items-center gap-2">
        <GitCompareIcon className="size-4 shrink-0" aria-hidden="true" />
        <h3 className="min-w-0 flex-1 text-sm font-medium">
          {labels[0]} against {labels[1]}
        </h3>
        <Button size="xs" variant="ghost" onClick={onClose}>
          <XIcon aria-hidden="true" />
          Close
        </Button>
      </header>
      {compact ? (
        <div className="flex gap-1">
          {sides.map((side, index) => (
            <Button
              key={side.id}
              size="xs"
              variant={focused === index ? "secondary" : "ghost"}
              aria-pressed={focused === index}
              onClick={() => setFocused(index === 0 ? 0 : 1)}
            >
              {index === 0 ? "A" : "B"}
            </Button>
          ))}
        </div>
      ) : null}
      <div className={cn("grid gap-3", compact ? "grid-cols-1" : "grid-cols-2")}>
        {sides.map((side, index) =>
          compact && focused !== index ? null : (
            <ComparePane
              key={side.id}
              threadRef={threadRef}
              build={side}
              label={labels[index] ?? ""}
              viewport={viewport}
              gameName={gameName}
              focused={focused === index}
              onFocus={() => setFocused(index === 0 ? 0 : 1)}
            />
          ),
        )}
      </div>
      <GameBuildFactsDiff deltas={comparison.deltas} labels={["A", "B"]} />
    </div>
  );
}

function ComparePane({
  threadRef,
  build,
  label,
  viewport,
  gameName,
  focused,
  onFocus,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  label: string;
  viewport: GameViewport;
  gameName: string;
  focused: boolean;
  onFocus: () => void;
}) {
  const plays = useBuildPlay(threadRef);
  const [result, setResult] = useState<GameBuildPlayResult | null>(null);
  const ref = refOf(build);
  const play = async () => {
    onFocus();
    setResult(await plays.send(ref));
  };
  const url = result?._tag === "web" ? result.url : null;
  return (
    <div className="space-y-1.5" onPointerDown={onFocus} onFocusCapture={onFocus}>
      <p className="truncate text-2xs text-muted-foreground">
        {label} · {formatBuildTime(build.at)}
      </p>
      <div className="flex aspect-video items-center justify-center [container-type:size]">
        <GameFrameBox viewport={viewport} gameName={gameName} playing={url !== null}>
          {url !== null ? (
            <GameFrame url={url} title={`${gameName}, ${label}`} hidden={!focused} />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center">
              {result?._tag === "window" ? (
                <p className="text-xs text-washi/90">{result.message}</p>
              ) : build.noPlay !== null ? (
                <p className="text-xs text-washi/90">{build.noPlay}</p>
              ) : (
                <Button
                  size="sm"
                  disabled={!build.available || !plays.canPlay || plays.playing(ref)}
                  onClick={() => void play()}
                >
                  <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
                  {plays.playing(ref) ? "Starting…" : "Play"}
                </Button>
              )}
              {plays.error(ref) ? (
                <p role="alert" className="text-2xs text-washi/90">
                  {plays.error(ref)}
                </p>
              ) : null}
            </div>
          )}
        </GameFrameBox>
      </div>
    </div>
  );
}
