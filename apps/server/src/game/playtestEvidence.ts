// @effect-diagnostics nodeBuiltinImport:off -- Playtest evidence is files under the game's builds/ directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  GameConsoleMessage,
  type GameLastPlaytest,
  type GamePlaytestStep,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";

const PLAYTEST_DIRECTORY = "builds/playtests";
const DIRECTORY_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/;
const KEEP_RUNS = 5;

const StoredFrame = Schema.Struct({
  label: Schema.String,
  file: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});
const StoredPlaytest = Schema.fromJsonString(
  Schema.Struct({
    at: Schema.String,
    success: Schema.Boolean,
    booted: Schema.Boolean,
    bootMs: Schema.NullOr(Schema.Number),
    responded: Schema.Boolean,
    changedPercent: Schema.Number,
    message: Schema.String,
    steps: Schema.Array(Schema.Unknown),
    consoleMessages: Schema.Array(GameConsoleMessage),
    frames: Schema.Array(StoredFrame),
  }),
);
export type StoredPlaytest = typeof StoredPlaytest.Type;
const decodeStoredPlaytest = Schema.decodeUnknownSync(StoredPlaytest);

const slug = (label: string) => {
  const cleaned = label.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "frame").slice(0, 40);
};

const timestampName = (at: Date) => at.toISOString().replace(/[:.]/g, "-");

const uniqueDirectory = async (root: string, base: string) => {
  const parent = NodePath.join(root, PLAYTEST_DIRECTORY);
  let name = base;
  for (let suffix = 2; ; suffix++) {
    try {
      await NodeFSP.access(NodePath.join(parent, name));
      name = `${base}-${suffix}`;
    } catch {
      return name;
    }
  }
};

/** Writes frames and a result.json, then keeps only the newest five runs. */
export const writePlaytestEvidence = async (input: {
  readonly root: string;
  readonly steps: readonly GamePlaytestStep[];
  readonly result: GameWebPlaytestResult;
  readonly at?: Date;
}): Promise<{ readonly directory: string }> => {
  const at = input.at ?? new Date();
  const name = await uniqueDirectory(input.root, timestampName(at));
  const relativeDirectory = `${PLAYTEST_DIRECTORY}/${name}`;
  const directory = NodePath.join(input.root, relativeDirectory);
  await NodeFSP.mkdir(directory, { recursive: true });
  const frames: { label: string; file: string; width: number; height: number }[] = [];
  for (const [index, shot] of input.result.screenshots.entries()) {
    const file = `${String(index + 1).padStart(2, "0")}-${slug(shot.label)}.png`;
    await NodeFSP.writeFile(NodePath.join(directory, file), Buffer.from(shot.data, "base64"));
    frames.push({ label: shot.label, file, width: shot.width, height: shot.height });
  }
  const stored: StoredPlaytest = {
    at: at.toISOString(),
    success: input.result.success,
    booted: input.result.booted,
    bootMs: input.result.bootMs,
    responded: input.result.responded,
    changedPercent: input.result.changedPercent,
    message: input.result.message,
    steps: [...input.steps],
    consoleMessages: input.result.consoleMessages,
    frames,
  };
  await NodeFSP.writeFile(
    NodePath.join(directory, "result.json"),
    `${JSON.stringify(stored, null, 2)}\n`,
  );
  await prunePlaytests(input.root);
  return { directory: relativeDirectory };
};

export const prunePlaytests = async (root: string): Promise<void> => {
  const parent = NodePath.join(root, PLAYTEST_DIRECTORY);
  let entries: string[] = [];
  try {
    entries = await NodeFSP.readdir(parent);
  } catch {
    return;
  }
  const runs = entries.filter((name) => DIRECTORY_NAME.test(name)).sort();
  for (const name of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS)))
    await NodeFSP.rm(NodePath.join(parent, name), { recursive: true, force: true });
};

/** Reads the newest run; malformed evidence counts as no evidence. */
export const readLastPlaytest = async (
  root: string,
  builds: readonly { readonly target: string; readonly updatedAt: string }[],
): Promise<GameLastPlaytest | null> => {
  const parent = NodePath.join(root, PLAYTEST_DIRECTORY);
  let entries: string[] = [];
  try {
    entries = await NodeFSP.readdir(parent);
  } catch {
    return null;
  }
  const newest = entries.filter((name) => DIRECTORY_NAME.test(name)).sort().at(-1);
  if (newest === undefined) return null;
  let stored: StoredPlaytest;
  try {
    stored = decodeStoredPlaytest(
      await NodeFSP.readFile(NodePath.join(parent, newest, "result.json"), "utf8"),
    );
  } catch {
    return null;
  }
  const webBuild = builds.find((build) => build.target === "Web");
  const stale =
    webBuild === undefined || Date.parse(stored.at) < Date.parse(webBuild.updatedAt);
  return {
    at: stored.at,
    directory: `${PLAYTEST_DIRECTORY}/${newest}`,
    success: stored.success,
    responded: stored.responded,
    changedPercent: stored.changedPercent,
    consoleErrorCount: stored.consoleMessages.filter((message) => message.level === "error")
      .length,
    frames: stored.frames.map((frame) => ({
      label: frame.label,
      path: `${PLAYTEST_DIRECTORY}/${newest}/${frame.file}`,
    })),
    stale,
  };
};
