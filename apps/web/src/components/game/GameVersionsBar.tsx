import { XIcon } from "lucide-react";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type {
  GameBuild,
  GameBuildId,
  GameTry,
  GameTryVersion,
  ScopedThreadRef,
} from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";

import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuerySelector } from "../../state/query";
import { gameEnvironment } from "../../state/game";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { checksLine } from "./gameBuilds.logic";

const STATE_WORDS: Record<GameTryVersion["state"], string> = {
  working: "Working…",
  ready: "",
  stopped: "Stopped",
  failed: "Failed",
};

const latestTry = (
  result: AsyncResult.AsyncResult<{ readonly tries: ReadonlyArray<GameTry> }, unknown>,
) => (AsyncResult.isSuccess(result) ? (result.value.tries[0] ?? null) : null);

/**
 * The chat's latest "try it N ways" on the Stage: each version with its approach and checks.
 * Choosing one plays its build from a copy; Keep makes it the game folder's, through the same
 * restore Undo takes back.
 */
export function GameVersionsBar({
  threadRef,
  builds,
  playing,
  current,
  onPlay,
}: {
  threadRef: ScopedThreadRef;
  builds: ReadonlyArray<GameBuild>;
  /** The build the Stage plays from a copy, if any. */
  playing: GameBuildId | null;
  /** The build the game folder holds. */
  current: GameBuildId | null;
  onPlay: (build: GameBuild) => void;
}) {
  const tried = useEnvironmentQuerySelector(
    gameEnvironment.tries({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    latestTry,
  );
  const canKeep = useAtomValue(gameEnvironment.keepVersion.permissionAtom(threadRef.environmentId));
  const keepVersion = useAtomCommand(gameEnvironment.keepVersion, { reportFailure: false });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [keeping, setKeeping] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (tried == null || dismissed === tried.runId) return null;
  const buildOf = (version: GameTryVersion) =>
    version.build === null ? null : (builds.find((each) => each.id === version.build) ?? null);
  const chosen = tried.versions.find(
    (version) => version.build !== null && version.build === playing,
  );
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
    <div data-game-versions="" className="flex flex-col gap-1.5 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <Text variant="meta" tone="muted" truncate>
          Tried {tried.versions.length} ways: {tried.request}
        </Text>
        <span className="flex-1" />
        {chosen !== undefined && chosen.state === "ready" ? (
          <Button
            size="xs"
            disabled={!canKeep || keeping !== null || chosen.build === current}
            onClick={() => void keep(chosen)}
          >
            {chosen.build === current ? `Version ${chosen.n} is kept` : `Keep version ${chosen.n}`}
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Hide the versions"
          onClick={() => setDismissed(tried.runId)}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <div className="flex gap-1.5">
        {tried.versions.map((version) => {
          const build = buildOf(version);
          const status =
            STATE_WORDS[version.state] ||
            (build === null ? "Not listed yet" : checksLine(build.facts));
          return (
            <Button
              key={version.n}
              size="sm"
              variant={version.build !== null && version.build === playing ? "secondary" : "ghost"}
              disabled={build === null}
              aria-pressed={version.build !== null && version.build === playing}
              title={version.approach === "" ? `Version ${version.n}` : version.approach}
              onClick={() => (build === null ? undefined : onPlay(build))}
            >
              <span className="flex min-w-0 flex-col items-start">
                <Text variant="label" tone="inherit" truncate>
                  Version {version.n}
                  {tried.kept?.n === version.n ? " · kept" : ""}
                  {version.build !== null && version.build === current ? " · in the folder" : ""}
                </Text>
                <Text variant="caption" tone="muted" truncate>
                  {version.approach === "" ? status : `${version.approach} · ${status}`}
                </Text>
              </span>
            </Button>
          );
        })}
      </div>
      {note === null ? null : (
        <Text variant="caption" tone="muted">
          {note}
        </Text>
      )}
    </div>
  );
}
