import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { stageBuildId } from "./gameBuildTimeline.logic";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  ColumnsIcon,
  GitCompareIcon,
  FileSearchIcon,
  FileVideoIcon,
  ImageIcon,
  InfoIcon,
  MinusIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  GAME_ENGINES,
  GAME_STYLE_FILE,
  GameStyle,
  gameChecksView,
  gameFactsView,
  type GameBuild,
  type GameBuildFacts,
  type GameBuildsResult,
  type GameCheck,
  type GameFactId,
  type GameFactView,
  type GameThing,
  type GameThingValue,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { useDiffPanelStore } from "../../diffPanelStore";
import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { openExpandedImagePreview } from "../chat/ExpandedImageDialog";
import { cn, randomUUID } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  useQuietThreadShell,
  useThreadCheckpointSummaries,
  useThreadProjection,
} from "../../state/entities";
import { readNextLine } from "@kurambit/shared/gameNextLine";
import ChatMarkdown from "../ChatMarkdown";
import { gameEnvironment, stagePlayTarget } from "../../state/game";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { KbdShortcut } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Separated } from "../ui/separated";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { refOf } from "./gameBuildRef";
import { GameBuildStill, PictureSourceBadge } from "./GameBuildStill";
import {
  characterRouteLabel,
  GameCharacterRoutePicker,
  useCharacterRoute,
} from "./GameCharacterRoute";
import { useGameName } from "./GameName";
import { GameTuneField } from "./GameTuneField";
import { GameGeneratedArt } from "./GameGeneratedArt";
import {
  GameGenerationBody,
  GenerationHeading,
  useChoosingCount,
  useGenerationCount,
  useGameGenerations,
  useGenerationActions,
} from "./GameGenerationCard";
import { GameFileActions, SaveMediaMenuItem } from "./GameSavedMedia";
import {
  assetLibraryNote,
  assetLines,
  assetUseLines,
  buildCaption,
  buildName,
  buildPhrase,
  formatBuildTime,
  plainWhy,
  undoOutcome,
} from "./gameBuilds.logic";
import {
  clearStageSelection,
  forgetStageTuning,
  hoverStageThing,
  resetStageValues,
  selectStageThing,
  tuneStageValue,
  useGameFreezeKey,
  useStageStill,
  useThreadStageBridge,
} from "./gameStageBridge";
import { turnStripRestore } from "./gameTurnBuild.logic";
import { stepVerdictText } from "./keepGoing.logic";
import { restoreQuestion, useBuildRestore, useMeasureOnOpen } from "./useBuildActions";
import { useChangedSinceBase } from "./useChangedSinceBase";
import { useTurnLanding } from "./useTurnLanding";

function Notice({ children }: { children: ReactNode }) {
  return (
    <Text variant="body" tone="muted" render={<p className="p-4" />}>
      {children}
    </Text>
  );
}

/** A titled group. The heading reads above its rows; a count after it stays quieter. */
function Section({
  title,
  detail,
  aside,
  children,
}: {
  title: string;
  /** The summary line: words, or a placeholder holding its line while they are read. */
  detail?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <div className="flex min-h-6 items-center gap-2">
          <Text variant="meta" tone="strong" emphasis render={<h3 />}>
            {title}
          </Text>
          {aside === undefined ? null : <span className="ml-auto flex items-center">{aside}</span>}
        </div>
        {/* The summary has its own line and wraps: no count is ever cut off. */}
        {detail === undefined || detail === null || detail === "" ? null : typeof detail ===
          "string" ? (
          <Text variant="meta" tone="muted" numeric render={<p />}>
            {detail}
          </Text>
        ) : (
          detail
        )}
      </div>
      {children}
    </section>
  );
}

/** Rows on one field surface, split by hairlines. */
function Rows({ children }: { children: ReactNode }) {
  return (
    <div className="surface-card-settings flex flex-col divide-y divide-border overflow-hidden rounded-lg">
      {children}
    </div>
  );
}

// ─── Build ────────────────────────────────────────────────────────────────────

/**
 * The right panel's Build tab: the build picked from the builds list or the chat, else the one on
 * the Stage, with its checks, what it changed and its recordings.
 */
export function GameBuildDetail({ threadRef }: { threadRef: ScopedThreadRef }) {
  // The tab scrolls as a whole: a build's checks, changes and recordings are taller than a window.
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-gutter-both">
      <BuildTab threadRef={threadRef} />
    </div>
  );
}

