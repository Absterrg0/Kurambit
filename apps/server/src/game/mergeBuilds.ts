// A merge of two of a game's builds from an explicit base: git's own merge (merge-tree), then the
// game's own files settled the way git cannot: the tune file per value, and a binary file kept
// whole from the side the person chose. Every other conflict is left to the person or the agent,
// with markers in text files. The base is always the caller's record (a copy's seat, a build's
// recorded base), never inferred: a merge from the wrong base drops work without a conflict.
import type { GameCopyConflict } from "@kurambit/contracts";
import * as Effect from "effect/Effect";

import type * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { mergeTuneFiles } from "./gameTune.ts";

export interface MergeBuildsInput {
  readonly root: string;
  /** The engine's tune file, game-relative ("web/tune.json"); null when the engine has none. */
  readonly tuneFile: string | null;
  /**
   * Files whose lines both sides add are all kept (git's union merge): ASSETS.md and the
   * credits file, which two chats adding from the Library both write.
   */
  readonly union: ReadonlyArray<string>;
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
  /** Which side is the game's, for a binary file kept as the game's or the copy's. */
  readonly game: "ours" | "theirs";
  /** Per binary conflict, whose file to take. */
  readonly keep?: Readonly<Record<string, "game" | "copy">>;
  /** The paths whose conflicts matter (a build's files); others are left as merged. */
  readonly within: (path: string) => boolean;
}

export const mergeBuilds = (
  checkpoints: CheckpointStore.CheckpointStore["Service"],
  input: MergeBuildsInput,
) =>
  Effect.gen(function* () {
    const merged = yield* checkpoints.mergeCheckpoints({
      cwd: input.root,
      base: input.base,
      ours: input.ours,
      theirs: input.theirs,
      unionPaths: input.union,
    });
    const conflicts: Array<GameCopyConflict> = [];
    const edits: Array<Parameters<typeof checkpoints.editTree>[0]["edits"][number]> = [];
    for (const conflict of merged.conflicts) {
      if (!input.within(conflict.path)) continue;
      if (conflict.path === input.tuneFile) {
        const at = (revision: string) =>
          checkpoints.readFileAt({ cwd: input.root, revision, path: conflict.path });
        const tune = mergeTuneFiles(
          yield* at(input.base),
          yield* at(input.ours),
          yield* at(input.theirs),
        );
        if (tune !== null && tune.conflicts.length === 0) {
          edits.push({ path: conflict.path, content: tune.text });
          continue;
        }
        conflicts.push({
          path: conflict.path,
          binary: false,
          ...(tune === null ? {} : { values: tune.conflicts }),
        });
        continue;
      }
      const choice = input.keep?.[conflict.path];
      if (conflict.binary && choice !== undefined) {
        const side =
          (choice === "game") === (input.game === "ours") ? conflict.ours : conflict.theirs;
        edits.push({ path: conflict.path, content: side });
        continue;
      }
      conflicts.push({ path: conflict.path, binary: conflict.binary });
    }
    const tree =
      edits.length === 0
        ? merged.tree
        : yield* checkpoints.editTree({ cwd: input.root, tree: merged.tree, edits });
    return { tree, conflicts };
  });
