// Pure lifecycle helpers for the existing-game `--exercise-lifecycle` extension.
//
// The runner applies real engine-source edits and reads the real agent's tool
// results through these, so a lifecycle verdict never trusts model prose.
// Nothing here touches a server, a model, or the filesystem.
export const LIFECYCLE_STALE_EDIT =
  "# lifecycle stale-submit probe (test-owned, harness restores)\n";

/** A line Godot's parser rejects, so `game_godot_check` names the file and line. */
export const LIFECYCLE_SYNTAX_DEFECT = "THIS IS NOT VALID GDSCRIPT (((\n";

/**
 * Picks the engine script the lifecycle phases edit, from game-relative paths.
 * The StudioProbe autoload is excluded: breaking it tests the probe policy, not
 * the check gate the syntax phase means to exercise. Sorted-first keeps the
 * choice deterministic across the platformer and card sources.
 */
export const pickLifecycleScript = (files: ReadonlyArray<string>): string => {
  const candidates = files
    .map((file) => file.replace(/\\/g, "/"))
    .filter(
      (file) =>
        file.startsWith("godot/") &&
        file.endsWith(".gd") &&
        !file.endsWith("/studio_probe.gd") &&
        file !== "godot/studio_probe.gd",
    )
    .sort();
  if (candidates.length === 0)
    throw new Error("The lifecycle phases need a godot/**/*.gd script and found none");
  return candidates[0]!;
};

export interface LifecycleSubmitCheck {
  readonly id: string;
  readonly status: string;
}

export interface LifecycleSubmitFacts {
  readonly accepted: boolean;
  readonly buildId: string | null;
  readonly message: string;
  readonly checks: ReadonlyArray<LifecycleSubmitCheck>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const structuredOutput = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/**
 * Reads a `game_submit` tool result strictly. Anything that is not the exact
 * accepted/refused shape is `null`, so the runner fails on an unreadable
 * result instead of grading prose.
 */
export const parseSubmitToolOutput = (value: unknown): LifecycleSubmitFacts | null => {
  value = structuredOutput(value);
  if (!isRecord(value)) return null;
  if (typeof value.accepted !== "boolean") return null;
  if (typeof value.message !== "string" || value.message === "") return null;
  if (value.buildId !== null && typeof value.buildId !== "string") return null;
  if (!Array.isArray(value.checks)) return null;
  const checks: LifecycleSubmitCheck[] = [];
  for (const check of value.checks) {
    if (!isRecord(check) || typeof check.id !== "string" || typeof check.status !== "string")
      return null;
    checks.push({ id: check.id, status: check.status });
  }
  return {
    accepted: value.accepted,
    buildId: value.buildId,
    message: value.message,
    checks,
  };
};

export interface LifecycleCheckError {
  readonly file: string | null;
  readonly line: number | null;
  readonly message: string;
}

export interface LifecycleVerifyFacts {
  readonly success: boolean;
  readonly failedStage: string | null;
  readonly checkOk: boolean | null;
  readonly checkErrors: ReadonlyArray<LifecycleCheckError>;
  readonly hasBuild: boolean;
  readonly hasPlaytest: boolean;
}

/**
 * Reads a `game_verify` tool result strictly. A failure that still carries a
 * build or claims success is reported as-is; the caller decides what that
 * means, it never coerces it into a pass.
 */
export const parseVerifyToolOutput = (value: unknown): LifecycleVerifyFacts | null => {
  value = structuredOutput(value);
  if (!isRecord(value)) return null;
  if (typeof value.success !== "boolean") return null;
  if (value.failedStage !== undefined && typeof value.failedStage !== "string") return null;
  let checkOk: boolean | null = null;
  const checkErrors: LifecycleCheckError[] = [];
  if (value.check !== undefined) {
    if (!isRecord(value.check) || typeof value.check.ok !== "boolean") return null;
    checkOk = value.check.ok;
    if (!Array.isArray(value.check.errors ?? [])) return null;
    for (const error of (value.check.errors ?? []) as ReadonlyArray<unknown>) {
      if (!isRecord(error) || typeof error.message !== "string") return null;
      checkErrors.push({
        file: typeof error.file === "string" ? error.file : null,
        line: typeof error.line === "number" ? error.line : null,
        message: error.message,
      });
    }
  }
  return {
    success: value.success,
    failedStage: typeof value.failedStage === "string" ? value.failedStage : null,
    checkOk,
    checkErrors,
    hasBuild: value.build !== undefined && value.build !== null,
    hasPlaytest: value.playtest !== undefined && value.playtest !== null,
  };
};
