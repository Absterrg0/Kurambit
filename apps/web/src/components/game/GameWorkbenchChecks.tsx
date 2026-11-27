import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@kurambit/client-runtime/environment";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import {
  gameChecksView,
  gameLookId,
  gameQaFindings,
  ownsUndo,
  playOutcomeWords,
  type GameBuild,
  type GameBuildFacts,
  type GameBuildsResult,
  type GameCheck,
  type GameSavedPlayReading,
  type GameThing,
  type GameTuneChange,
  type RunId,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  ClockIcon,
  FileVideoIcon,
  FlagIcon,
  ImageIcon,
  MinusIcon,
  MoreHorizontalIcon,
  PlayIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import {
  useQuietThreadShell,
  useThreadCheckpointSummaries,
  useThreadProjection,
} from "../../state/entities";
import { gameEnvironment, stagePlayTarget } from "../../state/game";
import { turnBuildView } from "../../state/gameTurnBuild";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { refOf } from "./gameBuildRef";
import {
  buildCaption,
  buildPhrase,
  formatBuildTime,
  notMeasuredWhy,
  qaLines,
  undoOutcome,
} from "./gameBuilds.logic";
import { stageBuildId } from "./gameBuildTimeline.logic";
import { replayStageRun, useThreadStageBridge } from "./gameStageBridge";
import { turnStripRestore } from "./gameTurnBuild.logic";
import {
  restoreQuestion,
  useBuildRestore,
  useBuildUndo,
  useMeasureOnOpen,
} from "./useBuildActions";
import { useTurnLanding } from "./useTurnLanding";
import {
  ControlsEvidence,
  hasControls,
  hasLastPlay,
  hasPerformanceProof,
  hasScreenFrames,
  LastPlayEvidence,
  openEvidence,
  PerformanceEvidence,
  ScreensEvidence,
  useBaseFacts,
} from "./GameChecksBoard";
import { colourHex } from "./GameColourField";
import { GameDecisionsSection, SwatchText } from "./GameDecisions";
import { chatTitle } from "./gameLibrary.logic";
import { useThreadGameName } from "./GameName";
import { clockLabel } from "./gameStageResume";
import { sameShape, stageDeviceAt } from "./gameStageDevice";
import { clearStageConsole, type StageConsoleLine, useStageConsole } from "./gameStageWatch";
import { Workbench } from "./GameWorkbenchParts";
import { valueLabel } from "./GameInspector";
import { useChangedSinceBase } from "./useChangedSinceBase";
import { readNextLine } from "@kurambit/shared/gameNextLine";

/**
 * The Workbench's Checks: the build picked in the strip or the chat, else the one on the Stage.
 * Its facts as one tidy list, its saved plays within it, and what it changed as a plain diff
 * whose files open T3's diff view.
 */
export function GameWorkbenchChecks({
  threadRef,
  onAsk,
  onOpenTurnDiff,
}: {
  threadRef: ScopedThreadRef;
  onAsk: (text: string) => void;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const list = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const inspected = useGameWorkspaceStore((state) =>
    state.inspectedBuild?.threadKey === threadKey ? state.inspectedBuild : null,
  );
  const asked = useAtomValue(stagePlayTarget(threadRef));
  const inspectBuild = useGameWorkspaceStore((state) => state.inspectBuild);
  const shell = useQuietThreadShell(threadRef);
  const working = threadRuntimeIsActive(shell?.runtime);
  const landing = useTurnLanding(threadRef, working);
  const data = list.data;
  if (data === null)
    return list.error === null ? (
      <ChecksLoading />
    ) : (
      <Workbench.Empty
        icon={<ClipboardCheckIcon />}
        title="Checks did not load"
        body={list.error}
      />
    );
  const onStageId = stageBuildId(data, asked?.build ?? null);
  // The list's own row when it holds it, so the facts it shows stay current.
  const build =
    (inspected === null
      ? undefined
      : (data.builds.find((entry) => entry.id === inspected.build) ?? inspected.snapshot)) ??
    data.builds.find((entry) => entry.id === (onStageId ?? data.current)) ??
    data.builds[0] ??
    null;
  // No build yet: what fills the section, and the one thing that makes it unless it is being made
  // (the top bar says so).
  if (build === null)
    return (
      <Workbench.Empty
        icon={<ClipboardCheckIcon />}
        body="Checks appear after the first build is measured."
        action={
          working || landing ? undefined : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onAsk("Make the game's first build.")}
            >
              Ask for build 1
            </Button>
          )
        }
      />
    );
  const side = inspected?.side;
  return (
    <BuildChecksBody
      key={build.id}
      threadRef={threadRef}
      build={build}
      list={data}
      onOpenTurnDiff={onOpenTurnDiff}
      onBackToStage={
        inspected !== null && side === undefined && build.id !== onStageId
          ? () => inspectBuild(null)
          : null
      }
    />
  );
}

/**
 * One build's Checks: its name and time, what it changed in plain words, then its checks as one
 * summary (the problems and what the person can try, each with its proof; the passes folded into
 * a line), the game's console when it said something worth reading, and the decisions every
 * session reads.
 */
