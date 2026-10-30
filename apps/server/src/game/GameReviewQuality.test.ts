import { expect, it } from "vite-plus/test";
import {
  GAME_REVIEW_QUALITY_DIMENSIONS,
  gameReviewQualityCoverage,
  type GameReviewCriticAnswer,
} from "@t3tools/contracts";
import { parseCriticAnswer } from "./GameReviewSessions.ts";
import { qualityRepairDefects } from "./gameQualityEval.ts";

const frames = new Set(["f1", "f2", "f3"]);
const checks = new Set(["boot"]);
const recipeIds = new Set<string>();

const fundamentals = {
  boots: { verdict: "yes", frameIds: ["f1"], note: "boots" },
  respondsToInput: { verdict: "yes", frameIds: ["f1", "f2"], note: "responds" },
  coreActionVisible: { verdict: "yes", frameIds: ["f1", "f2"], note: "visible" },
  stateReadable: { verdict: "yes", frameIds: ["f2"], note: "readable" },
} as const;

const qualityVerdict = (verdict: "yes" | "no" | "cannot-tell", frameIds: string[] = []) => ({
  verdict,
  frameIds,
  note: `${verdict} evidence`,
});

const fullQuality = (overrides: Record<string, unknown> = {}) => ({
  artConsistency: qualityVerdict("yes", ["f1", "f2"]),
  animation: qualityVerdict("cannot-tell"),
  audio: qualityVerdict("cannot-tell"),
  readability: qualityVerdict("yes", ["f2"]),
  progression: qualityVerdict("cannot-tell"),
  agency: qualityVerdict("cannot-tell"),
  playability: qualityVerdict("yes", ["f1", "f2"]),
  ...overrides,
});

const modernKnown = {
  frameIds: frames,
  checkIds: checks,
  recipeIds,
  requireQuality: true as const,
};
const legacyKnown = { frameIds: frames, checkIds: checks, recipeIds };

const answerWith = (quality: unknown) =>
  JSON.stringify({ fundamentals, defects: [], doNotRegress: [], quality });

it("accepts modern exact-once quality coverage", () => {
  const parsed = parseCriticAnswer(answerWith(fullQuality()), modernKnown);
  expect(parsed.kind).toBe("valid");
  if (parsed.kind === "valid") {
    const coverage = gameReviewQualityCoverage(parsed.answer.quality);
    expect(coverage).toEqual({ rubricVersion: 2, assessed: 7, total: 7, unknowns: 4 });
  }
});

it("reads legacy answers without quality as unknown, never met", () => {
  const parsed = parseCriticAnswer(
    JSON.stringify({ fundamentals, defects: [], doNotRegress: [] }),
    legacyKnown,
  );
  expect(parsed.kind).toBe("valid");
  if (parsed.kind === "valid") {
    expect(parsed.answer.quality).toBeUndefined();
    expect(gameReviewQualityCoverage(parsed.answer.quality)).toEqual({
      rubricVersion: 2,
      assessed: 0,
      total: 7,
      unknowns: 7,
    });
  }
});

it("rejects missing quality on new sessions and quality on frozen legacy evidence", () => {
  const missing = parseCriticAnswer(
    JSON.stringify({ fundamentals, defects: [], doNotRegress: [] }),
    modernKnown,
  );
  expect(missing.kind).toBe("invalid");
  if (missing.kind === "invalid") expect(missing.reason).toContain("did not assess quality");
  const frozen = parseCriticAnswer(answerWith(fullQuality()), legacyKnown);
  expect(frozen.kind).toBe("invalid");
  if (frozen.kind === "invalid") expect(frozen.reason).toContain("before the rubric");
});

it("unknown stays neutral: cannot-tell needs no frames and never fails", () => {
  const parsed = parseCriticAnswer(answerWith(fullQuality()), modernKnown);
  expect(parsed.kind).toBe("valid");
});

it("rejects a duplicated or unknown quality frame", () => {
  const unknown = parseCriticAnswer(
    answerWith(fullQuality({ readability: qualityVerdict("no", ["f9"]) })),
    modernKnown,
  );
  expect(unknown.kind).toBe("invalid");
  if (unknown.kind === "invalid") expect(unknown.reason).toContain("not in its manifest");
});

