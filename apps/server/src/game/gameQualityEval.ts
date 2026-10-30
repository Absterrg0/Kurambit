// @effect-diagnostics nodeBuiltinImport:off -- Fixture overlays are text edits on game files outside the server.
// @effect-diagnostics nodeBuiltinImport:off -- Fixture spinners and WAV bytes live on the native filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { approvalRecordFile, designIntentFile } from "./GameDesignApproval.ts";
import {
  GAME_REVIEW_QUALITY_DIMENSIONS,
  type GameReviewDefect,
  type GameReviewQuality,
  type GameReviewQualityDimension,
} from "@t3tools/contracts";

/** Frame-backed absolute-quality failures that may join the bounded repair defects. */

/**
 * Seeded quality-evaluation cases. Each fault case is one exact text overlay
 * on a template game with a known expected behavior; each clean case is the
 * same game without the overlay. Overlays are applied to disposable copies,
 * never to the templates, and groundtruth below is never shown to a critic:
 * the critic sees only frozen frames, the brief and checks.
 *
 * Styles cover 2D platformer (template 2d-platformer), fixed-screen
 * choice/management (template 2d-screen) and 3D exploration (template
 * 3d-explorer). Audio tone/silence/clipping baselines ride on
 * game_audio_inspect fixtures (see scripts/game-quality-eval.ts
 * `audio-fixtures`), not on these overlays: judging a heard effect from
 * frames is unsupported, so every case below expects audio=cannot-tell
 * unless frozen audio evidence is attached.
 */
export type QualityEvalStyle = "2d-platformer" | "2d-screen" | "3d-explorer";

export const copyQualityDesignRecords = async (input: {
  sourceStateDir: string;
  targetStateDir: string;
  sourceRoot: string;
  targetRoot: string;
}): Promise<void> => {
  const source = await NodeFSP.realpath(input.sourceRoot);
  const target = await NodeFSP.realpath(input.targetRoot);
  for (const recordFile of [designIntentFile, approvalRecordFile]) {
    const from = recordFile(input.sourceStateDir, source);
    const text = await NodeFSP.readFile(from, "utf8").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" && recordFile === approvalRecordFile) return null;
      throw cause;
    });
    if (text === null) continue;
    const record = JSON.parse(text) as Record<string, unknown>;
    record.game = target;
    delete record.buildDispatch;
    const to = recordFile(input.targetStateDir, target);
    await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
    await NodeFSP.writeFile(to, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  }
};

export interface QualityEvalOverlay {
  /** Game-relative file the overlay edits, e.g. godot/scripts/game_screen.gd. */
  readonly file: string;
  /** Exact text that must occur exactly once; tabs and newlines matter. */
  readonly find: string;
  /** Replacement text. Must keep the file syntactically valid. */
  readonly replace: string;
}

export type QualityVerdict = "yes" | "no" | "cannot-tell";

export interface QualityEvalCase {
  readonly id: string;
  readonly style: QualityEvalStyle;
  readonly template: QualityEvalStyle;
  readonly kind: "fault" | "clean";
  /** Seeded fault family, or "none" for clean controls. */
  readonly fault: "clipped-hud" | "meaningless-consequence" | "missing-feedback" | "none";
  readonly overlay: QualityEvalOverlay | null;
  /**
   * Groundtruth for the key dimensions only: the verdicts a real review of
   * the seeded game must reach on honest evidence. Every other dimension
   * only owes coverage, never a particular verdict. Kept out of critic input.
   */
  readonly expected: Partial<Record<GameReviewQualityDimension, QualityVerdict>>;
  /** What the route must show for the verdict to be reachable. */
  readonly routeNote: string;
}

const CLIPPED_HUD_FIND = `[node name="Coins" type="PanelContainer" parent="."]
offset_left = 8.0`;
// Move the child panel: a root Control under CanvasLayer can have its layout
// reset by the viewport, leaving root-only offsets invisible in actual play.
const CLIPPED_HUD_REPLACE = `[node name="Coins" type="PanelContainer" parent="."]
offset_left = -40.0`;

