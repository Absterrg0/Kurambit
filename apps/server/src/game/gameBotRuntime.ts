// @effect-diagnostics preferSchemaOverJson:off -- Bounds a stepped run's own JSON evidence.
import { GameOperationError } from "@kurambit/contracts";
import type { OwnedProcess } from "./processHost.ts";

/** One bot run call: a stop flips `stopped` and stops every process the run started. */
export interface Session {
  readonly root: string;
  readonly runId: string;
  stopped: boolean;
  readonly processes: OwnedProcess[];
}

export const opError = (
  operation: string,
  path: string,
  reason: GameOperationError["reason"],
  detail?: string,
  cause?: unknown,
): GameOperationError =>
  new GameOperationError({
    operation,
    path,
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(cause === undefined ? {} : { cause }),
  });

/** A run's structured evidence, kept only when its JSON fits 4 KB. */
export const boundEvidence = (
  evidence: unknown,
): { readonly value: unknown; readonly dropped: boolean } => {
  if (evidence === undefined || evidence === null) return { value: undefined, dropped: false };
  let text: string | undefined;
  try {
    text = JSON.stringify(evidence);
  } catch {
    return { value: undefined, dropped: true };
  }
  if (text === undefined) return { value: undefined, dropped: false };
  return Buffer.byteLength(text, "utf8") > 4096
    ? { value: undefined, dropped: true }
    : { value: evidence, dropped: false };
};

/** The run's last screen, beside its trace. */
export const END_FRAME = "frame-end.png";
