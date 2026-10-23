// @effect-diagnostics nodeBuiltinImport:off -- Qualification records and source snapshots live on the native filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  GameScenarioCriterionResult,
  GameScenarioKindCoverage,
  type GameAcceptanceCriterion,
  type GameDesignState,
  type GameQualificationRead,
  type GameQualificationStage,
  type GameQualificationStageRead,
  type GameQualificationSummary,
} from "@t3tools/contracts";
import { snapshotBuildSource, type SourceSnapshot } from "./sourceSnapshot.ts";
import { webArtifactIdentity, webArtifactsMatch, type WebArtifactFile } from "./webBuild.ts";
import { gameRecordFile, gameRecordLocation, migrateGameRecord } from "./gameRecord.ts";

/** The stages a real service operation can record today. */
const RECORDED_QUALIFICATION_STAGES = ["check", "test", "export", "playtest", "state"] as const;
export type RecordedQualificationStage = (typeof RECORDED_QUALIFICATION_STAGES)[number];
/** The stages the read always reports, including the ones later work will own. */
const ALL_STAGES = ["design", "check", "test", "export", "playtest", "state"] as const;
/** Stages a record can hold; `design` is the approval record, never written here. */
export type StoredQualificationStage = Exclude<(typeof ALL_STAGES)[number], "design">;

/**
 * `unknown` means the attempt could not tie its result to known sources.
 * `cancelled` is kept distinct so an interruption is not mistaken for a real
 * failure of the game, but neither can ever read as a pass.
 */
export type QualificationOutcome = "passed" | "failed" | "unknown" | "cancelled";

/**
 * The exam a recorded result was earned under. A stage written under another
 * policy revision (or another probe obligation) is stale even when the sources
 * did not change.
 */
export interface QualificationIdentity {
  readonly policyRevision: string;
  readonly probeRequired: boolean;
}

export interface QualificationStageRecord {
  readonly outcome: QualificationOutcome;
  /** The source snapshot the operation actually covered; null when unknowable. */
  readonly sourceId: string | null;
  /** For exports, the built artifact; for playtests, the build it played. */
  readonly buildId: string | null;
  readonly finishedAt: string;
  readonly evidenceDirectory: string | null;
  /** The orchestration run whose tool call produced this stage, when one did. */
  readonly runId?: string | null;
  /** The approved design revision the state stage graded, when there was one. */
  readonly designHash?: string | null;
  /** The per-criterion summary for the state stage. */
  readonly criteria?: readonly GameScenarioCriterionResult[];
  /** Proven/failed/missing counts per kind for the state stage. */
  readonly coverage?: readonly GameScenarioKindCoverage[];
  /** Why the state stage passed or failed, including legacy rules. */
  readonly detail?: string;
  /** For web exports, the exact files the build produced. */
  readonly artifacts?: readonly WebArtifactFile[];
  /** For web exports, the game-relative directory those files live in. */
  readonly buildDirectory?: string;
  /** The verification-policy revision the check/test/state ran under. */
  readonly policyRevision?: string | null;
  /** Whether the playtest owed a StudioProbe reading. */
  readonly probeRequired?: boolean | null;
}
export interface QualificationRecord {
  readonly schemaVersion: 2;
  readonly archivedVisual?: unknown;
  readonly game: string;
  readonly stages: Partial<Record<StoredQualificationStage, QualificationStageRecord>>;
}
const StoredArtifact = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  mtimeMs: Schema.Number,
});
const StoredStage = Schema.Struct({
  outcome: Schema.Literals(["passed", "failed", "unknown", "cancelled"]),
  sourceId: Schema.NullOr(Schema.String),
  buildId: Schema.NullOr(Schema.String),
  finishedAt: Schema.String,
  evidenceDirectory: Schema.NullOr(Schema.String),
  /** The orchestration run whose tool call produced this stage, when one did. */
  runId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  designHash: Schema.optionalKey(Schema.NullOr(Schema.String)),
  criteria: Schema.optionalKey(Schema.Array(GameScenarioCriterionResult)),
  coverage: Schema.optionalKey(Schema.Array(GameScenarioKindCoverage)),
  detail: Schema.optionalKey(Schema.String),
  artifacts: Schema.optionalKey(Schema.Array(StoredArtifact)),
  buildDirectory: Schema.optionalKey(Schema.String),
  policyRevision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  probeRequired: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
const StoredRecord = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literals([1, 2]),
    archivedVisual: Schema.optionalKey(Schema.Unknown),
    game: Schema.String,
    stages: Schema.Record(Schema.String, Schema.Unknown),
  }),
);
const decodeStoredStage = Schema.decodeUnknownSync(StoredStage);
const decodeStoredRecord = Schema.decodeUnknownSync(StoredRecord);

