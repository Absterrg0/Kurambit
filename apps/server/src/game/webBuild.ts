// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the game build directory on the native filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { GameOperationError } from "@t3tools/contracts";

export const webBuildIndex = (root: string) => NodePath.join(root, "builds/web/index.html");

/**
 * A walked entry budget, not a game-size limit: the check runs on the status
 * request path, so a tree far larger than a Godot game stays cheap. A build is
 * reported fresh when nothing newer is found inside the budget.
 */
const MAX_WALK_ENTRIES = 4_000;

/**
 * Whether `builds/web` is older than the newest game file under the Godot
 * project. Godot's own scratch (`.godot/`) is excluded because exporting
 * rewrites it, and a missing index.html counts as stale (never built).
 */
export const isWebBuildStale = (
  root: string,
  godotProject: string,
): Effect.Effect<boolean, GameOperationError> =>
  Effect.tryPromise({
    try: async () => {
      const index = webBuildIndex(root);
      const built = await NodeFSP.stat(index)
        .then((stat) => (stat.isFile() ? stat.mtimeMs : null))
        .catch(() => null);
      if (built === null) return true;
      const stack = [NodePath.join(root, godotProject)];
      let visited = 0;
      while (stack.length > 0 && visited < MAX_WALK_ENTRIES) {
        const directory = stack.pop()!;
        for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
          if (visited >= MAX_WALK_ENTRIES) break;
          visited += 1;
          const path = NodePath.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== ".godot") stack.push(path);
          } else if ((await NodeFSP.stat(path)).mtimeMs > built) return true;
        }
      }
      return false;
    },
    catch: (cause) =>
      new GameOperationError({ operation: "web-build-state", path: root, reason: "io", cause }),
  });
