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
  type GameDesignState,
  type GameQualificationRead,
  type GameQualificationStage,
  type GameQualificationStageRead,
  type GameQualificationSummary,
} from "@t3tools/contracts";
import { snapshotSource, type SourceSnapshot } from "./sourceSnapshot.ts";
import { webArtifactsMatch, type WebArtifactFile } from "./webBuild.ts";

/** The stages a real service operation can record today. */
const RECORDED_QUALIFICATION_STAGES = ["check", "test", "export", "playtest", "state"] as const;
export type RecordedQualificationStage = (typeof RECORDED_QUALIFICATION_STAGES)[number];
/** The stages the read always reports, including the ones later work will own. */
const ALL_STAGES = ["design", "check", "test", "export", "playtest", "state", "visual"] as const;

/**
 * `unknown` means the attempt could not tie its result to known sources.
 * `cancelled` is kept distinct so an interruption is not mistaken for a real
 * failure of the game, but neither can ever read as a pass.
 */
export type QualificationOutcome = "passed" | "failed" | "unknown" | "cancelled";

export interface QualificationStageRecord {
  readonly outcome: QualificationOutcome;
  /** The source snapshot the operation actually covered; null when unknowable. */
  readonly sourceId: string | null;
  /** For exports, the built artifact; for playtests, the build it played. */
  readonly buildId: string | null;
  readonly finishedAt: string;
  readonly evidenceDirectory: string | null;
  /** The approved design revision the state stage graded, when there was one. */
  readonly designHash?: string | null;
  /** The per-criterion summary for the state stage. */
  readonly criteria?: readonly GameScenarioCriterionResult[];
  /** Why the state stage passed or failed, including legacy rules. */
  readonly detail?: string;
  /** For web exports, the exact files the build produced. */
  readonly artifacts?: readonly WebArtifactFile[];
}
export interface QualificationRecord {
  readonly schemaVersion: 1;
  readonly game: string;
  readonly stages: Partial<Record<RecordedQualificationStage, QualificationStageRecord>>;
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
  designHash: Schema.optionalKey(Schema.NullOr(Schema.String)),
  criteria: Schema.optionalKey(Schema.Array(GameScenarioCriterionResult)),
  detail: Schema.optionalKey(Schema.String),
  artifacts: Schema.optionalKey(Schema.Array(StoredArtifact)),
});
const StoredRecord = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    game: Schema.String,
    stages: Schema.Record(Schema.String, StoredStage),
  }),
);
const decodeStoredRecord = Schema.decodeUnknownSync(StoredRecord);

const isRecordedStage = (key: string): key is RecordedQualificationStage =>
  (RECORDED_QUALIFICATION_STAGES as readonly string[]).includes(key);

const recordPath = (stateDir: string, root: string) => {
  const normalised = NodePath.resolve(root);
  const digest = NodeCrypto.createHash("sha256").update(normalised).digest("hex").slice(0, 32);
  return NodePath.join(stateDir, "game-qualification", `${digest}.json`);
};

