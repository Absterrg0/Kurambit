// A try ("try it N ways") is no record of its own, as a build is none: it is
// read from the chat's try run, its version child threads and the refs the
// game keeps. Version k's thread id is derived from the try's run, so a read
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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@kurambit/provider-core/server/IdAllocator";
import { checkpointRefForGameRun, gameRunRefsFolder } from "../checkpointing/Utils.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

/** The refs a game keeps for its tries: `versions/<chat>/<run>/base`, each part hex (ids are not ref-safe). */
export const VERSIONS_FOLDER = `${gameRunRefsFolder("game-builds")}versions/`;
const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
const unhex = (text: string) => Buffer.from(text, "hex").toString("utf8");

export const tryBaseRef = (threadId: ThreadId, runId: RunId | string) =>
  checkpointRefForGameRun("game-builds", `versions/${hex(threadId)}/${hex(runId)}/base`);

/** The chat and run of every try the refs name, from their base refs. */
export const triesInRefs = (refs: Iterable<string>) =>
  [...refs].flatMap((ref) => {
    if (!ref.startsWith(VERSIONS_FOLDER) || !ref.endsWith("/base")) return [];
    const [thread, run] = ref.slice(VERSIONS_FOLDER.length).split("/");
    return thread === undefined || run === undefined
      ? []
      : [{ threadId: ThreadId.make(unhex(thread)), runId: unhex(run) }];
  });

/** `game-version.start`'s id: one per try, so a repeat after a restart is a receipt. */
export const tryStartCommandId = (runId: string) => CommandId.make(`game-version:start:${runId}`);
const versionCommandId = (runId: string, n: number) =>
  CommandId.make(`${tryStartCommandId(runId)}:version:${n}`);
/** Version n's child thread, as the orchestrator derives it from its command. */
export const versionThreadId = (runId: string, n: number) =>
  IdAllocator.derive.delegatedTaskThread({ commandId: versionCommandId(runId, n) });

/** The notice a keep appends: its id carries the version, newest wins. */
export const keptSignal = (n: number, commandId: string) => `kept-${n}-${commandId}`;
const KEPT_IN_ID = /:signal:kept-(\d+)-/;

const MARKDOWN_LEAD = /^(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)+/;
/** A reply's first line of prose, without its markdown: the version's own line on its approach. */
export const approachOf = (reply: string | null) => {
  const line =
    (reply ?? "")
      .split("\n")
      .map((each) =>
        each
          .trim()
          .replace(MARKDOWN_LEAD, "")
          .replace(/^\*\*(.*)\*\*$/, "$1")
          .replace(/^approach:\s*/i, ""),
      )
      .find((each) => each !== "") ?? "";
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
          const build = checkpoint === undefined ? undefined : oids.get(checkpoint.ref);
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
    const base = oids.get(tryBaseRef(threadId, runId)) ?? null;
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

const STATE_WORDS: Record<GameTryVersion["state"], string> = {
  working: "still working",
  ready: "finished",
  stopped: "stopped",
  failed: "failed",
};

/**
 * What the chat's agent hears about the person's tries since its own last
 * turn, beside their next message: it never ran a try, so without this it
 * would not know the folder now holds a version another session built. Null
 * when there is nothing new.
 */
export const triesNote = (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  threadId: ThreadId,
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: Pick<OrchestrationV2Run, "ordinal">,
) =>
  Effect.gen(function* () {
    const earlier = runs.filter((each) => each.ordinal < run.ordinal);
    const tries = earlier.filter(
      (each) => each.versions !== undefined && each.status === "completed",
    );
    if (tries.length === 0) return null;
    const own = earlier
      .filter((each) => each.versions === undefined && each.completedAt !== null)
      .toSorted((a, b) => b.ordinal - a.ordinal)[0];
    const since =
      own?.completedAt === null || own === undefined ? null : DateTime.formatIso(own.completedAt);
    const read = yield* Effect.forEach(
      tries,
      (each) =>
        readTry(projections, new Map(), threadId, each.id).pipe(Effect.orElseSucceed(() => null)),
      { concurrency: 4 },
    );
    const news = read.flatMap((each, index) => {
      if (each === null) return [];
      const newTry = own === undefined || tries[index]!.ordinal > own.ordinal;
      const newKeep = each.kept !== null && (since === null || each.kept.at > since);
      return newTry || newKeep ? [each] : [];
    });
    if (news.length === 0) return null;
    return news
      .map((each) =>
        [
          `The person asked for "${each.request}" ${each.of} ways at once; each version was built by a session of its own in a copy of the game, not by you:`,
          ...each.versions.map(
            (version) =>
              `- Version ${version.n} (${STATE_WORDS[version.state]}): ${version.approach === "" ? "no approach given" : version.approach}`,
          ),
          each.kept === null
            ? "They have kept none yet, so the game folder is as it was before the try."
            : `They kept version ${each.kept.n}: the game folder now holds it. Continue from there.`,
        ].join("\n"),
      )
      .join("\n\n");
  });
