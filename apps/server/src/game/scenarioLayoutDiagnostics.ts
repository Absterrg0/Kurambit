import type { GameScenarioEvidence, GameScenarioLayoutFinding } from "@t3tools/contracts";

/**
 * Turns frozen scenario layout probes into critic hints. Pure so the
 * binding rule (same source, readable evidence, bounded output) is testable
 * without engines: stale, missing or unreadable evidence selects nothing,
 * and the formatted file always says where to look on Web frames without
 * ever claiming a Web verdict.
 */
export const NATIVE_DIAGNOSTICS_MAX_FINDINGS = 12;
export const NATIVE_DIAGNOSTICS_MAX_CHARS = 3_000;

export interface NativeLayoutHint {
  readonly scenario: string;
  readonly kind: GameScenarioLayoutFinding["kind"];
  readonly subject: string;
  readonly detail: string;
  readonly nodePath: string;
  readonly scenarioFrame: number;
  readonly step: number | null;
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface NativeLayoutSelection {
  readonly sourceId: string;
  readonly evidenceDirectory: string;
  readonly findings: readonly NativeLayoutHint[];
  /** Findings left out by the finding cap. */
  readonly omitted: number;
  /** Runtime probes the scenarios ran in total. */
  readonly probes: number;
  /** True when any scan or the cap itself stopped early. */
  readonly truncated: boolean;
}

/**
 * Binds frozen scenario layout to the selected build's exact source. Anything
 * else selects nothing: a stale, missing or unreadable state record is an
 * honest omission, never a hint, and a run with no findings needs no file.
 */
export function selectNativeLayout(input: {
  readonly stateSourceId: string | null;
  readonly stateEvidenceDirectory: string | null;
  readonly exportInputSourceId: string | null;
  readonly scenarios: readonly GameScenarioEvidence[];
}): NativeLayoutSelection | null {
  const { stateSourceId, stateEvidenceDirectory, exportInputSourceId, scenarios } = input;
  if (stateSourceId === null || stateEvidenceDirectory === "" || stateEvidenceDirectory === null)
    return null;
  if (exportInputSourceId === null || exportInputSourceId !== stateSourceId) return null;
  const findings: NativeLayoutHint[] = [];
  let total = 0;
  let probes = 0;
  let truncated = false;
  for (const scenario of scenarios) {
    const layout = scenario.layout;
    if (layout === undefined) continue;
    probes += layout.coverage.probes;
    if (layout.coverage.truncated) truncated = true;
    for (const finding of layout.findings) {
      total += 1;
      if (findings.length < NATIVE_DIAGNOSTICS_MAX_FINDINGS)
        findings.push({ scenario: scenario.id, ...finding });
    }
  }
  if (total === 0) return null;
  return {
    sourceId: stateSourceId,
    evidenceDirectory: stateEvidenceDirectory,
    findings,
    omitted: total - findings.length,
    probes,
    truncated: truncated || total !== findings.length,
  };
}

/** Bounded markdown for the critic evidence file: hints, never verdicts. */
export function formatNativeDiagnostics(selection: NativeLayoutSelection): string {
  const lines = [
    "# Native layout hints (same-source headless probes)",
    "",
    `Scenario evidence ${selection.evidenceDirectory} was recorded from these exact sources (${selection.sourceId.slice(0, 12)}).`,
    `Probed ${selection.probes} runtime samples across the recorded scenarios at their native sizes; these are native control geometry measurements, never exported Web frames.`,
    "",
  ];
  const footer = [
    "",
    `Coverage: ${selection.probes} probes; ${selection.omitted} further finding(s) omitted by the cap;${selection.truncated ? " a scan stopped early," : ""} so absence of a control here never means it was fully covered.`,
    "Treat every line as where to inspect with game_try_input on Web frames (use setupSteps to reach a later state from a fresh boot); never cite a line as proof about the shipped build.",
    "clip and viewport are definite native geometry; overlap-risk means covering geometry was measured but transparency can hide paint, so it is not proof of occlusion.",
  ];
  const reserved = footer.join("\n").length + 16;
  const budget = NATIVE_DIAGNOSTICS_MAX_CHARS - reserved - lines.join("\n").length;
  let used = 0;
  let shown = 0;
  for (const finding of selection.findings) {
    const where =
      finding.step === null
        ? `boot probe frame ${finding.scenarioFrame}`
        : `route step ${finding.step + 1} frame ${finding.scenarioFrame}`;
    const line = `- [${finding.kind}] scenario "${finding.scenario}" ${where}: ${finding.subject} — ${finding.detail} (${finding.nodePath}; native ${Math.round(finding.viewport.width)}x${Math.round(finding.viewport.height)})`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const hidden = selection.findings.length - shown + selection.omitted;
  lines.push(...footer.slice(0, 1));
  lines.push(
    hidden > 0
      ? `(${hidden} further finding(s) omitted by the critic-file cap.)`
      : "(No further findings omitted.)",
    ...footer.slice(1),
  );
  const text = `${lines.join("\n")}\n`;
  return text.length <= NATIVE_DIAGNOSTICS_MAX_CHARS
    ? text
    : `${text.slice(0, NATIVE_DIAGNOSTICS_MAX_CHARS - 15)} [truncated]\n`;
}