function BuildChecksBody({
  threadRef,
  build,
  list,
  onOpenTurnDiff,
  onBackToStage,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  onBackToStage: (() => void) | null;
}) {
  const facts = useShownFacts(threadRef, build);
  return (
    <Workbench.Body>
      <div className="flex flex-col pb-2">
        <BuildHeader
          threadRef={threadRef}
          build={build}
          list={list}
          onBackToStage={onBackToStage}
        />
        <WhatChanged
          threadRef={threadRef}
          build={build}
          list={list}
          onOpenTurnDiff={onOpenTurnDiff}
        />
      </div>
      <BuildChecks threadRef={threadRef} build={build} list={list} facts={facts} />
      <ChecksConsole threadKey={scopedThreadKey(threadRef)} />
      <GameDecisionsSection threadRef={threadRef} />
    </Workbench.Body>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────────

// Each names its build, as Undo does: the note under it can then say "this build".
const RESTORE = {
  undo: { label: (name: string) => `Undo ${name}`, busy: "Undoing…" },
  redo: { label: (name: string) => `Redo ${name}`, busy: "Redoing…" },
  "go-back": { label: (name: string) => `Go back to ${name}`, busy: "Going back…" },
} as const;

/**
 * The build's name and where it stands, Play when it is not on the Stage, and in a ⋯ the rest of
 * what can be done with it: its one restore by the strip's rules.
 */
function BuildHeader({
  threadRef,
  build,
  list,
  onBackToStage,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult;
  /** Shows the build on the Stage again, when this one was picked and is not on it. */
  onBackToStage: (() => void) | null;
}) {
  const canAct = useAtomValue(gameEnvironment.action.permissionAtom(threadRef.environmentId));
  const restores = useBuildRestore(threadRef, list.restore);
  const undoes = useBuildUndo(threadRef);
  // The quiet shell: a streaming turn does not re-render the Workbench.
  const turnRunning = threadRuntimeIsActive(useQuietThreadShell(threadRef)?.runtime);
  const requestStage = useGameWorkspaceStore((state) => state.requestStage);
  const onStageNow = stageBuildId(list, useAtomValue(stagePlayTarget(threadRef))?.build ?? null);
  const latestUndoable = list.builds.find((entry) => ownsUndo(entry.source)) ?? null;
  const view = canAct ? turnBuildView(list, build, build.id === latestUndoable?.id) : null;
  const action = view === null ? null : turnStripRestore(view, turnRunning);
  // A Redo names the build it brings back: an undo's own detail names the build it undid.
  const restoreName = action?.via === "undo" ? (view?.redo?.name ?? build.name) : build.name;
  const index = list.builds.findIndex((entry) => entry.id === build.id);
  const previous =
    list.builds.find((entry) => entry.id === build.base) ??
    (index === -1 ? undefined : list.builds[index + 1]);
  const kind = action === null ? null : RESTORE[action.kind];
  const viaUndo = action?.via === "undo";
  const error = action === null ? null : (viaUndo ? undoes.error : restores.error)(action.target);
  const canPlay = build.available && build.id !== onStageNow;
  // A build another chat made says whose it is: the top bar, this chat's last line and Checks
  // can each name a different build, and only this relates them.
  const madeIn = build.source._tag === "saved" ? null : build.source.threadId;
  const otherChat = madeIn === null || madeIn === threadRef.threadId ? null : madeIn;
  const otherShell = useQuietThreadShell(
    otherChat === null ? null : scopeThreadRef(threadRef.environmentId, otherChat),
  );
  const gameName = useThreadGameName(threadRef);
  // By that chat's title, as its row in the sidebar says it.
  const from =
    otherChat === null
      ? null
      : otherShell !== null
        ? chatTitle(otherShell, gameName)
        : build.source._tag === "turn"
          ? build.source.threadTitle
          : "another chat";
  return (
    <div className="flex flex-col gap-1 pt-2.5 pb-1">
      <div className="flex h-8 items-center gap-2 ps-4 pe-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <Text
            variant="label"
            tone="strong"
            truncate
            render={<h2 className={from === null ? undefined : "shrink-0"} />}
          >
            {build.name}
          </Text>
          {from === null ? null : (
            <Text variant="caption" tone="muted" truncate data-build-from="">
              from {from}
            </Text>
          )}
          <Text variant="caption" tone="muted" numeric render={<span className="shrink-0" />}>
            {formatBuildTime(build.at)}
          </Text>
        </div>
        {onBackToStage === null ? null : (
          <Button size="xs" variant="ghost" onClick={onBackToStage}>
            Back to the Stage's
          </Button>
        )}
        {canPlay ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => requestStage({ kind: "play", build: refOf(build) })}
          >
            <PlayIcon aria-hidden="true" />
            Play
          </Button>
        ) : null}
        {action !== null && kind !== null ? (
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label={`${build.name} actions`} />
              }
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup side="bottom" align="end" sideOffset={4} className="w-64">
              {action !== null && kind !== null ? (
                <MenuItem
                  disabled={
                    action.blocked !== null ||
                    !(viaUndo ? undoes.canUndo : restores.canRestore) ||
                    restores.pending ||
                    undoes.pending !== null
                  }
                  onClick={() =>
                    void (viaUndo
                      ? undoes.send(action.target)
                      : restores.send(
                          action.target,
                          action.kind === "go-back" ? restoreQuestion(build.name) : null,
                        ))
                  }
                >
                  <Undo2Icon className="mt-0.5 self-start" />
                  <span className="flex min-w-0 flex-col">
                    {(
                      viaUndo ? undoes.pending === action.target : restores.restoring(action.target)
                    )
                      ? kind.busy
                      : kind.label(buildPhrase(restoreName))}
                    <Text variant="caption" tone="muted">
                      {action.blocked ??
                        (action.kind === "undo"
                          ? undoOutcome(
                              previous === undefined ? null : previous.name,
                              list.folderEdited === true,
                            )
                          : action.kind === "redo"
                            ? viaUndo
                              ? "Its change comes back; later builds stay"
                              : "The game becomes this build again"
                            : "The game becomes this build; later ones stay in the strip")}
                    </Text>
                  </span>
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {build.noPlay === null ? null : (
        <Text variant="caption" tone="muted" render={<p className="px-4" />}>
          {build.noPlay}
        </Text>
      )}
      {error === null ? null : (
        <Text variant="caption" tone="destructive" render={<p role="alert" className="px-4" />}>
          {error}
        </Text>
      )}
    </div>
  );
}

// ─── Checks ────────────────────────────────────────────────────────────────────

const FACT_KEYS = [
  "boots",
  "masher",
  "performance",
  "use",
  "qa",
  "screens",
  "player",
] as const satisfies ReadonlyArray<keyof GameBuildFacts>;

/** A measuring build's facts with each reading still to come taken from its last measure. */
function withLastReadings(facts: GameBuildFacts, last: GameBuildFacts | null): GameBuildFacts {
  if (last === null) return facts;
  const merged: Record<(typeof FACT_KEYS)[number], unknown> = { ...facts };
  for (const key of FACT_KEYS)
    if (facts[key].status === "pending" && last[key].status === "measured") merged[key] = last[key];
  return { ...facts, ...(merged as Pick<GameBuildFacts, (typeof FACT_KEYS)[number]>) };
}

/**
 * The build's facts as Checks shows them: while it is measured again, what it measured before
 * stands until the new readings land, so a pass never blinks out and back. A build that never
 * was measured is, once, on being shown, and so is one an older harness measured (after an
 * update), so its readings compare with the others'.
 */
function useShownFacts(threadRef: ScopedThreadRef, build: GameBuild) {
  const facts = useEnvironmentQuery(
    build.available
      ? gameEnvironment.buildFacts({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, build: refOf(build) },
        })
      : null,
  );
  const measure = useMeasureOnOpen(threadRef);
  const owesMeasure =
    build.available && (build.facts.state === "never" || build.facts.state === "stale");
  const sendMeasure = measure.send;
  useEffect(() => {
    if (owesMeasure) void sendMeasure(build.id);
  }, [owesMeasure, build.id, sendMeasure]);
  const [lastSettled, setLastSettled] = useState<GameBuildFacts | null>(null);
  const read = facts.data;
  const busy = read !== null && (read.state === "measuring" || read.state === "queued");
  if (read !== null && !busy && read.state !== "never" && read !== lastSettled)
    setLastSettled(read);
  const shown = read === null ? null : withLastReadings(read, busy ? lastSettled : null);
  return { shown, busy, error: facts.error, measure };
}
type ShownFacts = ReturnType<typeof useShownFacts>;

/** "1 control", "2 controls": a count and its noun. */
const countOf = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function BuildChecks({
  threadRef,
  build,
  list,
  facts,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult;
  facts: ShownFacts;
}) {
  const { shown, busy, measure } = facts;
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const answer = measure.answer(build.id);
  const canMeasureAgain =
    measure.canMeasure && build.available && shown !== null && shown.state !== "never" && !busy;
  const sorted =
    shown === null || shown.state === "never" ? null : sortChecks(shown, root !== null);
  return (
    // The rows are the summary: each fact is said once, in its row.
    <Workbench.Section
      title="Checks"
      detail={
        shown !== null && busy ? (
          "Measuring"
        ) : shown === null && facts.error === null && build.available ? (
          <Skeleton className="h-3 w-28" />
        ) : null
      }
      aside={
        canMeasureAgain ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Measure again"
                  onClick={() => void measure.send(build.id, true)}
                />
              }
            >
              <RefreshCwIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="left">Measure again</TooltipPopup>
          </Tooltip>
        ) : busy ? (
          <Spinner size="sm" tone="muted" className="me-1.5" />
        ) : undefined
      }
    >
      {!build.available ? (
        <Note>This build's history was pruned; only its picture and name are left.</Note>
      ) : shown === null ? (
        facts.error === null ? (
          <CheckRowsLoading />
        ) : (
          <Note>{facts.error}</Note>
        )
      ) : sorted === null ? (
        <div className="flex flex-col items-start gap-2 px-4 py-1">
          {shown.message.trim() === "" ? null : (
            <Text variant="meta" tone="muted" render={<p />}>
              {shown.message}
            </Text>
          )}
          {measure.canMeasure ? (
            <Button size="xs" variant="outline" onClick={() => void measure.send(build.id, true)}>
              Measure now
            </Button>
          ) : null}
        </div>
      ) : (
        <CheckRows
          threadRef={threadRef}
          root={root}
          build={build}
          list={list}
          facts={shown}
          sorted={sorted}
          busy={busy}
        />
      )}
      {answer !== null && answer.failed ? (
        <Text variant="caption" tone="destructive" render={<p role="alert" className="px-4" />}>
          {answer.text}
        </Text>
      ) : null}
    </Workbench.Section>
  );
}

