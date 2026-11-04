// Which thread a role step's first turn made, as T3 recorded it.
import * as Effect from "effect/Effect";
import { CommandId } from "@kurambit/contracts";
import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type { RoleStep } from "./state.ts";

/**
 * A step's first turn: its launch, a follow-up's send, the relaunch that
 * replaces a deleted thread, or the fresh thread that replaces one whose
 * provider session refuses every turn.
 */
export type FirstTurn = "" | ":send" | ":relaunch" | ":fresh";

// Derived from the step alone, so a replay after a crash is the same command
// and T3's receipt for it names the thread it committed on.
export const firstTurnId = (runId: string, stepId: number, kind: FirstTurn) =>
  CommandId.make(`studio:${runId}:${stepId}${kind}`);

/**
 * The thread a resumed step reattaches to, or null when its first turn never
 * committed. A fresh thread or a relaunch replaces the step's own, so the
 * newest kind wins. A fresh attempt looks only for its own: the thread it
 * replaces is the one it must not wait on.
 */
export const findFirstTurn = (
  receipt: ThreadManagement.ThreadManagementService["Service"]["getCommandReceipt"],
  runId: string,
  step: RoleStep,
  fresh: boolean,
) =>
  Effect.gen(function* () {
    const kinds: ReadonlyArray<FirstTurn> = fresh
      ? [":fresh"]
      : [":fresh", ":relaunch", step.thread === null ? "" : ":send"];
    for (const kind of kinds) {
      const found = yield* receipt(firstTurnId(runId, step.id, kind));
      if (found?.status === "accepted") return { threadId: found.threadId, kind };
    }
    // Older run.json files recorded the turn themselves, and their follow-up
    // sends had no derived id, so that copy is the only record of one.
    const legacy = fresh ? undefined : step.attached?.threadId;
    return legacy === undefined ? null : { threadId: legacy, kind: "legacy" as const };
  });
