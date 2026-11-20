import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, PositiveInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { GameBuildFile, GameBuildId, GameBuildSource } from "./gameBuilds.ts";
import { GameKeepValuesInput } from "./gameStageBridge.ts";

/**
 * A game's builds as records of the event store: every build that lands in a game folder is a
 * `game-build.recorded` event, every restore (an Undo, a Go back, a landing) a
 * `game-build.restored`, every value kept while a turn worked a `game-build.kept`. The projection
 * holds what each read needs (the number, the name's parts, the base it undoes to, the folder's
 * current build), so nothing is read back out of ref names or files. A build's commit stays
 * reachable under a ref named by its id alone; the ref holds the tree and means nothing else.
 */

export const GameBuildKind = Schema.Literals([
  /** A chat turn's checkpoint that changed the game, a keep-going step's among them. */
  "turn",
  /** Values kept from the Stage. */
  "values",
  /** A Library add. */
  "library",
  /** A copy's work brought in. */
  "bring-in",
  /** One earlier build's change reversed. */
  "undo",
  /** What the folder held when a restore replaced it. */
  "restore-before",
  /** A version of an earlier Kurambit's "try it N ways"; read from old games, never made now. */
  "version",
  /** Where an earlier Kurambit's keep going wrote its play bot; shown as the build it was written on. */
  "setup",
]);
export type GameBuildKind = typeof GameBuildKind.Type;

/** Kinds in the game's one numbered sequence, the way a person counts what lands. */
export const isNumberedGameBuildKind = (kind: GameBuildKind) =>
  kind === "turn" ||
  kind === "values" ||
  kind === "library" ||
  kind === "bring-in" ||
  kind === "undo";

export const GameBuildRecord = Schema.Struct({
  id: GameBuildId,
  projectId: ProjectId,
  /** The folder it was made in: the game's own, or a copy's. */
  root: Schema.String,
  /** When it came into its folder. */
  at: IsoDateTime,
  kind: GameBuildKind,
  /** Its place in its folder's numbered sequence, oldest 1; null for a kind outside it. */
  number: Schema.NullOr(PositiveInt),
  /** A legacy fix of the build before it: keeps that build's number. */
  fix: Schema.optionalKey(PositiveInt),
  /** Its place among the game's restore parks, oldest 1. */
  nth: Schema.optionalKey(PositiveInt),
  /** The build restoring undoes it to (its parent); null when none is known. */
  base: Schema.NullOr(GameBuildId),
  /** An undo's: the build whose change it reversed. A setup's: the build it was written on. */
  undid: Schema.optionalKey(GameBuildId),
  /** What made it, as the rail shows it; a turn's step mark is read live, never stored. */
  source: GameBuildSource,
  summary: Schema.String,
  files: Schema.Array(GameBuildFile),
  fileCount: Schema.NullOr(Schema.Number),
});
export type GameBuildRecord = typeof GameBuildRecord.Type;

export const GameBuildRestoreOutcome = Schema.Struct({
  restored: Schema.Boolean,
  message: Schema.String,
  moved: Schema.Literals(["restored", "current", "moved-on", "refused"]),
});
export type GameBuildRestoreOutcome = typeof GameBuildRestoreOutcome.Type;

/** A game folder's latest restore: written before the folder moves, settled by the move. */
export const GameBuildRestore = Schema.Struct({
  requestId: Schema.String,
  target: GameBuildId,
  label: Schema.String,
  requestedAt: IsoDateTime,
  /** The build that undoes it: the park, or the build the folder already was. */
  before: Schema.NullOr(GameBuildId),
  /** Restore only while the folder holds this build (keep going's undo, a landing). */
  expect: Schema.optionalKey(GameBuildId),
  /** The chat that asked, whose next turn counts from the restored build. */
  thread: Schema.optionalKey(ThreadId),
  /** The build the folder held as the restore was asked for, when the asker read it. */
  holding: Schema.optionalKey(GameBuildId),
  outcome: Schema.NullOr(GameBuildRestoreOutcome),
});
export type GameBuildRestore = typeof GameBuildRestore.Type;

/** Values kept while a turn worked in their folder: they land as a build when it ends. */
export const GameBuildHeldKeep = Schema.Struct({
  request: Schema.String,
  input: GameKeepValuesInput,
  at: IsoDateTime,
});
export type GameBuildHeldKeep = typeof GameBuildHeldKeep.Type;

/** One game folder's state: the build it holds, its latest restore and the keeps it holds. */
export const GameBuildFolder = Schema.Struct({
  projectId: ProjectId,
  root: Schema.String,
  current: Schema.NullOr(GameBuildId),
  restore: Schema.NullOr(GameBuildRestore),
  held: Schema.Array(GameBuildHeldKeep),
  /** The legacy refs and files were read into records (once). */
  migrated: Schema.Boolean,
});
export type GameBuildFolder = typeof GameBuildFolder.Type;

const FolderFields = { projectId: ProjectId, root: Schema.String };

export const GAME_BUILD_EVENT_TYPES = [
  "game-build.recorded",
  "game-build.restored",
  "game-build.kept",
  "game-build.migrated",
  "game-build.dropped",
] as const;

