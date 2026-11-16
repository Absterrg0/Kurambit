import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import {
  gameChecksView,
  ownsUndo,
  playOutcomeWords,
  type GameBuild,
  type GameBuildFacts,
  type GameBuildsResult,
  type GameCheck,
  type GameFactView,
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
  ColumnsIcon,
  FileSearchIcon,
  FileVideoIcon,
  FlagIcon,
  GitCompareIcon,
  ImageIcon,
  LoaderCircleIcon,
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
import { useRightPanelStore } from "../../rightPanelStore";
import {
  useQuietThreadShell,
  useThreadCheckpointSummaries,
  useThreadProjection,
} from "../../state/entities";
import { gameEnvironment, stagePlayTarget } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { openExpandedImagePreview } from "../chat/ExpandedImageDialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { refOf } from "./gameBuildRef";
import {
  buildCaption,
  buildName,
  buildPhrase,
  formatBuildTime,
  notMeasuredWhy,
  qaLines,
  silentControlsNote,
  undoOutcome,
} from "./gameBuilds.logic";
import { stageBuildId } from "./gameBuildTimeline.logic";
import { replayStageRun, useThreadStageBridge } from "./gameStageBridge";
import { turnStripRestore } from "./gameTurnBuild.logic";
import { restoreQuestion, useBuildRestore, useMeasureOnOpen } from "./useBuildActions";
import { useTurnLanding } from "./useTurnLanding";
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
  onOpenTurnDiff,
}: {
  threadRef: ScopedThreadRef;
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
  if (build === null)
    return (
      <Workbench.Empty
        icon={<ClipboardCheckIcon />}
        title={
          working || landing
            ? "Build 1 is being made"
            : shell?.latestRun == null
              ? "Build 1 comes from your first change"
              : "No build yet"
        }
        // A game whose turn has run is never told its first change is still to come: the turn's
        // build may be a moment from landing, or the turn changed nothing.
        body={
          working || landing
            ? "When the agent's turn ends it plays on the Stage, and a bot plays it to check it."
            : shell?.latestRun == null
              ? "Tell your game what to change in the chat. Your agent's change becomes build 1, and its checks show here."
              : "Build 1 lands here when a turn of your agent changes the game."
        }
      />
    );
  const side = inspected?.side;
  const where =
    side !== undefined
      ? `Compare, side ${side}`
      : build.id === onStageId
        ? "On the Stage"
        : onStageId === null && inspected === null
          ? "The game changed since; the next build measures it"
          : "Not on the Stage";
  return (
    <Workbench.Body key={build.id}>
      <BuildHeader
        threadRef={threadRef}
        build={build}
        list={data}
        where={where}
        onBackToStage={
          inspected !== null && side === undefined && build.id !== onStageId
            ? () => inspectBuild(null)
            : null
        }
      />
      <WhatChanged
        threadRef={threadRef}
        build={build}
        list={data}
        onOpenTurnDiff={onOpenTurnDiff}
      />
      <BuildChecks threadRef={threadRef} build={build} />
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
 * what can be done with it: compare, and its one restore by the strip's rules.
 */
function BuildHeader({
  threadRef,
  build,
  list,
  where,
  onBackToStage,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult;
  where: string;
  /** Shows the build on the Stage again, when this one was picked and is not on it. */
  onBackToStage: (() => void) | null;
}) {
  const canAct = useAtomValue(gameEnvironment.action.permissionAtom(threadRef.environmentId));
  const restores = useBuildRestore(threadRef, list.restore);
  // The quiet shell: a streaming turn does not re-render the Workbench.
  const turnRunning = threadRuntimeIsActive(useQuietThreadShell(threadRef)?.runtime);
  const requestStage = useGameWorkspaceStore((state) => state.requestStage);
  const onStageNow = stageBuildId(list, useAtomValue(stagePlayTarget(threadRef))?.build ?? null);
  const latestUndoable = list.builds.find((entry) => ownsUndo(entry.source)) ?? null;
  const action = !canAct
    ? null
    : turnStripRestore(
        {
          build,
          latest: build.id === latestUndoable?.id,
          restore: list.restore,
          current: list.current,
          folderEdited: list.folderEdited,
        },
        turnRunning,
      );
  const index = list.builds.findIndex((entry) => entry.id === build.id);
  const previous =
    list.builds.find((entry) => entry.id === build.base) ??
    (index === -1 ? undefined : list.builds[index + 1]);
  const kind = action === null ? null : RESTORE[action.kind];
  const error = action === null ? null : restores.error(action.target);
  const canCompare = previous !== undefined && build.available && previous.available;
  const canPlay = build.available && build.id !== onStageNow;
  // Any other build can be its other side: the strip picks it, with this one already first.
  const canPickCompare = build.available && list.builds.some((entry) => entry.id !== build.id);
  return (
    <div className="flex flex-col gap-1 pt-2.5 pb-2">
      <div className="flex min-h-10 items-center gap-2 ps-4 pe-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <Text variant="label" tone="strong" truncate render={<h2 />}>
            {buildName(build)}
          </Text>
          <Text variant="caption" tone="muted" numeric truncate>
            {where} · {formatBuildTime(build.at)}
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
        {(action !== null && kind !== null) || canCompare || canPickCompare ? (
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label={`${buildName(build)} actions`} />
              }
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup side="bottom" align="end" sideOffset={4} className="w-64">
              {canCompare && previous !== undefined ? (
                <MenuItem
                  onClick={() =>
                    requestStage({ kind: "compare", pair: [refOf(previous), refOf(build)] })
                  }
                >
                  {/* Two-line items keep their icon on the title's line, like one-line ones. */}
                  <ColumnsIcon className="mt-0.5 self-start" />
                  <span className="flex min-w-0 flex-col">
                    Compare with the build before
                    <Text variant="caption" tone="muted" truncate>
                      {buildName(previous)}
                    </Text>
                  </span>
                </MenuItem>
              ) : null}
              {canPickCompare ? (
                <MenuItem onClick={() => requestStage({ kind: "compare", first: refOf(build) })}>
                  <GitCompareIcon />
                  Compare with another build…
                </MenuItem>
              ) : null}
              {(canCompare || canPickCompare) && action !== null && kind !== null ? (
                <MenuSeparator />
              ) : null}
              {action !== null && kind !== null ? (
                <MenuItem
                  disabled={action.blocked !== null || !restores.canRestore || restores.pending}
                  onClick={() =>
                    void restores.send(
                      action.target,
                      action.kind === "go-back" ? restoreQuestion(buildName(build)) : null,
                    )
                  }
                >
                  <Undo2Icon className="mt-0.5 self-start" />
                  <span className="flex min-w-0 flex-col">
                    {restores.restoring(action.target)
                      ? kind.busy
                      : kind.label(buildPhrase(buildName(build)))}
                    <Text variant="caption" tone="muted">
                      {action.blocked ??
                        (action.kind === "undo"
                          ? undoOutcome(
                              previous === undefined ? null : buildName(previous),
                              list.folderEdited === true,
                            )
                          : action.kind === "redo"
                            ? "The game becomes this build again"
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
  "skilled",
  "performance",
  "use",
  "qa",
  "screens",
] as const satisfies ReadonlyArray<keyof GameBuildFacts>;

/** A measuring build's facts with each reading still to come taken from its last measure. */
function withLastReadings(facts: GameBuildFacts, last: GameBuildFacts | null): GameBuildFacts {
  if (last === null) return facts;
  const merged: Record<(typeof FACT_KEYS)[number], unknown> = { ...facts };
  for (const key of FACT_KEYS)
    if (facts[key].status === "pending" && last[key].status === "measured") merged[key] = last[key];
  return { ...facts, ...(merged as Pick<GameBuildFacts, (typeof FACT_KEYS)[number]>) };
}

function BuildChecks({ threadRef, build }: { threadRef: ScopedThreadRef; build: GameBuild }) {
  const facts = useEnvironmentQuery(
    build.available
      ? gameEnvironment.buildFacts({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, build: refOf(build) },
        })
      : null,
  );
  const measure = useMeasureOnOpen(threadRef);
  // Shown, by a card or a link: a build that never was measured is, once, and so is one an
  // older harness measured (after an update), so its readings compare with the others'.
  const owesMeasure =
    build.available && (build.facts.state === "never" || build.facts.state === "stale");
  const sendMeasure = measure.send;
  useEffect(() => {
    if (owesMeasure) void sendMeasure(build.id);
  }, [owesMeasure, build.id, sendMeasure]);
  // While the build is measured again, what it measured before stands until new readings land,
  // so a pass never blinks out and back.
  const [lastSettled, setLastSettled] = useState<GameBuildFacts | null>(null);
  const read = facts.data;
  const busy = read !== null && (read.state === "measuring" || read.state === "queued");
  if (read !== null && !busy && read.state !== "never" && read !== lastSettled)
    setLastSettled(read);
  const shown = read === null ? null : withLastReadings(read, busy ? lastSettled : null);
  const answer = measure.answer(build.id);
  const canMeasureAgain =
    measure.canMeasure && build.available && shown !== null && shown.state !== "never" && !busy;
  return (
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
          <LoaderCircleIcon className="me-1.5 size-3.5 animate-spin text-muted-foreground" />
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
      ) : shown.state === "never" ? (
        <div className="flex flex-col items-start gap-2 px-4 py-1">
          <Text variant="meta" tone="muted" render={<p />}>
            {shown.message.trim() === ""
              ? "Not measured yet. A bot plays this build and its checks land here."
              : shown.message}
          </Text>
          {measure.canMeasure ? (
            <Button size="xs" variant="outline" onClick={() => void measure.send(build.id, true)}>
              Measure now
            </Button>
          ) : null}
        </div>
      ) : (
        <CheckRows threadRef={threadRef} facts={shown} />
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

function CheckRows({ threadRef, facts }: { threadRef: ScopedThreadRef; facts: GameBuildFacts }) {
  const view = gameChecksView(facts);
  const measured = view.checks.filter((check) => check.reading._tag === "measured");
  const pending = view.checks.filter((check) => check.reading._tag === "pending").length;
  // Context that changes how to read a row, never a finding of its own: said on hover.
  const noteOf = (fact: GameFactView): string | null =>
    fact.id === "performance" && facts.renderer
      ? `Played with ${facts.renderer}.`
      : fact.id === "controls"
        ? silentControlsNote(facts)
        : null;
  const passing = measured.filter(
    (check) => check.reading._tag === "measured" && check.reading.tone === "good",
  );
  const rest = measured.filter((check) => !passing.includes(check));
  const busy = facts.state === "measuring" || facts.state === "queued";
  const row = (check: GameCheck) => (
    <div key={check.id} className="flex flex-col">
      <CheckRow
        threadRef={threadRef}
        check={check}
        // What stopped a game from starting, and what a player would hit, are the things to
        // fix first: said, not hovered.
        detail={
          check.id === "boots" && facts.boots.status === "measured" && !facts.boots.value.ok
            ? [facts.boots.value.detail]
            : check.reading._tag === "measured" && check.reading.tone === "bad"
              ? qaLines(facts, check.id)
              : []
        }
        note={noteOf(check)}
      />
      {check.id === "saved-plays" ? <SavedPlays threadRef={threadRef} facts={facts} /> : null}
    </div>
  );
  return (
    <div className="flex flex-col">
      {/* The passing checks fold into one line; what is left to look at is listed under it.
          While measuring, the line waits for a first pass rather than say "0". */}
      {busy && passing.length === 0 ? null : (
        <PassingLine
          label={
            busy
              ? `${passing.length} pass so far`
              : `${passing.length} of ${view.checks.length} pass`
          }
          failed={rest.some(
            (check) => check.reading._tag === "measured" && check.reading.tone === "bad",
          )}
          count={passing.length}
        >
          {passing.map(row)}
        </PassingLine>
      )}
      {rest.map(row)}
      {pending > 0 ? (
        <Workbench.Row
          mark={<ClockIcon className="text-dim-foreground" aria-hidden="true" />}
          name={pendingWords(
            pending,
            facts.state === "measuring" || facts.state === "queued" ? facts.message : "",
          )}
          muted
        />
      ) : null}
      <NotMeasured checks={view.checks} note={noteOf} />
    </div>
  );
}

/**
 * The checks' one summary line ("6 of 9 pass"), which opens to the passing checks folded into it.
 */
function PassingLine({
  label,
  failed,
  count,
  children,
}: {
  label: string;
  failed: boolean;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const mark = failed ? (
    <TriangleAlertIcon className="text-warning" aria-hidden="true" />
  ) : (
    <CheckIcon className="text-success" aria-hidden="true" />
  );
  return (
    <>
      {count === 0 ? (
        <Workbench.Row mark={mark} name={label} />
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="cursor-pointer text-left outline-none hover:surface-selected-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <Workbench.Row
            mark={mark}
            name={label}
            end={
              <ChevronRightIcon
                className={cn(
                  "size-3.5 text-dim-foreground motion-popup transition-transform",
                  open && "rotate-90",
                )}
                aria-hidden="true"
              />
            }
          />
        </button>
      )}
      {open ? <div className="flex flex-col ps-5">{children}</div> : null}
    </>
  );
}

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

function CheckRow({
  threadRef,
  check,
  detail,
  note,
}: {
  threadRef: ScopedThreadRef;
  check: GameCheck;
  detail: ReadonlyArray<string>;
  /** Said on hover after the raw reading. */
  note: string | null;
}) {
  const proves = check.value === null ? check.sentence : `${check.sentence} ${check.value}`;
  return (
    <>
      <Workbench.Row
        mark={<CheckMark check={check} />}
        name={
          <Tooltip>
            <TooltipTrigger render={<span />}>{check.sentence}</TooltipTrigger>
            <TooltipPopup side="left" className="max-w-sm">
              <span className="flex flex-col gap-1">
                <span>
                  {check.label}:{" "}
                  {check.reading._tag === "measured" ? check.reading.text : check.sentence}
                </span>
                {note === null ? null : <span>{note}</span>}
              </span>
            </TooltipPopup>
          </Tooltip>
        }
        reading={check.value}
        end={<Evidence threadRef={threadRef} check={check} proves={proves} />}
      />
      {detail.length > 0 ? (
        <ul className="flex flex-col gap-0.5 ps-9.5 pe-4 pb-1.5">
          {detail.map((line) => (
            <Text key={line} variant="caption" tone="muted" render={<li className="break-words" />}>
              {line}
            </Text>
          ))}
        </ul>
      ) : null}
    </>
  );
}

type RunEvidence = GameFactView["evidence"][number];
const EVIDENCE_ICON = { video: FileVideoIcon, frame: ImageIcon, log: ScrollTextIcon } as const;

/**
 * A recording or frame opens in a lightbox sized to it, with the check it proves; its files are
 * one explicit "Show files" away. A log is a file, so it opens as one.
 */
function openEvidence(
  threadRef: ScopedThreadRef,
  root: string | null,
  item: RunEvidence,
  detail: string,
) {
  const showFiles = () => useRightPanelStore.getState().openFile(threadRef, item.path);
  if (item.kind === "log" || root === null) {
    showFiles();
    return;
  }
  const kind = item.kind === "video" ? "video" : "image";
  openExpandedImagePreview(scopedThreadKey(threadRef), {
    index: 0,
    images: [
      {
        src: null,
        name: item.label,
        ...(kind === "video" ? { type: "video" as const } : {}),
        detail,
        fileAction: "Show files",
        actionsSource: {
          kind,
          name: item.label,
          src: null,
          asset: {
            environmentId: threadRef.environmentId,
            resource: { _tag: "draft-workspace-file", cwd: root, path: item.path },
          },
          onOpenFile: showFiles,
        },
      },
    ],
  });
}

/** The row's recording, frame or log; several open from a menu. */
function Evidence({
  threadRef,
  check,
  proves,
}: {
  threadRef: ScopedThreadRef;
  check: GameCheck;
  proves: string;
}) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const [only] = check.evidence;
  if (only === undefined) return null;
  if (check.evidence.length === 1) {
    const EvidenceIcon = EVIDENCE_ICON[only.kind];
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={only.label}
              onClick={() => openEvidence(threadRef, root, only, proves)}
            />
          }
        >
          <EvidenceIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="left">{only.label}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label={`${check.label}: evidence`} />
        }
      >
        <FileSearchIcon aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end">
        {check.evidence.map((item) => {
          const EvidenceIcon = EVIDENCE_ICON[item.kind];
          return (
            <MenuItem key={item.path} onClick={() => openEvidence(threadRef, root, item, proves)}>
              <EvidenceIcon />
              {item.label}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

/** Why a build's checks could not be read when the build itself does not start. */
const DID_NOT_START = "the game did not start, so the bots could not play it";

/** Checks not measured, one row per reason, the reason on hover. */
function NotMeasured({
  checks,
  note,
}: {
  checks: ReadonlyArray<GameCheck>;
  note: (fact: GameFactView) => string | null;
}) {
  // A build that does not start leaves every other check unread for that one reason.
  const startFailed = checks.some(
    (check) =>
      check.id === "boots" && check.reading._tag === "measured" && check.reading.tone === "bad",
  );
  const folded = new Map<string, Array<GameCheck>>();
  for (const check of checks)
    if (check.reading._tag === "not-measured") {
      const why = startFailed ? DID_NOT_START : notMeasuredWhy(check.reading);
      folded.set(why, [...(folded.get(why) ?? []), check]);
    }
  return [...folded].map(([why, group]) => {
    const names = group.map((check) => check.sentence);
    const notes = group.map(note).filter((line) => line !== null);
    const said =
      why === DID_NOT_START
        ? `${names.length} not measured: it did not start`
        : names.length > 2
          ? `${names.length} not measured`
          : names.join(" · ");
    return (
      <Workbench.Row
        key={why}
        mark={<MinusIcon className="text-dim-foreground" aria-hidden="true" />}
        muted
        name={
          <Tooltip>
            <TooltipTrigger render={<span />}>
              {said}
              <span className="sr-only"> (not measured)</span>
            </TooltipTrigger>
            <TooltipPopup side="left" className="max-w-sm">
              <span className="flex flex-col gap-1">
                {names.length > 2 ? <span>{names.join(", ")}.</span> : null}
                <span>
                  Not measured: {why}
                  {/[.!?]$/.test(why) ? "" : "."}
                </span>
                {notes.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </span>
            </TooltipPopup>
          </Tooltip>
        }
      />
    );
  });
}

/** The rows' own shape while they are read, so nothing under them moves when they land. */
const SKELETON_CHECKS = [
  "Starts without errors",
  "No errors while playing",
  "Every control works",
  "Retry starts clean",
  "HUD fits the screen",
  "Holds its frame rate",
  "Not yet proven winnable",
] as const;

function CheckRowsLoading() {
  return (
    <div aria-busy="true" className="flex flex-col">
      {SKELETON_CHECKS.map((name) => (
        <Workbench.Row key={name} mark={<span />} name={name} muted />
      ))}
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
function SavedPlays({ threadRef, facts }: { threadRef: ScopedThreadRef; facts: GameBuildFacts }) {
  const reading = facts.savedPlays;
  const loadPlay = useAtomCommand(gameEnvironment.savedPlay, { reportFailure: false });
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
    const result = await loadPlay({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, name },
    });
    if (result._tag === "Failure") {
      setBusy(null);
      setNote(String(squashAtomCommandFailure(result)));
      return;
    }
    // From its start at its own pace, to its end, where the Stage holds it.
    const replayed = await replayStageRun({
      play: result.value,
      step: result.value.steps,
      pace: 0,
    });
    setBusy(null);
    if (replayed === null) setNote("The game on the Stage could not replay it.");
    else if (replayed.ended != null)
      setNote(`On the Stage it ${playOutcomeWords(replayed.ended)}.`);
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
          <div
            key={play.name}
            className="group/play flex h-7 min-w-0 items-center gap-2 ps-9.5 pe-2"
          >
            <button
              type="button"
              disabled={!canRead || !rewinds || busy !== null}
              onClick={() => void replay(play.name)}
              aria-label={`Replay ${play.name} on the Stage`}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
            >
              {busy === play.name ? (
                <LoaderCircleIcon
                  className="size-3 shrink-0 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              ) : (
                <FlagIcon
                  className="size-3 shrink-0 text-muted-foreground group-hover/play:hidden"
                  aria-hidden="true"
                />
              )}
              {busy === play.name ? null : (
                <PlayIcon
                  className="hidden size-3 shrink-0 text-foreground group-hover/play:block"
                  aria-hidden="true"
                />
              )}
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
            </button>
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
        <Text variant="caption" tone="muted" render={<p className="ps-9.5 pe-4 pb-1" />}>
          {note}
        </Text>
      )}
    </div>
  );
}

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
const tuneLine = (change: GameTuneChange, things: ReadonlyArray<GameThing>) => {
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

/** A saved play that no longer ends as it was recorded, as a person says it. */
const savedPlayLine = (play: {
  readonly name: string;
  readonly reading: GameSavedPlayReading;
  readonly differs: { readonly seconds: number } | null;
}) =>
  play.reading === "plays-differently"
    ? `Saved play "${play.name}" now plays differently${play.differs === null ? "" : ` at ${Math.round(play.differs.seconds)} s`}`
    : play.reading === "ending-changed"
      ? `Saved play "${play.name}" now ends differently`
      : play.reading === "cannot-replay"
        ? `Saved play "${play.name}" can no longer be replayed`
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
  const headline =
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
  const movedLines = (moved?.changed ?? [])
    .filter((row) => row.id !== "saved-plays")
    .map((row) => `${row.name} ${row.a ?? "not measured"} → ${row.b ?? "not measured"}`);
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
    <Workbench.Section title="What changed">
      <div className="flex flex-col gap-1 px-4 pb-1.5">
        {headline === null ? null : (
          <Text variant="body" tone="strong" render={<p className="break-words" />}>
            {headline}
          </Text>
        )}
        {shownLines.length === 0 ? null : (
          <ul className="flex flex-col gap-0.5">
            {shownLines.map((line) => (
              <Text
                key={line}
                variant="meta"
                tone="default"
                numeric
                render={<li className="break-words" />}
              >
                {line}
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
    </Workbench.Section>
  );
}