const isStoredStage = (key: string): key is StoredQualificationStage =>
  (ALL_STAGES as readonly string[]).includes(key) && key !== "design";

const recordPath = (stateDir: string, root: string) =>
  gameRecordFile(stateDir, "game-qualification", root);
/**
 * Qualification records are fail-closed already, so a failed migration just
 * leaves the read to the canonical key; it must never crash a status read.
 */
const qualificationLocation = async (stateDir: string, root: string) => {
  const location = await gameRecordLocation(stateDir, "game-qualification", root);
  await migrateGameRecord(location).catch(() => false);
  return location;
};

const readRecord = async (file: string): Promise<QualificationRecord | null> => {
  try {
    const stored = decodeStoredRecord(await NodeFSP.readFile(file, "utf8"));
    const stages: Partial<Record<StoredQualificationStage, QualificationStageRecord>> = {};
    for (const [key, value] of Object.entries(stored.stages))
      if (isStoredStage(key)) stages[key] = decodeStoredStage(value);
    const archivedVisual = stored.archivedVisual ?? stored.stages.visual;
    const record: QualificationRecord = {
      schemaVersion: 2,
      game: stored.game,
      stages,
      ...(archivedVisual === undefined ? {} : { archivedVisual }),
    };
    if (stored.schemaVersion === 1) await writeRecordFile(file, record);
    return record;
  } catch {
    // A missing or unreadable record simply proves nothing; it must never
    // become a pass, so it reads as no stages.
    return null;
  }
};