const readRecord = async (file: string): Promise<QualificationRecord | null> => {
  try {
    const stored = decodeStoredRecord(await NodeFSP.readFile(file, "utf8"));
    const stages: Partial<Record<RecordedQualificationStage, QualificationStageRecord>> = {};
    for (const [key, value] of Object.entries(stored.stages))
      if (isRecordedStage(key)) stages[key] = value;
    return { schemaVersion: 1, game: stored.game, stages };
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
 * real service operations can pass; `state` and `visual` stay missing until
 * their checks exist, so they can never be reported passed by accident.
 */
const deriveQualification = (input: {
  readonly record: QualificationRecord | null;
  readonly source: SourceSnapshot;
  readonly designState: GameDesignState | null;
  readonly designHash: string | null;
  /** Whether the recorded web artifact still matches builds/web. */
  readonly artifactsCurrent: boolean;
}): GameQualificationRead => {
  if (input.source.kind === "unknown")
    return {
      state: "unknown",
      sourceId: null,
      buildId: null,
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
  // Only the four stages with real operations can pass today. `state` and
  // `visual` are listed as missing and deliberately do not block qualification
  // yet; when their checks land they join this set and must pass too.
  for (const stage of RECORDED_QUALIFICATION_STAGES) {
    const recorded = input.record?.stages[stage];
    const read = (status: GameQualificationStageRead["status"]): GameQualificationStageRead => ({
      stage,
      status,
      sourceId: recorded?.sourceId ?? null,
      buildId: recorded?.buildId ?? null,
      finishedAt: recorded?.finishedAt ?? null,
      ...(recorded?.criteria === undefined ? {} : { criteria: recorded.criteria }),
      ...(recorded?.detail === undefined ? {} : { detail: recorded.detail }),
    });
    if (recorded === undefined) stageReads.set(stage, read("missing"));
    else if (recorded.outcome === "failed") stageReads.set(stage, read("failed"));
    else if (recorded.outcome === "cancelled") stageReads.set(stage, read("failed"));
    else if (recorded.outcome === "unknown") stageReads.set(stage, read("unknown"));
    else if (recorded.sourceId === null) stageReads.set(stage, read("unknown"));
    else if (recorded.sourceId !== currentSourceId) stageReads.set(stage, read("stale"));
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
    else stageReads.set(stage, read("passed"));
  }
  for (const stage of ["visual"] as const)
    stageReads.set(stage, {
      stage,
      status: "missing",
      sourceId: null,
      buildId: null,
      finishedAt: null,
    });

  // A playtest proves nothing about a build it did not play, so it also has to
  // name the export that is current right now.
  const exportRecord = input.record?.stages.export;
  const playtest = stageReads.get("playtest")!;
  const exportRead = stageReads.get("export")!;
  if (
    playtest.status === "passed" &&
    (exportRead.status !== "passed" ||
      exportRecord?.buildId == null ||
      input.record?.stages.playtest?.buildId !== exportRecord.buildId)
  )
    stageReads.set("playtest", { ...playtest, status: "stale" });

  const stages = ALL_STAGES.map((stage) => stageReads.get(stage)!);
  const qualified =
    stageReads.get("design")!.status === "passed" &&
    RECORDED_QUALIFICATION_STAGES.every((stage) => stageReads.get(stage)!.status === "passed");
  return {
    state: qualified ? "qualified" : "unqualified",
    sourceId: currentSourceId,
    buildId: exportRead.status === "passed" ? (exportRecord?.buildId ?? null) : null,
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
): GameQualificationSummary => {
  const stages = RECORDED_QUALIFICATION_STAGES.map((stage) => record?.stages[stage]);
  const finished = stages
    .flatMap((stage) => (stage === undefined ? [] : [stage.finishedAt]))
    .sort()
    .at(-1);
  if (record === null) return { state: "unqualified", asOf: null };
  const passed = RECORDED_QUALIFICATION_STAGES.every(
    (stage) => record.stages[stage]?.outcome === "passed",
  );
  const sourceIds = new Set(
    RECORDED_QUALIFICATION_STAGES.map((stage) => record.stages[stage]?.sourceId ?? null),
  );
  const exportBuild = record.stages.export?.buildId ?? null;
  const playtestBuild = record.stages.playtest?.buildId ?? null;
  const designBound = (record.stages.state?.designHash ?? null) === designHash;
  const qualified =
    passed &&
    sourceIds.size === 1 &&
    !sourceIds.has(null) &&
    exportBuild !== null &&
    playtestBuild === exportBuild &&
    designBound;
  return { state: qualified ? "qualified" : "unqualified", asOf: finished ?? null };
};

export interface QualificationRecordInput {
  readonly stage: RecordedQualificationStage;
  readonly outcome: QualificationOutcome;
  readonly sourceId: string | null;
  readonly buildId: string | null;
  readonly evidenceDirectory: string | null;
  readonly designHash?: string | null;
  readonly criteria?: readonly GameScenarioCriterionResult[];
  readonly detail?: string;
  readonly artifacts?: readonly WebArtifactFile[];
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
    ) => Effect.Effect<GameQualificationRead>;
    /**
     * The record-only verdict for a library row. Cheap by construction: it reads
     * one small record and never walks the game's sources.
     */
    readonly summary: (
      root: string,
      designHash: string | null,
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
      stage: RecordedQualificationStage,
    ) => Effect.Effect<void, GameOperationError>;
  }
>()("t3/game/GameQualification") {}

export const layer = (options: {
  readonly stateDir: string;
  /** Tests use a small bound to prove a bounded scan reads as unknown. */
  readonly maxSourceEntries?: number | undefined;
}) => {
  const writes = new Map<string, Promise<void>>();
  const serialized = (key: string, work: () => Promise<void>) => {
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
      summary: (root, designHash) =>
        Effect.promise(async () => {
          const record = await readRecord(recordPath(options.stateDir, root));
          return deriveQualificationSummary(record, designHash);
        }),
      read: (root, godotProject, designState, designHash) =>
        Effect.gen(function* () {
          const source = yield* Effect.promise(() =>
            snapshotSource(root, godotProject, {
              maxEntries: options.maxSourceEntries,
            }),
          );
          const record = yield* Effect.promise(() =>
            readRecord(recordPath(options.stateDir, root)),
          );
          const artifactsCurrent = yield* Effect.promise(() =>
            webArtifactsMatch(root, record?.stages.export?.artifacts),
          );
          return deriveQualification({
            record,
            source,
            designState: designState ?? null,
            designHash: designHash ?? null,
            artifactsCurrent,
          });
        }),
      record: (root, input) => {
        const file = recordPath(options.stateDir, root);
        const game = NodePath.resolve(root);
        return Effect.gen(function* () {
          const finishedAt = DateTime.formatIso(yield* DateTime.now);
          yield* Effect.tryPromise({
            try: () =>
              serialized(game, async () => {
                const previous = (await readRecord(file)) ?? {
                  schemaVersion: 1 as const,
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
                      ...(input.designHash === undefined ? {} : { designHash: input.designHash }),
                      ...(input.criteria === undefined ? {} : { criteria: input.criteria }),
                      ...(input.detail === undefined ? {} : { detail: input.detail }),
                      ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
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
        });
      },
      begin: (root, stage) => {
        const file = recordPath(options.stateDir, root);
        const game = NodePath.resolve(root);
        return Effect.tryPromise({
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
      },
    }),
  );
};

/** Exposed for tests and diagnostics; the hash keeps game names off the state path. */
export const qualificationRecordPath = (stateDir: string, root: string) =>
  recordPath(stateDir, root);
