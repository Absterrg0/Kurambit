import { describe, expect, it } from "vite-plus/test";
import type {
  GameAcceptanceCriterion,
  GamePlaytestProbe,
  GamePlaytestState,
} from "@t3tools/contracts";
import {
  missingVisualEvidence,
  selectVisualFrames,
  type VisualEvidenceFrame,
} from "./visualFrames.ts";

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
  { id: "hurt", kind: "lose", text: "The tide hurts", observe: { key: "health", expect: "<=0" } },
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
      ["hazard", "builds/playtests/run/04-water.png"],
      ["interaction", "builds/playtests/run/03-pearl.png"],
      ["later", "builds/playtests/run/05-final.png"],
      ["finish", "builds/playtests/run/06-after-steps.png"],
    ]);
    // The probe evidence travels with the frame instead of a caption claim.
    expect(selected[2]?.evidence).toContain("collected 0→1");
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

  it("picks a frame where a lose key took damage, not only where the run was lost", () => {
    const health = (value: number, x: number): GamePlaytestProbe => ({
      player: player(x),
      gameState: { health: value },
    });
    const damageFrames: readonly VisualEvidenceFrame[] = [
      { label: "start", file: "01.png", probe: health(100, 0) },
      { label: "hit", file: "02.png", probe: health(80, 10) },
      { label: "win", file: "03.png", probe: health(80, 20) },
    ];
    const selected = select({
      evidence: damageFrames,
      runState: state(health(100, 0), health(80, 20)),
      criteria: [
        {
          id: "hurt",
          kind: "lose",
          text: "Running out of health loses",
          observe: { key: "health", expect: "<=0" },
        },
      ],
    });
    // The losing condition is never reached, so the hit is the hazard evidence.
    expect(selected.find((frame) => frame.role === "hazard")?.path).toBe(
      "builds/playtests/run/02.png",
    );
  });

  it("keeps the damage frame for the hazard role when a lives mechanic also progresses there", () => {
    const run = (x: number, lives: number, collected: number): GamePlaytestProbe => ({
      player: player(x),
      gameState: { lives, collected },
    });
    const selected = select({
      evidence: [
        { label: "start", file: "01.png", probe: run(0, 3, 0) },
        { label: "spikes", file: "02.png", probe: run(10, 2, 0) },
        { label: "pearl", file: "03.png", probe: run(20, 2, 1) },
        { label: "gate", file: "04.png", probe: run(30, 2, 1) },
      ],
      runState: state(run(0, 3, 0), run(30, 2, 1)),
      criteria: [
        {
          id: "spikes-hurt",
          kind: "mechanic",
          text: "Touching spikes costs a life",
          observe: { key: "lives", expect: "<=2" },
        },
        {
          id: "collect",
          kind: "mechanic",
          text: "Collect a pearl",
          observe: { key: "collected", expect: ">=1" },
        },
        {
          id: "out-of-lives",
          kind: "lose",
          text: "Losing all three lives ends the run",
          observe: { key: "lives", expect: "<=0" },
        },
      ],
    });
    expect(selected.map((frame) => [frame.role, frame.path])).toEqual([
      ["early", "builds/playtests/run/01.png"],
      ["hazard", "builds/playtests/run/02.png"],
      ["interaction", "builds/playtests/run/03.png"],
      ["finish", "builds/playtests/run/04.png"],
    ]);
  });

  it("treats a met lose claim as the run's end, not as a hazard", () => {
    const run = (x: number, lives: number, collected: number): GamePlaytestProbe => ({
      player: player(x),
      gameState: { lives, collected },
    });
    const loseFrames: readonly VisualEvidenceFrame[] = [
      { label: "start", file: "01.png", probe: run(0, 3, 0) },
      { label: "pearl", file: "02.png", probe: run(10, 3, 1) },
      { label: "dead", file: "03.png", probe: run(20, 0, 1) },
      { label: "panel", file: "04.png", probe: run(20, 0, 1) },
      { label: "retry", file: "05.png", probe: run(0, 3, 0) },
    ];
    const selected = select({
      evidence: loseFrames,
      runState: state(run(0, 3, 0), run(0, 3, 0)),
      criteria: [
        {
          id: "collect",
          kind: "mechanic",
          text: "Collect a pearl",
          observe: { key: "collected", expect: ">=1" },
        },
        {
          id: "lose",
          kind: "lose",
          text: "Losing every life ends the run",
          observe: { key: "lives", expect: "==0" },
        },
      ],
    });
    expect(selected.map((frame) => [frame.role, frame.path])).toEqual([
      ["early", "builds/playtests/run/01.png"],
      ["interaction", "builds/playtests/run/02.png"],
      ["finish", "builds/playtests/run/05.png"],
      ["result", "builds/playtests/run/03.png"],
    ]);
    // With no hit short of the loss, the design owes a hazard the run never took.
    expect(missingVisualEvidence({ frames: selected, hazardRequired: true })).toEqual(["hazard"]);
  });

  it("never lets a result panel fill a gameplay role, even with the player in frame", () => {
    const panelRun: readonly VisualEvidenceFrame[] = [
      { label: "booted", file: "01.png" },
      { label: "spawn", file: "02.png", probe: probe({ x: 0 }) },
      { label: "lantern", file: "03.png", probe: probe({ x: 20, collected: 1 }) },
      { label: "approach", file: "04.png", probe: probe({ x: 40, collected: 1 }) },
      { label: "win-moment", file: "05.png", probe: probe({ x: 50, collected: 1, won: true }) },
      { label: "win-panel", file: "06.png", probe: probe({ x: 50, collected: 1, won: true }) },
    ];
    const selected = select({
      evidence: panelRun,
      runState: state(probe({ x: 0 }), probe({ x: 50, collected: 1, won: true })),
    });
    // The win frames still carry a player body behind the panel; only the
    // pixels before the win may be judged as gameplay, and the finish is the
    // last of them, not the panel or the winning frame after it.
    expect(selected.map((frame) => [frame.role, frame.path])).toEqual([
      ["early", "builds/playtests/run/02.png"],
      ["interaction", "builds/playtests/run/03.png"],
      ["finish", "builds/playtests/run/04.png"],
      ["result", "builds/playtests/run/05.png"],
    ]);
  });

  it("treats a `changes` criterion as progress only after the baseline", () => {
    const withState = (base: GamePlaytestProbe, value: number): GamePlaytestProbe => ({
      ...base,
      gameState: { ...base.gameState, state: value },
    });
    const changed = frames.map((frame, index) => ({
      ...frame,
      ...(frame.probe === undefined ? {} : { probe: withState(frame.probe, index >= 3 ? 1 : 0) }),
    }));
    const selected = select({
      evidence: changed,
      runState: state(withState(probe({ x: 0 }), 0), withState(probe({ x: 30 }), 1)),
      criteria: [
        {
          id: "enter-play",
          kind: "mechanic",
          text: "Play starts",
          observe: { key: "state", expect: "changes" },
        },
      ],
    });
    const interaction = selected.find((frame) => frame.role === "interaction");
    expect(interaction?.path).toBe("builds/playtests/run/04-water.png");
  });

  it("selects nothing when the evidence has no probe state", () => {
    const selected = select({
      evidence: frames.map(({ label, file }) => ({ label, file })),
      runState: null,
    });
    // Run order cannot prove a frame is gameplay, and guessing is how a result
    // screen became the review's only evidence in t38.
    expect(selected).toEqual([]);
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