/** Writes the whole record through a temporary file so a crash cannot tear it. */
const writeRecordFile = async (file: string, record: QualificationRecord) => {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  try {
    await NodeFSP.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
};

/**
 * The server's verdict for the current sources. Only the four stages that have
 * real service operations can pass. Review decisions never certify every
 * presentation claim or contribute a mechanical pass.
 */
const deriveQualification = (input: {
  readonly record: QualificationRecord | null;
  readonly source: SourceSnapshot;
  readonly designState: GameDesignState | null;
  readonly designHash: string | null;
  /** Whether the recorded web artifact still matches builds/web. */
  readonly artifactsCurrent: boolean;
  /** The current exam, when the caller knows it. */
  readonly identity: QualificationIdentity | null;
  /** The approved acceptance, so presentation claims can be listed as missing. */
  readonly acceptance: readonly GameAcceptanceCriterion[];
}): GameQualificationRead => {
  // The identity of the bytes actually served from builds/web: the recorded
  // export's own descriptor while it still matches the directory. Source
  // currentness is a different question, so even an unknown source snapshot
  // leaves this standing.
  const exportRecord = input.record?.stages.export;
  const servedArtifactId =
    exportRecord?.outcome === "passed" &&
    exportRecord.buildId !== null &&
    exportRecord.artifacts !== undefined &&
    input.artifactsCurrent
      ? webArtifactIdentity(exportRecord.artifacts)
      : null;
  if (input.source.kind === "unknown")
    return {
      state: "unknown",
      completion: "unknown",
      mechanicsQualified: false,
      sourceId: null,
      buildId: null,
      servedArtifactId,
      stages: ALL_STAGES.map((stage) => ({
        stage,
        status: "unknown" as const,
        sourceId: null,
        buildId: null,
        finishedAt: null,
      })),
    };
  const currentSourceId = input.source.sourceId;
  const stageReads = new Map<GameQualificationStage, GameQualificationStageRead>();
  // The design stage is the creator's approval, not a file the agent can edit.
  // A changed or unapproved design blocks qualification; legacy games with no
  // design document are accepted as they are.
  stageReads.set("design", {
    stage: "design",
    status:
      input.designState === "approved" || input.designState === "legacy"
        ? "passed"
        : input.designState === null
          ? "missing"
          : "failed",
    sourceId: null,
    buildId: null,
    finishedAt: null,
  });
  // These stages certify mechanics; review decisions have their own history.
  for (const stage of RECORDED_QUALIFICATION_STAGES) {
    const recorded = input.record?.stages[stage];
    const read = (status: GameQualificationStageRead["status"]): GameQualificationStageRead => ({
      stage,
      status,
      sourceId: recorded?.sourceId ?? null,
      buildId: recorded?.buildId ?? null,
      finishedAt: recorded?.finishedAt ?? null,
      ...(recorded?.criteria === undefined ? {} : { criteria: recorded.criteria }),
      ...(recorded?.coverage === undefined ? {} : { coverage: recorded.coverage }),
      ...(recorded?.detail === undefined ? {} : { detail: recorded.detail }),
      ...(recorded?.buildDirectory === undefined
        ? {}
        : { buildDirectory: recorded.buildDirectory }),
    });
    if (recorded === undefined) stageReads.set(stage, read("missing"));
    else if (recorded.outcome === "failed") stageReads.set(stage, read("failed"));
    else if (recorded.outcome === "cancelled") stageReads.set(stage, read("failed"));
    else if (recorded.outcome === "unknown") stageReads.set(stage, read("unknown"));
    else if (recorded.sourceId === null) stageReads.set(stage, read("unknown"));
    else if (recorded.sourceId !== currentSourceId) stageReads.set(stage, read("stale"));
    else if (
      input.identity !== null &&
      stage !== "export" &&
      stage !== "playtest" &&
      (recorded.policyRevision ?? null) !== input.identity.policyRevision
    )
      // The exam changed. A pass earned under another canonical suite, gameplay
      // scene or probe rule does not certify this one.
      stageReads.set(stage, {
        ...read("stale"),
        detail: "The game's verification policy changed after this result was recorded.",
      });
    else if (
      input.identity !== null &&
      stage === "playtest" &&
      (recorded.probeRequired ?? null) !== input.identity.probeRequired
    )
      stageReads.set(stage, {
        ...read("stale"),
        detail: "The game's probe requirement changed after this playtest was recorded.",
      });
    else if (stage === "export" && !input.artifactsCurrent)
      // The record names a build whose files are missing or were replaced. The
      // source ID is not enough: players and playtests load these exact bytes.
      stageReads.set(stage, {
        ...read("stale"),
        detail: "The exported web build files are missing or no longer match the build record.",
      });
    else if (stage === "state" && (recorded.designHash ?? null) !== input.designHash)
      // A new approved design binds new acceptance; an old route result cannot
      // silently grade it even when the game sources did not change.
      stageReads.set(stage, read("stale"));
    else if (
      stage === "state" &&
      (recorded.criteria ?? []).some((criterion) => criterion.provenBy === undefined)
    )
      // State results written before the play-start baseline do not carry the
      // proving scenario/frame; their pass may rest on boot constants, so make
      // the game rerun the exam rather than inherit it.
      stageReads.set(stage, {
        ...read("stale"),
        detail:
          "The state exam changed after this result was recorded; run game_scenarios_run again.",
      });
    else stageReads.set(stage, read("passed"));
  }
  const exportRead = stageReads.get("export")!;
  // A playtest proves nothing about a build it did not play, so it also has to
  // name the export that is current right now. The record was already read once
  // at the top of this derivation.
  const playtest = stageReads.get("playtest")!;
  if (
    playtest.status === "passed" &&
    (exportRead.status !== "passed" ||
      exportRecord?.buildId == null ||
      input.record?.stages.playtest?.buildId !== exportRecord.buildId)
  )
    stageReads.set("playtest", { ...playtest, status: "stale" });

  const stages = ALL_STAGES.map((stage) => stageReads.get(stage)!);
  const mechanicsQualified =
    stageReads.get("design")!.status === "passed" &&
    RECORDED_QUALIFICATION_STAGES.every((stage) => stageReads.get(stage)!.status === "passed");
  const qualified = mechanicsQualified;
  // Playable completion: the exact bytes served from builds/web were played by
  // a current, input-responsive playtest. test and state are optional
  // certification; their absence never makes a playable game incomplete.
  const completion =
    exportRead.status === "passed" &&
    playtest.status === "passed" &&
    exportRecord?.buildId !== null &&
    exportRecord?.buildId !== undefined &&
    input.record?.stages.playtest?.buildId === exportRecord.buildId
      ? "complete"
      : "incomplete";
  return {
    state: qualified ? "qualified" : "unqualified",
    completion,
    mechanicsQualified,
    sourceId: currentSourceId,
    buildId: exportRead.status === "passed" ? (exportRecord?.buildId ?? null) : null,
    servedArtifactId,
    stages,
  };
};

/**
 * The verdict a library row may show without touching the source tree: the
 * record alone, bound to the design revision the caller already knows. It says
 * what was true when the last stage was written; only `read` can say whether
 * the files still match, so the Stage never inherits this as an exact answer.
 */
const deriveQualificationSummary = (
  record: QualificationRecord | null,
  designHash: string | null,
  identity: QualificationIdentity | null,
): GameQualificationSummary => {
  const stages = RECORDED_QUALIFICATION_STAGES.map((stage) => record?.stages[stage]);
  const finished = stages
    .flatMap((stage) => (stage === undefined ? [] : [stage.finishedAt]))
    .sort()
    .at(-1);
  if (record === null) return { state: "unqualified", completion: "incomplete", asOf: null };
  const passed = RECORDED_QUALIFICATION_STAGES.every(
    (stage) => record.stages[stage]?.outcome === "passed",
  );
  const sourceIds = new Set(
    RECORDED_QUALIFICATION_STAGES.map((stage) => record.stages[stage]?.sourceId ?? null),
  );
  const exportBuild = record.stages.export?.buildId ?? null;
  const playtestBuild = record.stages.playtest?.buildId ?? null;
  const designBound = (record.stages.state?.designHash ?? null) === designHash;
  const exportStage = record.stages.export;
  const playtestStage = record.stages.playtest;
  const completion =
    exportStage?.outcome === "passed" &&
    playtestStage?.outcome === "passed" &&
    exportBuild !== null &&
    playtestBuild === exportBuild &&
    (exportStage.sourceId ?? null) !== null &&
    exportStage.sourceId === playtestStage.sourceId
      ? ("complete" as const)
      : ("incomplete" as const);
  // A state record from before the baseline exam has no proving frame; the
  // library must not advertise it until the scenario stage is rerun.
  const stateExamCurrent = (record.stages.state?.criteria ?? []).every(
    (criterion) => criterion.provenBy !== undefined,
  );
  const policyBound =
    identity === null ||
    (RECORDED_QUALIFICATION_STAGES.filter(
      (stage) => stage !== "export" && stage !== "playtest",
    ).every(
      (stage) => (record.stages[stage]?.policyRevision ?? null) === identity.policyRevision,
    ) &&
      (record.stages.playtest?.probeRequired ?? null) === identity.probeRequired);
  const qualified =
    passed &&
    sourceIds.size === 1 &&
    !sourceIds.has(null) &&
    exportBuild !== null &&
    playtestBuild === exportBuild &&
    designBound &&
    stateExamCurrent &&
    policyBound;
  return { state: qualified ? "qualified" : "unqualified", completion, asOf: finished ?? null };
};

export interface QualificationRecordInput {
  readonly stage: StoredQualificationStage;
  readonly outcome: QualificationOutcome;
  readonly sourceId: string | null;
  readonly buildId: string | null;
  readonly evidenceDirectory: string | null;
  readonly runId?: string | null;
  readonly designHash?: string | null;
  readonly criteria?: readonly GameScenarioCriterionResult[];
  readonly coverage?: readonly GameScenarioKindCoverage[];
  readonly detail?: string;
  readonly artifacts?: readonly WebArtifactFile[];
  readonly buildDirectory?: string;
  readonly policyRevision?: string | null;
  readonly probeRequired?: boolean | null;
}

export class GameQualification extends Context.Service<
  GameQualification,
  {
    /**
     * Qualification of a game's current sources. IO or a scan-bound hit reads as
     * unknown, never as current. The caller passes the server-owned design
     * state; without one the design stage is missing and never counts as passed.
     */
    readonly read: (
      root: string,
      godotProject: string,
      designState?: GameDesignState,
      designHash?: string | null,
      identity?: QualificationIdentity | null,
      acceptance?: readonly GameAcceptanceCriterion[],
    ) => Effect.Effect<GameQualificationRead>;
    /**
     * The record-only verdict for a library row. Cheap by construction: it reads
     * one small record and never walks the game's sources.
     */
    readonly summary: (
      root: string,
      designHash: string | null,
      identity?: QualificationIdentity | null,
    ) => Effect.Effect<GameQualificationSummary>;
    /** Records one real operation result. Concurrent writers are serialized per game. */
    readonly record: (
      root: string,
      input: QualificationRecordInput,
    ) => Effect.Effect<void, GameOperationError>;
    /**
     * Starts an attempt by removing the stage's previous result before the work
     * runs. A crash, interruption or failed terminal write then leaves the stage
     * missing rather than readable as the earlier pass.
     */
    readonly begin: (
      root: string,
      stage: StoredQualificationStage,
    ) => Effect.Effect<void, GameOperationError>;
    /**
     * One raw stage record, including the fields the derived read drops (the
     * export's build directory and detail). Null when the stage never ran.
     */
    readonly stageRecord: (
      root: string,
      stage: StoredQualificationStage,
    ) => Effect.Effect<QualificationStageRecord | null, GameOperationError>;
  }
>()("t3/game/GameQualification") {}

export const layer = (options: {
  readonly stateDir: string;
  /** Tests use a small bound to prove a bounded scan reads as unknown. */
  readonly maxSourceEntries?: number | undefined;
}) => {
  const writes = new Map<string, Promise<unknown>>();
  const serialized = <A>(key: string, work: () => Promise<A>) => {
    const previous = writes.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    // Keep the chain alive after a failed write; the failure goes to its caller.
    writes.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };
  return Layer.succeed(
    GameQualification,
    GameQualification.of({
      summary: (root, designHash, identity) =>
        Effect.promise(async () => {
          const location = await qualificationLocation(options.stateDir, root);
          const record = await serialized(location.canonicalRoot, () => readRecord(location.file));
          return deriveQualificationSummary(record, designHash, identity ?? null);
        }),
      read: (root, godotProject, designState, designHash, identity, acceptance) =>
        Effect.gen(function* () {
          const source = yield* Effect.promise(() =>
            snapshotBuildSource(root, godotProject, {
              maxEntries: options.maxSourceEntries,
            }),
          );
          const record = yield* Effect.promise(async () => {
            const location = await qualificationLocation(options.stateDir, root);
            return serialized(location.canonicalRoot, () => readRecord(location.file));
          });
          const artifactsCurrent = yield* Effect.promise(() =>
            webArtifactsMatch(
              root,
              record?.stages.export?.artifacts,
              record?.stages.export?.buildDirectory,
            ),
          );
          return deriveQualification({
            record,
            source,
            designState: designState ?? null,
            designHash: designHash ?? null,
            artifactsCurrent,
            identity: identity ?? null,
            acceptance: acceptance ?? [],
          });
        }),
      record: (root, input) =>
        Effect.gen(function* () {
          const location = yield* Effect.promise(() =>
            qualificationLocation(options.stateDir, root),
          );
          const file = location.file;
          const game = location.canonicalRoot;
          const finishedAt = DateTime.formatIso(yield* DateTime.now);
          yield* Effect.tryPromise({
            try: () =>
              serialized(game, async () => {
                const previous = (await readRecord(file)) ?? {
                  schemaVersion: 2 as const,
                  game,
                  stages: {},
                };
                const next: QualificationRecord = {
                  ...previous,
                  stages: {
                    ...previous.stages,
                    [input.stage]: {
                      outcome: input.outcome,
                      sourceId: input.sourceId,
                      buildId: input.buildId,
                      finishedAt,
                      evidenceDirectory: input.evidenceDirectory,
                      ...(input.runId === undefined ? {} : { runId: input.runId }),
                      ...(input.designHash === undefined ? {} : { designHash: input.designHash }),
                      ...(input.criteria === undefined ? {} : { criteria: input.criteria }),
                      ...(input.coverage === undefined ? {} : { coverage: input.coverage }),
                      ...(input.detail === undefined ? {} : { detail: input.detail }),
                      ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
                      ...(input.buildDirectory === undefined
                        ? {}
                        : { buildDirectory: input.buildDirectory }),
                      ...(input.policyRevision === undefined
                        ? {}
                        : { policyRevision: input.policyRevision }),
                      ...(input.probeRequired === undefined
                        ? {}
                        : { probeRequired: input.probeRequired }),
                    },
                  },
                };
                await writeRecordFile(file, next);
              }),
            catch: (cause) =>
              new GameOperationError({
                operation: "qualification",
                path: file,
                reason: "io",
                cause,
              }),
          });
        }),
      begin: (root, stage) =>
        Effect.gen(function* () {
          const location = yield* Effect.promise(() =>
            qualificationLocation(options.stateDir, root),
          );
          const file = location.file;
          const game = location.canonicalRoot;
          yield* Effect.tryPromise({
            try: () =>
              serialized(game, async () => {
                const previous = await readRecord(file);
                if (previous === null || previous.stages[stage] === undefined) return;
                const stages = { ...previous.stages };
                delete stages[stage];
                await writeRecordFile(file, { ...previous, stages });
              }),
            catch: (cause) =>
              new GameOperationError({
                operation: "qualification",
                path: file,
                reason: "io",
                cause,
              }),
          });
        }),
      stageRecord: (root, stage) =>
        Effect.gen(function* () {
          const location = yield* Effect.promise(() =>
            qualificationLocation(options.stateDir, root),
          );
          const record = yield* Effect.tryPromise({
            try: () => serialized(location.canonicalRoot, () => readRecord(location.file)),
            catch: (cause) =>
              new GameOperationError({
                operation: "qualification",
                path: location.file,
                reason: "io",
                cause,
              }),
          });
          return record?.stages[stage] ?? null;
        }),
    }),
  );
};

/** Exposed for tests and diagnostics; the hash keeps game names off the state path. */
export const qualificationRecordPath = (stateDir: string, root: string) =>
  recordPath(stateDir, root);
