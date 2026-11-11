import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  ColumnsIcon,
  FileIcon,
  FileVideoIcon,
  ImageIcon,
  MinusIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
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
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { refOf } from "./gameBuildRef";
import { GameBuildStill } from "./GameBuildStill";
import { characterRouteLabel, useCharacterRoute } from "./GameCharacterRoute";
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
  assetLines,
  assetUseLines,
  buildCaption,
  buildName,
  factLine,
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
    <div
      role="tablist"
      aria-label="Inspector"
      className="grid h-8 w-full grid-cols-3 gap-0.5 rounded-lg bg-card p-0.5"
    >
      {TABS.map((entry) => (
        <button
          key={entry.tab}
          type="button"
          role="tab"
          aria-selected={tab === entry.tab}
          onClick={() => showTab(entry.tab)}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            tab === entry.tab && "bg-accent text-strong-foreground",
          )}
        >
          <Text variant="meta" tone="inherit">
            {entry.label}
          </Text>
          {entry.tab === "scene" && choosing > 0 ? (
            <span className="size-1.5 rounded-full bg-warning" aria-label="A pick is waiting" />
          ) : null}
        </button>
      ))}
    </div>
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
      className="absolute inset-x-0 bottom-0 top-(--workspace-topbar-height) z-50 flex min-h-0 flex-col overflow-y-auto bg-background"
    >
      {tab === "build" ? (
        <BuildPanel threadRef={threadRef} />
      ) : (
        <ScenePanel threadRef={threadRef} />
      )}
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
    <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-card">
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
  if (data === null) return <Notice>{list.error ?? "Reading the builds…"}</Notice>;
  const onStageId = asked?.build ?? data.current;
  // The list's own row when it holds it, so the facts it shows stay current.
  const build =
    (inspected === null
      ? undefined
      : (data.builds.find((entry) => entry.id === inspected.build) ?? inspected.snapshot)) ??
    data.builds.find((entry) => entry.id === onStageId) ??
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
      <Notice>
        No builds yet. Each change your agent makes to the game becomes one, with its checks
        measured here.
      </Notice>
    );
  return (
    <BuildDetail
      key={build.id}
      threadRef={threadRef}
      gameName={gameName}
      build={build}
      list={data}
      onStage={build.id === onStageId}
    />
  );
}