export const QUALITY_EVAL_CASES: readonly QualityEvalCase[] = [
  {
    id: "platformer-clipped-hud",
    style: "2d-platformer",
    template: "2d-platformer",
    kind: "fault",
    fault: "clipped-hud",
    overlay: {
      file: "godot/scenes/ui/hud.tscn",
      find: CLIPPED_HUD_FIND,
      replace: CLIPPED_HUD_REPLACE,
    },
    expected: { readability: "no" },
    routeNote:
      "Boot into gameplay so the HUD is up, then play: the coin/heart panel begins 40 logical pixels off-screen, clipping its contents. Confirm the visible clip on actual frames.",
  },
  {
    id: "platformer-clean",
    style: "2d-platformer",
    template: "2d-platformer",
    kind: "clean",
    fault: "none",
    overlay: null,
    expected: { readability: "yes" },
    routeNote:
      "Same route as the fault case on the unmodified game: the whole HUD stays on-screen.",
  },
  {
    id: "screen-meaningless-consequence",
    style: "2d-screen",
    template: "2d-screen",
    kind: "fault",
    fault: "meaningless-consequence",
    overlay: {
      file: "godot/scripts/game_screen.gd",
      // The state update stays: GameState.answer must keep moving trust so the
      // canonical suite still passes and the builder has no gate failure to
      // repair before the critic sees the game. Only the advertised feedback
      // lies, so the critic can observe a real consequence the screen hides.
      find: [
        "\tif cold_delta > 0:",
        '\t\teffect_label.text = "Cold reply · trust %d" % trust_delta',
        '\t\teffect_label.add_theme_color_override("font_color", Color(0.88, 0.48, 0.42))',
        "\telif trust_delta > 0:",
        '\t\teffect_label.text = "Warm reply · trust +%d" % trust_delta',
        '\t\teffect_label.add_theme_color_override("font_color", Color(0.44, 0.83, 0.78))',
        "\telse:",
        '\t\teffect_label.text = "Steady reply · trust unchanged"',
        '\t\teffect_label.add_theme_color_override("font_color", Color(0.95, 0.71, 0.36))',
      ].join("\n"),
      replace: [
        "\t# SEEDED FAULT: the effect label never reports the actual consequence.",
        '\teffect_label.text = "Steady reply · trust unchanged"',
        '\teffect_label.add_theme_color_override("font_color", Color(0.95, 0.71, 0.36))',
      ].join("\n"),
    },
    expected: { readability: "no" },
    routeNote:
      "Answer one call with a warm (+1) reply: the reply frame still reads Steady/unchanged while the probe's trust moves 2 to 3 across the before/after frames. The consequence is real but never visible, so the choice has no readable consequence.",
  },
  {
    id: "screen-clean",
    style: "2d-screen",
    template: "2d-screen",
    kind: "clean",
    fault: "none",
    overlay: null,
    expected: { readability: "yes" },
    routeNote:
      "Same route on the unmodified game: the advertised trust change is visible in the probe across before/after frames.",
  },
  {
    id: "explorer-missing-feedback",
    style: "3d-explorer",
    template: "3d-explorer",
    kind: "fault",
    fault: "missing-feedback",
    overlay: {
      file: "godot/scripts/ui/hud.gd",
      // The pickup mechanics stay: GameState.collect still counts, the relic
      // still vanishes and the burst still fires, so the canonical suite keeps
      // passing and the builder has nothing to repair. Only the HUD counter
      // stops refreshing, so run state the probe reports never reaches the
      // screen. A missing burst alone could not fail the global animation
      // dimension while idle motion continues, so the honest target is the
      // unreadable counter, not the motion.
      find: [
        "func _on_collected(collected: int, total: int, _score: int) -> void:",
        '\trelic_value.text = "%d / %d" % [collected, total]',
      ].join("\n"),
      replace: [
        "func _on_collected(_collected: int, _total: int, _score: int) -> void:",
        "\tpass  # SEEDED FAULT: relic counter never refreshes",
      ].join("\n"),
    },
    // The counter freeze is the fault: readability=no is reachable from
    // before/after frames alone (relic gone, counter still 0 / 5). Audio stays
    // cannot-tell without attached audio evidence; that target is a policy
    // check, never fault detection.
    expected: { readability: "no", audio: "cannot-tell" },
    routeNote:
      "Touch a relic: it vanishes while the HUD counter still reads 0 / 5 across the before/after frames, even as the probe's collected count moves. Judge the frames, not the GameState counter.",
  },
  {
    id: "explorer-clean",
    style: "3d-explorer",
    template: "3d-explorer",
    kind: "clean",
    fault: "none",
    overlay: null,
    expected: { readability: "yes", audio: "cannot-tell" },
    routeNote:
      "Same route on the unmodified game: the pickup burst is visible and the counter moves across frames. Audio stays cannot-tell without attached audio evidence.",
  },
];

