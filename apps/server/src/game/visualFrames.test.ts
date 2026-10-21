import { describe, expect, it } from "vite-plus/test";
import type {
  GameAcceptanceCriterion,
  GamePlaytestProbe,
  GamePlaytestState,
} from "@t3tools/contracts";
import { selectVisualFrames, type VisualEvidenceFrame } from "./visualFrames.ts";

const player = (x: number): GamePlaytestProbe["player"] => ({ x, y: 0, z: 0 });

const probe = (input: {
  readonly x: number;
  readonly collected?: number;
  readonly health?: number;
  readonly won?: boolean;
}): GamePlaytestProbe => ({
  player: player(input.x),
  gameState: {
    collected: input.collected ?? 0,
    health: input.health ?? 100,
    won: input.won ?? false,
  },
});

const state = (before: GamePlaytestProbe, after: GamePlaytestProbe): GamePlaytestState => ({
  before,
  after,
  playerMoved: 0,
  changes: [],
});

const acceptance: readonly GameAcceptanceCriterion[] = [
  {
    id: "collect",
    kind: "mechanic",
    text: "Collect a pearl",
    observe: { key: "collected", expect: ">=1" },
  },
  { id: "hurt", kind: "lose", text: "The tide hurts", observe: { key: "health", expect: "<=95" } },
  { id: "win", kind: "win", text: "Reach the gate", observe: { key: "won", expect: "==1" } },
  { id: "glow", kind: "presentation", text: "The gate glows" },
];

const frames: readonly VisualEvidenceFrame[] = [
  { label: "booted", file: "01-booted.png" },
  { label: "level-start", file: "02-level-start.png", probe: probe({ x: 0 }) },
  { label: "moon-pearl", file: "03-pearl.png", probe: probe({ x: 10, collected: 1 }) },
  { label: "water", file: "04-water.png", probe: probe({ x: 20, collected: 1, health: 90 }) },
  { label: "final", file: "05-final.png", probe: probe({ x: 30, collected: 1, health: 90 }) },
  {
    label: "after-steps",
    file: "06-after-steps.png",
    probe: probe({ x: 30, collected: 1, health: 90 }),
  },
];

const select = (input: {
  readonly evidence?: readonly VisualEvidenceFrame[];
  readonly runState?: GamePlaytestState | null;
  readonly criteria?: readonly GameAcceptanceCriterion[];
}) =>
  selectVisualFrames({
    frames: input.evidence ?? frames,
    state: input.runState ?? state(probe({ x: 0 }), probe({ x: 30 })),
    acceptance: input.criteria ?? acceptance,
    evidenceDirectory: "builds/playtests/run",
  });

describe("visual frame selection", () => {
  it("picks frames from persisted probe state, in the states a review needs", () => {
    const selected = select({});
    expect(selected.map((frame) => [frame.role, frame.path])).toEqual([
      ["early", "builds/playtests/run/02-level-start.png"],
      ["interaction", "builds/playtests/run/03-pearl.png"],
      ["hazard", "builds/playtests/run/04-water.png"],
      ["later", "builds/playtests/run/05-final.png"],
      ["finish", "builds/playtests/run/06-after-steps.png"],
    ]);
    // The probe evidence travels with the frame instead of a caption claim.
    expect(selected[1]?.evidence).toContain("collected 0→1");
  });

  it("ignores captions: renaming every label selects the same files", () => {
    const renamed = frames.map((frame, index) => ({
      ...frame,
      label: `definitely-not-a-caption-${index}`,
    }));
    expect(select({ evidence: renamed }).map((frame) => frame.path)).toEqual(
      select({}).map((frame) => frame.path),
    );
  });

  it("does not invent an interaction or hazard from a caption", () => {
    const flat = frames.map((frame) => ({
      label: frame.label,
      file: frame.file,
      ...(frame.probe === undefined ? {} : { probe: probe({ x: frame.probe.player?.x ?? 0 }) }),
    }));
    const selected = select({ evidence: flat });
    expect(selected.map((frame) => frame.role)).not.toContain("interaction");
    expect(selected.map((frame) => frame.role)).not.toContain("hazard");
  });

  it("falls back to run order when the evidence has no probe state", () => {
    const selected = select({
      evidence: frames.map(({ label, file }) => ({ label, file })),
      runState: null,
    });
    expect(selected.map((frame) => [frame.role, frame.path])).toEqual([
      ["early", "builds/playtests/run/02-level-start.png"],
      ["later", "builds/playtests/run/05-final.png"],
      ["finish", "builds/playtests/run/06-after-steps.png"],
    ]);
  });

  it("caps the review at six frames", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      label: `frame-${index}`,
      file: `${String(index).padStart(2, "0")}.png`,
      probe: probe({ x: index * 10, collected: index === 1 ? 1 : 0 }),
    }));
    expect(select({ evidence: many }).length).toBeLessThanOrEqual(6);
  });
});