function BuildTab({ threadRef }: { threadRef: ScopedThreadRef }) {
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
    return list.error === null ? <GameInspectorLoading /> : <Notice>{list.error}</Notice>;
  const onStageId = stageBuildId(data, asked?.build ?? null);
  // The folder changed since its last build: the Stage plays something no build holds yet.
  const nowOnStage = onStageId === null && inspected === null;
  // The list's own row when it holds it, so the facts it shows stay current.
  const build =
    (inspected === null
      ? undefined
      : (data.builds.find((entry) => entry.id === inspected.build) ?? inspected.snapshot)) ??
    data.builds.find((entry) => entry.id === (onStageId ?? data.current)) ??
    data.builds[0] ??
    null;
  if (build === null)
    return working || landing ? (
      <div className="flex flex-col gap-5 p-4">
        <div className="flex flex-col gap-1">
          <Text variant="label" tone="strong" render={<h2 />}>
            Build 1
          </Text>
          <Text variant="meta" tone="muted" render={<p />}>
            {landing
              ? "Being saved. It plays on the Stage in a moment, and a bot plays it to check it."
              : "Being made. When the agent's turn ends it plays on the Stage, and a bot plays it to check it."}
          </Text>
        </div>
      </div>
    ) : (
      <div className="flex flex-col gap-4 p-4">
        <Empty variant="well">
          {/* The top bar already says it is not measured: this says what comes next. A game
              whose turn has run is never told its first change is still to come: the turn's
              build may be a moment from landing, or the turn changed nothing. */}
          <EmptyHeader>
            <EmptyTitle>
              {shell?.latestRun == null ? "Build 1 comes from your first change" : "No build yet"}
            </EmptyTitle>
            <EmptyDescription>
              {shell?.latestRun == null
                ? "Tell your game what to change in the chat. Your agent's change becomes build 1, and a bot plays it and checks it here."
                : "Build 1 lands here when a turn of your agent changes the game."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  const detail = (
    <BuildDetail
      key={build.id}
      threadRef={threadRef}
      build={build}
      list={data}
      // A compare's side is on the compare, not the Stage: it is named by its letter.
      onStage={inspected?.side === undefined && build.id === onStageId}
      heading={
        inspected?.side !== undefined
          ? `Compare · side ${inspected.side}`
          : nowOnStage
            ? "The build it changed from"
            : build.id !== onStageId
              ? "Not on the Stage"
              : null
      }
      onBackToStage={
        inspected !== null && inspected.side === undefined && build.id !== onStageId && !nowOnStage
          ? () => inspectBuild(null)
          : null
      }
    />
  );
  if (!nowOnStage) return detail;
  // What plays now, then a hard line, then the build the checks are from: green ticks
  // under the line are history, never a reading of the game on the Stage.
  return (
    <>
      <div className="flex flex-col gap-0.5 border-b border-border p-4">
        <Text variant="label" tone="strong" render={<h2 />}>
          Now on the Stage
        </Text>
        <Text variant="meta" tone="muted" render={<p />}>
          Not measured yet. The next build measures it.
        </Text>
      </div>
      {detail}
    </>
  );
}

function BuildDetail({
  threadRef,
  build,
  list,
  onStage,
  heading,
  onBackToStage,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult;
  onStage: boolean;
  /** Said over the build when it is shown for a reason other than being picked. */
  heading: string | null;
  /** Shows the build on the Stage again, when this one was picked and is not on it. */
  onBackToStage: (() => void) | null;
}) {
  const facts = useEnvironmentQuery(
    build.available
      ? gameEnvironment.buildFacts({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, build: refOf(build) },
        })
      : null,
  );
  const measure = useMeasureOnOpen(threadRef);
  // Shown, by a card or a link: a build that never was measured is, once.
  const neverMeasured = build.available && build.facts.state === "never";
  const sendMeasure = measure.send;
  useEffect(() => {
    if (neverMeasured) void sendMeasure(build.id);
  }, [neverMeasured, build.id, sendMeasure]);
  // While the build is measured again, what it measured before stands until new readings land,
  // so a pass never blinks out and back; the heading says it is being measured.
  const [lastSettled, setLastSettled] = useState<GameBuildFacts | null>(null);
  const read = facts.data;
  const busy = read !== null && (read.state === "measuring" || read.state === "queued");
  if (read !== null && !busy && read.state !== "never" && read !== lastSettled)
    setLastSettled(read);
  const factsData = read === null ? null : withLastReadings(read, busy ? lastSettled : null);
  const measureAnswer = measure.answer(build.id);
  const source = build.source;
  const step = source._tag === "turn" ? source.step : null;
  // A keep-going step says why it was taken; a person's own request is theirs already.
  const asked =
    source._tag === "saved" || step === null
      ? null
      : { title: "Why", text: buildCaption(build), verdict: stepVerdictText(step) };
  const requestStage = useGameWorkspaceStore((state) => state.requestStage);
  return (
    <div className="@container/build">
      <div className="grid gap-x-10 gap-y-5 p-4 @3xl/build:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          {heading === null ? null : (
            <div className="-mb-3 flex min-h-6 items-center gap-2">
              <Text
                variant="meta"
                tone="strong"
                emphasis
                render={<h3 className="min-w-0 flex-1" />}
              >
                {heading}
              </Text>
              {onBackToStage === null ? null : (
                <Button size="xs" variant="ghost" onClick={onBackToStage}>
                  Show the Stage's build
                </Button>
              )}
            </div>
          )}
          <BuildActions
            threadRef={threadRef}
            build={build}
            list={list}
            onCompare={(other) =>
              requestStage({ kind: "compare", pair: [refOf(other), refOf(build)] })
            }
          >
            {/* The strip above already shows the build's picture; its name and time lead here. */}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Text variant="label" tone="strong" truncate render={<h2 />}>
                {buildName(build)}
              </Text>
              {/* Where it is, then when it was made; it wraps rather than cut either. Each part
              leads with its separator and the line's first one is clipped, so a wrap neither
              ends nor starts a line on it. */}
              <Text variant="meta" tone="muted">
                <Separated nowrap>
                  {onStage ? <span>On the Stage</span> : null}
                  <span>{formatBuildTime(build.at)}</span>
                </Separated>
              </Text>
            </div>
          </BuildActions>
          {asked === null ? null : (
            <Section title={asked.title}>
              <Text
                variant="body"
                render={<p className="border-l-2 border-border py-0.5 ps-2.5 break-words" />}
              >
                {asked.text}
              </Text>
              {asked.verdict === null ? null : (
                <Text variant="meta" tone="muted" render={<p />}>
                  {asked.verdict.charAt(0).toUpperCase() + asked.verdict.slice(1)}
                </Text>
              )}
            </Section>
          )}
          <Section
            // Under another build's heading, the checks name whose they are: never read as the Stage's.
            title={heading === null ? "Checks" : `Checks · ${buildName(build)}`}
            detail={
              factsData !== null && factsData.state !== "never" && build.available ? (
                checksSummary(factsData, busy && factsData.message.trim() !== "")
              ) : factsData === null && facts.error === null && build.available ? (
                // The summary's line, held while the checks are read.
                <Skeleton className="my-0.5 h-3 w-36" />
              ) : null
            }
            aside={
              measure.canMeasure &&
              build.available &&
              factsData !== null &&
              // An unmeasured build's well carries its own Measure now.
              factsData.state !== "never" &&
              factsData.state !== "measuring" &&
              factsData.state !== "queued" ? (
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
                  <TooltipPopup side="top">Measure again</TooltipPopup>
                </Tooltip>
              ) : undefined
            }
          >
            {!build.available ? (
              <Text variant="meta" tone="muted" render={<p />}>
                This build's history was pruned; only what the strip shows is left.
              </Text>
            ) : factsData === null ? (
              facts.error === null ? (
                <ChecksLoading />
              ) : (
                <Text variant="meta" tone="muted" render={<p />}>
                  {facts.error}
                </Text>
              )
            ) : factsData.state === "never" ? (
              <Empty variant="well">
                <EmptyHeader>
                  <EmptyTitle>Not measured yet</EmptyTitle>
                  <EmptyDescription>
                    {factsData.message.trim() === ""
                      ? "A bot plays this build and its checks land here."
                      : factsData.message}
                  </EmptyDescription>
                </EmptyHeader>
                {measure.canMeasure ? (
                  <EmptyContent>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void measure.send(build.id, true)}
                    >
                      Measure now
                    </Button>
                  </EmptyContent>
                ) : null}
              </Empty>
            ) : (
              <>
                <SinceBase threadRef={threadRef} build={build} list={list} />
                <Checks threadRef={threadRef} facts={factsData} />
              </>
            )}
            {/* Only a refusal: a queued or running measurement says so in the line under the title. */}
            {measureAnswer !== null && measureAnswer.failed ? (
              <Text variant="meta" tone="destructive" render={<p role="alert" />}>
                {measureAnswer.text}
              </Text>
            ) : null}
          </Section>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <WhatChanged threadRef={threadRef} build={build} />
          {factsData !== null && factsData.state !== "never" ? (
            <Recordings threadRef={threadRef} build={build} facts={factsData} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * What the build changed in the readings since the build it was made from, in a line, with
 * the way to see them side by side: the change a turn made, without opening Compare. Only
 * once both are measured, so nothing being measured is ever said to differ.
 */
function SinceBase({
  threadRef,
  build,
  list,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult;
}) {
  const requestStage = useGameWorkspaceStore((state) => state.requestStage);
  const since = useChangedSinceBase(threadRef, build, list);
  if (since === null) return null;
  const { base, changed } = since;
  const differ = changed.length;
  const from = buildPhrase(buildName(base));
  return (
    <div className="flex flex-col gap-1 px-1">
      <div className="flex items-center gap-2">
        <Text variant="meta" tone="muted" render={<p className="min-w-0 flex-1" />}>
          {differ === 0
            ? `No reading differs from ${from}.`
            : `${differ} ${differ === 1 ? "reading differs" : "readings differ"} from ${from}:`}
        </Text>
        {differ === 0 ? null : (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => requestStage({ kind: "compare", pair: [refOf(base), refOf(build)] })}
          >
            <GitCompareIcon aria-hidden="true" />
            Compare
          </Button>
        )}
      </div>
      {/* The count is never left to stand for the change: the readings that moved are named,
          from the one before to this one. Compare has the rest. */}
      {changed.slice(0, SINCE_BASE_SHOWN).map((row) => (
        <Text key={row.id} variant="meta" tone="default" numeric render={<p />}>
          {row.name}: <span className="text-muted-foreground">{row.a ?? "not measured"}</span> →{" "}
          {row.b ?? "not measured"}
        </Text>
      ))}
      {differ > SINCE_BASE_SHOWN ? (
        <Text variant="meta" tone="muted" render={<p />}>
          and {differ - SINCE_BASE_SHOWN} more in Compare
        </Text>
      ) : null}
    </div>
  );
}

/** How many changed readings the Build tab names before it sends the rest to Compare. */
const SINCE_BASE_SHOWN = 2;

const EVIDENCE_ICON = { video: FileVideoIcon, frame: ImageIcon, log: ScrollTextIcon } as const;

/**
 * The lead checks as plain sentences under one count, then every other
 * measurement folded away. Facts not measured for the same reason are said
 * once, with the reason, so a missing tool is named once with its fix.
 */
/**
 * The Checks heading's count, of the rows it heads ("5 of 7 pass"), in the
 * words the Log and the strip use for the same build (checksPhrase), so the
 * first number read always matches the rows. Before any reading lands, "0
 * pass" would read as a verdict.
 */
const FACT_KEYS = [
  "boots",
  "idle",
  "masher",
  "skilled",
  "winnableWithoutSkill",
  "liveness",
  "firstResponse",
  "assets",
  "performance",
  "use",
  "scene",
] as const satisfies ReadonlyArray<keyof GameBuildFacts>;

/** A measuring build's facts with each reading still to come taken from its last measure. */
function withLastReadings(facts: GameBuildFacts, last: GameBuildFacts | null): GameBuildFacts {
  if (last === null) return facts;
  const merged: Record<(typeof FACT_KEYS)[number], unknown> = { ...facts };
  for (const key of FACT_KEYS)
    if (facts[key].status === "pending" && last[key].status === "measured") merged[key] = last[key];
  return { ...facts, ...(merged as Pick<GameBuildFacts, (typeof FACT_KEYS)[number]>) };
}

function checksSummary(facts: GameBuildFacts, stepLine: boolean): string {
  const view = gameChecksView(facts);
  const busy = facts.state === "measuring" || facts.state === "queued";
  const shownPass = view.checks.filter(
    (check) => check.reading._tag === "measured" && check.reading.tone === "good",
  ).length;
  const notMeasured = view.checks.filter((check) => check.reading._tag === "not-measured").length;
  // A reading with no verdict (colour that is varied) is counted, so the counts add up to all
  // the checks: the bot measured it and the person judges it.
  const toJudge = view.checks.filter(
    (check) => check.reading._tag === "measured" && check.reading.tone === "neutral",
  ).length;
  const pending = view.checks.filter((check) => check.reading._tag === "pending").length;
  // A build that does not start is its outcome, in the words the strip and the top bar use,
  // not one check to look at among passes.
  if (
    !busy &&
    view.checks.some(
      (check) =>
        check.id === "boots" && check.reading._tag === "measured" && check.reading.tone === "bad",
    )
  )
    return ["Does not start", ...(notMeasured > 0 ? [`${notMeasured} not measured`] : [])].join(
      " · ",
    );
  return [
    // While measuring, the count is what has landed so far, never a verdict out of all of them.
    ...(busy
      ? shownPass > 0
        ? [`${shownPass} pass so far`]
        : []
      : [`${shownPass} of ${view.checks.length} pass`]),
    ...(view.toLook > 0 ? [`${view.toLook} to look at`] : []),
    ...(toJudge > 0 ? [`${toJudge} for you to judge`] : []),
    ...(notMeasured > 0 ? [`${notMeasured} not measured`] : []),
    ...(busy && pending > 0 ? [`${pending} to measure`] : []),
    // A pending row under it says it is measuring, and which step; with none (measuring again
    // over the last readings) the line says it.
    ...(busy && pending === 0
      ? [facts.state === "queued" ? "measuring again soon" : "measuring again"]
      : busy && !stepLine
        ? ["measuring"]
        : []),
  ].join(" · ");
}

function Checks({ threadRef, facts }: { threadRef: ScopedThreadRef; facts: GameBuildFacts }) {
  const characters = useCharacterRoute(threadRef).route;
  const view = gameChecksView(facts);
  const measured = view.checks.filter((check) => check.reading._tag === "measured");
  const pending = view.checks.filter((check) => check.reading._tag === "pending").length;
  const moreMeasured = view.more.filter((more) => more.reading._tag === "measured");
  const morePending = view.more.filter((more) => more.reading._tag === "pending").length;
  const detailOf = (fact: GameFactView): ReadonlyArray<string> =>
    fact.id === "assets" && facts.assets.status === "measured"
      ? assetLines(facts.assets.value)
      : fact.id === "use" && facts.use.status === "measured"
        ? assetUseLines(facts.use.value)
        : [];
  // Context that changes how to read a row, never a finding of its own: said on hover.
  const noteOf = (fact: GameFactView): string | null =>
    fact.id === "assets" && facts.assets.status === "measured"
      ? [
          assetLibraryNote(facts.assets.value),
          characters === null
            ? null
            : `This game makes characters with ${characterRouteLabel(characters)}; change it in the Scene tab.`,
        ]
          .filter((line) => line !== null)
          .join(" ") || null
      : fact.id === "performance" && facts.renderer
        ? `Played with ${facts.renderer}.`
        : null;
  return (
    <div className="flex flex-col gap-2">
      <Rows>
        {measured.map((check) => (
          <CheckRow
            key={check.id}
            threadRef={threadRef}
            fact={check}
            text={check.sentence}
            value={check.value}
            detail={[]}
            note={noteOf(check)}
            lead
          />
        ))}
        {pending > 0 ? (
          <PendingRow
            count={pending}
            step={facts.state === "measuring" || facts.state === "queued" ? facts.message : ""}
          />
        ) : null}
        <NotMeasured facts={view.checks} note={noteOf} />
      </Rows>
      {view.more.length > 0 ? (
        <Rows>
          <Collapsible>
            <CollapsibleTrigger className="group flex min-h-9 w-full items-center gap-2.5 px-3 text-left hover:bg-accent focus-visible:bg-accent">
              <ChevronRightIcon
                className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90"
                aria-hidden="true"
              />
              <Text variant="meta" tone="default" render={<span className="flex-1" />}>
                Other measurements
              </Text>
              {/* How much of this group was measured, so its scope never reads as a second
                  total of the checks above; what passed is in its rows. */}
              <Text variant="meta" tone="muted" numeric>
                {moreMeasured.length === 0
                  ? morePending > 0
                    ? `${morePending} to measure`
                    : "None measured"
                  : `${moreMeasured.length} of ${view.more.length} measured`}
              </Text>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="flex flex-col divide-y divide-border border-t border-border">
                {moreMeasured.map((fact) => (
                  <CheckRow
                    key={fact.id}
                    threadRef={threadRef}
                    fact={fact}
                    text={fact.sentence}
                    value={fact.value}
                    detail={detailOf(fact)}
                    note={noteOf(fact)}
                  />
                ))}
                {morePending > 0 ? <PendingRow count={morePending} /> : null}
                <NotMeasured facts={view.more} note={noteOf} />
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </Rows>
      ) : null}
    </div>
  );
}

/**
 * The checks still to come, as one row of the list: while a bot is playing, what it is doing
 * ("Checking it starts (step 2 of 4)"), since the summary above already counts them.
 */
function PendingRow({ count, step = "" }: { count: number; step?: string }) {
  const doing = step
    .trim()
    .replace(/^Measuring:\s*/i, "")
    .replace(/\.$/, "");
  return (
    <div className="flex min-h-9 items-center gap-2.5 px-3">
      <ClockIcon className="size-4 shrink-0 text-dim-foreground" aria-hidden="true" />
      <Text variant="meta" tone="muted">
        {doing === ""
          ? `${count === 1 ? "1 check" : `${count} checks`} still to measure`
          : `${doing.charAt(0).toUpperCase()}${doing.slice(1)}`}
      </Text>
    </div>
  );
}

/** A list of names as one phrase: the first two, then how many more. */
function namesPhrase(names: ReadonlyArray<string>): string {
  const lower = names.map((name, index) =>
    index === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1),
  );
  if (lower.length <= 2) return lower.join(" and ");
  return `${lower.slice(0, 2).join(", ")} and ${lower.length - 2} more`;
}