function Note({ children }: { children: string }) {
  return (
    <Text variant="meta" tone="muted" render={<p className="px-4 py-1" />}>
      {children}
    </Text>
  );
}

/** Why a build's checks could not be read when the build itself does not start. */
const DID_NOT_START = "the game did not start, so the bots could not play it";

const toneOf = (check: GameCheck) =>
  check.reading._tag === "measured" ? check.reading.tone : null;

/** A frame rate read on a machine that cannot time one: its draw counts are all it has. */
const frameRateUnread = (facts: GameBuildFacts, check: GameCheck) =>
  check.id === "performance" &&
  facts.performance.status === "measured" &&
  facts.performance.value.fps === null;

/**
 * PURE. A build's checks sorted by what the person does with them: problems to fix, readings for
 * them to judge, how many controls are theirs to try, the passes, the ones still being measured
 * and the ones not measured with each one's reason.
 */
const sortChecks = (facts: GameBuildFacts, rooted: boolean) => {
  const { checks } = gameChecksView(facts);
  const measured = checks.filter(
    (check) => check.reading._tag === "measured" && !frameRateUnread(facts, check),
  );
  // A build that does not start leaves every other check unread for that one reason.
  const startFailed = checks.some((check) => check.id === "boots" && toneOf(check) === "bad");
  return {
    problems: measured.filter((check) => toneOf(check) === "bad"),
    judge: measured.filter((check) => toneOf(check) === "neutral"),
    toTry: facts.qa.status === "measured" ? gameQaFindings(facts.qa.value).silent.length : 0,
    passes: measured.filter((check) => toneOf(check) === "good"),
    pending: checks.filter((check) => check.reading._tag === "pending").length,
    unread: checks.flatMap((check) =>
      check.reading._tag === "not-measured"
        ? [{ check, why: startFailed ? DID_NOT_START : notMeasuredWhy(check.reading) }]
        : frameRateUnread(facts, check)
          ? [{ check, why: check.value ?? "" }]
          : [],
    ),
    startFailed,
    rooted,
  };
};
type SortedChecks = ReturnType<typeof sortChecks>;

/**
 * The checks in one grammar: every row is a mark, a sentence and a reading, and opens to its
 * proof when it has one. Problems and what the person can try are open; the passes are one line
 * that opens to them, and so are the checks not measured, each with its reason.
 */