it("rejects audio judged from screenshots without attached evidence", () => {
  const heard = parseCriticAnswer(
    answerWith(fullQuality({ audio: qualityVerdict("yes", ["f1"]) })),
    modernKnown,
  );
  expect(heard.kind).toBe("invalid");
  if (heard.kind === "invalid") expect(heard.reason).toContain("without attached audio evidence");
  const missingEvidence = parseCriticAnswer(
    answerWith(
      fullQuality({ audio: { verdict: "cannot-tell", frameIds: [], note: "no audio attached" } }),
    ),
    modernKnown,
  );
  expect(missingEvidence.kind).toBe("valid");
  const bound = parseCriticAnswer(
    answerWith(fullQuality({ audio: qualityVerdict("yes", ["f1"]) })),
    { ...modernKnown, hasAudioEvidence: true as const },
  );
  expect(bound.kind).toBe("valid");
  const unbound = parseCriticAnswer(answerWith(fullQuality({ audio: qualityVerdict("yes", []) })), {
    ...modernKnown,
    hasAudioEvidence: true as const,
  });
  expect(unbound.kind).toBe("invalid");
});

it("rejects animation yes from one pose and agency yes from menu labels alone", () => {
  const pose = parseCriticAnswer(
    answerWith(fullQuality({ animation: qualityVerdict("yes", ["f2"]) })),
    modernKnown,
  );
  expect(pose.kind).toBe("invalid");
  if (pose.kind === "invalid") expect(pose.reason).toContain("one pose");
  const pair = parseCriticAnswer(
    answerWith(fullQuality({ animation: qualityVerdict("yes", ["f1", "f2"]) })),
    modernKnown,
  );
  expect(pair.kind).toBe("valid");
  const labels = parseCriticAnswer(
    answerWith(fullQuality({ agency: qualityVerdict("yes", ["f2"]) })),
    modernKnown,
  );
  expect(labels.kind).toBe("invalid");
  if (labels.kind === "invalid") expect(labels.reason).toContain("menu labels");
});

it("rejects a yes/no without frames on visual dimensions", () => {
  const bare = parseCriticAnswer(
    answerWith(fullQuality({ readability: qualityVerdict("no", []) })),
    modernKnown,
  );
  expect(bare.kind).toBe("invalid");
  if (bare.kind === "invalid") expect(bare.reason).toContain("needs a frame citation");
});

it("maps only frame-backed visual failures to repair, within the shared cap", () => {
  const answer = {
    quality: fullQuality({
      readability: { verdict: "no", frameIds: ["f2"], note: "HUD clipped" },
      animation: { verdict: "no", frameIds: ["f1", "f2"], note: "no burst" },
      audio: { verdict: "no", frameIds: ["f1"], note: "unsupported claim" },
      agency: { verdict: "no", frameIds: [], note: "hidden behavior" },
      progression: { verdict: "cannot-tell", frameIds: [], note: "short" },
    }),
  } as unknown as GameReviewCriticAnswer;
  const defects = qualityRepairDefects(answer.quality);
  // Audio never maps from screenshots; hidden behavior without frames is not
  // invented; cannot-tell stays neutral.
  expect(defects.map((defect) => defect.frameId).sort()).toEqual(["f1", "f2"]);
  expect(defects.every((defect) => defect.severity === "visible")).toBe(true);
  expect(defects.every((defect) => defect.fix.includes("yes/no"))).toBe(true);
  expect(qualityRepairDefects(undefined)).toEqual([]);
  expect(GAME_REVIEW_QUALITY_DIMENSIONS).toHaveLength(7);
});

it("does not count a duplicate citation as two temporal witnesses", () => {
  for (const dimension of ["animation", "agency"]) {
    const result = parseCriticAnswer(
      answerWith(fullQuality({ [dimension]: qualityVerdict("yes", ["f1", "f1"]) })),
      modernKnown,
    );
    expect(result.kind).toBe("invalid");
  }
});
