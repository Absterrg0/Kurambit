import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import {
  loadedWords,
  playOutcomeWords,
  type GameBuild,
  type GameBuildFacts,
  type GameBuildsResult,
  type GameSavedPlayReading,
  type GameTuneChange,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { ChevronRightIcon, GitCompareIcon, PlayIcon } from "lucide-react";

import { useDiffPanelStore } from "../../diffPanelStore";
import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadCheckpointSummaries, useThreadProjection } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { readNextLine } from "@kurambit/shared/gameNextLine";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Text } from "../ui/text";
import { refOf } from "./gameBuildRef";
import { buildName, buildPhrase } from "./gameBuilds.logic";
import { GameBuildStill } from "./GameBuildStill";
import { useGameName } from "./GameName";
import { replayStageRun, useThreadStageBridge } from "./gameStageBridge";
import { useChangedSinceBase } from "./useChangedSinceBase";
import { Workbench } from "./GameWorkbenchParts";
import { useQuietThreadShell } from "../../state/entities";

// ─── What changed ──────────────────────────────────────────────────────────────

type FileKind = "code" | "art" | "audio" | "tune" | "other";

const KIND_WORDS: Record<FileKind, string> = {
  code: "Code",
  art: "Art",
  audio: "Audio",
  tune: "Tuned values",
  other: "Notes and other files",
};
const KIND_ORDER: ReadonlyArray<FileKind> = ["code", "art", "audio", "tune", "other"];
const CODE = /\.(m?js|cjs|jsx?|tsx?|html?|css|glsl|wgsl|vert|frag|json)$/i;
const ART = /\.(glb|gltf|fbx|obj|blend\d?|png|jpe?g|webp|gif|svg|ktx2|hdr|exr|bin|basis)$/i;
const AUDIO = /\.(mp3|ogg|wav|m4a|flac|opus|aac|webm)$/i;

/** A changed file in game terms: what a game developer calls it, not its extension. */
const fileKind = (path: string): FileKind =>
  /(^|\/)tune\.json$/.test(path)
    ? "tune"
    : AUDIO.test(path)
      ? "audio"
      : ART.test(path) || path.startsWith("art/")
        ? "art"
        : CODE.test(path)
          ? "code"
          : "other";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The first sentence of the agent's reply for the turn, without its markdown: the changelog's
 * title. The reply itself is the chat's.
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
  return sentence.length > 220 ? `${sentence.slice(0, 219)}…` : sentence;
};

const lineCounts = (files: GameBuild["files"]) => {
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <Text variant="caption" tone="muted" numeric render={<span className="shrink-0" />}>
      <span className="text-success">+{added.toLocaleString("en-US")}</span>{" "}
      <span className="text-destructive-foreground">−{removed.toLocaleString("en-US")}</span>
    </Text>
  );
};

/** One tuned value as the changelog says it: "jump 9 → 12", a new one "jump 12", a dropped one "jump back to default". */
const tuneWords = (change: GameTuneChange) =>
  change.from === null
    ? `${change.key} ${change.to}`
    : change.to === null
      ? `${change.key} ${change.from} → the game's own`
      : `${change.key} ${change.from} → ${change.to}`;

/**
 * What a build changed, as a changelog: its title from the agent's reply (one sentence), its files
 * grouped in game terms with their lines, tuned values as "jump 9 → 12", and the readings that
 * moved since the build it was made from. The full reply stays in the chat, the code in the diff.
 */