/** Facts not measured, one row per reason. */
/**
 * The checks' rows while they are read, in the words and order a measured build's list most
 * often has (a game's play bot comes later, so its row is last), so the rows do not change text
 * or swap places when the readings arrive.
 */
const SKELETON_CHECKS = [
  { name: "Starts without errors", value: false },
  { name: "Can be lost with no input", value: true },
  { name: "Not won by random or no input", value: false },
  { name: "Runs smoothly", value: true },
  { name: "Keeps moving", value: true },
  { name: "Colour is varied", value: true },
  { name: "Can be won by the play bot", value: false },
] as const;

/**
 * The checks list's own shape while it is read: every build is measured on the same checks, so
 * their names and rows are known and nothing under them moves.
 */
function ChecksLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-2">
      <Rows>
        {SKELETON_CHECKS.map((check) => (
          // A loaded row's own boxes, so the list is the height it will be to the pixel.
          <div key={check.name} className="flex flex-col gap-1 px-3 py-1.5">
            <div className="flex min-h-6 items-center gap-2.5">
              <span className="size-4 shrink-0" />
              <Text variant="meta" tone="muted" render={<span className="min-w-0 flex-1" />}>
                {check.name}
              </Text>
              {/* A reading's place only on the checks that have one, so every name keeps the
                  one line it has once the list is read. */}
              {check.value ? <Skeleton className="h-3 w-8" /> : null}
              <span className="w-6 shrink-0" />
            </div>
          </div>
        ))}
      </Rows>
      <Rows>
        <div className="flex min-h-9 items-center px-3">
          <Skeleton className="h-3 w-40" />
        </div>
      </Rows>
    </div>
  );
}

/**
 * The Build tab before its builds are read: a build's header and the named check rows, the
 * shape it has once they are, from the first frame the Inspector is on screen.
 */
function GameInspectorLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-5 p-4">
      <div className="flex items-center gap-3">
        <Skeleton shape="card" className="h-12 w-20" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      {/* The room every loaded header takes before its checks (what was asked, or the build
          the game changed from), so the named rows below it barely move when it is read. */}
      <div className="flex flex-col gap-2">
        <Skeleton className="my-1.5 h-3 w-20" />
        <Skeleton shape="card" className="h-12 w-full" />
      </div>
      <Section title="Checks" detail={<Skeleton className="my-0.5 h-3 w-36" />}>
        <ChecksLoading />
      </Section>
    </div>
  );
}

