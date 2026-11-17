// Many chats in one game. The game folder is the game: one chat's turn writes it at a time, and a
// turn that would be a second writer waits in its chat's queue (OrchestrationV2Run.queueHeldReason)
// unless the person runs it in a copy. A copy is a chat working in its own worktree, seated on a
// build of the game; its work comes into the game only through Bring in.
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";
import { GameBuildId } from "./gameBuildId.ts";

/** A file a bring-in or an update could not merge. */
export const GameCopyConflict = Schema.Struct({
  /** Game-relative. */
  path: Schema.String,
  /** Not mergeable by lines (art, sound, models): kept as the game's or the copy's, per file. */
  binary: Schema.Boolean,
  /** Tuned values both sides changed differently ("fish speed"), when the file is the tune file. */
  values: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type GameCopyConflict = typeof GameCopyConflict.Type;

/**
 * Where a copy's work stands. `ready`: work the game does not have yet; `same`: nothing the game
 * does not have; `conflicts`: the last bring-in or update could not merge these files, and the copy
 * holds them with both sides; `held`: its last bring-in did not land because the game would lose
 * health, with why (Bring in anyway lands it).
 */
export const GameCopyState = Schema.Union([
  Schema.TaggedStruct("working", {}),
  Schema.TaggedStruct("ready", {}),
  Schema.TaggedStruct("same", {}),
  Schema.TaggedStruct("conflicts", { files: Schema.Array(GameCopyConflict) }),
  Schema.TaggedStruct("held", { reason: Schema.String }),
]);
export type GameCopyState = typeof GameCopyState.Type;

/** A chat working in a copy of one of the game's builds. */
export const GameCopyPlace = Schema.TaggedStruct("copy", {
  /** The game's build the copy was seated on (moved by Update); null for an older copy. */
  seat: Schema.NullOr(GameBuildId),
  /** That build's number in the game, when it is one of the game's builds. */
  seatNumber: Schema.NullOr(PositiveInt),
  /** Builds the game landed since the seat: Update takes them into the copy. */
  ahead: NonNegativeInt,
  state: GameCopyState,
  /** Why it cannot come in at all (a copy from before seats were kept), else null. */
  noBringIn: Schema.NullOr(Schema.String),
});
export type GameCopyPlace = typeof GameCopyPlace.Type;

/** Where a chat works: in the game folder, or in a copy. */
export const GameChatPlace = Schema.Union([Schema.TaggedStruct("game", {}), GameCopyPlace]);
export type GameChatPlace = typeof GameChatPlace.Type;

/** A copy not in the game yet: what the game's "Not in the game yet" lists. */
export const GameCopy = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  place: GameCopyPlace,
});
export type GameCopy = typeof GameCopy.Type;

export const GameCopiesResult = Schema.Struct({
  /** The game's chats in a copy, newest seat first. */
  copies: Schema.Array(GameCopy),
  /** The asking chat's own place. */
  place: GameChatPlace,
});
export type GameCopiesResult = typeof GameCopiesResult.Type;

export const GameBringInInput = Schema.Struct({
  /** The asking chat: the copy itself, its parent, or any chat of the game. */
  threadId: ThreadId,
  /** The copy to bring in; the asking chat when omitted. */
  chat: Schema.optionalKey(ThreadId),
  /** The copy is done: it is removed and the chat works in the game again. */
  close: Schema.optionalKey(Schema.Boolean),
  /** Land although the game would lose health (a held bring-in). */
  anyway: Schema.optionalKey(Schema.Boolean),
  /** Per binary conflict, whose file comes in. */
  keep: Schema.optionalKey(Schema.Record(Schema.String, Schema.Literals(["game", "copy"]))),
  commandId: Schema.optionalKey(Schema.String),
});
export type GameBringInInput = typeof GameBringInInput.Type;

export const GameBringInResult = Schema.Union([
  /** The copy's work is a build of the game now. */
  Schema.TaggedStruct("landed", { build: GameBuildId, message: Schema.String }),
  /** Nothing to bring: the game already holds the copy's work. */
  Schema.TaggedStruct("same", { message: Schema.String }),
  /** Nothing landed; the copy now holds both sides of these files to resolve. */
  Schema.TaggedStruct("conflicts", {
    files: Schema.Array(GameCopyConflict),
    message: Schema.String,
  }),
  /** Nothing landed: the game would lose health. */
  Schema.TaggedStruct("held", { reason: Schema.String, message: Schema.String }),
]);
export type GameBringInResult = typeof GameBringInResult.Type;

export const GameCopyInput = Schema.Struct({
  threadId: ThreadId,
  commandId: Schema.optionalKey(Schema.String),
});

export const GameCopyUpdateResult = Schema.Struct({
  /** Files the copy now holds with both sides to resolve. */
  conflicts: Schema.Array(GameCopyConflict),
  message: Schema.String,
});
export type GameCopyUpdateResult = typeof GameCopyUpdateResult.Type;

export const GameBuildUndoInput = Schema.Struct({
  threadId: ThreadId,
  /** Any build of the game: its change is reversed, and later builds stay. */
  build: GameBuildId,
  commandId: Schema.optionalKey(Schema.String),
});

export const GameBuildUndoResult = Schema.Union([
  Schema.TaggedStruct("undone", { build: GameBuildId, message: Schema.String }),
  /** Later work changed the same lines: nothing moved. Go back to a build, or ask the agent. */
  Schema.TaggedStruct("conflicts", {
    files: Schema.Array(GameCopyConflict),
    message: Schema.String,
  }),
]);
export type GameBuildUndoResult = typeof GameBuildUndoResult.Type;
