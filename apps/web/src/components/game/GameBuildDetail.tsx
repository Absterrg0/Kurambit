import { useEffect } from "react";
import { ColumnsIcon, HistoryIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import {
  gameFactsView,
  type GameBuild,
  type GameBuildFacts,
  type GameBuildRef,
  type GameBuildsResult,
  type ScopedThreadRef,
} from "@kurambit/contracts";

import { useDiffPanelStore } from "../../diffPanelStore";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadCheckpointSummaries } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { GameBuildFactsList } from "./GameBuildFacts";
import { useCharacterRoute } from "./GameCharacterRoute";
import { SaveMediaButton } from "./GameSavedMedia";
import { buildName, buildSourceLabel, formatBuildTime } from "./gameBuilds.logic";
import { restoreQuestion, useBuildRestore, useMeasureOnOpen } from "./useBuildActions";

export const refOf = (build: GameBuild): GameBuildRef => ({ _tag: "build", build: build.id });

/**
 * One build in full: what changed, its facts (read and, if never measured,
 * measured once when it opens), Play, Compare, Go back and its diff.
 */
export function GameBuildDetail({
  threadRef,
  build,
  list,
  loaded,
  writer,
  turnRunning,
  onCompare,
  onPlay,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult | null;
  /** Every loaded row, older pages too. */
  loaded: ReadonlyArray<GameBuild>;
  writer: boolean;
  turnRunning: boolean;
  /** The other build to compare with; null picks it on the timeline. */
  onCompare: (b: GameBuildRef | null) => void;
  /** Plays it on the Stage, from a copy, or in its own window. */
  onPlay: (build: GameBuild) => void;
}) {
  const facts = useEnvironmentQuery(
    build.available
      ? gameEnvironment.buildFacts({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, build: refOf(build) },
        })
      : null,
  );
  const restores = useBuildRestore(threadRef, list?.restore ?? null);
  const characters = useCharacterRoute(threadRef).route;
  const measure = useMeasureOnOpen(threadRef);
  // Opened, by a row or a link: a build that never was measured is, once.
  const neverMeasured = build.available && build.facts.state === "never";
  const sendMeasure = measure.send;
  useEffect(() => {
    if (neverMeasured) void sendMeasure(build.id);
  }, [neverMeasured, build.id, sendMeasure]);
  // The folder holds this build unless the list knows of an edit since (phase
  // 1's folder-build rule): going back to it restores nothing, and its record
  // would replace the undo's, taking Redo away.
  const isCurrent = list?.current === build.id && list.folderEdited !== true;
  // The server stays authoritative; these say why before the person presses.
  const restoreBlocked =
    build.noRestore ?? (turnRunning ? "Wait for the agent's turn to end." : null);
  const index = loaded.findIndex((entry) => entry.id === build.id);
  const previous = index === -1 ? undefined : loaded[index + 1];
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
          disabled={!build.available || build.noPlay !== null}
          onClick={() => onPlay(build)}
        >
          <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
          Play
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
            <MenuItem onClick={() => onCompare(null)}>Pick on the timeline…</MenuItem>
          </MenuPopup>
        </Menu>
        {writer && !isCurrent ? (
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
        <p className="text-2xs text-muted-foreground">The game folder holds this build.</p>
      ) : null}
      {writer && !isCurrent && restoreBlocked !== null ? (
        <p className="text-2xs text-muted-foreground">{restoreBlocked}</p>
      ) : null}
      {restores.error(build.id) ? (
        <p role="alert" className="text-2xs text-destructive-foreground">
          {restores.error(build.id)}
        </p>
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
          <>
            <GameBuildFactsList threadRef={threadRef} facts={factsData} characters={characters} />
            <SaveEvidence threadRef={threadRef} build={build} facts={factsData} />
          </>
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
      Open diff
    </Button>
  );
}

/**
 * The bot runs' videos and frames, each with Save: the person keeps evidence
 * past the log cleanup in the game's saved/, the same save the agent has.
 */
function SaveEvidence({
  threadRef,
  build,
  facts,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  facts: GameBuildFacts;
}) {
  const name = buildName(build)
    .replace(/'s build$/, "")
    .toLowerCase();
  const seen = new Set<string>();
  const media = gameFactsView(facts).flatMap((view) =>
    view.evidence.flatMap((item) => {
      if (item.kind === "log" || seen.has(item.path)) return [];
      seen.add(item.path);
      return [{ path: item.path, fact: view.label, what: item.label }];
    }),
  );
  if (media.length === 0) return null;
  return (
    <ul className="space-y-1">
      {media.map((item) => (
        <li key={item.path} className="flex flex-wrap items-center gap-2 text-2xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {item.fact} · {item.what}
          </span>
          <SaveMediaButton
            threadRef={threadRef}
            source={item.path}
            label={`${name} ${item.fact} ${item.what}`.toLowerCase()}
          />
        </li>
      ))}
    </ul>
  );
}