/** Why a build's checks could not be read when the build itself does not start. */
const DID_NOT_START = "the game did not start, so the bots could not play it";

function NotMeasured({
  facts,
  note,
}: {
  facts: ReadonlyArray<GameCheck>;
  note: (fact: GameFactView) => string | null;
}) {
  // A build that does not start leaves every other check unread for that one reason: one row
  // says so, rather than several rows whose reasons all follow from it.
  const startFailed = facts.some(
    (fact) =>
      fact.id === "boots" && fact.reading._tag === "measured" && fact.reading.tone === "bad",
  );
  const folded = new Map<string, Array<GameCheck>>();
  for (const fact of facts)
    if (fact.reading._tag === "not-measured") {
      const why = startFailed ? DID_NOT_START : fact.reading.why;
      folded.set(why, [...(folded.get(why) ?? []), fact]);
    }
  // One row like every check, the names wrapping rather than cut; every name and
  // why none was measured wait behind its info button.
  return [...folded].map(([why, group]) => {
    const names = group.map((fact) => fact.sentence);
    const notes = group.map(note).filter((line) => line !== null);
    return (
      <div key={why} className="flex min-h-9 items-center gap-2.5 px-3 py-1.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          <MinusIcon className="size-4 text-dim-foreground" aria-hidden="true" />
        </span>
        {/* The dash and the quieter tone say "not measured"; the words would take the
            sentence's room and wrap it. Why, and every name, open in a popover that stays. */}
        <Text variant="meta" tone="muted" render={<span className="min-w-0 flex-1" />}>
          {/* A list of labels is no sentence: past two, the row counts them and its popover names them. */}
          {why === DID_NOT_START
            ? `${names.length} not measured: it did not start`
            : names.length > 2
              ? `${names.length} not measured`
              : namesPhrase(names)}
          {names.length > 2 || why === DID_NOT_START ? null : (
            <span className="sr-only"> (not measured)</span>
          )}
        </Text>
        <span className="flex w-6 shrink-0 items-center justify-end">
          <Popover>
            <PopoverTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Why not measured" />}
            >
              <InfoIcon aria-hidden="true" />
            </PopoverTrigger>
            {/* Under its row, ending at the button: the row it explains stays readable. */}
            <PopoverPopup side="bottom" align="end" width="sm" padding="compact">
              <span className="flex flex-col gap-1.5">
                <Text variant="meta" tone="strong">
                  Not measured
                </Text>
                {names.length > 2 ? (
                  <Text variant="meta" tone="default" render={<span />}>
                    {names.join(", ")}.
                  </Text>
                ) : null}
                <Text variant="meta" tone="muted" render={<span />}>
                  {plainWhy(why).charAt(0).toUpperCase() + plainWhy(why).slice(1)}
                  {/[.!?]$/.test(plainWhy(why)) ? "" : "."}
                </Text>
                {notes.map((line) => (
                  <Text key={line} variant="meta" tone="muted" render={<span />}>
                    {line}
                  </Text>
                ))}
              </span>
            </PopoverPopup>
          </Popover>
        </span>
      </div>
    );
  });
}

/**
 * A recording or frame opens in a lightbox sized to it, over the game screen, with the check it
 * proves; its files are one explicit "Show files" away. A log is a file, so it opens as one.
 */
function openEvidence(
  threadRef: ScopedThreadRef,
  root: string | null,
  item: RunEvidence,
  name: string,
  detail: string | null,
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
        name,
        ...(kind === "video" ? { type: "video" as const } : {}),
        ...(detail === null ? {} : { detail }),
        fileAction: "Show files",
        actionsSource: {
          kind,
          name,
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

function EvidenceButton({
  threadRef,
  item,
  check,
}: {
  threadRef: ScopedThreadRef;
  item: RunEvidence;
  /** The check the evidence proves, said under it. */
  check: string;
}) {
  const EvidenceIcon = EVIDENCE_ICON[item.kind];
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={item.label}
            onClick={() => openEvidence(threadRef, root, item, item.label, check)}
          />
        }
      >
        <EvidenceIcon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup side="top">{item.label}</TooltipPopup>
    </Tooltip>
  );
}

