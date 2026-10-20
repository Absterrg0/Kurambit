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
  type GameQualificationRead,
  type GameQualificationStage,
  type GameQualificationStageRead,
} from "@t3tools/contracts";
import { snapshotSource, type SourceSnapshot } from "./sourceSnapshot.ts";

/** The stages a real service operation can record today. */
const RECORDED_QUALIFICATION_STAGES = ["check", "test", "export", "playtest"] as const;
export type RecordedQualificationStage = (typeof RECORDED_QUALIFICATION_STAGES)[number];
/** The stages the read always reports, including the ones later work will own. */
const ALL_STAGES = ["check", "test", "export", "playtest", "state", "visual"] as const;

export interface QualificationStageRecord {
  readonly outcome: "passed" | "failed";
  /** The source snapshot the operation actually covered; null when unknowable. */
  readonly sourceId: string | null;
  /** For exports, the built artifact; for playtests, the build it played. */
  readonly buildId: string | null;
  readonly finishedAt: string;
  readonly evidenceDirectory: string | null;
}
export interface QualificationRecord {
  readonly schemaVersion: 1;
  readonly game: string;
  readonly stages: Partial<Record<RecordedQualificationStage, QualificationStageRecord>>;
}
const StoredStage = Schema.Struct({
  outcome: Schema.Literals(["passed", "failed"]),
  sourceId: Schema.NullOr(Schema.String),
  buildId: Schema.NullOr(Schema.String),
  finishedAt: Schema.String,
  evidenceDirectory: Schema.NullOr(Schema.String),
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

/**
 * The server's verdict for the current sources. Only the four stages that have
 * real service operations can pass; `state` and `visual` stay missing until
 * their checks exist, so they can never be reported passed by accident.
 */
export const deriveQualification = (input: {
  readonly record: QualificationRecord | null;
  readonly source: SourceSnapshot;
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
  for (const stage of RECORDED_QUALIFICATION_STAGES) {
    const recorded = input.record?.stages[stage];
    const read = (status: GameQualificationStageRead["status"]): GameQualificationStageRead => ({
      stage,
      status,
      sourceId: recorded?.sourceId ?? null,
      buildId: recorded?.buildId ?? null,
      finishedAt: recorded?.finishedAt ?? null,
    });
    if (recorded === undefined) stageReads.set(stage, read("missing"));
    else if (recorded.outcome === "failed") stageReads.set(stage, read("failed"));
    else if (recorded.sourceId === null) stageReads.set(stage, read("unknown"));
    else if (recorded.sourceId !== currentSourceId) stageReads.set(stage, read("stale"));
    else stageReads.set(stage, read("passed"));
  }
  for (const stage of ["state", "visual"] as const)
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
  const qualified = RECORDED_QUALIFICATION_STAGES.every(
    (stage) => stageReads.get(stage)!.status === "passed",
  );
  return {
    state: qualified ? "qualified" : "unqualified",
    sourceId: currentSourceId,
    buildId: exportRead.status === "passed" ? (exportRecord?.buildId ?? null) : null,
    stages,
  };
};

export interface QualificationRecordInput {
  readonly stage: RecordedQualificationStage;
  readonly outcome: "passed" | "failed";
  readonly sourceId: string | null;
  readonly buildId: string | null;
  readonly evidenceDirectory: string | null;
}

export class GameQualification extends Context.Service<
  GameQualification,
  {
    /**
     * Qualification of a game's current sources. IO or a scan-bound hit reads as
     * unknown, never as current.
     */
    readonly read: (root: string, godotProject: string) => Effect.Effect<GameQualificationRead>;
    /** Records one real operation result. Concurrent writers are serialized per game. */
    readonly record: (
      root: string,
      input: QualificationRecordInput,
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
      read: (root, godotProject) =>
        Effect.gen(function* () {
          const source = yield* Effect.promise(() =>
            snapshotSource(root, godotProject, {
              maxEntries: options.maxSourceEntries,
            }),
          );
          const record = yield* Effect.promise(() =>
            readRecord(recordPath(options.stateDir, root)),
          );
          return deriveQualification({ record, source });
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
                    },
                  },
                };
                const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
                await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
                try {
                  await NodeFSP.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
                  await NodeFSP.rename(temporary, file);
                } finally {
                  await NodeFSP.rm(temporary, { force: true });
                }
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
    }),
  );
};

/** Exposed for tests and diagnostics; the hash keeps game names off the state path. */
export const qualificationRecordPath = (stateDir: string, root: string) =>
  recordPath(stateDir, root);