function CheckRows({
  threadRef,
  root,
  build,
  list,
  facts,
  sorted,
  busy,
}: {
  threadRef: ScopedThreadRef;
  root: string | null;
  build: GameBuild;
  list: GameBuildsResult;
  facts: GameBuildFacts;
  sorted: SortedChecks;
  busy: boolean;
}) {
  const base = useBaseFacts(threadRef, build, list);
  // What the person folded or opened, against each row's own start.
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const isOpen = (id: string, start: boolean) => flipped.has(id) !== start;
  const toggle = (id: string) =>
    setFlipped((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const evidence = { threadRef, root, base, facts };
  const row = (check: GameCheck, start: boolean, grouped: boolean) => {
    const proof = hasEvidence(facts, check, root !== null);
    const open = proof && isOpen(check.id, start);
    return (
      <div key={check.id} className="flex flex-col">
        <Workbench.Row
          // In a group the group's mark stands for its rows.
          mark={grouped ? <span /> : <CheckMark check={check} />}
          name={check.sentence}
          // What a control check leaves the person to try is its own row.
          reading={check.id === "controls" && toneOf(check) === "good" ? null : check.value}
          {...(proof ? { expanded: open, onToggle: () => toggle(check.id) } : {})}
        />
        {open ? <CheckEvidence check={check} {...evidence} /> : null}
      </div>
    );
  };
  const passesOpen = isOpen("passes", false);
  const unreadOpen = isOpen("unread", false);
  const tryOpen = isOpen("try", true);
  return (
    <div className="flex flex-col">
      {sorted.problems.map((check) => row(check, true, false))}
      {sorted.judge.map((check) => row(check, true, false))}
      {sorted.toTry === 0 ? null : (
        <div className="flex flex-col">
          <Workbench.Row
            mark={
              <span
                aria-hidden="true"
                className="size-2 rounded-full border border-muted-foreground"
              />
            }
            name={`${countOf(sorted.toTry, "control")} to try yourself`}
            expanded={tryOpen}
            onToggle={() => toggle("try")}
          />
          {tryOpen ? (
            <EvidenceBlock>
              <ControlsEvidence
                threadKey={scopedThreadKey(threadRef)}
                facts={facts}
                only={["try"]}
              />
            </EvidenceBlock>
          ) : null}
        </div>
      )}
      {sorted.passes.length === 0 ? null : (
        <div className="flex flex-col">
          <Workbench.Row
            mark={<CheckIcon className="text-success" aria-hidden="true" />}
            name={`${sorted.passes.length} pass`}
            expanded={passesOpen}
            onToggle={() => toggle("passes")}
          />
          {passesOpen ? sorted.passes.map((check) => row(check, false, true)) : null}
        </div>
      )}
      {sorted.pending > 0 ? (
        <Workbench.Row
          mark={<ClockIcon className="text-dim-foreground" aria-hidden="true" />}
          name={pendingWords(sorted.pending, busy ? facts.message : "")}
          muted
        />
      ) : null}
      {/* While it is measured again, what is still to come is the row above, not a list. */}
      {sorted.unread.length === 0 || busy ? null : sorted.startFailed ? (
        <Workbench.Row
          mark={<MinusIcon className="text-dim-foreground" aria-hidden="true" />}
          name={`${sorted.unread.length} not measured: it did not start`}
          muted
        />
      ) : (
        <div className="flex flex-col">
          <Workbench.Row
            mark={<MinusIcon className="text-dim-foreground" aria-hidden="true" />}
            name={`${sorted.unread.length} not measured`}
            muted
            expanded={unreadOpen}
            onToggle={() => toggle("unread")}
          />
          {unreadOpen
            ? sorted.unread.map(({ check, why }) => {
                const proof = frameRateUnread(facts, check) && hasPerformanceProof(facts);
                const open = proof && isOpen(check.id, false);
                return (
                  <div key={check.id} className="flex flex-col">
                    <Workbench.Row
                      mark={<span />}
                      // Its reason always under its name, however short: one place for every row.
                      name={
                        <span className="flex flex-col">
                          {check.sentence}
                          {proof || why === "" ? null : (
                            <Text variant="caption" tone="muted">
                              {sentenceOf(why)}
                            </Text>
                          )}
                        </span>
                      }
                      muted
                      {...(proof ? { expanded: open, onToggle: () => toggle(check.id) } : {})}
                    />
                    {open ? <CheckEvidence check={check} {...evidence} /> : null}
                  </div>
                );
              })
            : null}
        </div>
      )}
    </div>
  );
}

/** A reason as a sentence of its own: its first letter raised. */
const sentenceOf = (text: string) =>
  text === "" ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The checks still to come, as one row: what the bot is doing, when it says. */
const pendingWords = (count: number, step: string) => {
  const doing = step
    .trim()
    .replace(/^Measuring:\s*/i, "")
    .replace(/\.$/, "");
  return doing === ""
    ? `${count === 1 ? "1 check" : `${count} checks`} still to measure`
    : `${doing.charAt(0).toUpperCase()}${doing.slice(1)}`;
};

/**
 * A pass is a tick, something to look at a warning, a reading with no verdict (for you to judge)
 * a hollow ring; a game that does not start is the build's outcome, in the one red the strip and
 * the Stage give it.
 */
function CheckMark({ check }: { check: GameCheck }) {
  const tone = check.reading._tag === "measured" ? check.reading.tone : null;
  if (tone === "good") return <CheckIcon className="text-success" aria-hidden="true" />;
  if (tone === "bad")
    return (
      <TriangleAlertIcon
        className={check.id === "boots" ? "text-destructive" : "text-warning"}
        aria-hidden="true"
      />
    );
  return <span aria-hidden="true" className="size-2 rounded-full border border-muted-foreground" />;
}

interface Evidence {
  readonly threadRef: ScopedThreadRef;
  /** The game's folder, which frames and recordings are read from; null until it is known. */
  readonly root: string | null;
  /** The build this one was made from, whose readings each number is compared with. */
  readonly base: GameBuildFacts | null;
  readonly facts: GameBuildFacts;
}

/**
 * Whether a passing check has proof worth its own block: a chart, keys, frames or plays. A pass
 * with only a log or a line folds into the one line of passes.
 */
const hasProof = (facts: GameBuildFacts, check: GameCheck, rooted: boolean): boolean => {
  switch (check.id) {
    case "performance":
      return hasPerformanceProof(facts);
    case "controls":
      return hasControls(facts);
    case "screens":
      return rooted && hasScreenFrames(facts);
    // The harness's play is the one the errors were watched in.
    case "errors":
      return rooted && hasLastPlay(facts);
    case "saved-plays":
      return facts.savedPlays.status === "measured" && facts.savedPlays.value.plays.length > 0;
    default:
      return false;
  }
};

/** Whether a check has anything to show under it. */
const hasEvidence = (facts: GameBuildFacts, check: GameCheck, rooted: boolean): boolean => {
  if (hasProof(facts, check, rooted) || check.evidence.length > 0) return true;
  switch (check.id) {
    case "screens":
      return qaLines(facts, "screens").length > 0;
    case "boots":
      return facts.boots.status === "measured" && !facts.boots.value.ok;
    case "errors":
      return errorLines(facts).length > 0;
    default:
      return qaLines(facts, check.id).length > 0;
  }
};

/** Where a check's evidence sits: under its sentence, in the text column. */
function EvidenceBlock({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 ps-9.5 pe-4 pt-1 pb-3">{children}</div>;
}

/** The most problem lines shown before the rest are one click away. */
const PROBLEM_LINES = 3;

/**
 * Lines a check found, each a message and, quieter, where it happened. An error's message is in
 * the code face; a finding (a HUD off screen) is a sentence.
 */
function ProblemLines({ lines, code = false }: { lines: ReadonlyArray<string>; code?: boolean }) {
  const [all, setAll] = useState(false);
  if (lines.length === 0) return null;
  const shown = all ? lines : lines.slice(0, PROBLEM_LINES);
  return (
    <ul className="flex flex-col gap-1">
      {shown.map((line) => {
        const problem = problemText(line);
        return (
          <li key={line} className="flex flex-col">
            <Text
              variant={code ? "caption" : "meta"}
              tone="default"
              mono={code}
              render={<span className="break-words" />}
            >
              {problem.message}
            </Text>
            {problem.where === null ? null : (
              <Text variant="caption" tone="muted">
                {problem.where}
              </Text>
            )}
          </li>
        );
      })}
      {lines.length > shown.length ? (
        <li>
          <Button size="xs" variant="ghost-muted" className="-ms-2" onClick={() => setAll(true)}>
            {lines.length - shown.length} more
          </Button>
        </li>
      ) : null}
    </ul>
  );
}

/** A check's evidence, by what it measured: the pictures, the chart, the keys, the plays or the messages. */
function CheckEvidence({ threadRef, root, base, facts, check }: Evidence & { check: GameCheck }) {
  const proves = check.value === null ? check.sentence : `${check.sentence} ${check.value}`;
  const recordings = <EvidenceButtons threadRef={threadRef} check={check} proves={proves} />;
  switch (check.id) {
    case "screens":
      return (
        <EvidenceBlock>
          {root === null ? null : (
            <ScreensEvidence threadRef={threadRef} root={root} facts={facts} />
          )}
          <ProblemLines lines={qaLines(facts, "screens")} />
          {/* Its frames are the thumbnails above: no second way to open them. */}
          {root !== null && hasScreenFrames(facts) ? null : recordings}
        </EvidenceBlock>
      );
    case "performance":
      return (
        <EvidenceBlock>
          <PerformanceEvidence facts={facts} base={base} />
          {recordings}
        </EvidenceBlock>
      );
    case "controls":
      return (
        <EvidenceBlock>
          <ControlsEvidence
            threadKey={scopedThreadKey(threadRef)}
            facts={facts}
            // A problem lists the controls not read; a pass, the ones that answered.
            only={toneOf(check) === "bad" ? ["dead"] : ["works"]}
          />
          {/* The key rows say which control was not read; the lines only when there are none. */}
          {hasControls(facts) ? null : <ProblemLines lines={qaLines(facts, "controls")} />}
          {recordings}
        </EvidenceBlock>
      );
    case "saved-plays":
      return (
        <EvidenceBlock>
          <SavedPlays threadRef={threadRef} facts={facts} />
        </EvidenceBlock>
      );
    case "errors":
      return (
        <EvidenceBlock>
          {root === null ? null : (
            <LastPlayEvidence threadRef={threadRef} root={root} facts={facts} />
          )}
          <ProblemLines lines={errorLines(facts)} code />
          {recordings}
        </EvidenceBlock>
      );
    default: {
      const lines =
        check.id === "boots"
          ? facts.boots.status === "measured" && !facts.boots.value.ok
            ? [facts.boots.value.detail]
            : []
          : qaLines(facts, check.id);
      return (
        <EvidenceBlock>
          <ProblemLines lines={lines} code={check.id === "boots"} />
          {recordings}
        </EvidenceBlock>
      );
    }
  }
}

/** What the plays threw: the play that broke, then each error a control's press threw. */
const errorLines = (facts: GameBuildFacts): ReadonlyArray<string> => {
  const broke = [facts.masher].flatMap((tier) =>
    tier.status === "measured" &&
    (tier.value.ending === "crashed" || tier.value.ending === "unresponsive") &&
    tier.value.note.trim() !== ""
      ? [tier.value.note]
      : [],
  );
  return [...broke, ...qaLines(facts, "errors")];
};

/**
 * A problem's line as a person reads it: the message itself, and where it happened (the file and
 * line, or what the bot was doing) said after it, without the harness's "check failed:" and the
 * browser's "Page error:" and "Uncaught Error:" wording.
 */
const problemText = (line: string): { message: string; where: string | null } => {
  let rest = line.trim().replace(/^check failed:\s*/i, "");
  let where: string | null = null;
  const file = /^([\w./-]+\.\w+(?::\d+)*):\s*/.exec(rest);
  if (file !== null) {
    where = file[1]!.split("/").at(-1) ?? file[1]!;
    rest = rest.slice(file[0].length);
  }
  const doing = /^([^:]{1,40}?):\s*(?=(?:Page error|Uncaught \w*|\w*Error)\b)/.exec(rest);
  if (doing !== null) {
    where = where ?? doing[1]!;
    rest = rest.slice(doing[0].length);
  }
  rest = rest.replace(/^(?:Page error|Uncaught \w*Error|Uncaught|\w*Error):\s*/, "");
  const at = /\s*\(([\w./-]+\.\w+:\d+)(?::\d+)?\)\s*$/.exec(rest);
  if (at !== null) {
    rest = rest.slice(0, at.index);
    where = at[1]!.split("/").at(-1) ?? at[1]!;
  }
  return { message: rest === "" ? line : rest, where };
};

const EVIDENCE_ICON = { video: FileVideoIcon, frame: ImageIcon, log: ScrollTextIcon } as const;

/** The check's recordings, frames and logs, each a quiet button that opens it. */
function EvidenceButtons({
  threadRef,
  check,
  proves,
}: {
  threadRef: ScopedThreadRef;
  check: GameCheck;
  proves: string;
}) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  if (check.evidence.length === 0) return null;
  return (
    <div className="-ms-2 flex flex-wrap items-center gap-1">
      {check.evidence.map((item) => {
        const EvidenceIcon = EVIDENCE_ICON[item.kind];
        return (
          <Button
            key={item.path}
            size="xs"
            variant="ghost-muted"
            onClick={() => openEvidence(threadRef, root, item, proves)}
          >
            <EvidenceIcon aria-hidden="true" />
            {item.label}
          </Button>
        );
      })}
    </div>
  );
}

/** The rows' own shape while they are read, so nothing under them moves when they land. */
function CheckRowsLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-2.5 px-4 py-1.5">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-3 w-24" />
    </div>
  );
}

function ChecksLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-2 py-3">
      <div className="flex flex-col gap-1.5 px-4 pb-2">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3 w-32" />
      </div>
      <CheckRowsLoading />
    </div>
  );
}

// ─── Saved plays ───────────────────────────────────────────────────────────────

const READING_WORDS: Record<GameSavedPlayReading, string> = {
  same: "Same",
  "ending-changed": "Ending changed",
  "plays-differently": "Plays differently",
  "cannot-replay": "Can't replay",
};

/**
 * Each saved play as this build replayed it, under the check that counts them: its name, whether
 * it ended the same, and where it first played differently. Clicking one replays it on the Stage.
 */
/**
 * Replays a test play on this chat's Stage from its start, at the shape it was played at, to its
 * end, where the Stage holds it. Answers what happened in a line, or null when nothing needs saying.
 */
export function useReplayTestPlay(threadRef: ScopedThreadRef) {
  const loadPlay = useAtomCommand(gameEnvironment.savedPlay, { reportFailure: false });
  return async (name: string): Promise<string | null> => {
    const result = await loadPlay({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, name },
    });
    if (result._tag === "Failure") return String(squashAtomCommandFailure(result));
    // Mouse aim depends on the shape: the responsive view, when the Stage's frame has another one.
    await showStageAt(scopedThreadKey(threadRef), result.value.viewport);
    const replayed = await replayStageRun({
      play: result.value,
      step: result.value.steps,
      pace: 0,
    });
    if (replayed === null) return "The game on the Stage could not replay it.";
    return replayed.ended == null ? null : `On the Stage it ${playOutcomeWords(replayed.ended)}.`;
  };
}

