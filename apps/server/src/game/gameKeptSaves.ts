// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the filesystem boundary for kept play-session saves.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { GameOperationError, type GameSaves } from "@kurambit/contracts";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import { isPathInside } from "./gameNativeUserDir.ts";
import type { KeptStorage } from "./webPlaySession.ts";

/** Game-relative home of kept saves; run state, ignored and never merged. */
export const KEPT_SAVES_DIR = ".studio/saves";

/**
 * The one stable save location a kept play session of this game and engine
 * uses, created when missing. It must resolve inside the game's own
 * `.studio/saves/` even through links, so a game whose tree points it at the
 * user's real saves (HOME, ~/.local/share/godot, ~/.config/unity3d) is
 * refused instead of written to.
 */
export const keptSavesDir = async (root: string, engine: string): Promise<string> => {
  if (!/^[a-z0-9-]+$/.test(engine)) throw new Error(`Unexpected engine id "${engine}".`);
  const dir = NodePath.join(root, KEPT_SAVES_DIR, engine);
  const realRoot = await NodeFSP.realpath(root);
  const refuse = (real: string) =>
    new Error(
      `The kept save location ${dir} resolves to ${real}, outside the game's ${KEPT_SAVES_DIR}/; kept saves are refused rather than written there.`,
    );
  // The nearest existing ancestor is checked before anything is created, so a
  // linked `.studio` cannot get even an empty directory made outside the game.
  let existing = dir;
  while (
    !(await NodeFSP.lstat(existing).then(
      () => true,
      () => false,
    ))
  )
    existing = NodePath.dirname(existing);
  const realExisting = await NodeFSP.realpath(existing);
  if (!isPathInside(realExisting, realRoot)) throw refuse(realExisting);
  await NodeFSP.mkdir(dir, { recursive: true });
  const realDir = await NodeFSP.realpath(dir);
  if (!isPathInside(realDir, NodePath.join(realRoot, KEPT_SAVES_DIR))) throw refuse(realDir);
  // Ignored however old the game's own .gitignore is, so saves never reach a commit.
  await NodeFSP.writeFile(NodePath.join(root, KEPT_SAVES_DIR, ".gitignore"), "*\n");
  return dir;
};

/** Where a kept browser session's localStorage lives in its save location. */
export const keptWebStorage = (saves: string | null): string | null =>
  saves === null ? null : NodePath.join(saves, "localStorage.json");

/** The save location a play session's `saves` choice names: null for a fresh session. */
export const keptSavesFor = (input: {
  readonly root: string;
  readonly engine: string;
  readonly saves: GameSaves | undefined;
  readonly operation: string;
}): Effect.Effect<string | null, GameOperationError> =>
  input.saves !== "keep"
    ? Effect.succeed(null)
    : Effect.tryPromise({
        try: () => keptSavesDir(input.root, input.engine),
        catch: (cause) =>
          new GameOperationError({
            operation: input.operation,
            path: NodePath.join(input.root, KEPT_SAVES_DIR),
            reason: "invalid-path",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

/**
 * Writes a kept page's storage back into the game's saves, replacing a link
 * planted at its name rather than writing through it.
 */
export const writeKeptStorage = (kept: KeptStorage) =>
  writeFileStringAtomically({
    filePath: kept.path,
    contents: kept.contents,
    followLink: false,
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("A kept session's saves could not be written back.", { cause }),
    ),
  );
