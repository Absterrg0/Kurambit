// @effect-diagnostics nodeBuiltinImport:off -- Writes ASSETS.md in the game folder.
// ASSETS.md lines for files the game tools make (a Blender export, drawn pictures).
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { GameOperationError } from "@kurambit/contracts";

const io = (path: string) => (cause: unknown) =>
  new GameOperationError({ operation: "game-provenance", path, reason: "io", cause });

/** Writes a file, refusing to follow a symbolic link planted at its name. */
export const writeOwn = (path: string, bytes: Buffer) =>
  NodeFSP.writeFile(path, bytes, {
    flag:
      NodeFSP.constants.O_WRONLY |
      NodeFSP.constants.O_CREAT |
      NodeFSP.constants.O_TRUNC |
      (NodeFSP.constants.O_NOFOLLOW ?? 0),
  });

/** Where the agent's own words start on a provenance line; a re-render keeps what follows. */
const FILL_MARKERS = ["Depicts / loaded by: ", "Depicts: ", "Loaded by: "];
const suffixOf = (line: string) => {
  for (const marker of FILL_MARKERS) {
    const at = line.lastIndexOf(marker);
    if (at >= 0) return { at, marker, rest: line.slice(at + marker.length) };
  }
  return null;
};

/** One provenance line per file, replaced in place when the same file is made again, keeping what the agent filled in. */
export const recordProvenance = (
  realRoot: string,
  lines: ReadonlyArray<{ first: string; line: string }>,
  tool: string,
) =>
  Effect.gen(function* () {
    const path = NodePath.join(realRoot, "ASSETS.md");
    const stat = yield* Effect.promise(() => NodeFSP.lstat(path).catch(() => null));
    if (stat !== null && !stat.isFile())
      return `ASSETS.md is ${stat.isSymbolicLink() ? "a symbolic link" : "not a file"}; provenance was not written.`;
    const current =
      stat === null
        ? "# ASSETS\n"
        : yield* Effect.tryPromise({
            try: () => NodeFSP.readFile(path, "utf8"),
            catch: io("ASSETS.md"),
          });
    const kept = current.split("\n");
    while (kept.length > 0 && kept.at(-1) === "") kept.pop();
    const added: string[] = [];
    for (const { first, line } of lines) {
      const at = kept.findIndex(
        (l) => l.includes(tool) && (l.includes(`\`${first}\``) || l.includes(`\`${first} `)),
      );
      if (at < 0) {
        added.push(line);
        continue;
      }
      const old = suffixOf(kept[at]!);
      const fresh = suffixOf(line);
      kept[at] =
        old === null || fresh === null || old.rest === "(fill in)."
          ? line
          : `${line.slice(0, fresh.at + fresh.marker.length)}${old.rest}`;
    }
    const next = `${[...kept, ...added].join("\n")}\n`;
    yield* Effect.tryPromise({
      try: () => writeOwn(path, Buffer.from(next)),
      catch: io("ASSETS.md"),
    });
    return stat === null
      ? "ASSETS.md created with the provenance."
      : "ASSETS.md records the provenance.";
  });