function SavedPlays({ threadRef, facts }: { threadRef: ScopedThreadRef; facts: GameBuildFacts }) {
  const reading = facts.savedPlays;
  const replayPlay = useReplayTestPlay(threadRef);
  const deletePlay = useAtomCommand(gameEnvironment.deletePlay, { reportFailure: false });
  const canRead = useAtomValue(gameEnvironment.savedPlay.permissionAtom(threadRef.environmentId));
  const canDelete = useAtomValue(
    gameEnvironment.deletePlay.permissionAtom(threadRef.environmentId),
  );
  const rewinds = useThreadStageBridge(
    scopedThreadKey(threadRef),
    (state) => state.status === "ready" && state.capabilities.includes("rewind"),
    false,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  if (reading.status !== "measured") return null;
  const replay = async (name: string) => {
    setBusy(name);
    setNote(null);
    const said = await replayPlay(name);
    setBusy(null);
    setNote(said);
  };
  const remove = async (name: string) => {
    const result = await deletePlay({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, name },
    });
    if (result._tag === "Failure") setNote(String(squashAtomCommandFailure(result)));
    else setDeleted(new Set([...deleted, name]));
  };
  return (
    <div className="flex flex-col">
      {reading.value.plays
        .filter((play) => !deleted.has(play.name))
        .map((play) => (
          <div key={play.name} className="group/play flex h-7 min-w-0 items-center gap-2">
            <FlagIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Text variant="meta" tone="default" truncate render={<span className="flex-1" />}>
              {play.name}
            </Text>
            <Text
              variant="caption"
              tone={play.reading === "same" ? "muted" : "inherit"}
              numeric
              truncate
              render={
                <span
                  className={cn("shrink-0", play.reading !== "same" && "text-warning-foreground")}
                />
              }
            >
              {READING_WORDS[play.reading]}
              {play.differs === null ? "" : ` · ${Math.round(play.differs.seconds)} s`}
            </Text>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canRead || !rewinds || busy !== null}
              onClick={() => void replay(play.name)}
              aria-label={`Replay ${play.name} on the Stage`}
            >
              {busy === play.name ? (
                <Spinner aria-hidden="true" />
              ) : (
                <PlayIcon aria-hidden="true" />
              )}
              Replay
            </Button>
            <span className="flex w-6 shrink-0 justify-end">
              {canDelete ? (
                // Shown on the row's hover or its own focus, so the list reads clean at rest.
                <span className="flex opacity-0 group-hover/play:opacity-100 focus-within:opacity-100">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost-destructive"
                          aria-label={`Delete ${play.name}`}
                          onClick={() => void remove(play.name)}
                        />
                      }
                    >
                      <Trash2Icon aria-hidden="true" />
                    </TooltipTrigger>
                    <TooltipPopup side="left">Delete this test play</TooltipPopup>
                  </Tooltip>
                </span>
              ) : null}
            </span>
          </div>
        ))}
      {note === null ? null : (
        <Text variant="caption" tone="muted" render={<p />}>
          {note}
        </Text>
      )}
    </div>
  );
}

/** The game frame of the Stage on screen, in the folder's surface. */
const STAGE_FRAME =
  'section[data-game-stage]:not([aria-hidden="true"]) [data-game-play-surface="true"] iframe[data-game-frame]';

/**
 * Puts the Stage's game at a play's shape before it replays: the responsive view at its size
 * when the frame on screen has another shape, then a moment for the game's resize to land.
 */
const showStageAt = async (
  threadKey: string,
  shape: { readonly width: number; readonly height: number } | undefined,
) => {
  const frame = document.querySelector<HTMLIFrameElement>(STAGE_FRAME);
  if (shape === undefined || frame === null || frame.clientWidth === 0) return;
  if (sameShape({ width: frame.clientWidth, height: frame.clientHeight }, shape)) return;
  useGameWorkspaceStore.getState().setStageDevice(threadKey, stageDeviceAt(shape));
  await new Promise((resolve) => window.setTimeout(resolve, 150));
};

// ─── What changed ──────────────────────────────────────────────────────────────

const lines = (count: number) => count.toLocaleString("en-US");

/**
 * The first sentence of the agent's reply for the turn, without its markdown or its Next line: the
 * build's headline in the words of the turn. The reply itself is the chat's.
 */
const firstSentence = (reply: string): string | null => {
  const text = (
    readNextLine(reply) === null ? reply : reply.trimEnd().split("\n").slice(0, -1).join("\n")
  )
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .find(
      (paragraph) => paragraph !== "" && !paragraph.startsWith("#") && !/^[-*\d]/.test(paragraph),
    );
  if (text === undefined) return null;
  const plain = text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ");
  const end = /[.!?](\s|$)/.exec(plain);
  const sentence = end === null ? plain : plain.slice(0, end.index + 1);
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
};

