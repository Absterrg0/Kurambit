import type { ProjectId, ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class TurnAdmissionRejectedError extends Schema.TaggedError<TurnAdmissionRejectedError>()(
  "TurnAdmissionRejectedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * Runs before a message turn commits, whatever surface sent it (websocket,
 * MCP, launch, scheduled task). A feature that owns a workspace, such as a
 * game review, can stop its own work first, refuse the turn, or hold it in the
 * thread's queue with a reason until it releases it (`queue.resume`). The
 * default admits everything, so orchestration needs no knowledge of those features.
 */
export interface TurnAdmissionThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

/** Admitted (nothing), or held in the queue with the person's reason. */
export type TurnAdmissionDecision = void | { readonly hold: string };

interface TurnAdmissionShape {
  readonly admit: (
    thread: TurnAdmissionThread,
  ) => Effect.Effect<TurnAdmissionDecision, TurnAdmissionRejectedError>;
}

export class TurnAdmission extends Context.Reference<
  TurnAdmissionShape & {
    /**
     * The feature above orchestration attaches its admission once its services exist; only
     * `layerAttachable` takes one.
     */
    readonly attach?: (admission: TurnAdmissionShape) => Effect.Effect<void>;
  }
>("kurambit/orchestration-v2/TurnAdmission", {
  defaultValue: () => ({ admit: () => Effect.void }),
}) {}

/** One admission for the runtime, which the game layer attaches to as its copy note is. */
export const layerAttachable = Layer.sync(TurnAdmission, () => {
  let attached: TurnAdmissionShape | null = null;
  return {
    admit: (thread) => (attached === null ? Effect.void : attached.admit(thread)),
    attach: (admission) =>
      Effect.sync(() => {
        attached = admission;
      }),
  };
});