/** The events' payloads; the stored and live shapes are one (no DateTime fields). */
export const GameBuildEventPayloads = {
  /** A build landed in a folder; with `current`, the folder now holds it. */
  recorded: Schema.Struct({ build: GameBuildRecord, current: Schema.Boolean }),
  /** A restore was asked for (outcome null) or settled; a settled restore names the folder's build. */
  restored: Schema.Struct({
    ...FolderFields,
    restore: GameBuildRestore,
    current: Schema.NullOr(GameBuildId),
  }),
  /** A held keep was taken (`keep`) or let go (`drop`). */
  kept: Schema.Struct({
    ...FolderFields,
    keep: Schema.NullOr(GameBuildHeldKeep),
    drop: Schema.NullOr(Schema.String),
  }),
  /** Builds a tuning session folded away or put back: no longer the game's. */
  dropped: Schema.Struct({
    ...FolderFields,
    ids: Schema.Array(GameBuildId),
    /** The build the folder holds again; null leaves it as it was. */
    current: Schema.NullOr(GameBuildId),
  }),
  /** The folder's legacy builds were read in; `current` and `restore` as they read. */
  migrated: Schema.Struct({
    ...FolderFields,
    current: Schema.NullOr(GameBuildId),
    restore: Schema.NullOr(GameBuildRestore),
  }),
} as const;

const GameBuildCommandFields = { commandId: CommandId, threadId: ThreadId };

/**
 * Commands of a game's builds. Only the game layer sends them (GameBuilds); the decider numbers
 * a build and names its park from the projection, so two builds never share a number.
 */
export const OrchestrationV2GameBuildCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("game-build.record"),
    ...GameBuildCommandFields,
    /** Its number and nth are the decider's: what the command carries is ignored. */
    build: GameBuildRecord,
    current: Schema.Boolean,
    /** A copy's first build numbers on from its seat's number. */
    numberFrom: Schema.optionalKey(Schema.Number),
    /** The tuning build this one folds: it takes that build's number, and that build goes. */
    replaces: Schema.optionalKey(GameBuildId),
  }),
  Schema.Struct({
    type: Schema.Literal("game-build.drop"),
    ...GameBuildCommandFields,
    ...FolderFields,
    ids: Schema.Array(GameBuildId),
    /** The build the folder holds again. */
    current: Schema.NullOr(GameBuildId),
  }),
  /** A restore asked for: the record commits, and the folder's move is its outbox effect. */
  Schema.Struct({
    type: Schema.Literal("game-build.restore"),
    ...GameBuildCommandFields,
    ...FolderFields,
    restore: GameBuildRestore,
  }),
  /** The move's answer, from the effect that made it. */
  Schema.Struct({
    type: Schema.Literal("game-build.restore.settle"),
    ...GameBuildCommandFields,
    ...FolderFields,
    /** The restore as it settled: its `before` and `outcome` set. */
    restore: GameBuildRestore,
    /** The park, when the folder held something no build had: recorded with the settle. */
    park: Schema.NullOr(Schema.Struct({ id: GameBuildId, at: IsoDateTime })),
  }),
  Schema.Struct({
    type: Schema.Literal("game-build.keep"),
    ...GameBuildCommandFields,
    ...FolderFields,
    keep: Schema.NullOr(GameBuildHeldKeep),
    drop: Schema.NullOr(Schema.String),
  }),
  /** The legacy builds of one folder read in, oldest first, numbered as the old reader numbered them. */
  Schema.Struct({
    type: Schema.Literal("game-build.migrate"),
    ...GameBuildCommandFields,
    ...FolderFields,
    builds: Schema.Array(GameBuildRecord),
    current: Schema.NullOr(GameBuildId),
    restore: Schema.NullOr(GameBuildRestore),
    held: Schema.Array(GameBuildHeldKeep),
  }),
]);
export type OrchestrationV2GameBuildCommand = typeof OrchestrationV2GameBuildCommand.Type;

/** The name a build goes by in every surface: "Build 5", "Build 6 · tuned", "The game before restore 2". */
export const gameBuildName = (
  build: Pick<GameBuildRecord, "id" | "kind" | "number" | "fix" | "nth" | "source">,
  step: boolean,
): string => {
  const numbered = `Build ${build.number ?? build.id.slice(0, 8)}`;
  switch (build.kind) {
    case "turn":
      return step
        ? `${numbered} · Keep going`
        : `${numbered}${build.fix === undefined ? "" : ` · fix ${build.fix}`}`;
    case "values":
      return `${numbered} · tuned`;
    case "library":
      return `${numbered} · added`;
    case "bring-in":
      return `${numbered} · brought in`;
    case "undo":
      return `${numbered} · undo`;
    case "version":
      return build.source._tag === "version"
        ? `Version ${build.source.n} of ${build.source.of}${build.source.kept ? " · kept" : ""}`
        : numbered;
    case "restore-before":
    case "setup": {
      const label = build.source._tag === "saved" ? build.source.label : numbered;
      return build.nth === undefined ? label : `${label} ${build.nth}`;
    }
  }
};
