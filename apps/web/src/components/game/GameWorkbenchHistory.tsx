import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import type {
  GameBuildsResult,
  GameTry,
  GameTryVersion,
  ScopedThreadRef,
} from "@kurambit/contracts";
import { Redo2Icon, Undo2Icon } from "lucide-react";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { randomUUID } from "../../lib/utils";
import { gameEnvironment, stagePlayTarget } from "../../state/game";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuerySelector } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { refOf } from "./gameBuildRef";
import { GameBuildHistory } from "./GameBuildHistory";
import { buildName, buildPhrase, checksLine } from "./gameBuilds.logic";
import { useGameName } from "./GameName";
import { Workbench } from "./GameWorkbenchParts";
import { useTurnUndo } from "./useBuildActions";

const STATE_WORDS: Record<GameTryVersion["state"], string> = {
  working: "Working…",
  ready: "",
  stopped: "Stopped",
  failed: "Failed",
};

const latestTry = (
  result: AsyncResult.AsyncResult<{ readonly tries: ReadonlyArray<GameTry> }, unknown>,
) => (AsyncResult.isSuccess(result) ? (result.value.tries[0] ?? null) : null);

const buildsOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) =>
  AsyncResult.isSuccess(result) ? result.value : null;

/**
 * The Workbench's History tab: the game's builds and its latest "try it N ways" versions in one
 * place, with Undo and Redo, compare any two, and keeping a version. Playing or comparing goes
 * through the Stage's own requests, so the Stage stays the one place a build plays.
 */
export function GameWorkbenchHistory({ threadRef }: { threadRef: ScopedThreadRef }) {
  const requestStage = useGameWorkspaceStore((state) => state.requestStage);
  const inspectBuild = useGameWorkspaceStore((state) => state.inspectBuild);
  const playing = useAtomValue(stagePlayTarget(threadRef))?.build ?? null;
  const gameName = useGameName(
    threadRef.environmentId,
    useQuietThreadShell(threadRef)?.projectId ?? null,
    "",
  );
  const threadKey = scopedThreadKey(threadRef);
  return (
    <Workbench.Body>
      <UndoRedo threadRef={threadRef} />
      <Versions threadRef={threadRef} playing={playing} />
      <div className="px-2 py-2">
        <GameBuildHistory
          threadRef={threadRef}
          gameName={gameName}
          playing={playing}
          slot={null}
          request={null}
          reelOpen={false}
          onPlay={(build) => requestStage({ kind: "play", build: refOf(build) })}
          onPlayUnlisted={(ref) => requestStage({ kind: "play", build: ref })}
          onLive={() => requestStage({ kind: "live" })}
          onCompare={(pair) => requestStage({ kind: "compare", pair })}
          // The Checks tab follows the build last picked here.
          onInspect={(build) => inspectBuild({ threadKey, build: build.id, snapshot: build })}
        />
      </div>
    </Workbench.Body>
  );
}

/** Undo and Redo of the latest build, saying what they go back to before they are pressed. */
function UndoRedo({ threadRef }: { threadRef: ScopedThreadRef }) {
  const requestStage = useGameWorkspaceStore((state) => state.requestStage);
  const undo = useTurnUndo(threadRef, null);
  const allowed = (kind: "undo" | "redo") =>
    undo.action?.kind === kind && undo.action.blocked === null && undo.canRestore && !undo.pending;
  const name = undo.view === null ? null : buildPhrase(buildName(undo.view.build));
  return (
    <Workbench.Section
      title="Undo"
      detail={
        undo.action?.blocked ??
        (name === null
          ? "Nothing to undo yet: each change your agent makes is a build you can take back."
          : allowed("undo")
            ? `Undo takes ${name} back. Your later work is never lost: it stays a build here.`
            : allowed("redo")
              ? `${name.charAt(0).toUpperCase()}${name.slice(1)} was undone; Redo brings it back.`
              : null)
      }
      aside={
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={!allowed("undo")}
            onClick={() => requestStage({ kind: "undo" })}
          >
            <Undo2Icon aria-hidden="true" />
            Undo
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!allowed("redo")}
            onClick={() => requestStage({ kind: "redo" })}
          >
            <Redo2Icon aria-hidden="true" />
            Redo
          </Button>
        </>
      }
    />
  );
}

/**
 * The chat's latest "try it N ways": each version with its approach and checks. Choosing one
 * plays its build from a copy; Keep makes it the game folder's, through the same restore Undo
 * takes back.
 */
function Versions({ threadRef, playing }: { threadRef: ScopedThreadRef; playing: string | null }) {
  const requestStage = useGameWorkspaceStore((state) => state.requestStage);
  const tried = useEnvironmentQuerySelector(
    gameEnvironment.tries({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    latestTry,
  );
  const list = useEnvironmentQuerySelector(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    buildsOf,
  );
  const canKeep = useAtomValue(gameEnvironment.keepVersion.permissionAtom(threadRef.environmentId));
  const keepVersion = useAtomCommand(gameEnvironment.keepVersion, { reportFailure: false });
  const [keeping, setKeeping] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (tried == null) return null;
  const current = list?.current ?? null;
  const buildOf = (version: GameTryVersion) =>
    version.build === null
      ? null
      : (list?.builds.find((each) => each.id === version.build) ?? null);
  const keep = async (version: GameTryVersion) => {
    setKeeping(version.n);
    setNote(null);
    const result = await keepVersion({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        runId: tried.runId,
        n: version.n,
        commandId: randomUUID(),
      },
    });
    setKeeping(null);
    setNote(
      result._tag === "Failure" ? String(squashAtomCommandFailure(result)) : result.value.message,
    );
  };
  return (
    <Workbench.Section title={`Tried ${tried.versions.length} ways`} detail={tried.request}>
      <ul className="flex flex-col gap-1" data-game-versions="">
        {tried.versions.map((version) => {
          const build = buildOf(version);
          const status =
            STATE_WORDS[version.state] ||
            (build === null ? "Not listed yet" : checksLine(build.facts));
          const onStage = version.build !== null && version.build === playing;
          const inFolder = version.build !== null && version.build === current;
          return (
            <li key={version.n} className="flex min-w-0 items-center gap-2">
              <Button
                size="sm-multiline"
                variant={onStage ? "secondary" : "ghost"}
                className="min-w-0 flex-1 justify-start"
                disabled={build === null}
                aria-pressed={onStage}
                onClick={() =>
                  build === null ? undefined : requestStage({ kind: "play", build: refOf(build) })
                }
              >
                <span className="flex min-w-0 flex-col items-start text-start">
                  <Text variant="label" tone="inherit" truncate>
                    Version {version.n}
                    {tried.kept?.n === version.n ? " · kept" : ""}
                    {inFolder ? " · in the folder" : ""}
                  </Text>
                  <Text variant="caption" tone="muted" render={<span className="break-words" />}>
                    {version.approach === "" ? status : `${version.approach} · ${status}`}
                  </Text>
                </span>
              </Button>
              {version.state === "ready" && build !== null ? (
                <Button
                  size="xs"
                  variant={inFolder ? "ghost" : "outline"}
                  disabled={!canKeep || keeping !== null || inFolder}
                  onClick={() => void keep(version)}
                >
                  {inFolder ? "Kept" : keeping === version.n ? "Keeping…" : "Keep"}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {note === null ? null : (
        <Text variant="caption" tone="muted" render={<p />}>
          {note}
        </Text>
      )}
    </Workbench.Section>
  );
}
