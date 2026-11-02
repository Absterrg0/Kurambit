import type { ProjectId, ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class TurnAdmissionRejectedError extends Schema.TaggedError<TurnAdmissionRejectedError>()(
  "TurnAdmissionRejectedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * Runs before a message turn commits, whatever surface sent it (websocket,
 * MCP, launch, scheduled task). A feature that owns a workspace, such as a
 * game review, can stop its own work first or refuse the turn. The default
 * admits everything, so orchestration needs no knowledge of those features.
 */
export interface TurnAdmissionThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

export class TurnAdmission extends Context.Reference<{
  readonly admit: (thread: TurnAdmissionThread) => Effect.Effect<void, TurnAdmissionRejectedError>;
}>("kurambit/orchestration-v2/TurnAdmission", {
  defaultValue: () => ({ admit: () => Effect.void }),
}) {}
