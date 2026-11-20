// @effect-diagnostics nodeBuiltinImport:off -- A ref name holds a hash of a thread id.
// An earlier Kurambit's tries ("try it N ways"), read once into the game's records so their
// versions stay listed as builds. A try is read from the chat's try run, its version child
// threads and the refs the game kept. Version k's thread id is derived from the try's run, so a read
// needs no list of children; the newest "kept" notice on the try's run names
// the kept version.
import {
  CommandId,
  type GameBuildId,
  type GameTryVersion,
  type OrchestrationV2Run,
  type RunId,
  ThreadId,
} from "@kurambit/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@kurambit/provider-core/server/IdAllocator";
import { checkpointRefForGameRun, gameRunRefsFolder } from "../checkpointing/Utils.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

/**
 * The refs a game keeps for its tries: `versions/<chat>/<ordinal>/base`, the chat's id in
 * base64url and the try's run ordinal, since a run's id is derived from those two and a full id
 * would pass a ref name's 255-byte limit.
 */
const VERSIONS_FOLDER = `${gameRunRefsFolder("game-builds")}versions/`;

const tryBaseRef = (threadId: ThreadId, ordinal: number) =>
  checkpointRefForGameRun(
    "game-builds",
    `versions/${Buffer.from(threadId, "utf8").toString("base64url")}/${ordinal}/base`,
  );

/**
 * A version whose turn ended with no checkpoint (a restart cancels it): its worktree as it was
 * left, captured before the worktree goes, so no version's work is lost.
 */
const versionLeftRef = (childThreadId: ThreadId) =>
  checkpointRefForGameRun(
    "game-builds",
    `versions/left/${NodeCrypto.createHash("sha256").update(childThreadId).digest("hex").slice(0, 32)}`,
  );

/** The chat and run of every try the refs name, from their base refs. */
export const triesInRefs = (refs: Iterable<string>) =>
  [...refs].flatMap((ref) => {
    if (!ref.startsWith(VERSIONS_FOLDER) || !ref.endsWith("/base")) return [];
    const [thread, ordinal] = ref.slice(VERSIONS_FOLDER.length).split("/");
    if (thread === undefined || ordinal === undefined || !/^\d+$/.test(ordinal)) return [];
    const threadId = ThreadId.make(Buffer.from(thread, "base64url").toString("utf8"));
    return [
      { threadId, runId: IdAllocator.derive.run({ threadId, ordinal: Number(ordinal) }) as string },
    ];
  });

/** `game-version.start`'s id: one per try, so a repeat after a restart is a receipt. */
const tryStartCommandId = (runId: string) => CommandId.make(`game-version:start:${runId}`);
const versionCommandId = (runId: string, n: number) =>
  CommandId.make(`${tryStartCommandId(runId)}:version:${n}`);
/** Version n's child thread, as the orchestrator derives it from its command. */
const versionThreadId = (runId: string, n: number) =>
  IdAllocator.derive.delegatedTaskThread({ commandId: versionCommandId(runId, n) });

const KEPT_IN_ID = /:signal:kept-(\d+)-/;

const MARKDOWN_LEAD = /^(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)+/;
const APPROACH_LINE = /^(?:\*\*)?approach:?(?:\*\*)?:?\s*/i;
/**
 * The version's own line on its approach: the reply's "Approach:" line, which it is asked to
 * start with, else its first line of prose, without markdown.
 */
const approachOf = (reply: string | null) => {
  const lines = (reply ?? "")
    .split("\n")
    .map((each) => each.trim().replace(MARKDOWN_LEAD, ""))
    .filter((each) => each !== "");
  const named = lines.find((each) => APPROACH_LINE.test(each));
  const line = (named ?? lines[0] ?? "").replace(APPROACH_LINE, "").replace(/^\*\*(.*)\*\*$/, "$1");
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

const firstLine = (text: string) => {
  const line =
    text
      .split("\n")
      .map((each) => each.trim())
      .find((each) => each !== "") ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

const versionState = (run: OrchestrationV2Run | undefined): GameTryVersion["state"] => {
  switch (run?.status) {
    case undefined:
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return "working";
    case "completed":
      return "ready";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
};

/**
 * One try, or null when the run is no try. `oids` maps the game's refs to
 * their commits: a version's build is its turn checkpoint's.
 */
export const readTry = (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  oids: ReadonlyMap<string, string>,
  threadId: ThreadId,
  runId: string,
) =>
  Effect.gen(function* () {
    const records = yield* projections.getThreadRecords(
      threadId,
      ["runs", "messages", "turnItems"],
      {
        runIds: [runId as RunId],
        messageRoles: ["user"],
        messageRunIds: [runId as RunId],
        turnItemRunIds: [runId as RunId],
        turnItemTypes: ["system_notice"],
      },
    );
    const run = records.runs.find((each) => each.id === runId);
    if (run === undefined || run.versions === undefined) return null;
    const request = records.messages.find((message) => message.id === run.userMessageId);
    const keeps = records.turnItems.flatMap((item) => {
      const n = KEPT_IN_ID.exec(item.id)?.[1];
      return n === undefined ? [] : [{ n: Number(n), at: DateTime.formatIso(item.startedAt!) }];
    });
    const kept = keeps.toSorted((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null;
    const versions = yield* Effect.forEach(
      Array.from({ length: run.versions }, (_, i) => i + 1),
      (n) =>
        Effect.gen(function* () {
          const childThreadId = versionThreadId(runId, n);
          const child = yield* projections
            .getThreadRecords(childThreadId, ["runs", "checkpoints", "messages"], {
              messageRoles: ["assistant"],
            })
            .pipe(Effect.option);
          if (child._tag === "None") return [];
          const childRun = child.value.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
          const checkpoint = child.value.checkpoints.find(
            (each) => each.id === childRun?.checkpointId && each.status === "ready",
          );
          const build =
            (checkpoint === undefined ? undefined : oids.get(checkpoint.ref)) ??
            oids.get(versionLeftRef(childThreadId));
          const reply = child.value.messages.findLast((each) => each.runId === childRun?.id);
          return [
            {
              n,
              childThreadId,
              state: versionState(childRun),
              build: (build ?? null) as GameBuildId | null,
              approach: approachOf(reply?.text ?? null),
              capturedAt:
                checkpoint === undefined ? null : DateTime.formatIso(checkpoint.capturedAt),
            },
          ];
        }),
      { concurrency: 4 },
    );
    const base = oids.get(tryBaseRef(threadId, run.ordinal)) ?? null;
    return {
      threadId,
      runId,
      request: firstLine(request?.text ?? ""),
      of: run.versions,
      at: DateTime.formatIso(run.requestedAt),
      base: base as GameBuildId | null,
      versions: versions.flat(),
      kept,
    };
  });

export type ReadTry = NonNullable<Effect.Success<ReturnType<typeof readTry>>>;
