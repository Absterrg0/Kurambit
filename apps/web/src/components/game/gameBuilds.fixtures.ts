import {
  GameBuildId,
  ThreadId,
  type GameBuild,
  type GameBuildFacts,
  type GameBuildsResult,
  type GameFactDelta,
  type GameFactView,
  type GameRunRoundRef,
} from "@kurambit/contracts";

/**
 * A faithful fake of the builds RPCs' results, typed by the contract: every
 * source, every facts state, every reading and every kind of change, with
 * the not-measured reasons the server gives. The tests read it.
 */
export const BUILD_A = GameBuildId.make("a".repeat(40));
export const BUILD_B = GameBuildId.make("b".repeat(40));
export const BUILD_C = GameBuildId.make("c".repeat(40));
export const BUILD_D = GameBuildId.make("d".repeat(40));
/** The folder before an undo of turn 5: what Redo restores. */
export const BUILD_E = GameBuildId.make("e".repeat(40));

const summary = (state: GameBuild["facts"]["state"]): GameBuild["facts"] => ({
  state,
  chips:
    state === "measured"
      ? [
          { id: "boots", text: "Boots", tone: "good" },
          { id: "winnable-without-skill", text: "Masher wins at 9 s", tone: "bad" },
        ]
      : [],
  notMeasured: state === "incomplete" ? 2 : 0,
});

export const FAKE_BUILDS: ReadonlyArray<GameBuild> = [
  {
    id: BUILD_C,
    at: "2026-11-06T15:42:00.000Z",
    source: {
      _tag: "turn",
      threadId: ThreadId.make("thread-main"),
      threadTitle: "Main chat",
      turn: 5,
      runId: "run:thread:thread-main:ordinal:5",
      request: "Make the slime jump higher",
      step: null,
    },
    summary: "Make the slime jump higher",
    files: [{ path: "web/main.js", additions: 12, deletions: 3 }],
    fileCount: 1,
    available: true,
    noPlay: null,
    noRestore: null,
    // A turn's base is the build the folder held when it started: turn 4's.
    base: BUILD_D,
    facts: summary("measuring"),
  },
  {
    id: BUILD_D,
    at: "2026-11-06T15:20:00.000Z",
    source: {
      _tag: "turn",
      threadId: ThreadId.make("thread-main"),
      threadTitle: "Main chat",
      turn: 4,
      runId: "run:thread:thread-main:ordinal:4",
      request: "Add a second slime",
      step: null,
    },
    summary: "Add a second slime",
    files: [{ path: "web/main.js", additions: 30, deletions: 2 }],
    fileCount: 1,
    available: true,
    noPlay: null,
    noRestore: null,
    base: BUILD_B,
    facts: summary("measured"),
  },
  {
    id: BUILD_B,
    at: "2026-11-06T14:10:00.000Z",
    source: {
      _tag: "round",
      runId: "run-1",
      round: 3,
      rung: "Enemies chase the player",
      move: "Add a chasing enemy",
      outcome: "kept",
      best: true,
      durationMs: 720_000,
      linesChanged: 140,
    },
    summary: "Add a chasing enemy",
    files: [
      { path: "web/enemy.js", additions: 120, deletions: 0 },
      { path: "web/main.js", additions: 20, deletions: 4 },
    ],
    fileCount: 2,
    available: true,
    noPlay: null,
    noRestore: "Stop the run to go back to a build.",
    base: BUILD_A,
    facts: summary("measured"),
  },
  {
    id: BUILD_A,
    at: "2026-11-05T09:00:00.000Z",
    source: { _tag: "saved", runId: "run-1", label: "The game before restoring round 2" },
    summary: "The game before restoring round 2",
    files: [],
    fileCount: null,
    available: false,
    noPlay: "Unity builds cannot be played here yet.",
    noRestore: "This build's history was pruned.",
    base: null,
    facts: summary("incomplete"),
  },
];

export const FAKE_BUILDS_RESULT: GameBuildsResult = {
  builds: FAKE_BUILDS,
  next: null,
  current: BUILD_C,
  folderEdited: false,
  restore: {
    requestId: "restore-1",
    target: BUILD_B,
    label: "Round 3's build",
    requestedAt: "2026-11-06T15:00:00.000Z",
    // Turns 4 and 5 changed the folder since: the restore has no undo any more.
    undo: null,
    outcome: { restored: true, message: "Round 3's build is back in the folder." },
  },
};