const NO_THINGS: ReadonlyArray<GameThing> = [];

/**
 * A tuned value as a person says it, named from the running game where it can be: "Runner speed
 * 7 → 9.5 m/s". A value first set in the tune file changed from the code's own, which the game
 * reports as the value's default.
 */
const LOOK_PREFIX = gameLookId("");
const LOOK_WORDS: Readonly<Record<string, string>> = {
  color: "colour",
  emissive: "glow colour",
  emissiveIntensity: "glow",
  flatShading: "flat shading",
  scaleX: "scale x",
  scaleY: "scale y",
  scaleZ: "scale z",
  castShadow: "casts shadows",
  receiveShadow: "takes shadows",
};
/** A JSON string value of the tune file's patch as its text; null for anything else. */
const textOf = (raw: string | null): string | null => {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};
/** A look edit as a person says it: "Cabin roof colour #3c4a5c → #b8322a". */
const lookLine = (change: GameTuneChange & { readonly thing: string }) => {
  const name = change.thing.slice(LOOK_PREFIX.length).split(" › ").at(-1) ?? "";
  const slash = change.key.lastIndexOf("/");
  const prop = change.key.slice(slash + 1);
  const material =
    slash === -1
      ? ""
      : change.key
          .slice(0, slash)
          .replace(/^\d+:/, "")
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .toLowerCase();
  if (prop === "name") {
    const whose = [name, slash !== -1 && material === "" ? "material" : material]
      .filter((part) => part !== "")
      .join(" ");
    const given = textOf(change.to);
    return given === null
      ? `${whose} has the game's own name again`
      : `${whose} renamed “${given}”`;
  }
  const said = [name, material, LOOK_WORDS[prop] ?? prop].filter((part) => part !== "").join(" ");
  const shown = (raw: string | null) =>
    raw !== null && (prop === "color" || prop === "emissive") && Number.isFinite(Number(raw))
      ? colourHex(Number(raw))
      : raw;
  const from = shown(change.from);
  const to = shown(change.to) ?? "the game's own";
  return from === null ? `${said} set to ${to}` : `${said} ${from} → ${to}`;
};

const tuneLine = (change: GameTuneChange, things: ReadonlyArray<GameThing>) => {
  if (change.thing?.startsWith(LOOK_PREFIX) === true)
    return lookLine({ ...change, thing: change.thing });
  const thing =
    change.thing === null ? null : (things.find((each) => each.id === change.thing) ?? null);
  const value = thing?.values?.find((each) => each.key === change.key);
  const name =
    `${thing?.name ?? change.thing ?? ""} ${(value === undefined ? change.key : valueLabel(value)).toLowerCase()}`.trim();
  const own = value?.default === undefined ? null : String(value.default);
  const from = change.from ?? own;
  const to = change.to ?? own ?? "the game's own";
  const unit = value?.unit === undefined ? "" : ` ${value.unit}`;
  return from === null ? `${name} set to ${to}${unit}` : `${name} ${from} → ${to}${unit}`;
};

/** A test play that no longer ends as it was recorded, as a person says it. */
const savedPlayLine = (play: {
  readonly name: string;
  readonly reading: GameSavedPlayReading;
  readonly differs: { readonly seconds: number } | null;
}) =>
  play.reading === "plays-differently"
    ? `Test play "${play.name}" now plays differently${play.differs === null ? "" : ` at ${Math.round(play.differs.seconds)} s`}`
    : play.reading === "ending-changed"
      ? `Test play "${play.name}" now ends differently`
      : play.reading === "cannot-replay"
        ? `Test play "${play.name}" can no longer be replayed`
        : null;

/** The most change lines said at once; the rest are counted. */
const CHANGE_LINES = 4;

/**
 * What the build changed, in plain words first: the turn's headline, the values it tuned and the
 * readings that moved since the build before. Then one quiet line of its files, which opens to a
 * row per file; a file opens T3's diff view on it, as a chat turn's files do.
 */