/** Applies a case overlay to a disposable game copy. Clean cases change nothing. */
export const applyQualityOverlay = async (
  gameRoot: string,
  overlay: QualityEvalOverlay | null,
): Promise<{ readonly applied: boolean; readonly file: string | null }> => {
  if (overlay === null) return { applied: false, file: null };
  const absolute = NodePath.join(gameRoot, overlay.file);
  const text = await NodeFSP.readFile(absolute, "utf8");
  const occurrences = text.split(overlay.find).length - 1;
  if (occurrences !== 1)
    throw new Error(
      `Overlay target must occur exactly once in ${overlay.file}; found ${occurrences}.`,
    );
  await NodeFSP.writeFile(absolute, text.replace(overlay.find, overlay.replace));
  return { applied: true, file: overlay.file };
};

export type QualityCaseOutcome = "hit" | "miss" | "unknown" | "invalid" | "error";

export interface QualityCaseResult {
  readonly caseId: string;
  readonly kind: "fault" | "clean";
  /** Per key dimension: hit (expected verdict reached), miss (opposite), unknown (cannot-tell). */
  readonly dimensions: ReadonlyArray<{
    readonly dimension: GameReviewQualityDimension;
    readonly expected: QualityVerdict;
    readonly actual: QualityVerdict | null;
    readonly outcome: QualityCaseOutcome;
  }>;
  /** Dimensions assessed out of the frozen rubric, when an answer was read. */
  readonly coverage: {
    readonly assessed: number;
    readonly total: number;
    readonly unknowns: number;
  } | null;
  readonly invalidReason: string | null;
  readonly error: string | null;
}

export const firstQualityRound = <
  T extends {
    readonly startedAt: string;
    readonly quality?: unknown;
    readonly qualityCoverage?: unknown;
  },
>(
  rounds: readonly T[],
): T | undefined =>
  rounds
    .filter((round) => round.quality !== undefined || round.qualityCoverage !== undefined)
    .toSorted((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))[0];

/**
 * Scores one case against groundtruth. Unknown (cannot-tell) is never a hit
 * and never a miss: it is honestly reported as unknown. An expected
 * cannot-tell target is a policy check, not fault detection: an abstention
 * passes it (unknown) and a yes/no overclaim fails it (miss), but neither
 * ever counts as a detection hit. An unreadable answer is invalid, a failed
 * run is an error; neither counts as a verdict.
 */
