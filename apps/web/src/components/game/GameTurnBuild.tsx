import { CheckIcon, Redo2Icon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import type { GameBuild, RunId, ScopedThreadRef } from "@kurambit/contracts";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { buildName, factsSummaryLine } from "./gameBuilds.logic";
import { stepVerdictText } from "./keepGoing.logic";
import { useTurnUndo } from "./useBuildActions";

/** "4 checks pass, 1 to look at", or what state the checks are in. */
const checksLine = (build: GameBuild): string => {
  const { good, bad, state } = build.facts;
  if (good === 0 && bad === 0) return factsSummaryLine(build.facts) ?? "Measured";
  const parts = [
    ...(good > 0 ? [`${good} ${good === 1 ? "check passes" : "checks pass"}`] : []),
    ...(bad > 0 ? [`${bad} to look at`] : []),
  ];
  return `${parts.join(", ")}${state === "measuring" || state === "queued" ? " so far" : ""}`;
};

/**
 * A changing chat turn's build in the Log, on one line: its name, its checks,
 * and Undo or Redo while it is the latest. The name shows it on the Stage and
 * in the Inspector, where everything else about it lives.
 */
export function GameTurnBuild({ threadRef, runId }: { threadRef: ScopedThreadRef; runId: RunId }) {
  const undo = useTurnUndo(threadRef, runId);
  const view = undo.view;
  const open = () =>
    useGameWorkspaceStore
      .getState()
      .requestStage(
        view === null
          ? { kind: "detail", build: { _tag: "turn", threadId: threadRef.threadId, runId } }
          : { kind: "play", build: { _tag: "build", build: view.build.id } },
      );
  if (view === null)
    return (
      <div data-game-turn-build="" className="mt-1.5">
        <Button size="xs" variant="ghost" onClick={open}>
          Open this turn's build
        </Button>
      </div>
    );
  const build = view.build;
  const action = undo.action?.kind === "go-back" ? null : undo.action;
  const step = build.source._tag === "turn" ? build.source.step : null;
  return (
    <div data-game-turn-build={build.id} className="mt-1.5 flex flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        {build.facts.bad > 0 ? (
          <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
        ) : (
          <CheckIcon className="size-3.5 shrink-0 text-success" aria-hidden="true" />
        )}
        <Button size="xs" variant="ghost" onClick={open} disabled={!build.available}>
          {buildName(build)}
        </Button>
        <Text variant="meta" tone="muted" truncate>
          {step?.verdict != null ? `${stepVerdictText(step)} · ` : ""}
          {checksLine(build)}
        </Text>
        {action !== null ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={action.blocked !== null || !undo.canRestore || undo.pending}
            onClick={() => void undo.send()}
          >
            {action.kind === "undo" ? (
              <Undo2Icon aria-hidden="true" />
            ) : (
              <Redo2Icon aria-hidden="true" />
            )}
            {undo.restoring
              ? action.kind === "undo"
                ? "Undoing…"
                : "Redoing…"
              : action.kind === "undo"
                ? "Undo"
                : "Redo"}
          </Button>
        ) : null}
      </div>
      {undo.error !== null ? (
        <Text variant="caption" tone="destructive" render={<p role="alert" />}>
          {undo.error}
        </Text>
      ) : null}
    </div>
  );
}