export function BuildChangelog({
  threadRef,
  build,
  list,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  list: GameBuildsResult;
}) {
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
  const changes = useEnvironmentQuery(
    build.available
      ? gameEnvironment.buildChanges({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, build: build.id },
        })
      : null,
  );
  const files = changes.data?.files ?? build.files;
  const count = changes.data?.count ?? build.fileCount;
  const tunes = changes.data?.tunes ?? [];
  const title =
    (reply === undefined ? null : firstSentence(reply.text)) ??
    (build.source._tag === "turn" || build.source._tag === "version"
      ? build.source.request
      : build.summary);
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    files: files.filter((file) => fileKind(file.path) === kind),
  })).filter((group) => group.files.length > 0);
  const openDiff = () => {
    if (runId === null) return;
    useDiffPanelStore.getState().selectTurn(threadRef, runId);
    useRightPanelStore.getState().open(threadRef, "diff");
  };
  return (
    <Workbench.Section
      title="What changed"
      aside={
        runId === null ? undefined : (
          <Button size="xs" variant="ghost" onClick={openDiff}>
            {count === null || count === 0 ? "Code" : count === 1 ? "1 file" : `${count} files`}
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        )
      }
    >
      {title === "" ? null : (
        <Text variant="body" tone="strong" render={<p className="break-words" />}>
          {title}
        </Text>
      )}
      {changes.data === null && changes.error === null && build.available ? (
        <Skeleton className="h-3 w-48" />
      ) : groups.length === 0 ? (
        <Text variant="meta" tone="muted" render={<p />}>
          {count === null ? "The first build: everything in it is new." : "No game files changed."}
        </Text>
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((group) => (
            <li key={group.kind} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <Text variant="meta" tone="default" emphasis render={<span className="flex-1" />}>
                  {KIND_WORDS[group.kind]}
                  <Text variant="caption" tone="muted" numeric>
                    {" "}
                    · {group.files.length} {group.files.length === 1 ? "file" : "files"}
                  </Text>
                </Text>
                {lineCounts(group.files)}
              </div>
              {group.kind === "tune" && tunes.length > 0 ? (
                <ul className="flex flex-col">
                  {tunes.map((change) => (
                    <Text
                      key={`${change.thing ?? ""}\0${change.key}`}
                      variant="meta"
                      tone="muted"
                      numeric
                      render={<li className="truncate" />}
                    >
                      {change.thing === null ? null : (
                        <span className="text-foreground">{change.thing} · </span>
                      )}
                      {tuneWords(change)}
                    </Text>
                  ))}
                </ul>
              ) : (
                <Text variant="caption" tone="muted" render={<p className="break-words" />}>
                  {group.files
                    .slice(0, 5)
                    .map((file) => baseName(file.path))
                    .join(", ")}
                  {group.files.length > 5 ? ` and ${group.files.length - 5} more` : ""}
                </Text>
              )}
            </li>
          ))}
        </ul>
      )}
      <FactsMoved threadRef={threadRef} build={build} list={list} />
    </Workbench.Section>
  );
}