/** The same game after Undo on turn 5: turn 4's build is back, and the folder before it is parked. */
export const FAKE_UNDONE_RESULT: GameBuildsResult = {
  ...FAKE_BUILDS_RESULT,
  builds: [
    {
      id: BUILD_E,
      at: "2026-11-06T15:50:00.000Z",
      source: { _tag: "saved", runId: null, label: "The game before restoring turn 4's build" },
      summary: "The game before restoring turn 4's build",
      files: [],
      fileCount: null,
      available: true,
      noPlay: null,
      noRestore: null,
      base: null,
      facts: summary("never"),
    },
    ...FAKE_BUILDS,
  ],
  current: BUILD_D,
  restore: {
    requestId: "restore-2",
    target: BUILD_D,
    label: "Turn 4's build",
    requestedAt: "2026-11-06T15:50:00.000Z",
    undo: BUILD_E,
    outcome: { restored: true, message: "Turn 4's build is back in the folder." },
  },
};

const bot = (ending: "won" | "lost" | "no-ending", at: number | null) => ({
  ending,
  at,
  played: 60,
  note: "",
  evidence: "builds/logs/bot-1",
});

export const FAKE_FACTS: GameBuildFacts = {
  build: BUILD_B,
  key: "tree-b",
  harness: "1",
  state: "incomplete",
  measuredAt: "2026-11-06T14:20:00.000Z",
  renderer: "Compatibility; native exports draw Forward+",
  boots: { status: "measured", value: { ok: true, detail: "Reached play in 2.1 s" } },
  idle: { status: "measured", value: bot("no-ending", null) },
  masher: { status: "measured", value: bot("won", 9.4) },
  skilled: { status: "not-measured", why: "this game has no skilled bot", retry: false },
  winnableWithoutSkill: { status: "measured", value: true },
  liveness: { status: "not-measured", why: "the browser host went away", retry: true },
  firstResponse: { status: "pending" },
  assets: { status: "measured", value: { models: [], more: 0, libraryFiles: 0 } },
  message: "",
};

export const FAKE_FACT_VIEWS: ReadonlyArray<GameFactView> = [
  {
    id: "boots",
    label: "Boots",
    reading: { _tag: "measured", text: "Reached play in 2.1 s", value: 2.1, tone: "good" },
    evidence: [],
  },
  {
    id: "masher",
    label: "Masher",
    reading: { _tag: "measured", text: "Won at 9.4 s", value: 9.4, tone: "bad" },
    evidence: [{ kind: "video", label: "Masher run", path: "builds/logs/bot-1/video.mp4" }],
  },
  {
    id: "skilled",
    label: "Skilled",
    reading: { _tag: "not-measured", why: "this game has no skilled bot" },
    evidence: [],
  },
  { id: "first-response", label: "First response", reading: { _tag: "pending" }, evidence: [] },
];

export const FAKE_DELTAS: ReadonlyArray<GameFactDelta> = [
  {
    id: "masher",
    label: "Masher",
    a: "Won at 9.4 s",
    b: "Lost at 40 s",
    change: "up",
    tone: "better",
    why: null,
  },
  {
    id: "freeze",
    label: "Longest freeze",
    a: "1 s",
    b: "4 s",
    change: "up",
    tone: "worse",
    why: null,
  },
  {
    id: "first-response",
    label: "First response",
    a: "0.2 s",
    b: "0.1 s",
    change: "down",
    tone: "better",
    why: null,
  },
  { id: "boots", label: "Boots", a: "Yes", b: "Yes", change: "same", tone: "neutral", why: null },
  {
    id: "idle",
    label: "Idle",
    a: "Never ends",
    b: "Ends at 30 s",
    change: "changed",
    tone: "neutral",
    why: null,
  },
  {
    id: "skilled",
    label: "Skilled",
    a: null,
    b: "Won at 50 s",
    change: "not-comparable",
    tone: "neutral",
    why: "this game has no skilled bot",
  },
];

export const fakeRound = (overrides: Partial<GameRunRoundRef>): GameRunRoundRef => ({
  round: 3,
  move: "Add a chasing enemy",
  branch: "round-3",
  kept: true,
  current: true,
  outcome: "kept",
  verdicts: [],
  linesChanged: 140,
  durationMs: 720_000,
  note: null,
  steer: [],
  rung: null,
  build: BUILD_B,
  base: BUILD_A,
  endedAt: "2026-11-06T14:10:00.000Z",
  tokens: 84_000,
  ...overrides,
});