export const evaluateQualityCase = (input: {
  readonly case: QualityEvalCase;
  readonly actual: Partial<Record<GameReviewQualityDimension, QualityVerdict>> | null;
  readonly coverage: QualityCaseResult["coverage"];
  readonly invalidReason?: string | undefined;
  readonly error?: string | undefined;
}): QualityCaseResult => {
  const dimensions = (
    Object.entries(input.case.expected) as ReadonlyArray<
      [GameReviewQualityDimension, QualityVerdict]
    >
  ).map(([dimension, expected]) => {
    const actual = input.actual?.[dimension] ?? null;
    let outcome: QualityCaseOutcome;
    if (input.error !== undefined) outcome = "error";
    else if (input.invalidReason !== undefined) outcome = "invalid";
    else if (expected === "cannot-tell")
      outcome = actual === null || actual === "cannot-tell" ? "unknown" : "miss";
    else if (actual === null || actual === "cannot-tell") outcome = "unknown";
    else outcome = actual === expected ? "hit" : "miss";
    return { dimension, expected, actual, outcome };
  });
  return {
    caseId: input.case.id,
    kind: input.case.kind,
    dimensions,
    coverage: input.coverage,
    invalidReason: input.invalidReason ?? null,
    error: input.error ?? null,
  };
};

export interface QualityEvalAggregate {
  readonly cases: number;
  /** Every expected target across all cases, including error/invalid runs: the truthful denominator. */
  readonly keyDimensions: number;
  /** Detection hits: seeded faults found plus clean controls held. Policy passes never count here. */
  readonly hits: number;
  /** Detection misses: seeded faults missed (false negatives) plus clean controls falsely flagged. */
  readonly misses: number;
  /** Abstentions on yes/no detection targets: honestly unknown, never a pass or fail. */
  readonly unknowns: number;
  readonly invalid: number;
  readonly errors: number;
  /** Seeded fault found where seeded: detection hits on fault cases. */
  readonly truePositives: number;
  /** Seeded fault missed or called clean: detection misses on fault cases. */
  readonly falseNegatives: number;
  /** Clean control held: detection hits on clean cases. */
  readonly trueNegatives: number;
  /** Clean control falsely flagged: detection misses on clean cases. */
  readonly falsePositives: number;
  /** Targets whose groundtruth is cannot-tell: critic abstention is the pass. */
  readonly policyTargets: number;
  /** Policy targets answered cannot-tell (or unread): the honest pass. */
  readonly policyPass: number;
  /** Policy targets answered yes/no: an overclaim against missing evidence. */
  readonly policyFail: number;
  readonly assessedTotal: number;
  readonly coverageUnknowns: number;
  readonly results: ReadonlyArray<QualityCaseResult>;
}

/**
 * Aggregates case results with honest denominators. Every expected target
 * counts in keyDimensions even when its run errored or its answer was
 * unreadable; those runs surface as errors/invalid instead of verdicts.
 * Detection (yes/no targets) and policy (cannot-tell targets) stay in
 * separate buckets, and hits never mix clean controls with found faults:
 * see truePositives/trueNegatives. Unknown never passes or fails a target.
 */
export const aggregateQualityEval = (
  results: ReadonlyArray<QualityCaseResult>,
): QualityEvalAggregate => {
  let keyDimensions = 0;
  let hits = 0;
  let misses = 0;
  let unknowns = 0;
  let invalid = 0;
  let errors = 0;
  let truePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  let falsePositives = 0;
  let policyTargets = 0;
  let policyPass = 0;
  let policyFail = 0;
  let assessedTotal = 0;
  let coverageUnknowns = 0;
  for (const result of results) {
    if (result.error !== null) {
      errors += 1;
      keyDimensions += result.dimensions.length;
      continue;
    }
    if (result.invalidReason !== null) {
      invalid += 1;
      keyDimensions += result.dimensions.length;
      continue;
    }
    for (const dimension of result.dimensions) {
      keyDimensions += 1;
      if (dimension.expected === "cannot-tell") {
        policyTargets += 1;
        if (dimension.outcome === "unknown") policyPass += 1;
        else if (dimension.outcome === "miss") policyFail += 1;
        continue;
      }
      if (dimension.outcome === "hit") {
        hits += 1;
        if (result.kind === "fault") truePositives += 1;
        else trueNegatives += 1;
      } else if (dimension.outcome === "miss") {
        misses += 1;
        if (result.kind === "fault") falseNegatives += 1;
        else falsePositives += 1;
      } else {
        unknowns += 1;
      }
    }
    if (result.coverage !== null) {
      assessedTotal += result.coverage.assessed;
      coverageUnknowns += result.coverage.unknowns;
    }
  }
  return {
    cases: results.length,
    keyDimensions,
    hits,
    misses,
    unknowns,
    invalid,
    errors,
    truePositives,
    falseNegatives,
    trueNegatives,
    falsePositives,
    policyTargets,
    policyPass,
    policyFail,
    assessedTotal,
    coverageUnknowns,
    results,
  };
};