/** The readings that moved since the build this one was made from, named from one to the other. */
function FactsMoved({
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
  const from = buildPhrase(buildName(base));
  return (
    <div className="flex flex-col gap-0.5 border-t border-border pt-2">
      <div className="flex items-center gap-2">
        <Text variant="meta" tone="default" emphasis render={<span className="flex-1" />}>
          {changed.length === 0 ? `No reading moved since ${from}` : `Readings since ${from}`}
        </Text>
        {changed.length === 0 ? null : (
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
      {changed.map((row) => (
        <Text key={row.id} variant="meta" tone="muted" numeric render={<p />}>
          <span className="text-foreground">{row.name}</span> {row.a ?? "not measured"} →{" "}
          <span className="text-foreground">{row.b ?? "not measured"}</span>
        </Text>
      ))}
    </div>
  );
}

// ─── Performance ───────────────────────────────────────────────────────────────

const big = (count: number) =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 10_000
      ? `${Math.round(count / 1000)}k`
      : count.toLocaleString("en-US");

/** Where a frame's time goes, as the random-input play measured it. */
export function BuildPerformance({ facts }: { facts: GameBuildFacts }) {
  const reading = facts.performance;
  if (reading.status !== "measured") return null;
  const perf = reading.value;
  return (
    <Workbench.Section
      title="Performance"
      detail={`Measured over ${perf.frames.toLocaleString("en-US")} frames at ${perf.width}×${perf.height}`}
    >
      <div className="grid grid-cols-2 gap-x-5">
        <Workbench.Stat
          label="Frame rate"
          value={perf.fps === null ? "not measured" : `${Math.round(perf.fps)} fps`}
          {...(perf.fps !== null && perf.fps < 50 ? { tone: "bad" as const } : {})}
        />
        <Workbench.Stat
          label="Slowest 1%"
          value={perf.low1 === null ? "not measured" : `${Math.round(perf.low1)} fps`}
        />
        <Workbench.Stat
          label="GPU per frame"
          value={perf.gpuMs === null ? "not measured" : `${perf.gpuMs.toFixed(1)} ms`}
        />
        <Workbench.Stat
          label="Render scale"
          value={perf.scale === null ? "not measured" : `${perf.scale.toFixed(2)}×`}
        />
        <Workbench.Stat
          label="Draw calls"
          value={perf.drawCalls === undefined ? "not measured" : big(perf.drawCalls)}
        />
        <Workbench.Stat
          label="Triangles"
          value={perf.triangles === undefined ? "not measured" : big(perf.triangles)}
        />
      </div>
    </Workbench.Section>
  );
}

// ─── Screens ───────────────────────────────────────────────────────────────────

/** The game at phone and widescreen size, each frame as the check saw it. */
export function BuildScreens({
  threadRef,
  facts,
}: {
  threadRef: ScopedThreadRef;
  facts: GameBuildFacts;
}) {
  const gameName = useGameName(
    threadRef.environmentId,
    useQuietThreadShell(threadRef)?.projectId ?? null,
    "",
  );
  const reading = facts.screens;
  if (reading.status !== "measured") return null;
  const report = reading.value;
  return (
    <Workbench.Section
      title="Screens"
      detail={report.bytes === null ? null : `The page ${loadedWords(report.bytes)} to start`}
    >
      <ul className="grid grid-cols-2 gap-3">
        {report.sizes.map((size) => {
          const problems = [
            ...(size.booted ? [] : ["does not start"]),
            ...(size.canvas === null ? ["no canvas"] : []),
            ...(size.errors.length === 0
              ? []
              : [`${size.errors.length} ${size.errors.length === 1 ? "error" : "errors"}`]),
            ...(size.hudOff === null || size.hudOff.length === 0 ? [] : ["HUD off screen"]),
          ];
          return (
            <li key={size.name} className="flex min-w-0 flex-col gap-1">
              <GameBuildStill
                threadRef={threadRef}
                gameName={gameName}
                build={{ still: size.frame }}
                mark="absent"
                className={
                  size.name === "phone"
                    ? "mx-auto aspect-[9/16] h-32 rounded-md ring-1 ring-border ring-inset"
                    : "aspect-video w-full rounded-md ring-1 ring-border ring-inset"
                }
              />
              <Text variant="meta" tone="default" truncate>
                {size.name === "phone" ? "Phone" : "Widescreen"}{" "}
                <Text variant="caption" tone="muted" numeric>
                  {size.width}×{size.height}
                </Text>
              </Text>
              <Text
                variant="caption"
                tone={problems.length === 0 ? "muted" : "destructive"}
                render={<span />}
              >
                {problems.length === 0 ? "Fits" : problems.join(", ")}
              </Text>
            </li>
          );
        })}
      </ul>
    </Workbench.Section>
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
 * Each saved play as this build replayed it: whether it ends the same, where it first played
 * differently, and Replay to watch it on the Stage.
 */
export function BuildSavedPlays({
  threadRef,
  facts,
}: {
  threadRef: ScopedThreadRef;
  facts: GameBuildFacts;
}) {
  const reading = facts.savedPlays;
  const loadPlay = useAtomCommand(gameEnvironment.savedPlay, { reportFailure: false });
  const canRead = useAtomValue(gameEnvironment.savedPlay.permissionAtom(threadRef.environmentId));
  const rewinds = useThreadStageBridge(
    scopedThreadKey(threadRef),
    (state) => state.status === "ready" && state.capabilities.includes("rewind"),
    false,
  );
  const [busy, setBusy] = useState<string | null>(null);
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
  const plays = reading.value.plays;
  return (
    <Workbench.Section
      title="Saved plays"
      detail={
        reading.value.skipped > 0
          ? `${reading.value.skipped} older plays were not replayed on this build`
          : "Each saved play replayed on this build, input for input"
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Play</TableHead>
            <TableHead>Reading</TableHead>
            <TableHead>First difference</TableHead>
            <TableHead>
              <span className="sr-only">Replay</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plays.map((play) => (
            <TableRow key={play.name}>
              <TableCell className="max-w-28">
                <Text variant="meta" tone="default" truncate render={<span className="block" />}>
                  {play.name}
                </Text>
              </TableCell>
              <TableCell>
                <Text
                  variant="meta"
                  tone={play.reading === "same" ? "muted" : "destructive"}
                  render={<span />}
                >
                  {READING_WORDS[play.reading]}
                </Text>
              </TableCell>
              <TableCell className="max-w-32">
                <Text
                  variant="meta"
                  tone="muted"
                  numeric
                  truncate
                  render={<span className="block" />}
                >
                  {play.differs === null
                    ? "None"
                    : `${Math.round(play.differs.seconds)} s · ${play.differs.what}`}
                </Text>
              </TableCell>
              <TableCell>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canRead || !rewinds || busy !== null}
                  aria-label={`Replay ${play.name} on the Stage`}
                  onClick={() => void replay(play.name)}
                >
                  <PlayIcon aria-hidden="true" />
                  {busy === play.name ? "Replaying…" : "Replay"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {note === null ? null : (
        <Text variant="meta" tone="muted" render={<p />}>
          {note}
        </Text>
      )}
    </Workbench.Section>
  );
}
