// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the filesystem boundary for kept play-session saves.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { GameOperationError, type GameSaves } from "@kurambit/contracts";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import { isPathInside } from "./gameNativeUserDir.ts";
import { insideGame } from "./gamePath.ts";
import type { KeptStorage } from "./webPlaySession.ts";

/** Game-relative home of kept saves; run state, ignored and never merged. */
const KEPT_SAVES_DIR = ".studio/saves";

/**
 * A directory inside the game folder, created when missing, that resolves
 * inside the game even through links: an agent can replace any folder of the
 * game with a link (`.studio`, `builds/logs`), and a server write must never
 * follow it out. It is checked before anything is created, so not even an
 * empty directory is made outside the game, and again after, for a link
 * swapped in meanwhile. `.` is the game folder itself.
 */
export const ensureGameDir = async (root: string, relative: string): Promise<string> => {
  const dir = insideGame(root, relative, { root: "allowed" });
  await NodeFSP.mkdir(dir, { recursive: true });
  insideGame(root, relative, { root: "allowed" });
  return dir;
};

/**
 * The one stable save location a kept play session of this game and engine
 * uses, created when missing. It must resolve inside the game's own
 * `.studio/saves/` even through links, so a game whose tree points it at the
 * user's real saves (HOME, ~/.local/share/godot, ~/.config/unity3d) is
 * refused instead of written to.
 */
export const keptSavesDir = async (root: string, engine: string): Promise<string> => {
  if (!/^[a-z0-9-]+$/.test(engine)) throw new Error(`Unexpected engine id "${engine}".`);
  const dir = await ensureGameDir(root, NodePath.join(KEPT_SAVES_DIR, engine));
  // Inside the game is not enough: a saves folder linked elsewhere in it is refused too.
  const realDir = await NodeFSP.realpath(dir);
  if (!isPathInside(realDir, NodePath.join(await NodeFSP.realpath(root), KEPT_SAVES_DIR)))
    throw new Error(
      `The kept save location ${dir} resolves to ${realDir}, outside the game's ${KEPT_SAVES_DIR}/; kept saves are refused rather than written there.`,
    );
  // Ignored however old the game's own .gitignore is, so saves never reach a commit.
  await writeNoFollow(NodePath.join(root, KEPT_SAVES_DIR, ".gitignore"), "*\n");
  return dir;
};

/** Writes a file the server owns inside a checked game directory, replacing a link at its name. */
const writeNoFollow = async (file: string, text: string): Promise<void> => {
  await NodeFSP.rm(file, { force: true }).catch(() => undefined);
  await NodeFSP.writeFile(file, text, { flag: "wx" });
};

/** Appends one line, refusing a link at the file (O_NOFOLLOW where the OS has it). */
export const appendNoFollow = async (file: string, line: string): Promise<void> => {
  const handle = await NodeFSP.open(
    file,
    NodeFSP.constants.O_WRONLY |
      NodeFSP.constants.O_APPEND |
      NodeFSP.constants.O_CREAT |
      (NodeFSP.constants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    await handle.appendFile(line);
  } finally {
    await handle.close();
  }
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
