import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { stageBuildId } from "./gameBuildTimeline.logic";
import {
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  ColumnsIcon,
  GitCompareIcon,
  FileIcon,
  FileSearchIcon,
  FileVideoIcon,
  ImageIcon,
  InfoIcon,
  MinusIcon,
  MoreHorizontalIcon,
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
  type GameFactView,
  type GameThing,
  type GameThingValue,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { useDiffPanelStore } from "../../diffPanelStore";
import { type GameInspectorTab, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn, randomUUID } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShell, useThreadCheckpointSummaries } from "../../state/entities";
import { gameEnvironment, stagePlayTarget } from "../../state/game";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { Tabs, TabsList, TabsTab } from "../ui/tabs";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { refOf } from "./gameBuildRef";
import { GameBuildStill } from "./GameBuildStill";
import {
  characterRouteLabel,
  GameCharacterRoutePicker,
  useCharacterRoute,
} from "./GameCharacterRoute";
import { useGameName } from "./GameName";
import { GameGeneratedArt } from "./GameGeneratedArt";
import {
  GameGenerationBody,
  GenerationHeading,
  useChoosingCount,
  useGameGenerations,
  useGenerationActions,
} from "./GameGenerationCard";
import { GameFileActions, SaveMediaButton } from "./GameSavedMedia";
import {
  assetLibraryNote,
  assetLines,
  assetUseLines,
  buildCaption,
  buildName,
  formatBuildTime,
} from "./gameBuilds.logic";
import {
  clearStageSelection,
  forgetStageTuning,
  hoverStageThing,
  resetStageValues,
  selectStageThing,
  tuneStageValue,
  useThreadStageBridge,
} from "./gameStageBridge";
import { turnStripRestore } from "./gameTurnBuild.logic";
import { stepVerdictText } from "./keepGoing.logic";
import { restoreQuestion, useBuildRestore, useMeasureOnOpen } from "./useBuildActions";

const TABS: ReadonlyArray<{ readonly tab: GameInspectorTab; readonly label: string }> = [
  { tab: "build", label: "Build" },
  { tab: "scene", label: "Scene" },
  { tab: "log", label: "Log" },
];

/**
 * The Inspector's three tabs, in its column's header. The Log stays mounted
 * under the other two, so its scroll, find and running turn never reset.
 */