function CheckRow({
  threadRef,
  fact,
  text,
  value,
  detail,
  note,
  lead = false,
}: {
  threadRef: ScopedThreadRef;
  fact: GameFactView;
  text: string;
  value: string | null;
  detail: ReadonlyArray<string>;
  /** Said on hover after the raw reading. */
  note: string | null;
  /** One of the lead checks, which the summary counts: a reading with no verdict gets a glyph. */
  lead?: boolean;
}) {
  const tone = fact.reading._tag === "measured" ? fact.reading.tone : null;
  // A tick passes, a warning is to look at, a dash was not measured. A lead check with no
  // verdict is a hollow ring, counted as one for you to judge; a further fact with no verdict
  // (where the art comes from) has no glyph, so no mark stands for two things.
  const Icon =
    tone === "good"
      ? CheckIcon
      : tone === "bad"
        ? TriangleAlertIcon
        : tone === "neutral" && lead
          ? CircleIcon
          : null;
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  return (
    <div className="flex flex-col gap-1 px-3 py-1.5">
      <div className="flex min-h-6 items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {Icon === null ? null : (
            <Icon
              className={cn(
                tone === "neutral" ? "size-3 text-muted-foreground" : "size-4",
                tone === "good"
                  ? "text-success"
                  : tone === "bad"
                    ? // A game that does not start is the build's outcome, in the one red the
                      // strip, the Stage and the sidebar give it; other checks are to look at.
                      fact.id === "boots"
                      ? "text-destructive"
                      : "text-warning"
                    : null,
              )}
              aria-hidden="true"
            />
          )}
        </span>
        {/* The name on one line and its reading beside it; a reading that does not fit moves
            under the name rather than breaking it mid-row. */}
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5">
          <Text variant="meta" tone="default" render={<span className="min-w-0" />}>
            <Tooltip>
              <TooltipTrigger render={<span />}>{text}</TooltipTrigger>
              <TooltipPopup side="left" className="max-w-sm">
                <span className="flex flex-col gap-1">
                  <span>
                    {fact.label}: {fact.reading._tag === "measured" ? fact.reading.text : text}
                  </span>
                  {note === null ? null : <span>{note}</span>}
                </span>
              </TooltipPopup>
            </Tooltip>
          </Text>
          {value === null ? null : (
            <Text
              variant="meta"
              tone="muted"
              numeric
              render={<span className="ms-auto shrink-0 whitespace-nowrap" />}
            >
              {value}
            </Text>
          )}
        </span>
        {/* One fixed 24px gutter, so values right-align in one column and every sentence keeps
            room for one line; a row with several pieces of evidence opens them from a menu. */}
        <span className="flex w-6 shrink-0 items-center justify-end">
          {fact.evidence.length === 1 && fact.evidence[0] !== undefined ? (
            <EvidenceButton
              threadRef={threadRef}
              item={fact.evidence[0]}
              check={value === null ? text : `${text} ${value}`}
            />
          ) : fact.evidence.length > 1 ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button size="icon-xs" variant="ghost" aria-label={`${fact.label}: evidence`} />
                }
              >
                <FileSearchIcon aria-hidden="true" />
              </MenuTrigger>
              <MenuPopup align="end">
                {fact.evidence.map((item) => {
                  const EvidenceIcon = EVIDENCE_ICON[item.kind];
                  return (
                    <MenuItem
                      key={item.path}
                      onClick={() =>
                        openEvidence(
                          threadRef,
                          root,
                          item,
                          item.label,
                          value === null ? text : `${text} ${value}`,
                        )
                      }
                    >
                      <EvidenceIcon />
                      {item.label}
                    </MenuItem>
                  );
                })}
              </MenuPopup>
            </Menu>
          ) : null}
        </span>
      </div>
      {detail.length > 0 ? (
        <ul className="flex flex-col gap-0.5 ps-6.5">
          {detail.map((line) => (
            <Text key={line} variant="caption" tone="muted" render={<li className="break-words" />}>
              {line}
            </Text>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** What the build changed, folded to one row: it opens this chat's diff, else lists the files. */
/**
 * What the build changed, in place: its files, most changed first. The code diff is a
 * deliberate second step, so a click here never turns the game screen into a code view.
 */
/** A reply's own words, without the `Next:` line it ends on (the composer offers that). */
const withoutNextLine = (reply: string): string => {
  const lines = reply.trimEnd().split("\n");
  return readNextLine(reply) === null ? reply.trim() : lines.slice(0, -1).join("\n").trim();
};

/**
 * What a build changed, in the agent's words: its reply for the turn that made the build. The
 * code itself is the diff, one click away in the side panel.
 */
function WhatChanged({ threadRef, build }: { threadRef: ScopedThreadRef; build: GameBuild }) {
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
  const words = reply === undefined ? "" : withoutNextLine(reply.text);
  const count = build.fileCount ?? build.files.length;
  if (words === "" && runId === null) return null;
  const openDiff = () => {
    if (runId === null) return;
    useDiffPanelStore.getState().selectTurn(threadRef, runId);
    useRightPanelStore.getState().open(threadRef, "diff");
  };
  return (
    <Section
      title="What changed"
      aside={
        runId === null ? undefined : (
          <Button size="xs" variant="ghost" onClick={openDiff}>
            {count === 0 ? "Code changes" : count === 1 ? "1 file" : `${count} files`}
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        )
      }
    >
      {words === "" ? null : <ChatMarkdown text={words} cwd={undefined} threadRef={threadRef} />}
    </Section>
  );
}

type RunEvidence = GameFactView["evidence"][number];

/**
 * The bot runs as pictures: each run's last frame, which opens its video, and
 * Save for both, so the person keeps evidence past the log cleanup in the
 * game's saved/, the same save the agent has.
 */
function Recordings({
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
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const gameName = useGameName(
    threadRef.environmentId,
    useQuietThreadShell(threadRef)?.projectId ?? null,
    "",
  );
  const runs = new Map<
    string,
    { video: RunEvidence | null; frame: RunEvidence | null; ending: string | null }
  >();
  const seen = new Set<string>();
  // How the bot's play ended, in the game's own seconds. Said as an ending ("Lost at 3.6 s"),
  // never a bare time, which would read as the video's length.
  const endingOf = (id: GameFactId): string | null => {
    if (id !== "idle" && id !== "masher" && id !== "skilled") return null;
    const tier = facts[id];
    if (tier.status !== "measured") return null;
    const { ending, at, played } = tier.value;
    const time = (seconds: number) =>
      `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
    return at !== null && (ending === "lost" || ending === "won")
      ? `${ending === "lost" ? "Lost" : "Won"} at ${time(at)}`
      : `Played ${time(played)}`;
  };
  // The check a run proves, as its row in Checks says it.
  const checks = gameChecksView(facts);
  const checkOf = (id: GameFactId): string | null => {
    const check = [...checks.checks, ...checks.more].find((entry) => entry.id === id);
    return check === undefined
      ? null
      : check.value === null
        ? check.sentence
        : `${check.sentence} ${check.value}`;
  };
  const proves = new Map<string, string | null>();
  for (const view of gameFactsView(facts))
    for (const item of view.evidence) {
      if (item.kind === "log" || seen.has(item.path)) continue;
      seen.add(item.path);
      const run = runs.get(view.label) ?? { video: null, frame: null, ending: endingOf(view.id) };
      runs.set(view.label, { ...run, [item.kind]: item });
      if (!proves.has(view.label)) proves.set(view.label, checkOf(view.id));
    }
  if (runs.size === 0) return null;
  return (
    <Section title="Recordings">
      {/* Two stills a row, each no wider than a glance needs, at every Inspector width. */}
      <ul role="list" className="grid max-w-120 grid-cols-2 gap-x-3 gap-y-4">
        {[...runs].map(([fact, run]) => (
          <li key={fact} className="flex min-w-0 flex-col gap-1.5">
            <button
              type="button"
              aria-label={`${fact}: play the ${run.video === null ? "frame" : "recording"}`}
              onClick={() => {
                const open = run.video ?? run.frame;
                if (open !== null)
                  openEvidence(
                    threadRef,
                    root,
                    open,
                    `${fact} recording · ${buildName(build)}`,
                    proves.get(fact) ?? null,
                  );
              }}
              className="group/run relative overflow-hidden rounded-md"
            >
              {/* A recording is of a build whose picture is already here: that picture, dimmed,
                  is the tile until the run's own frame has loaded, so the tile never changes
                  colour as it arrives. */}
              {run.frame === null ? null : (
                <GameBuildStill
                  threadRef={threadRef}
                  gameName={gameName}
                  build={build}
                  mark="none"
                  className="absolute inset-0 opacity-50"
                />
              )}
              <GameBuildStill
                threadRef={threadRef}
                gameName={gameName}
                build={{ still: run.frame?.path ?? null }}
                // A run with no frame says so, rather than pass its pigment off as a picture.
                mark="absent"
                // Clear until its frame has loaded, so the build's picture under it shows.
                className={cn(
                  "aspect-video w-full rounded-md ring-1 ring-border ring-inset group-hover/run:ring-foreground/30",
                  run.frame !== null && "bg-transparent",
                )}
              >
                {run.video === null || run.ending === null ? null : (
                  <Text
                    variant="micro"
                    tone="inherit"
                    numeric
                    render={
                      <span className="absolute right-1.5 bottom-1.5 z-20 rounded-sm bg-black/65 px-1.5 py-px text-white" />
                    }
                  >
                    {run.ending}
                  </Text>
                )}
                {run.video === null ? null : (
                  <span className="absolute inset-0 z-10 grid place-items-center">
                    <span className="grid size-7 place-items-center rounded-full bg-black/60 text-stage-foreground backdrop-blur-sm transition-transform group-hover/run:scale-105">
                      <PlayIcon
                        className="size-3.5 translate-x-px fill-current"
                        aria-hidden="true"
                      />
                    </span>
                  </span>
                )}
              </GameBuildStill>
            </button>
            <span className="flex min-w-0 items-center gap-1 ps-0.5">
              <Text variant="meta" tone="default" truncate render={<span className="flex-1" />}>
                {fact}
              </Text>
              {run.video === null && run.frame === null ? null : (
                // One labelled menu for the files, so the tile's footer is its name and Save.
                <Menu>
                  <MenuTrigger
                    render={<Button size="micro" variant="ghost" aria-label={`${fact}: save`} />}
                  >
                    Save
                    <ChevronDownIcon aria-hidden="true" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {run.video === null ? null : (
                      <SaveMediaMenuItem
                        threadRef={threadRef}
                        source={run.video.path}
                        label={`${name} ${fact} ${run.video.label}`.toLowerCase()}
                        text="Video"
                        icon={<FileVideoIcon aria-hidden="true" />}
                      />
                    )}
                    {run.frame === null ? null : (
                      <SaveMediaMenuItem
                        threadRef={threadRef}
                        source={run.frame.path}
                        label={`${name} ${fact} ${run.frame.label}`.toLowerCase()}
                        text="Frame"
                        icon={<ImageIcon aria-hidden="true" />}
                      />
                    )}
                  </MenuPopup>
                </Menu>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// Each names its build, as the top bar's Undo does: the note under it can then say "this build".
const RESTORE = {
  undo: { label: (name: string) => `Undo ${name}`, busy: "Undoing…" },
  redo: { label: (name: string) => `Redo ${name}`, busy: "Redoing…" },
  "go-back": { label: (name: string) => `Go back to ${name}`, busy: "Going back…" },
} as const;

/** Its one restore, by the strip's rules, and a compare with the build before it. */
/**
 * The build's header: its still and name, and in a ⋯ beside them what can be
 * done with it (its one restore, a compare with the build before), so the
 * panel opens on what the build is, not on a button.
 */
function BuildActions({
  threadRef,
  build,
  list,
  onCompare,
  children,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult;
  onCompare: (other: GameBuild) => void;
  children: ReactNode;
}) {
  const canAct = useAtomValue(gameEnvironment.action.permissionAtom(threadRef.environmentId));
  const restores = useBuildRestore(threadRef, list.restore);
  // The quiet shell: a streaming turn does not re-render the Inspector.
  const turnRunning = threadRuntimeIsActive(useQuietThreadShell(threadRef)?.runtime);
  const latestUndoable =
    list.builds.find(
      (entry) =>
        entry.source._tag === "turn" ||
        (entry.source._tag === "saved" && entry.source.edit !== undefined),
    ) ?? null;
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
  const requestStage = useGameWorkspaceStore((state) => state.requestStage);
  const onStageNow = stageBuildId(list, useAtomValue(stagePlayTarget(threadRef))?.build ?? null);
  const canPlay = build.available && build.id !== onStageNow;
  // Any other build can be its other side: the strip picks it, with this one already first.
  const canPickCompare = build.available && list.builds.some((entry) => entry.id !== build.id);
  return (
    <div className="flex flex-col gap-1.5">
      <header className="flex items-center gap-3">
        {children}
        {(action !== null && kind !== null) || canCompare || canPickCompare || canPlay ? (
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-sm" variant="ghost" aria-label={`${buildName(build)} actions`} />
              }
            >
              <MoreHorizontalIcon className="size-3.5" aria-hidden="true" />
            </MenuTrigger>
            {/* Below, ending at the trigger: it falls over the Checks heading's empty right
                side and leaves the build it acts on (picture, name, time) in view. */}
            <MenuPopup side="bottom" align="end" sideOffset={4} className="w-64">
              {canPlay ? (
                <MenuItem onClick={() => requestStage({ kind: "play", build: refOf(build) })}>
                  <PlayIcon />
                  Play this build
                </MenuItem>
              ) : null}
              {canCompare && previous !== undefined ? (
                <MenuItem onClick={() => onCompare(previous)}>
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
              {(canPlay || canCompare || canPickCompare) && action !== null && kind !== null ? (
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
                          ? // The top bar's Undo says the same two sentences.
                            undoOutcome(
                              previous === undefined ? null : buildName(previous),
                              list.folderEdited === true,
                            )
                          : action.kind === "redo"
                            ? "The game becomes this build again"
                            : "The game becomes this build; later ones stay on the strip")}
                    </Text>
                  </span>
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
      </header>
      {build.noPlay !== null ? (
        <Text variant="meta" tone="muted" render={<p />}>
          {build.noPlay}
        </Text>
      ) : null}
      {error !== null ? (
        <Text variant="caption" tone="destructive" render={<p role="alert" />}>
          {error}
        </Text>
      ) : null}
    </div>
  );
}

// ─── Scene ────────────────────────────────────────────────────────────────────

const decodeStyle = Schema.decodeUnknownOption(Schema.fromJsonString(GameStyle));

/**
 * Why there is nothing to select, said as what is true now: this engine or this game's shell
 * cannot point at things, the game is not on the Stage, or it has not answered yet. Null when
 * selecting works, and the list itself says whether it is empty.
 */
function useSelectNotice(
  threadRef: ScopedThreadRef,
): { readonly title: string; readonly body: string } | null {
  const engine = useIsGameThreadStatus(threadRef).data?.manifest.engine.name ?? null;
  const status = useThreadStageBridge(scopedThreadKey(threadRef), (state) => state.status, null);
  if (engine !== null && !GAME_ENGINES[engine].stageBridge)
    return {
      title: "Not in this engine yet",
      body: `Pointing at things in the running game is not in ${GAME_ENGINES[engine].name} yet.`,
    };
  if (status === "none")
    return {
      title: "This game's shell is older",
      body: "Pointing at things needs the newer game shell, which games made from now on have. Freeze still pauses this one.",
    };
  if (status === null)
    return {
      title: "The game isn't on the Stage",
      body: "Play it on the Stage and the characters, props and rules it names show here.",
    };
  if (status === "waiting")
    return {
      title: "Waiting for the game",
      body: "The game is starting. Its named things show here once it answers.",
    };
  return null;
}

/**
 * The Tune tab: every value the running game tunes (`ctx.tune`), grouped by thing, as controls
 * that change the game at once. The thing pointed at on the frozen Stage comes first, with its
 * look. One Keep makes the changed values a build; Reset puts them back.
 */
export function GameTunePanel({
  threadRef,
  onAsk,
}: {
  threadRef: ScopedThreadRef;
  onAsk: (text: string) => void;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const notice = useSelectNotice(threadRef);
  const status = useThreadStageBridge(threadKey, (state) => state.status, null);
  const tunable = useThreadStageBridge(
    threadKey,
    (state) => state.capabilities.includes("tune"),
    false,
  );
  const things = useThreadStageBridge(threadKey, (state) => state.things, NO_THINGS);
  const selected = useThreadStageBridge(threadKey, (state) => state.selected?.thing ?? null, null);
  const tunedFrom = useThreadStageBridge(threadKey, (state) => state.tunedFrom, NO_TUNING);
  const canKeep = useAtomValue(gameEnvironment.keepValues.permissionAtom(threadRef.environmentId));
  const keep = useAtomCommand(gameEnvironment.keepValues, { reportFailure: false });
  const [keeping, setKeeping] = useState(false);
  const [said, setSaid] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const groups = things.filter(
    (thing) => (thing.values?.length ?? 0) > 0 && thing.id !== selected?.id,
  );
  const changedOf = (thing: GameThing) =>
    (thing.values ?? []).filter((value) => {
      const was = tunedFrom[thing.id]?.[value.key];
      return was !== undefined && was !== value.value;
    });
  const changed = [...(selected === null ? [] : [selected]), ...groups]
    .map((thing) => ({ id: thing.id, values: changedOf(thing) }))
    .filter((thing) => thing.values.length > 0);
  const changedCount = changed.reduce((sum, thing) => sum + thing.values.length, 0);
  const keepAll = async () => {
    setKeeping(true);
    setSaid(null);
    const result = await keep({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, things: changed, commandId: randomUUID() },
    });
    setKeeping(false);
    if (result._tag === "Failure")
      setSaid({ text: String(squashAtomCommandFailure(result)), failed: true });
    else {
      for (const thing of changed) forgetStageTuning(thing.id);
      setSaid({ text: result.value.message, failed: false });
    }
  };
  const playing = status === "ready";
  const paused = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-160 flex-col gap-5 p-4">
        {notice === null && selected !== null ? (
          <ThingInspector threadRef={threadRef} thing={selected} />
        ) : null}
        {notice !== null ? (
          <Empty variant="well">
            <EmptyHeader>
              <EmptyTitle>{notice.title}</EmptyTitle>
              <EmptyDescription>{notice.body}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : !playing ? (
          <Empty variant="well">
            <EmptyHeader>
              <EmptyTitle>Play the game to tune it</EmptyTitle>
              <EmptyDescription>
                Its speeds, jump height, timers and counts show here while it runs, and change it as
                you drag them.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : groups.length === 0 && selected === null ? (
          <Empty variant="well">
            <EmptyHeader>
              <EmptyTitle>Nothing to tune on this screen</EmptyTitle>
              <EmptyDescription>
                A game's values show here once play starts. If none show while you play, your agent
                can expose them.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  onAsk(
                    "Make this game's key numbers tunable from the Stage: the player's speed and jump height, enemy speeds and counts, timers and the win and lose targets.",
                  )
                }
              >
                Ask your agent to expose them
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="-mx-4 border-t border-border">
            {groups.map((thing) => (
              <TuneGroup
                key={thing.id}
                thing={thing}
                tunedFrom={tunedFrom[thing.id]}
                disabled={!tunable}
              />
            ))}
          </div>
        )}
        {/* Paused, everything on screen can be pointed at, tunable or not. */}
        {playing && paused && notice === null ? <ThingsSection threadRef={threadRef} /> : null}
      </div>
      {playing && (groups.length > 0 || said !== null) ? (
        <div className="sticky bottom-0 mt-auto flex flex-col gap-1.5 border-t border-border bg-background px-4 py-3">
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              disabled={changedCount === 0 || keeping || !canKeep}
              onClick={() => void keepAll()}
            >
              {keeping ? "Keeping…" : "Keep as a build"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={Object.keys(tunedFrom).length === 0}
              onClick={() => {
                for (const id of Object.keys(tunedFrom)) resetStageValues(id);
              }}
            >
              Reset all
            </Button>
          </div>
          <Text
            variant="caption"
            tone={said?.failed === true ? "destructive" : "muted"}
            render={<p role={said?.failed === true ? "alert" : undefined} />}
          >
            {said !== null
              ? said.text
              : changedCount > 0
                ? `${changedCount === 1 ? "One value" : `${changedCount} values`} changed and playing. Keep makes them a build; Undo takes it back.`
                : "Changes play at once and last until the game reloads, unless you keep them."}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

const NO_TUNING: Readonly<Record<string, Readonly<Record<string, number | boolean>>>> = {};

/** One thing's values under a header that folds them, the way an inspector groups components. */
function TuneGroup({
  thing,
  tunedFrom,
  disabled,
}: {
  thing: GameThing;
  tunedFrom: Readonly<Record<string, number | boolean>> | undefined;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-border pb-1">
      <div className="flex h-8 items-center gap-1.5 pe-2 ps-1">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-expanded={open}
          aria-label={open ? `Fold ${thing.name}` : `Unfold ${thing.name}`}
          onClick={() => setOpen(!open)}
        >
          <ChevronRightIcon
            className={cn("motion-popup transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
        </Button>
        <Text variant="meta" tone="strong" emphasis truncate render={<h3 />}>
          {thing.name}
        </Text>
        <Text variant="caption" tone="dim">
          {thing.kind}
        </Text>
        <span className="flex-1" />
        {tunedFrom === undefined ? null : (
          <Button size="xs" variant="ghost" onClick={() => resetStageValues(thing.id)}>
            Reset
          </Button>
        )}
      </div>
      {open
        ? (thing.values ?? []).map((value) => {
            const was = tunedFrom?.[value.key];
            return (
              <ValueRow
                key={value.key}
                value={value}
                was={was !== undefined && was !== value.value ? was : undefined}
                disabled={disabled}
                onChange={(next) => tuneStageValue(thing.id, value.key, next, value.value)}
              />
            );
          })
        : null}
    </section>
  );
}

/** The Look tab: the game's style, how its characters are made, and the art made for it. */
export function GameLookPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto w-full max-w-160 p-4">
        <LookSection threadRef={threadRef} />
      </div>
    </div>
  );
}

/**
 * A style family's slug as a person would say the look, without the asset
 * pack's vendor: "kenney-lowpoly" reads "Low-poly".
 */
const styleFamilyWords = (family: string) => {
  const words = family
    .toLowerCase()
    .replace(/^(kenney|quaternius|kaykit|polyhaven|synty)[-_ ]?/, "")
    .replace(/low[-_ ]?poly/, "low-poly")
    .replaceAll("_", " ");
  const spaced = words.includes("low-poly") ? words : words.replaceAll("-", " ");
  return spaced.length === 0 ? family : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
};

/** STYLE.json's family and palette, then the generated art and its picks. */
function LookSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const file = useEnvironmentQuery(
    root === null
      ? null
      : projectEnvironment.readFile({
          environmentId: threadRef.environmentId,
          input: { cwd: root, relativePath: GAME_STYLE_FILE },
        }),
  );
  const style = file.data === null ? null : Option.getOrNull(decodeStyle(file.data.contents));
  const swatches = style !== null && Array.isArray(style.palette) ? style.palette : [];
  const [artOpen, setArtOpen] = useState(false);
  const choosing = useChoosingCount(threadRef);
  const generated = useGenerationCount(threadRef);
  // The look shown, not only named: the folder's latest build as its picture.
  const builds = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const lookBuild = builds?.builds.find((build) => build.id === builds.current) ?? null;
  const buildStill = lookBuild?.still ?? null;
  // A game with no build still has a look: the Stage's last frame of it, once it has shown one.
  const stageStill = useStageStill(scopedThreadKey(threadRef));
  const lookStill = buildStill ?? stageStill;
  const gameName = useIsGameThreadStatus(threadRef).data?.manifest.name ?? "";
  return (
    <Section title="Look">
      {buildStill !== null ? (
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={{ still: buildStill }}
          className="group/sourced aspect-video w-full rounded-lg ring-1 ring-border ring-inset"
        >
          {/* The game has changed since this build: the picture says whose it is, as Now's
              card does, rather than pass for the game as it is now. */}
          {lookBuild !== null && builds?.folderEdited === true ? (
            <PictureSourceBadge>Picture from {buildName(lookBuild)}</PictureSourceBadge>
          ) : null}
        </GameBuildStill>
      ) : stageStill !== null ? (
        <img
          src={stageStill}
          alt=""
          className="aspect-video w-full rounded-lg object-cover ring-1 ring-border ring-inset"
        />
      ) : null}
      {/* The look's colours under its picture, as a strip a person can read at a glance. */}
      {lookStill !== null && swatches.length > 0 ? (
        <div className="flex h-3 overflow-hidden rounded-sm ring-1 ring-border ring-inset">
          {swatches.slice(0, 8).map((hex) => (
            <span key={hex} aria-label={hex} className="flex-1" style={{ background: hex }} />
          ))}
        </div>
      ) : null}
      <Rows>
        <div className="flex min-h-9 items-center gap-2.5 px-3 py-1.5">
          <Text variant="meta" tone="default" render={<span className="flex-1" />}>
            Style
          </Text>
          {style === null ? (
            <Text variant="caption" tone="muted">
              Not chosen yet
            </Text>
          ) : (
            <>
              {swatches.length > 0 ? (
                <span className="flex gap-0.5">
                  {swatches.slice(0, 6).map((hex) => (
                    <span
                      key={hex}
                      aria-label={hex}
                      className="size-3.5 rounded-sm ring-1 ring-border ring-inset"
                      style={{ background: hex }}
                    />
                  ))}
                </span>
              ) : null}
              <Text variant="meta" tone="muted" truncate>
                {[
                  style.family === undefined || style.family === null
                    ? null
                    : styleFamilyWords(style.family),
                  style.mode === "pixel" ? "Pixel art" : "Smooth",
                  typeof style.palette === "string" ? style.palette : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </Text>
            </>
          )}
        </div>
        <div className="flex min-h-9 items-center gap-2.5 ps-3 pe-1.5">
          <Text variant="meta" tone="default" render={<span className="flex-1" />}>
            Characters
          </Text>
          <GameCharacterRoutePicker threadRef={threadRef} />
        </div>
        <button
          type="button"
          aria-expanded={artOpen}
          onClick={() => setArtOpen(!artOpen)}
          className="flex min-h-9 items-center gap-2.5 px-3 text-left hover:bg-accent focus-visible:bg-accent"
        >
          <Text variant="meta" tone="default" render={<span className="flex-1" />}>
            Generated art
          </Text>
          {choosing > 0 ? (
            <Text
              variant="caption"
              tone="inherit"
              render={<span className="text-warning-foreground" />}
            >
              {choosing} to pick
            </Text>
          ) : generated === null ? null : (
            // What is inside, like the rows above say theirs: nobody opens it to find it empty.
            <Text variant="meta" tone="muted" numeric>
              {generated === 0 ? "None yet" : generated === 1 ? "1 piece" : `${generated} pieces`}
            </Text>
          )}
          {/* The same trailing ⌄ as Characters' picker: a row that opens more has one mark. */}
          <ChevronDownIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              artOpen && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </Rows>
      {style === null ? (
        <Text variant="caption" tone="muted" render={<p />}>
          The agent writes {GAME_STYLE_FILE} when it picks a look.
        </Text>
      ) : null}
      {artOpen ? <GameGeneratedArt threadRef={threadRef} /> : null}
    </Section>
  );
}

const KIND_GROUPS: ReadonlyArray<{ readonly kind: GameThing["kind"]; readonly label: string }> = [
  { kind: "character", label: "Characters" },
  { kind: "creature", label: "Creatures" },
  { kind: "prop", label: "Props" },
  { kind: "level", label: "Level" },
  { kind: "effect", label: "Effects" },
  { kind: "ui", label: "Interface" },
  { kind: "rule", label: "Rules" },
  { kind: "sound", label: "Sound" },
  { kind: "other", label: "Other" },
];

const NO_THINGS: ReadonlyArray<GameThing> = [];

/** Everything the game registered, on screen or not; choosing one points at it. */
function ThingsSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(threadRef);
  const freezeKey = useGameFreezeKey();
  const things = useThreadStageBridge(threadKey, (state) => state.things, NO_THINGS);
  const selectedId = useThreadStageBridge(
    threadKey,
    (state) => state.selected?.thing.id ?? null,
    null,
  );
  // The Stage's own Freeze, asked from here: a person who does not use the shortcut starts
  // pointing from the line that tells them to.
  const requestStage = useGameWorkspaceStore((state) => state.requestStage);
  const gameOnStage = useThreadStageBridge(threadKey, () => true, false);
  const frozenByPerson = useThreadStageBridge(threadKey, (state) => state.frozen, false);
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase();
  const shownThings =
    words === ""
      ? things
      : things.filter(
          (thing) =>
            thing.name.toLowerCase().includes(words) || thing.id.toLowerCase().includes(words),
        );
  return (
    <Section
      title="On screen"
      aside={
        things.length === 0 ? undefined : (
          <Text variant="caption" tone="muted">
            {things.length === 1 ? "1 thing" : `${things.length} things`}
          </Text>
        )
      }
    >
      {things.length > 8 ? (
        <Input
          size="sm"
          type="search"
          value={query}
          placeholder="Find a thing"
          aria-label="Find a thing"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      ) : null}
      {things.length === 0 ? (
        <Empty variant="well">
          {/* The game answered and names nothing in this scene: a title or menu often has
              nothing to point at, and play does. */}
          <EmptyHeader>
            <EmptyTitle>Nothing named on screen yet</EmptyTitle>
            <EmptyDescription>Play, then freeze the game to point at something.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {/* The action and its key side by side: the key is the same Freeze, said once. */}
            <span className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!gameOnStage}
                onClick={() => requestStage({ kind: "freeze" })}
              >
                {frozenByPerson ? (
                  <PlayIcon aria-hidden="true" />
                ) : (
                  <PauseIcon aria-hidden="true" />
                )}
                {frozenByPerson ? "Play on" : "Freeze to point at things"}
              </Button>
              {freezeKey === null ? null : <KbdShortcut>{freezeKey}</KbdShortcut>}
            </span>
          </EmptyContent>
        </Empty>
      ) : null}
      {KIND_GROUPS.map((group) => {
        const rows = shownThings.filter((thing) => thing.kind === group.kind);
        if (rows.length === 0) return null;
        return (
          <div key={group.kind} role="group" aria-label={group.label} className="flex flex-col">
            <Text variant="caption" tone="muted" render={<h4 className="px-2 pt-1.5 pb-1" />}>
              {group.label} {rows.length}
            </Text>
            {rows.map((thing) => {
              const hasBody = thing.kind !== "rule" && thing.kind !== "sound";
              return (
                <button
                  key={thing.id}
                  type="button"
                  aria-current={selectedId === thing.id ? "true" : undefined}
                  onClick={() => selectStageThing(thing.id)}
                  onPointerEnter={() => hoverStageThing(thing.id)}
                  onPointerLeave={() => hoverStageThing(null)}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-md px-2 text-left hover:bg-accent focus-visible:bg-accent",
                    selectedId === thing.id && "bg-accent text-strong-foreground",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      !hasBody
                        ? "invisible"
                        : thing.onScreen
                          ? "bg-success"
                          : "border border-muted-foreground/60",
                    )}
                  />
                  <Text variant="meta" tone="inherit" truncate render={<span className="flex-1" />}>
                    {thing.name}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {thing.values !== undefined && thing.values.length > 0
                      ? `${thing.values.length} ${thing.values.length === 1 ? "value" : "values"}`
                      : hasBody
                        ? thing.onScreen
                          ? "on screen"
                          : "off screen"
                        : thing.kind}
                  </Text>
                </button>
              );
            })}
          </div>
        );
      })}
    </Section>
  );
}

/** The thing pointed at: where its look comes from and its values, tuned live. */
function ThingInspector({ threadRef, thing }: { threadRef: ScopedThreadRef; thing: GameThing }) {
  return (
    <div
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
          return;
        event.preventDefault();
        clearStageSelection();
      }}
      className="flex flex-col gap-4 border-y border-border py-4 outline-none"
    >
      <header className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Text variant="title" tone="strong" truncate render={<h3 />}>
            {thing.name}
          </Text>
          <Text variant="caption" tone="muted" truncate>
            {thing.kind} · {thing.onScreen ? "on screen" : "off screen"} · {thing.id}
          </Text>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Stop pointing at it (Esc)"
          onClick={clearStageSelection}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </header>
      <ThingLook threadRef={threadRef} thing={thing} />
      <ValuesSection threadRef={threadRef} thing={thing} />
      <Text variant="caption" tone="muted" render={<p />}>
        It is in the box under the game: what you write there goes to your agent with this frame,
        the {thing.name.toLowerCase()} and its values.
      </Text>
    </div>
  );
}

/** Its model or sprite and where it comes from: a generation's own card, or the file. */
function ThingLook({ threadRef, thing }: { threadRef: ScopedThreadRef; thing: GameThing }) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const generations = useGameGenerations(threadRef).data;
  const actions = useGenerationActions(threadRef);
  const asset = thing.asset;
  if (asset === undefined)
    return (
      <Section title="Look">
        <Text variant="meta" tone="muted" render={<p />}>
          Made in the game's code; it has no asset file.
        </Text>
      </Section>
    );
  const generation =
    generations?.generations.find(
      (entry) =>
        entry.files.includes(asset.path) ||
        (asset.sidecar !== undefined && entry.files.includes(asset.sidecar)),
    ) ?? null;
  if (generation !== null)
    return (
      <Section
        title="Look"
        aside={
          <Text variant="caption" tone="muted">
            Generated
          </Text>
        }
      >
        <GenerationHeading generation={generation} />
        <GameGenerationBody
          threadRef={threadRef}
          root={root}
          generation={generation}
          actions={actions}
        />
      </Section>
    );
  return (
    <Section
      title="Look"
      aside={
        <Text variant="caption" tone="muted">
          {asset.path.includes("/library/") ? "Library pack" : "Game file"}
        </Text>
      }
    >
      <Text variant="caption" tone="muted" mono render={<code className="break-all" />}>
        {asset.path}
      </Text>
      {root === null ? null : (
        <div className="-ms-2 flex flex-wrap items-center gap-1">
          <GameFileActions
            threadRef={threadRef}
            path={`${root}/${asset.path}`}
            relativePath={asset.path}
          />
        </div>
      )}
    </Section>
  );
}

/** A value's name as a person reads it: the game's label, else its key in words ("dashCooldown" → "Dash cooldown"). */
const valueLabel = (value: GameThingValue) => {
  if (value.label !== undefined) return value.label;
  const words = value.key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
  return words.length === 0 ? value.key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** Live sliders for its tuned values, kept as a build or put back. */
function ValuesSection({ threadRef, thing }: { threadRef: ScopedThreadRef; thing: GameThing }) {
  const threadKey = scopedThreadKey(threadRef);
  const tunable = useThreadStageBridge(
    threadKey,
    (state) => state.capabilities.includes("tune"),
    false,
  );
  const before = useThreadStageBridge(threadKey, (state) => state.tunedFrom[thing.id], undefined);
  const canKeep = useAtomValue(gameEnvironment.keepValues.permissionAtom(threadRef.environmentId));
  const keep = useAtomCommand(gameEnvironment.keepValues, { reportFailure: false });
  const [keeping, setKeeping] = useState(false);
  const [said, setSaid] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const values = thing.values ?? [];
  if (values.length === 0)
    return (
      <Section title="Values">
        <Text variant="meta" tone="muted" render={<p />}>
          The game tunes no values on this thing. Ask your agent to expose some.
        </Text>
      </Section>
    );
  const changed = values.filter(
    (value) => before !== undefined && value.key in before && before[value.key] !== value.value,
  );
  const keepAsBuild = async () => {
    setKeeping(true);
    setSaid(null);
    const result = await keep({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        things: [{ id: thing.id, values: changed }],
        commandId: randomUUID(),
      },
    });
    setKeeping(false);
    if (result._tag === "Failure")
      setSaid({ text: String(squashAtomCommandFailure(result)), failed: true });
    else {
      forgetStageTuning(thing.id);
      setSaid({ text: result.value.message, failed: false });
    }
  };
  return (
    <Section
      title="Values"
      aside={
        tunable ? (
          <Text variant="caption" tone="muted">
            Live in the running game
          </Text>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {values.map((value) => {
          const was = before?.[value.key];
          const edited = was !== undefined && was !== value.value;
          return (
            <ValueRow
              key={value.key}
              value={value}
              was={edited ? was : undefined}
              disabled={!tunable}
              onChange={(next) => tuneStageValue(thing.id, value.key, next, value.value)}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={changed.length === 0 || keeping || !canKeep}
          onClick={() => void keepAsBuild()}
        >
          {keeping ? "Keeping…" : "Keep as a build"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={before === undefined}
          onClick={() => resetStageValues(thing.id)}
        >
          Reset
        </Button>
      </div>
      <Text
        variant="caption"
        tone={said?.failed === true ? "destructive" : "muted"}
        render={<p role={said?.failed === true ? "alert" : undefined} />}
      >
        {said !== null
          ? said.text
          : changed.length > 0
            ? `${changed.length === 1 ? "One value" : `${changed.length} values`} changed and the game is using ${changed.length === 1 ? "it" : "them"}. Keep makes a build; Undo takes it back.`
            : "Changes play at once and last until the game reloads, unless you keep them."}
      </Text>
    </Section>
  );
}

function ValueRow({
  value,
  was,
  disabled,
  onChange,
}: {
  value: GameThingValue;
  was: number | boolean | undefined;
  disabled: boolean;
  onChange: (next: number | boolean) => void;
}) {
  return (
    <GameTuneField
      label={valueLabel(value)}
      value={value}
      was={was}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