function BuildDetail({
  threadRef,
  gameName,
  build,
  list,
  onStage,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  build: GameBuild;
  list: GameBuildsResult;
  onStage: boolean;
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
      <header className="flex items-center gap-3">
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={build}
          className="h-12 w-20 shrink-0 rounded-md ring-1 ring-border ring-inset"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <Text variant="label" tone="strong" truncate render={<h2 />}>
            {buildCaption(build) === buildName(build)
              ? buildName(build)
              : `${buildName(build)} · ${buildCaption(build)}`}
          </Text>
          <Text variant="meta" tone="muted" truncate>
            {formatBuildTime(build.at)}
            {onStage ? " · on the Stage" : ""}
          </Text>
        </div>
      </header>
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
        title="Checks"
        aside={
          measure.canMeasure &&
          build.available &&
          factsData !== null &&
          factsData.state !== "measuring" &&
          factsData.state !== "queued" ? (
            <Button size="xs" variant="ghost" onClick={() => void measure.send(build.id, true)}>
              <RefreshCwIcon aria-hidden="true" />
              {factsData.state === "never" ? "Measure" : "Measure again"}
            </Button>
          ) : undefined
        }
      >
        {!build.available ? (
          <Text variant="meta" tone="muted" render={<p />}>
            This build's history was pruned; only what the strip shows is left.
          </Text>
        ) : factsData === null ? (
          <Text variant="meta" tone="muted" render={<p />}>
            {facts.error ?? "Reading the checks…"}
          </Text>
        ) : factsData.state === "never" ? (
          <Text variant="meta" tone="muted" render={<p />}>
            {factsData.message.trim() === "" ? "Not measured yet." : factsData.message}
          </Text>
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
      <BuildActions
        threadRef={threadRef}
        build={build}
        list={list}
        onCompare={(other) => requestStage({ kind: "compare", pair: [refOf(other), refOf(build)] })}
      />
    </div>
  );
}

const EVIDENCE_ICON = { video: FileVideoIcon, frame: ImageIcon, log: ScrollTextIcon } as const;

/**
 * The lead checks as plain sentences under one count, then every other
 * measurement folded away. Facts not measured for the same reason are said
 * once, with the reason, so a missing tool is named once with its fix.
 */
function Checks({ threadRef, facts }: { threadRef: ScopedThreadRef; facts: GameBuildFacts }) {
  const characters = useCharacterRoute(threadRef).route;
  const [moreOpen, setMoreOpen] = useState(false);
  const view = gameChecksView(facts);
  const measured = view.checks.filter((check) => check.reading._tag === "measured");
  const pending = view.checks.filter((check) => check.reading._tag === "pending").length;
  const moreMeasured = view.more.filter((more) => more.reading._tag === "measured");
  const busy = facts.state === "measuring" || facts.state === "queued";
  const detailOf = (fact: GameFactView): ReadonlyArray<string> =>
    fact.id === "assets" && facts.assets.status === "measured"
      ? [
          ...assetLines(facts.assets.value),
          ...(characters === null
            ? []
            : [
                `This game makes characters with ${characterRouteLabel(characters)}; change it in the ⋯ menu above the game.`,
              ]),
        ]
      : fact.id === "use" && facts.use.status === "measured"
        ? assetUseLines(facts.use.value)
        : [];
  return (
    <div className="flex flex-col gap-2">
      <Text variant="meta" tone="muted" render={<p />}>
        {[
          // Before any reading lands, "0 pass" would read as a verdict.
          ...(view.pass > 0 || view.toLook > 0 || !busy ? [`${view.pass} pass`] : []),
          ...(view.toLook > 0 ? [`${view.toLook} to look at`] : []),
          ...(busy && facts.message.trim() !== "" ? [facts.message.replace(/\.$/, "")] : []),
        ].join(" · ")}
      </Text>
      {measured.length > 0 ? (
        <Rows>
          {measured.map((check) => (
            <CheckRow
              key={check.id}
              threadRef={threadRef}
              fact={check}
              text={check.sentence}
              value={check.value}
              detail={[]}
            />
          ))}
        </Rows>
      ) : null}
      {pending > 0 ? <PendingRow count={pending} /> : null}
      <NotMeasured facts={view.checks} />
      {view.more.length > 0 ? (
        <Rows>
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(!moreOpen)}
            className="flex items-center gap-2.5 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent"
          >
            <ChevronRightIcon
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                moreOpen && "rotate-90",
              )}
              aria-hidden="true"
            />
            <Text variant="meta" tone="default">
              More measurements ({view.more.length})
            </Text>
          </button>
          {moreOpen
            ? moreMeasured.map((fact) => (
                <CheckRow
                  key={fact.id}
                  threadRef={threadRef}
                  fact={fact}
                  text={factLine(fact).text}
                  value={null}
                  detail={detailOf(fact)}
                />
              ))
            : null}
        </Rows>
      ) : null}
      {moreOpen ? (
        <>
          {view.more.some((fact) => fact.reading._tag === "pending") ? (
            <PendingRow
              count={view.more.filter((fact) => fact.reading._tag === "pending").length}
            />
          ) : null}
          <NotMeasured facts={view.more} />
          {facts.renderer ? (
            <Text variant="caption" tone="dim" render={<p />}>
              Played with {facts.renderer}.
            </Text>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PendingRow({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-card px-3 py-2">
      <ClockIcon className="size-4 shrink-0 text-dim-foreground" aria-hidden="true" />
      <Text variant="meta" tone="muted">
        {count === 1 ? "1 check" : `${count} checks`} still to measure
      </Text>
    </div>
  );
}

/** Facts not measured, one notice per reason. */
function NotMeasured({ facts }: { facts: ReadonlyArray<GameFactView | GameCheck> }) {
  const folded = new Map<string, Array<string>>();
  for (const fact of facts)
    if (fact.reading._tag === "not-measured")
      folded.set(fact.reading.why, [
        ...(folded.get(fact.reading.why) ?? []),
        "sentence" in fact ? fact.sentence : fact.label,
      ]);
  return [...folded].map(([why, names]) => (
    <div key={why} className="flex items-start gap-2.5 rounded-lg bg-card px-3 py-2">
      <MinusIcon className="mt-0.5 size-4 shrink-0 text-dim-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <Text variant="meta" tone="default">
          Not measured: {names.join(", ")}
        </Text>
        <Text variant="meta" tone="muted" render={<p className="break-words" />}>
          {why.charAt(0).toUpperCase() + why.slice(1)}
        </Text>
      </div>
    </div>
  ));
}

function CheckRow({
  threadRef,
  fact,
  text,
  value,
  detail,
}: {
  threadRef: ScopedThreadRef;
  fact: GameFactView;
  text: string;
  value: string | null;
  detail: ReadonlyArray<string>;
}) {
  const tone = fact.reading._tag === "measured" ? fact.reading.tone : null;
  const Icon = tone === "good" ? CheckIcon : tone === "bad" ? TriangleAlertIcon : CircleIcon;
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          <Icon
            className={cn(
              tone === "good"
                ? "size-4 text-success"
                : tone === "bad"
                  ? "size-4 text-warning"
                  : "size-2.5 text-dim-foreground",
            )}
            aria-hidden="true"
          />
        </span>
        <Text variant="meta" tone="default" render={<span className="min-w-0 flex-1" />}>
          <Tooltip>
            <TooltipTrigger render={<span />}>{text}</TooltipTrigger>
            <TooltipPopup side="left" className="max-w-sm">
              {fact.label}: {fact.reading._tag === "measured" ? fact.reading.text : text}
            </TooltipPopup>
          </Tooltip>
        </Text>
        {value === null ? null : (
          <Text variant="caption" tone="muted" numeric>
            {value}
          </Text>
        )}
        {fact.evidence.length > 0 ? (
          <span className="flex shrink-0 items-center">
            {fact.evidence.map((item) => {
              const EvidenceIcon = EVIDENCE_ICON[item.kind];
              return (
                <Tooltip key={item.path}>
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
            })}
          </span>
        ) : null}
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

/**
 * The bot runs' videos and frames, each with Save: the person keeps evidence
 * past the log cleanup in the game's saved/, the same save the agent has.
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
    <Section title="Recordings">
      <Rows>
        {media.map((item) => (
          <div key={item.path} className="flex items-center gap-2 px-3 py-1.5">
            <Text variant="meta" tone="muted" truncate>
              {item.fact} · {item.what}
            </Text>
            <span className="ml-auto shrink-0">
              <SaveMediaButton
                threadRef={threadRef}
                source={item.path}
                label={`${name} ${item.fact} ${item.what}`.toLowerCase()}
              />
            </span>
          </div>
        ))}
      </Rows>
    </Section>
  );
}

const RESTORE = {
  undo: { label: "Undo this build", busy: "Undoing…" },
  redo: { label: "Redo this build", busy: "Redoing…" },
  "go-back": { label: "Go back to this build", busy: "Going back…" },
} as const;

/** Its one restore, by the strip's rules, and a compare with the build before it. */
function BuildActions({
  threadRef,
  build,
  list,
  onCompare,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult;
  onCompare: (other: GameBuild) => void;
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
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {action !== null && kind !== null ? (
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <Button
                size="sm"
                variant="secondary"
                disabled={action.blocked !== null || !restores.canRestore || restores.pending}
                onClick={() =>
                  void restores.send(
                    action.target,
                    action.kind === "go-back" ? restoreQuestion(buildName(build)) : null,
                  )
                }
              >
                {restores.restoring(action.target) ? kind.busy : kind.label}
              </Button>
            </TooltipTrigger>
            {action.blocked === null ? null : (
              <TooltipPopup side="top">{action.blocked}</TooltipPopup>
            )}
          </Tooltip>
        ) : null}
        {previous !== undefined && build.available && previous.available ? (
          <Button size="sm" variant="ghost" onClick={() => onCompare(previous)}>
            <ColumnsIcon aria-hidden="true" />
            Compare with {buildName(previous).replace(/^Build /, "")}
          </Button>
        ) : null}
      </div>
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
  return (
    <Section
      title="Look"
      aside={
        <Text variant="caption" tone="dim">
          {GAME_STYLE_FILE}
        </Text>
      }
    >
      {style === null ? (
        <Text variant="meta" tone="muted" render={<p />}>
          No look is locked yet. The agent writes {GAME_STYLE_FILE} when it picks one.
        </Text>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {swatches.length > 0 ? (
            <span className="flex gap-1">
              {swatches.slice(0, 8).map((hex) => (
                <span
                  key={hex}
                  aria-label={hex}
                  className="size-5 rounded ring-1 ring-border ring-inset"
                  style={{ background: hex }}
                />
              ))}
            </span>
          ) : null}
          <Text variant="meta" tone="muted">
            {[
              style.family ?? null,
              style.mode === "pixel" ? "Pixel art" : "Smooth",
              typeof style.palette === "string" ? `palette ${style.palette}` : null,
            ]
              .filter((part) => part !== null)
              .join(" · ")}
          </Text>
        </div>
      )}
      <Button
        size="xs"
        variant="ghost"
        aria-expanded={artOpen}
        onClick={() => setArtOpen(!artOpen)}
        className="self-start"
      >
        {artOpen ? "Hide generated art" : "Generated art"}
      </Button>
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
        <Text variant="caption" tone="dim">
          {things.length === 1 ? "1 thing" : `${things.length} things`}
        </Text>
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
        <Text variant="meta" tone="muted" render={<p />}>
          Nothing named yet. The game's things show here while it plays, once your agent names them.
        </Text>
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