/**
 * True when a critic-input packet carries no groundtruth labels: no expected
 * verdicts, no case ids, no dimension verdict keys, and no seeded-fault
 * marker from the overlay comments (the critic reads frames, never sources).
 */
export const assertNoGroundtruthLeak = (
  packet: unknown,
  cases: readonly QualityEvalCase[] = QUALITY_EVAL_CASES,
): boolean => {
  const text = JSON.stringify(packet ?? {});
  return (
    !text.includes('"expected"') &&
    !text.includes("SEEDED FAULT") &&
    !cases.some((entry) => text.includes(entry.id)) &&
    GAME_REVIEW_QUALITY_DIMENSIONS.every((dimension) => !text.includes(`quality:${dimension}`))
  );
};

/** True when the groundtruth file lives outside the game copy it describes. */
export const groundtruthOutsideCopy = (copy: string, groundtruthFile: string): boolean => {
  const resolvedCopy = NodePath.resolve(copy);
  const resolvedTruth = NodePath.resolve(groundtruthFile);
  return (
    resolvedTruth !== resolvedCopy && !resolvedTruth.startsWith(`${resolvedCopy}${NodePath.sep}`)
  );
};

/**
 * True when a prepared game copy carries no groundtruth sidecars: no
 * groundtruth directory or file, and no JSON document naming an expected
 * verdict. The seeded overlay comments stay (the critic never reads sources);
 * only reviewer-facing labels are refused. Bounded to *.json contents so
 * design prose can use ordinary words.
 */
export const assertNoGroundtruthInCopy = async (
  copy: string,
  cases: readonly QualityEvalCase[] = QUALITY_EVAL_CASES,
): Promise<boolean> => {
  const ids = new Set(cases.map((entry) => entry.id));
  const walk = async (directory: string): Promise<boolean> => {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = NodePath.join(directory, entry.name);
      if (entry.name === "groundtruth" || entry.name.endsWith(".groundtruth.json")) return false;
      if (
        ids.has(entry.name) ||
        ids.has(NodePath.basename(entry.name, NodePath.extname(entry.name)))
      )
        return false;
      if (entry.isDirectory()) {
        if (!(await walk(absolute))) return false;
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        const text = await NodeFSP.readFile(absolute, "utf8").catch(() => "");
        if (text.includes('"expected"')) return false;
      }
    }
    return true;
  };
  return walk(NodePath.resolve(copy));
};

/**
 * Maps visual quality no-verdicts to bounded repair defects. Audio never
 * maps: judging a heard effect from screenshots is unsupported, and hidden
 * behavior without frames is not invented. Cannot-tell stays neutral.
 */
export const qualityRepairDefects = (
  quality: GameReviewQuality | undefined,
): GameReviewDefect[] => {
  if (quality === undefined) return [];
  return (
    GAME_REVIEW_QUALITY_DIMENSIONS.filter(
      (dimension) => dimension !== "audio",
    ) as GameReviewQualityDimension[]
  )
    .filter(
      (dimension) => quality[dimension].verdict === "no" && quality[dimension].frameIds.length > 0,
    )
    .map((dimension) => ({
      severity: "visible" as const,
      what: `Quality ${dimension} fails: ${quality[dimension].note}`.slice(0, 400),
      frameId: quality[dimension].frameIds[0]!,
      fix: `Make ${dimension} hold in play and verify the actual effect with before/after frames or game_try_input; yes/no: ${quality[dimension].note}`.slice(
        0,
        400,
      ),
    }));
};
