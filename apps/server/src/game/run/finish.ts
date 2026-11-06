// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off -- Export bookkeeping in the game folder: verified on-disk paths plus the final video copy.
// Exports and the final video on any ending. Every outcome lands in the log and in
// .studio/exports.json with the artifact each export published and whether it is
// still there.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type { ThreadId } from "@kurambit/contracts";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import type * as BotEvidence from "../botEvidence.ts";
import type * as GameService from "../GameService.ts";
import { walkFiles } from "../walkFiles.ts";
import { botVideoFile } from "./roundDetail.ts";

type Row = {
  ok: boolean;
  skipped: null | "unsupported-target";
  message: string;
  path: string | null;
};

const fileOver = (path: string, bytes: number) =>
  NodeFSP.stat(path)
    .then((stat) => stat.isFile() && stat.size > bytes)
    .catch(() => false);

// A static three.js entry is a few hundred bytes of HTML; what proves the
// build is real is the whole directory's substance.
const dirBytes = async (dir: string): Promise<number> => {
  let total = 0;
  for (const full of await walkFiles(dir))
    total += (await NodeFSP.stat(full).catch(() => null))?.size ?? 0;
  return total;
};

/**
 * The run's bot runs in the game folder, from the bot service's records of
 * its role threads: the folder's .studio/bot-results.jsonl is a role agent's
 * to write, so it never picks the video. A role in a folder of its own played
 * another game, and gives none.
 */
const botRuns = (root: string, records: ReadonlyArray<BotEvidence.ThreadBots>) =>
  records.flatMap((record) => (record.root === root ? record.runs : []));

export const finishExports = Effect.fn("GameRun.finishExports")(function* (
  root: string,
  creatorThreadId: ThreadId,
  game: GameService.GameService["Service"],
  log: (line: string) => Effect.Effect<void>,
  owner: string,
  /** The finish's one deadline for waiting out another owner's operation. */
  waitUntil: number,
  /** The run's role threads, whose recorded bot runs the final video is chosen from. */
  roleThreads: ReadonlyArray<ThreadId>,
) {
  // Ask only targets the backend declares; anything else is recorded skipped.
  const targets = yield* game
    .exportTargets(creatorThreadId, owner, waitUntil)
    .pipe(
      Effect.orElseSucceed(() => ({ targets: ["Web", "Linux"] as const, displayName: "Game" })),
    );
  const runTarget = (target: "Web" | "Linux"): Effect.Effect<Row> =>
    targets.targets.includes(target)
      ? // Another owner's operation is waited out, and a failure says why in the log and exports.json.
        game.export(creatorThreadId, target, owner, waitUntil).pipe(
          Effect.map((r): Row => ({
            ok: r.success,
            skipped: null,
            message: r.message,
            path: r.path,
          })),
          Effect.catch((error) =>
            Effect.succeed<Row>({
              ok: false,
              skipped: null,
              message:
                `${target} export failed: ${error.reason === "busy" ? "the game stayed busy with another operation" : error.reason}: ${error.detail ?? ""}`.slice(
                  0,
                  400,
                ),
              path: null,
            }),
          ),
        )
      : Effect.succeed({
          ok: false,
          skipped: "unsupported-target",
          message: `${targets.displayName} games export ${targets.targets.join(", ")} only; ${target} skipped`,
          path: null,
        });
  const web = yield* runTarget("Web");
  const linux = yield* runTarget("Linux");
  // An export's own result names the artifact it published (GameExport: an
  // absolute path that existed at publication); the finish checks it is still
  // there and has substance, and derives no engine's file names itself.
  const verify = (row: Row) =>
    Effect.promise(async () => {
      if (!row.ok || row.path === null) return false;
      const stat = await NodeFSP.stat(row.path).catch(() => null);
      if (stat === null) return false;
      // A static web entry is a few hundred bytes of HTML; its folder proves the build.
      return stat.isDirectory() ? (await dirBytes(row.path)) > 4096 : stat.size > 4096;
    });
  const webOk = yield* verify(web);
  const linuxOk = yield* verify(linux);
  yield* log(
    `finishExports web ok=${webOk} path=${web.path ?? "none"} msg=${web.message.slice(0, 200)}`,
  );
  yield* log(
    `finishExports linux ok=${linuxOk} path=${linux.path ?? "none"} msg=${linux.message.slice(0, 200)}`,
  );
  // A record that cannot be read leaves its runs out; the video is a nicety.
  const records = yield* Effect.forEach(roleThreads, (threadId) =>
    game.botRuns(threadId).pipe(
      Effect.map((record) => [record]),
      Effect.catch((error) =>
        log(
          `finishExports: the bot runs of ${threadId} could not be read (${error.detail ?? error.reason})`,
        ).pipe(Effect.as([])),
      ),
    ),
  ).pipe(Effect.map((each) => each.flat()));
  // Best real run: fastest win first; otherwise the longest run with a real
  // video (a short clean run can be a bot stuck at the menu).
  // A record for people, whole or not at all.
  yield* writeFileStringAtomically({
    filePath: NodePath.join(root, ".studio", "exports.json"),
    contents: `${JSON.stringify({ at: new Date().toISOString(), web: { ...web, verified: webOk }, linux: { ...linux, verified: linuxOk } }, null, 2)}\n`,
  }).pipe(
    Effect.catchCause((cause) =>
      log(`finishExports: exports.json not written (${String(cause)})`.slice(0, 300)),
    ),
  );
  const chosen = yield* Effect.tryPromise(async () => {
    const rows = botRuns(root, records);
    const ordered = [
      ...rows.filter((r) => r.won).sort((a, b) => a.seconds - b.seconds),
      ...rows
        .filter((r) => !r.won)
        .sort((a, b) => b.seconds - a.seconds || a.findings - b.findings),
    ];
    for (const row of ordered) {
      const video = await botVideoFile(root, row.runId);
      if (video === null || !(await fileOver(video, 4096))) continue;
      const reason = row.won
        ? `fastest winning bot run (${row.seconds.toFixed(1)}s)`
        : `longest non-winning bot run (${row.seconds.toFixed(1)}s, ${row.findings} findings; no win recorded)`;
      await NodeFSP.copyFile(video, NodePath.join(root, ".studio", "final.mp4"));
      return { runId: row.runId, video, reason };
    }
    return null;
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (chosen === undefined) return yield* log("finishExports: the final video could not be chosen");
  if (chosen === null) return yield* log("finishExports: no bot run video for the final video");
  yield* writeFileStringAtomically({
    filePath: NodePath.join(root, ".studio", "final-video.json"),
    contents: `${JSON.stringify({ ...chosen, at: new Date().toISOString() }, null, 2)}\n`,
  }).pipe(Effect.orElseSucceed(() => undefined));
  yield* log(`finishExports: final video from run ${chosen.runId} (${chosen.reason})`);
});
