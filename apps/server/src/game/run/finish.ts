// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off -- Export bookkeeping in the game folder: verified on-disk paths plus the final video copy.
// Exports and the final video on any ending. Every outcome lands in the log and in
// .studio/exports.json with verified on-disk paths (T27b reported the web build missing
// because nothing recorded where the content-addressed export actually landed).
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type { ThreadId } from "@kurambit/contracts";
import type * as GameService from "../GameService.ts";

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
  for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = NodePath.join(dir, entry.name);
    total += entry.isDirectory()
      ? await dirBytes(full)
      : ((await NodeFSP.stat(full).catch(() => null))?.size ?? 0);
  }
  return total;
};

type BotRow = { runId: string; seconds: number; won: boolean; video: string; findings: number };

const botRows = async (root: string): Promise<BotRow[]> => {
  const text = await NodeFSP.readFile(
    NodePath.join(root, ".studio", "bot-results.jsonl"),
    "utf8",
  ).catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (typeof row.runId !== "string" || typeof row.video !== "string") return [];
        return [
          {
            runId: row.runId,
            video: row.video,
            seconds: typeof row.seconds === "number" ? row.seconds : Number.POSITIVE_INFINITY,
            won: row.won === true,
            findings: typeof row.findings === "number" ? row.findings : 999,
          },
        ];
      } catch {
        return [];
      }
    });
};

export const finishExports = Effect.fn("GameRun.finishExports")(function* (
  root: string,
  creatorThreadId: ThreadId,
  game: GameService.GameService["Service"],
  log: (line: string) => Effect.Effect<void>,
  owner: string,
) {
  // Ask only targets the backend declares; anything else is recorded skipped.
  const targets = yield* game
    .exportTargets(creatorThreadId, owner)
    .pipe(
      Effect.orElseSucceed(() => ({ targets: ["Web", "Linux"] as const, displayName: "Game" })),
    );
  const runTarget = (target: "Web" | "Linux"): Effect.Effect<Row> =>
    targets.targets.includes(target)
      ? game.export(creatorThreadId, target, owner).pipe(
          Effect.map((r): Row => ({
            ok: r.success,
            skipped: null,
            message: r.message,
            path: r.path,
          })),
          Effect.orElseSucceed((): Row => ({
            ok: false,
            skipped: null,
            message: `${target} export errored`,
            path: null,
          })),
        )
      : Effect.succeed({
          ok: false,
          skipped: "unsupported-target",
          message: `${targets.displayName} games export ${targets.targets.join(", ")} only; ${target} skipped`,
          path: null,
        });
  const web = yield* runTarget("Web");
  const linux = yield* runTarget("Linux");
  const verified = yield* Effect.promise(async () => {
    const selected = await NodeFSP.readFile(NodePath.join(root, "builds/web-selected.json"), "utf8")
      .then((text) => (JSON.parse(text) as { directory?: unknown }).directory)
      .catch(() => undefined);
    const webIndex =
      typeof selected === "string" ? NodePath.join(root, selected, "index.html") : null;
    const webOk =
      web.ok &&
      webIndex !== null &&
      (await fileOver(webIndex, 0)) &&
      ((await fileOver(webIndex, 4096)) || (await dirBytes(NodePath.dirname(webIndex))) > 4096);
    const linuxBin = NodePath.join(root, "builds/linux/game.x86_64");
    return { webIndex, webOk, linuxBin, linuxOk: linux.ok && (await fileOver(linuxBin, 4096)) };
  });
  yield* log(
    `finishExports web ok=${verified.webOk} index=${verified.webIndex ?? "none"} msg=${web.message.slice(0, 200)}`,
  );
  yield* log(
    `finishExports linux ok=${verified.linuxOk} bin=${verified.linuxBin} msg=${linux.message.slice(0, 200)}`,
  );
  // Best real run: fastest win first; otherwise the longest run with a real
  // video (a short clean run can be a bot stuck at the menu).
  yield* Effect.promise(async () => {
    await NodeFSP.writeFile(
      NodePath.join(root, ".studio", "exports.json"),
      `${JSON.stringify({ at: new Date().toISOString(), web: { ...web, index: verified.webIndex, verified: verified.webOk }, linux: { ...linux, bin: verified.linuxBin, verified: verified.linuxOk } }, null, 2)}\n`,
    ).catch(() => undefined);
    const rows = await botRows(root);
    const ordered = [
      ...rows.filter((r) => r.won).sort((a, b) => a.seconds - b.seconds),
      ...rows
        .filter((r) => !r.won)
        .sort((a, b) => b.seconds - a.seconds || a.findings - b.findings),
    ];
    for (const row of ordered) {
      if (!(await fileOver(row.video, 4096))) continue;
      const reason = row.won
        ? `fastest winning bot run (${row.seconds.toFixed(1)}s)`
        : `longest non-winning bot run (${row.seconds.toFixed(1)}s, ${row.findings} findings; no win recorded)`;
      await NodeFSP.copyFile(row.video, NodePath.join(root, ".studio", "final.mp4")).catch(
        () => undefined,
      );
      await NodeFSP.writeFile(
        NodePath.join(root, ".studio", "final-video.json"),
        `${JSON.stringify({ runId: row.runId, video: row.video, reason, at: new Date().toISOString() }, null, 2)}\n`,
      ).catch(() => undefined);
      return `final video from run ${row.runId} (${reason})`;
    }
    return "no bot run video for the final video";
  }).pipe(Effect.flatMap((line) => log(`finishExports: ${line}`)));
});
