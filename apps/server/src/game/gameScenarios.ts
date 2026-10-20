// @effect-diagnostics nodeBuiltinImport:off -- Scenario files and runner results live on the native filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  GAME_SCENARIO_LIMITS,
  GameScenarioEvidence,
  parseGameScenario,
  type GameAcceptanceCriterion,
  type GameScenario,
} from "@t3tools/contracts";
import { LEGACY_PLAYING_MATCH_ID } from "./scenarioEvaluation.ts";

const decodeEvidence = Schema.decodeUnknownSync(Schema.fromJsonString(GameScenarioEvidence));

export interface ScenarioFile {
  readonly scenario: GameScenario;
  /** Absolute path, passed to the runner so it never resolves game paths itself. */
  readonly path: string;
}

export interface ScenarioFilesRead {
  readonly scenarios: readonly ScenarioFile[];
  readonly errors: readonly string[];
}

/** Input actions Godot always defines; the runner still checks the live InputMap. */
const isBuiltinAction = (action: string) => action.startsWith("ui_");

/**
 * Reads `godot/tests/scenarios/*.json`. Every file is independently validated, so
 * one bad route names itself instead of hiding the working ones. The cap applies
 * to files, not only valid routes, or a folder could hold a thousand entries.
 */
export async function readScenarioFiles(godotProject: string): Promise<ScenarioFilesRead> {
  const directory = NodePath.join(godotProject, "tests/scenarios");
  let names: string[];
  try {
    names = await NodeFSP.readdir(directory);
  } catch {
    return {
      scenarios: [],
      errors: [
        "No scenarios found. Add godot/tests/scenarios/<id>.json with press, hold and wait steps.",
      ],
    };
  }
  const files = names.filter((name) => name.endsWith(".json")).sort();
  const errors: string[] = [];
  if (files.length > GAME_SCENARIO_LIMITS.maxScenarios)
    errors.push(
      `Found ${files.length} scenarios; only ${GAME_SCENARIO_LIMITS.maxScenarios} may run. The extra files were ignored.`,
    );
  const scenarios: ScenarioFile[] = [];
  const ids = new Set<string>();
  for (const name of files.slice(0, GAME_SCENARIO_LIMITS.maxScenarios)) {
    const path = NodePath.join(directory, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    } catch (cause) {
      errors.push(
        `${name} is not readable JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      continue;
    }
    const result = parseGameScenario(parsed);
    if (!result.ok) {
      errors.push(`${name}: ${result.issues.join(" ")}`);
      continue;
    }
    if (ids.has(result.scenario.id)) {
      errors.push(`${name}: the id "${result.scenario.id}" is used by more than one scenario.`);
      continue;
    }
    ids.add(result.scenario.id);
    scenarios.push({ scenario: result.scenario, path });
  }
  return { scenarios, errors };
}

/** The action names project.godot declares under `[input]`. */
export function parseProjectInputActions(project: string): ReadonlySet<string> {
  const actions = new Set<string>();
  let inInput = false;
  for (const raw of project.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inInput = line === "[input]";
      continue;
    }
    if (!inInput || line === "" || line.startsWith(";")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match !== null) actions.add(match[1]!);
  }
  return actions;
}

/**
 * Actions a scenario may press. Godot's built-ins are not written in
 * project.godot, so they are allowed by their documented `ui_` namespace; the
 * runner checks the live InputMap again and rejects anything it does not know.
 */
export function scenarioActionIssues(
  scenario: GameScenario,
  projectActions: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const step of scenario.steps) {
    const actions = "press" in step ? [step.press] : "hold" in step ? step.hold : [];
    for (const action of actions) {
      if (seen.has(action)) continue;
      seen.add(action);
      if (!projectActions.has(action) && !isBuiltinAction(action))
        issues.push(`"${action}" is not an input action in project.godot's InputMap.`);
    }
  }
  return issues;
}

/** Reads each approved observation plus the legacy playing-state proof. */
export function scenarioObservations(
  mode: "criteria" | "legacy" | "none",
  criteria: readonly GameAcceptanceCriterion[],
): { readonly id: string; readonly key: string; readonly expect: string }[] {
  const observations =
    mode === "criteria"
      ? criteria
          .filter(
            (
              criterion,
            ): criterion is GameAcceptanceCriterion & {
              observe: { key: string; expect: string };
            } => criterion.observe !== undefined,
          )
          .map((criterion) => ({
            id: criterion.id,
            key: criterion.observe.key,
            expect: criterion.observe.expect,
          }))
      : [];
  // Always sample `state`; a legacy game proves the menu really started a run
  // with it, and an approved design may also observe it directly.
  observations.push({ id: LEGACY_PLAYING_MATCH_ID, key: "state", expect: "==1" });
  return observations;
}

export function decodeScenarioEvidence(text: string): typeof GameScenarioEvidence.Type | null {
  try {
    return decodeEvidence(text);
  } catch {
    return null;
  }
}