function WhatChanged({
  threadRef,
  build,
  list,
  onOpenTurnDiff,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const turn =
    build.source._tag === "turn" && build.source.threadId === threadRef.threadId
      ? build.source.turn
      : null;
  const runId =
    useThreadCheckpointSummaries(threadRef).find((entry) => entry.checkpointTurnCount === turn)
      ?.runId ?? null;
  const reply = useThreadProjection(
    runId === null ? null : threadRef,
  )?.projection.messages.findLast(
    (message) => message.role === "assistant" && !message.streaming && message.runId === runId,
  );
  const things = useThreadStageBridge(
    scopedThreadKey(threadRef),
    (state) => state.things,
    NO_THINGS,
  );
  const facts = useEnvironmentQuery(
    build.available
      ? gameEnvironment.buildFacts({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, build: refOf(build) },
        })
      : null,
  ).data;
  const moved = useChangedSinceBase(threadRef, build, list);
  const changes = useEnvironmentQuery(
    build.available
      ? gameEnvironment.buildChanges({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, build: build.id },
        })
      : null,
  );
  const source = build.source;
  // A keep-going step's build is named by its step: a step the time cap cut off ends on a
  // progress line ("Rendering a review of the Blender queen."), never on what it changed.
  const headline =
    (source._tag === "turn" && source.step !== null ? buildCaption(build) : null) ??
    (reply === undefined ? null : firstSentence(reply.text)) ??
    (source._tag === "version"
      ? source.approach.trim() || source.request.trim()
      : source._tag === "turn"
        ? buildCaption(build)
        : null);
  const savedPlays =
    facts?.savedPlays.status === "measured"
      ? facts.savedPlays.value.plays.flatMap((play) => {
          const line = savedPlayLine(play);
          return line === null ? [] : [line];
        })
      : [];
  // A reading that got worse is a problem Checks lists under it: said once, there.
  const movedLines = (moved?.changed ?? [])
    .filter((row) => row.id !== "saved-plays" && row.tone !== "worse")
    // The check's name is a sentence of its own ("The first minute plays clean"), as in Compare.
    .map((row) => `${row.name}: ${row.a ?? "not measured"} → ${row.b ?? "not measured"}`);
  const said = [
    ...(changes.data?.tunes ?? []).map((change) => tuneLine(change, things)),
    ...savedPlays,
    ...movedLines,
  ];
  const shownLines = said.slice(0, headline === null ? CHANGE_LINES : CHANGE_LINES - 1);
  const files = changes.data?.files ?? build.files;
  const count = changes.data?.count ?? build.fileCount;
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);
  const openDiff = (path?: string) => {
    if (runId !== null) onOpenTurnDiff(runId, path);
  };
  return (
    <section aria-label="What changed" className="flex flex-col">
      <div className="flex flex-col gap-1 px-4 pb-1">
        {headline === null ? null : (
          <Text variant="body" tone="default" render={<p className="break-words" />}>
            {headline}
          </Text>
        )}
        {shownLines.length === 0 ? null : (
          <ul className="flex flex-col gap-0.5">
            {shownLines.map((line) => (
              <Text
                key={line}
                variant="meta"
                tone="muted"
                numeric
                render={<li className="break-words" />}
              >
                <SwatchText text={line} />
              </Text>
            ))}
            {said.length > shownLines.length ? (
              <Text variant="caption" tone="muted" render={<li />}>
                and {said.length - shownLines.length} more
              </Text>
            ) : null}
          </ul>
        )}
        {headline === null && shownLines.length === 0 && changes.data !== null ? (
          <Text variant="meta" tone="muted" render={<p />}>
            {count === null
              ? "The first build: everything in it is new."
              : "No change to say in words."}
          </Text>
        ) : null}
      </div>
      {changes.data === null && changes.error === null && build.available ? (
        <div className="px-4 py-1.5">
          <Skeleton className="h-3 w-40" />
        </div>
      ) : files.length === 0 ? null : (
        <>
          {/* The files, quietly: one line that opens to a row per file. */}
          <div className="flex h-7 min-w-0 items-center gap-1 ps-2 pe-2">
            <Button
              size="xs"
              variant="ghost-muted"
              aria-expanded={filesOpen}
              onClick={() => setFilesOpen(!filesOpen)}
            >
              <ChevronRightIcon
                aria-hidden="true"
                className={cn("motion-popup transition-transform", filesOpen && "rotate-90")}
              />
              <Text variant="caption" tone="inherit" numeric>
                {count === 1 ? "1 file" : `${count ?? files.length} files`}{" "}
                <span className="text-success">+{lines(added)}</span>{" "}
                <span className="text-destructive-foreground">−{lines(removed)}</span>
              </Text>
            </Button>
            {runId === null ? null : (
              <Button size="xs" variant="ghost-muted" onClick={() => openDiff()}>
                Open diff
              </Button>
            )}
          </div>
          {filesOpen ? (
            <ul className="flex flex-col">
              {files.map((file) => {
                const slash = file.path.lastIndexOf("/");
                const body = (
                  <>
                    <Text
                      variant="meta"
                      tone="default"
                      truncate
                      render={<span className="flex-1" />}
                    >
                      {slash === -1 ? null : (
                        <span className="text-muted-foreground">
                          {file.path.slice(0, slash + 1)}
                        </span>
                      )}
                      {file.path.slice(slash + 1)}
                    </Text>
                    <Text
                      variant="caption"
                      tone="muted"
                      numeric
                      render={<span className="shrink-0" />}
                    >
                      <span className="text-success">+{lines(file.additions)}</span>{" "}
                      <span className="text-destructive-foreground">−{lines(file.deletions)}</span>
                    </Text>
                  </>
                );
                return (
                  <li key={file.path} className="flex px-2">
                    {runId === null ? (
                      <div className="flex h-7 min-w-0 flex-1 items-center gap-2 ps-2 pe-2">
                        {body}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openDiff(file.path)}
                        aria-label={`Open the diff of ${file.path}`}
                        className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md ps-2 pe-2 text-left outline-none hover:surface-selected-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      >
                        {body}
                      </button>
                    )}
                  </li>
                );
              })}
              {count !== null && count > files.length ? (
                <Text variant="caption" tone="muted" render={<li className="px-4 py-1" />}>
                  and {count - files.length} more
                </Text>
              ) : null}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

// ─── Console ───────────────────────────────────────────────────────────────────

/** The most lines the console shows; the store keeps the last few hundred. */
const CONSOLE_LINES = 120;

/**
 * The game page's console as a plain log, newest at the bottom, with how many errors and
 * warnings it holds: only once the game logged an error or a warning. Folded to its counts until
 * opened: a renderer's raw shader dump is for whoever chases it, not the build's checks.
 */
function ChecksConsole({ threadKey }: { threadKey: string }) {
  const { lines, dropped } = useStageConsole(threadKey);
  const [open, setOpen] = useState(false);
  const errors = lines.filter((line) => line.level === "error").length;
  const warnings = lines.filter((line) => line.level === "warn").length;
  if (errors === 0 && warnings === 0) return null;
  const shown = lines.slice(-CONSOLE_LINES);
  const older = dropped + lines.length - shown.length;
  return (
    <Workbench.Section
      title="Console"
      detail={[
        errors === 0 ? null : `${errors} ${errors === 1 ? "error" : "errors"}`,
        warnings === 0 ? null : `${warnings} ${warnings === 1 ? "warning" : "warnings"}`,
        older === 0 ? null : `${older} older not kept`,
      ]
        .filter((part) => part !== null)
        .join(" · ")}
      aside={
        <>
          {open ? (
            <Button size="xs" variant="ghost" onClick={() => clearStageConsole(threadKey)}>
              Clear
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"}
          </Button>
        </>
      }
    >
      {open ? (
        <div className="flex flex-col gap-0.5 py-1">
          {shown.map((line) => (
            <LogLine key={line.n} line={line} />
          ))}
        </div>
      ) : null}
    </Workbench.Section>
  );
}

/** One log line: the game second it came at, then the text, coloured by its level. */
function LogLine({ line }: { line: StageConsoleLine }) {
  return (
    <div className="flex items-start gap-3 ps-4 pe-4 leading-5">
      <Text
        variant="caption"
        tone="dim"
        numeric
        render={<span className="w-10 shrink-0 text-end" />}
      >
        {line.t < 60 ? line.t.toFixed(1) : clockLabel(line.t)}
      </Text>
      <Text
        variant="caption"
        tone={
          line.level === "error"
            ? "destructive"
            : line.level === "log" || line.level === "renderer"
              ? "muted"
              : "inherit"
        }
        mono
        render={
          <span
            className={cn(
              "min-w-0 flex-1 break-words whitespace-pre-wrap",
              line.level === "warn" && "text-warning-foreground",
            )}
          />
        }
      >
        {line.text}
      </Text>
    </div>
  );
}