export function GameInspectorTabs({ threadRef }: { threadRef: ScopedThreadRef }) {
  const tab = useGameWorkspaceStore((state) => state.inspectorTab);
  const showTab = useGameWorkspaceStore((state) => state.showInspectorTab);
  // A generation waiting on the person's pick is never missed behind another tab.
  const choosing = useChoosingCount(threadRef);
  return (
    <Tabs
      value={tab}
      onValueChange={(next: GameInspectorTab) => showTab(next)}
      className="w-full max-w-80"
    >
      <TabsList aria-label="Inspector" className="w-full">
        {TABS.map((entry) => (
          <TabsTab key={entry.tab} value={entry.tab}>
            {entry.label}
            {entry.tab === "scene" && choosing > 0 ? (
              <span className="size-1.5 rounded-full bg-warning" aria-label="A pick is waiting" />
            ) : null}
          </TabsTab>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** The open tab's panel, over the Log; nothing while the Log is open. */
export function GameInspectorPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const tab = useGameWorkspaceStore((state) => state.inspectorTab);
  if (tab === "log") return null;
  return (
    <div
      role="tabpanel"
      aria-label={TABS.find((entry) => entry.tab === tab)?.label}
      className="absolute inset-x-0 bottom-0 top-(--workspace-topbar-height) z-(--z-sheet) flex min-h-0 flex-col overflow-y-auto bg-background"
    >
      {/* In the wide sheet of a narrow window, the panel keeps a reading width. Keyed by tab,
          so a new tab fades in on the popup clock as the pill slides, like TabsPanel (the
          tabs live in the column's header, outside this panel's tree). */}
      <div
        key={tab}
        className="w-full max-w-160 motion-popup transition-opacity starting:opacity-0"
      >
        {tab === "build" ? (
          <BuildPanel threadRef={threadRef} />
        ) : (
          <ScenePanel threadRef={threadRef} />
        )}
      </div>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <Text variant="body" tone="muted" render={<p className="p-4" />}>
      {children}
    </Text>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center gap-2">
        <Text variant="meta" tone="muted" render={<h3 />}>
          {title}
        </Text>
        {aside === undefined ? null : <span className="ml-auto flex items-center">{aside}</span>}
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

/** The build the Inspector shows: the one picked on the strip, else the one on the Stage. */
function BuildPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
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
  const shell = useQuietThreadShell(threadRef);
  const gameName = useGameName(
    threadRef.environmentId,
    shell?.projectId ?? null,
    useIsGameThreadStatus(threadRef).data?.manifest.name ?? "",
  );
  const working = threadRuntimeIsActive(shell?.runtime);
  const data = list.data;
  if (data === null)
    return list.error === null ? (
      // The build header and its check rows at their final size, so nothing jumps when they land.
      <div className="flex flex-col gap-5 p-4">
        <div className="flex items-center gap-3">
          <Skeleton shape="card" className="h-12 w-20" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <Skeleton shape="card" className="h-40 w-full" />
      </div>
    ) : (
      <Notice>{list.error}</Notice>
    );
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
    return working ? (
      <div className="flex flex-col gap-1 p-4">
        <Text variant="label" tone="strong" render={<h2 />}>
          Build 1
        </Text>
        <Text variant="meta" tone="muted" render={<p />}>
          Being made. Its checks are measured after its first play.
        </Text>
      </div>
    ) : (
      <div className="p-4">
        <Empty variant="well">
          <EmptyHeader>
            <EmptyTitle>Not measured yet</EmptyTitle>
            <EmptyDescription>
              The next change your agent makes becomes a build, with its checks here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  const detail = (
    <BuildDetail
      key={build.id}
      threadRef={threadRef}
      gameName={gameName}
      build={build}
      list={data}
      onStage={build.id === onStageId}
      note={nowOnStage ? "last measured" : null}
    />
  );
  if (!nowOnStage) return detail;
  return (
    <>
      <div className="flex flex-col gap-0.5 px-4 pt-4">
        <Text variant="label" tone="strong" render={<h2 />}>
          Now on the Stage
        </Text>
        <Text variant="meta" tone="muted" render={<p />}>
          Not measured yet. The checks below are from {buildName(build)}.
        </Text>
      </div>
      {detail}
    </>
  );
}

function BuildDetail({
  threadRef,
  gameName,
  build,
  list,
  onStage,
  note,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  build: GameBuild;
  list: GameBuildsResult;
  onStage: boolean;
  /** Said after the build's time, when it is shown for a reason other than being picked. */
  note: string | null;
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
  const factsData = facts.data;
  const measureAnswer = measure.answer(build.id);
  const source = build.source;
  const step = source._tag === "turn" ? source.step : null;
  const asked =
    source._tag === "saved"
      ? null
      : step !== null
        ? { title: "Why", text: buildCaption(build), verdict: stepVerdictText(step) }
        : source.request.trim() === ""
          ? null
          : { title: "You asked", text: source.request, verdict: null };
  const requestStage = useGameWorkspaceStore((state) => state.requestStage);
  return (
    <div className="flex flex-col gap-5 p-4">
      <BuildActions
        threadRef={threadRef}
        build={build}
        list={list}
        onCompare={(other) => requestStage({ kind: "compare", pair: [refOf(other), refOf(build)] })}
      >
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={build}
          className="h-12 w-20 shrink-0 rounded-md ring-1 ring-border ring-inset"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Text variant="label" tone="strong" truncate render={<h2 />}>
            {buildCaption(build) === buildName(build)
              ? buildName(build)
              : `${buildName(build)} · ${buildCaption(build)}`}
          </Text>
          <Text variant="meta" tone="muted" truncate>
            {formatBuildTime(build.at)}
            {onStage ? " · on the Stage" : note === null ? "" : ` · ${note}`}
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
        title={
          factsData !== null && factsData.state !== "never" && build.available
            ? `Checks · ${checksSummary(factsData)}`
            : "Checks"
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
            <Skeleton shape="card" className="h-40 w-full" />
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
          <Checks threadRef={threadRef} facts={factsData} />
        )}
        {measureAnswer !== null && measureAnswer.text !== factsData?.message ? (
          <Text
            variant="meta"
            tone={measureAnswer.failed ? "destructive" : "muted"}
            render={<p role={measureAnswer.failed ? "alert" : undefined} />}
          >
            {measureAnswer.text}
          </Text>
        ) : null}
      </Section>
      <Changes threadRef={threadRef} build={build} />
      {factsData !== null && factsData.state !== "never" ? (
        <Recordings threadRef={threadRef} build={build} facts={factsData} />
      ) : null}
    </div>
  );
}

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
function checksSummary(facts: GameBuildFacts): string {
  const view = gameChecksView(facts);
  const busy = facts.state === "measuring" || facts.state === "queued";
  const shownPass = view.checks.filter(
    (check) => check.reading._tag === "measured" && check.reading.tone === "good",
  ).length;
  const notMeasured = view.checks.filter((check) => check.reading._tag === "not-measured").length;
  return [
    ...(shownPass > 0 || view.toLook > 0 || !busy
      ? [`${shownPass} of ${view.checks.length} pass`]
      : []),
    ...(view.toLook > 0 ? [`${view.toLook} to look at`] : []),
    ...(notMeasured > 0 ? [`${notMeasured} not measured`] : []),
    ...(busy && facts.message.trim() !== "" ? [facts.message.replace(/\.$/, "")] : []),
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
  const morePass = moreMeasured.filter(
    (fact) => fact.reading._tag === "measured" && fact.reading.tone === "good",
  ).length;
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
          />
        ))}
        {pending > 0 ? <PendingRow count={pending} /> : null}
        <NotMeasured facts={view.checks} note={noteOf} />
      </Rows>
      {view.more.length > 0 ? (
        <Rows>
          <Collapsible>
            <CollapsibleTrigger className="group flex min-h-9 items-center gap-2.5 px-3 text-left outline-none hover:bg-accent focus-visible:bg-accent">
              <ChevronRightIcon
                className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90"
                aria-hidden="true"
              />
              <Text variant="meta" tone="default" render={<span className="flex-1" />}>
                More measurements
              </Text>
              {/* One unit, measured facts, on both sides of the dot; the rows below say the rest. */}
              <Text variant="caption" tone="muted" numeric>
                {moreMeasured.length === 0
                  ? morePending > 0
                    ? `${morePending} to measure`
                    : "None measured"
                  : `${moreMeasured.length} measured · ${morePass} pass`}
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

function PendingRow({ count }: { count: number }) {
  return (
    <div className="flex min-h-9 items-center gap-2.5 px-3">
      <ClockIcon className="size-4 shrink-0 text-dim-foreground" aria-hidden="true" />
      <Text variant="meta" tone="muted">
        {count === 1 ? "1 check" : `${count} checks`} still to measure
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
function NotMeasured({
  facts,
  note,
}: {
  facts: ReadonlyArray<GameCheck>;
  note: (fact: GameFactView) => string | null;
}) {
  const folded = new Map<string, Array<GameCheck>>();
  for (const fact of facts)
    if (fact.reading._tag === "not-measured")
      folded.set(fact.reading.why, [...(folded.get(fact.reading.why) ?? []), fact]);
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
        <Text variant="meta" tone="muted" render={<span className="min-w-0 flex-1" />}>
          {namesPhrase(names)}
        </Text>
        {/* In the value column, like a reading. */}
        <Text variant="caption" tone="dim" render={<span className="shrink-0" />}>
          not measured
        </Text>
        <span className="flex w-6 shrink-0 items-center justify-end">
          <Tooltip>
            <TooltipTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Why not measured" />}
            >
              <InfoIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup side="left" className="max-w-sm">
              <span className="flex flex-col gap-1">
                {names.length > 2 ? <span>{names.join(", ")}.</span> : null}
                <span>{why.charAt(0).toUpperCase() + why.slice(1)}</span>
                {notes.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </span>
            </TooltipPopup>
          </Tooltip>
        </span>
      </div>
    );
  });
}

function EvidenceButton({ threadRef, item }: { threadRef: ScopedThreadRef; item: RunEvidence }) {
  const EvidenceIcon = EVIDENCE_ICON[item.kind];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={item.label}
            onClick={() => useRightPanelStore.getState().openFile(threadRef, item.path)}
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
}: {
  threadRef: ScopedThreadRef;
  fact: GameFactView;
  text: string;
  value: string | null;
  detail: ReadonlyArray<string>;
  /** Said on hover after the raw reading. */
  note: string | null;
}) {
  const tone = fact.reading._tag === "measured" ? fact.reading.tone : null;
  // A reading that is neither good nor bad gets a small solid dot: a hollow ring reads as an unticked option.
  const Icon = tone === "good" ? CheckIcon : tone === "bad" ? TriangleAlertIcon : null;
  return (
    <div className="flex flex-col gap-1 px-3 py-1.5">
      <div className="flex min-h-6 items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {Icon === null ? (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground" />
          ) : (
            <Icon
              className={cn("size-4", tone === "good" ? "text-success" : "text-warning")}
              aria-hidden="true"
            />
          )}
        </span>
        <Text variant="meta" tone="default" render={<span className="min-w-0 flex-1" />}>
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
          <Text variant="caption" tone="muted" numeric render={<span className="shrink-0" />}>
            {value}
          </Text>
        )}
        {/* One fixed 24px gutter, so values right-align in one column and every sentence keeps
            room for one line; a row with several pieces of evidence opens them from a menu. */}
        <span className="flex w-6 shrink-0 items-center justify-end">
          {fact.evidence.length === 1 && fact.evidence[0] !== undefined ? (
            <EvidenceButton threadRef={threadRef} item={fact.evidence[0]} />
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
                      onClick={() => useRightPanelStore.getState().openFile(threadRef, item.path)}
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
function Changes({ threadRef, build }: { threadRef: ScopedThreadRef; build: GameBuild }) {
  const [open, setOpen] = useState(false);
  const turn =
    build.source._tag === "turn" && build.source.threadId === threadRef.threadId
      ? build.source.turn
      : null;
  const runId =
    useThreadCheckpointSummaries(threadRef).find((entry) => entry.checkpointTurnCount === turn)
      ?.runId ?? null;
  if (build.fileCount === null && build.files.length === 0) return null;
  const count = build.fileCount ?? build.files.length;
  const complete = build.fileCount === null || build.fileCount <= build.files.length;
  const additions = build.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = build.files.reduce((sum, file) => sum + file.deletions, 0);
  const openDiff = () => {
    if (runId === null) {
      setOpen(!open);
      return;
    }
    useDiffPanelStore.getState().selectTurn(threadRef, runId);
    useRightPanelStore.getState().open(threadRef, "diff");
  };
  return (
    <Section title="Changes">
      <Rows>
        <button
          type="button"
          aria-expanded={runId === null ? open : undefined}
          onClick={openDiff}
          disabled={count === 0}
          className="flex items-center gap-2.5 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:hover:bg-transparent"
        >
          <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Text variant="meta" tone="default">
            {count === 1 ? "1 file" : `${count} files`}
          </Text>
          {count > 0 ? (
            <Text variant="meta" tone="inherit" numeric render={<span className="ml-auto" />}>
              <span className="text-success-foreground">+{additions}</span>{" "}
              <span className="text-destructive-foreground">−{deletions}</span>
              {complete ? "" : " in the top 8"}
            </Text>
          ) : null}
        </button>
        {open
          ? build.files.map((file) => (
              <div key={file.path} className="flex items-baseline gap-2 px-3 py-1.5">
                <Text variant="caption" tone="muted" mono truncate>
                  {file.path}
                </Text>
                <Text
                  variant="caption"
                  tone="inherit"
                  numeric
                  render={<span className="ml-auto" />}
                >
                  <span className="text-success-foreground">+{file.additions}</span>{" "}
                  <span className="text-destructive-foreground">−{file.deletions}</span>
                </Text>
              </div>
            ))
          : null}
      </Rows>
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
  const gameName = useGameName(
    threadRef.environmentId,
    useQuietThreadShell(threadRef)?.projectId ?? null,
    "",
  );
  const runs = new Map<string, { video: RunEvidence | null; frame: RunEvidence | null }>();
  const seen = new Set<string>();
  for (const view of gameFactsView(facts))
    for (const item of view.evidence) {
      if (item.kind === "log" || seen.has(item.path)) continue;
      seen.add(item.path);
      const run = runs.get(view.label) ?? { video: null, frame: null };
      runs.set(view.label, { ...run, [item.kind]: item });
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
              aria-label={`${fact}: open the ${run.video === null ? "frame" : "video"}`}
              onClick={() => {
                const open = run.video ?? run.frame;
                if (open !== null) useRightPanelStore.getState().openFile(threadRef, open.path);
              }}
              className="group/run relative outline-none"
            >
              <GameBuildStill
                threadRef={threadRef}
                gameName={gameName}
                build={{ still: run.frame?.path ?? null }}
                className="aspect-video w-full rounded-md ring-1 ring-border ring-inset group-hover/run:ring-foreground/30 group-focus-visible/run:ring-2 group-focus-visible/run:ring-ring"
              >
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
              <Text variant="caption" tone="default" truncate render={<span className="flex-1" />}>
                {fact}
              </Text>
              {run.video === null ? null : (
                <SaveMediaButton
                  threadRef={threadRef}
                  source={run.video.path}
                  label={`${name} ${fact} ${run.video.label}`.toLowerCase()}
                  text="Video"
                  icon={<FileVideoIcon aria-hidden="true" />}
                />
              )}
              {run.frame === null ? null : (
                <SaveMediaButton
                  threadRef={threadRef}
                  source={run.frame.path}
                  label={`${name} ${fact} ${run.frame.label}`.toLowerCase()}
                  text="Frame"
                  icon={<ImageIcon aria-hidden="true" />}
                />
              )}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const RESTORE = {
  undo: { label: "Undo this build", busy: "Undoing…" },
  redo: { label: "Redo this build", busy: "Redoing…" },
  "go-back": { label: "Go back to this build", busy: "Going back…" },
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
            {/* Upward: below, it would cover the Checks heading the build's actions are about. */}
            <MenuPopup side="top" align="end" className="w-64">
              {canPlay ? (
                <MenuItem onClick={() => requestStage({ kind: "play", build: refOf(build) })}>
                  <PlayIcon />
                  Play this build
                </MenuItem>
              ) : null}
              {canCompare && previous !== undefined ? (
                <MenuItem onClick={() => onCompare(previous)}>
                  <ColumnsIcon />
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
                  <Undo2Icon />
                  <span className="flex min-w-0 flex-col">
                    {restores.restoring(action.target) ? kind.busy : kind.label}
                    {action.blocked === null ? null : (
                      <Text variant="caption" tone="muted">
                        {action.blocked}
                      </Text>
                    )}
                  </span>
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
      </header>
      {build.noPlay !== null ? (
        <Text variant="caption" tone="muted" render={<p />}>
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

/** Why there is nothing to select, in this engine or this game's shell; null when selecting works. */
function useSelectNotice(threadRef: ScopedThreadRef): string | null {
  const engine = useIsGameThreadStatus(threadRef).data?.manifest.engine.name ?? null;
  const status = useThreadStageBridge(scopedThreadKey(threadRef), (state) => state.status, null);
  if (engine !== null && !GAME_ENGINES[engine].stageBridge)
    return `Pointing at things in the running game is not in ${GAME_ENGINES[engine].name} yet.`;
  if (status === "none")
    return "Pointing at things needs the newer game shell, which games made from now on have. Freeze still pauses this one.";
  if (status === null) return "Play the game on the Stage to see its things.";
  return null;
}

/** The game's look, its things, and the thing pointed at on the frozen Stage. */
function ScenePanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(threadRef);
  const selected = useThreadStageBridge(threadKey, (state) => state.selected, null);
  const notice = useSelectNotice(threadRef);
  return (
    <div className="flex flex-col gap-5 p-4">
      <LookSection threadRef={threadRef} />
      {/* The thing pointed at comes before the list, which can run to a hundred props. */}
      {notice === null && selected !== null ? (
        <ThingInspector threadRef={threadRef} thing={selected.thing} />
      ) : null}
      {notice !== null ? (
        <Section title="On screen">
          <Text variant="meta" tone="muted" render={<p />}>
            {notice}
          </Text>
        </Section>
      ) : (
        <ThingsSection threadRef={threadRef} />
      )}
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
  // The look shown, not only named: the folder's latest build as its picture.
  const builds = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const lookStill = builds?.builds.find((build) => build.id === builds.current)?.still ?? null;
  const gameName = useIsGameThreadStatus(threadRef).data?.manifest.name ?? "";
  return (
    <Section title="Look">
      {lookStill === null ? null : (
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={{ still: lookStill }}
          className="aspect-video w-full rounded-lg ring-1 ring-border ring-inset"
        ></GameBuildStill>
      )}
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
              <Text variant="caption" tone="muted" truncate>
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
          className="flex min-h-9 items-center gap-2.5 px-3 text-left outline-none hover:bg-accent focus-visible:bg-accent"
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
          ) : null}
          <ChevronRightIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              artOpen && "rotate-90",
            )}
            aria-hidden="true"
          />
        </button>
      </Rows>
      {style === null ? (
        <Text variant="caption" tone="dim" render={<p />}>
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
  const things = useThreadStageBridge(threadKey, (state) => state.things, NO_THINGS);
  const selectedId = useThreadStageBridge(
    threadKey,
    (state) => state.selected?.thing.id ?? null,
    null,
  );
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
          <Text variant="caption" tone="dim">
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
          <EmptyHeader>
            <EmptyTitle>Nothing named yet</EmptyTitle>
            <EmptyDescription>
              Named characters, props and rules show here while the game plays. <Kbd>Tab</Kbd> on
              the Stage freezes it so you can point at one.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {KIND_GROUPS.map((group) => {
        const rows = shownThings.filter((thing) => thing.kind === group.kind);
        if (rows.length === 0) return null;
        return (
          <div key={group.kind} role="group" aria-label={group.label} className="flex flex-col">
            <Text variant="caption" tone="dim" render={<h4 className="px-2 pt-1.5 pb-1" />}>
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
                    "flex h-8 items-center gap-2.5 rounded-md px-2 text-left outline-none hover:bg-accent focus-visible:bg-accent",
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
                  <Text variant="caption" tone="dim">
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
          <Text variant="caption" tone="dim">
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
        <Text variant="caption" tone="dim">
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

const valueLabel = (value: GameThingValue) => value.label ?? value.key;
const shownValue = (value: number | boolean) =>
  typeof value === "number" ? String(Math.round(value * 1000) / 1000) : value ? "on" : "off";

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
          <Text variant="caption" tone="dim">
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
  const label = valueLabel(value);
  const reading = (
    <Text
      variant="caption"
      tone="inherit"
      mono
      numeric
      render={<span className={was !== undefined ? "text-primary" : "text-muted-foreground"} />}
    >
      {was === undefined ? null : <span className="me-1.5">was {shownValue(was)}</span>}
      {shownValue(value.value)}
    </Text>
  );
  if (typeof value.value === "boolean")
    return (
      <label className="flex items-center gap-2">
        <Text variant="meta" truncate render={<span className="flex-1" />}>
          {label}
        </Text>
        {reading}
        <Switch
          checked={value.value}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked)}
          aria-label={label}
        />
      </label>
    );
  const ranged = value.min !== undefined && value.max !== undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <Text variant="meta" truncate render={<span className="flex-1" />}>
          {label}
        </Text>
        {reading}
      </div>
      {ranged ? (
        <input
          type="range"
          aria-label={label}
          min={value.min}
          max={value.max}
          step={value.step ?? ((value.max ?? 1) - (value.min ?? 0)) / 100}
          value={value.value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          className={cn(
            "h-4 w-full cursor-pointer disabled:cursor-default disabled:opacity-50",
            was !== undefined ? "accent-primary" : "accent-foreground",
          )}
        />
      ) : (
        <Text variant="caption" tone="muted" render={<p />}>
          No range set, so it has no slider.
        </Text>
      )}
    </div>
  );
}
