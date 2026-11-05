import * as Base64Url from "effect/encoding/Base64Url";
import { CheckpointRef, ProjectId, type ThreadId } from "@kurambit/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/kurambit/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/turn/${turnCount}`,
  );
}

const GAME_RUN_REFS_PREFIX = "refs/kurambit/game-runs";

/** A production run's build, by the name the run gives it (`best`, `round-3/candidate`). */
export function checkpointRefForGameRun(runId: string, name: string): CheckpointRef {
  return CheckpointRef.make(`${gameRunRefsFolder(runId)}${name}`);
}

/** The ref folder holding every build of one production run. */
export const gameRunRefsFolder = (runId: string) =>
  `${GAME_RUN_REFS_PREFIX}/${Base64Url.encode(runId)}/`;

function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
