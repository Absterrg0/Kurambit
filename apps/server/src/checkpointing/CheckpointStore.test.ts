// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CheckpointRef, ThreadId, type VcsError } from "@kurambit/contracts";
import * as HostProcess from "@kurambit/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { checkpointRefForGameRun, checkpointRefForThreadTurn } from "./Utils.ts";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";

const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "kurambit-checkpoint-store-test-",
});
const layerVcsProcessTest = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerVcsDriverTest = VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcessTest));
const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provideMerge(layerVcsDriverTest),
  Layer.provideMerge(NodeServices.layer),
);
const layerTest = layerCheckpointStoreTest.pipe(
  Layer.provideMerge(layerVcsProcessTest),
  Layer.provideMerge(layerVcsDriverTest),
  Layer.provideMerge(layerServerConfig),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly committedAt?: string; readonly allowNonZeroExit?: boolean } = {},
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const result = yield* vcsProcess.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
      ...(options.committedAt === undefined
        ? {}
        : { env: { ...process.env, GIT_COMMITTER_DATE: options.committedAt } }),
      ...(options.allowNonZeroExit === undefined
        ? {}
        : { allowNonZeroExit: options.allowNonZeroExit }),
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(NodePath.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(layerTest)("CheckpointStore.layer", (it) => {
  describe("isGitRepository", () => {
    it.effect("returns false when no Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(false);
      }),
    );

    it.effect("returns true when a Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(true);
      }),
    );
  });

  it.effect("detects a nested workspace without its own .git entry", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      yield* initRepoWithCommit(tmp);
      const fileSystem = yield* FileSystem.FileSystem;
      const nested = NodePath.join(tmp, "packages", "nested");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      const checkpointStore = yield* CheckpointStore.CheckpointStore;
      expect(yield* checkpointStore.isGitRepository(nested)).toBe(true);
    }),
  );
  describe("diffCheckpoints", () => {
    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("keeps a/ and b/ patch prefixes when the repository disables them", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.noprefix", "true"]);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-noprefix");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# changed\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });

        expect(diff).toContain("diff --git a/README.md b/README.md");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = NodePath.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");

        for (const ignoreWhitespace of [false, true]) {
          const numstat = yield* checkpointStore.diffCheckpoints({
            cwd: tmp,
            fromCheckpointRef,
            toCheckpointRef,
            ignoreWhitespace,
            format: "numstat",
          });
          expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
            {
              path: "Component.tsx",
              additions: ignoreWhitespace ? 4 : 6,
              deletions: ignoreWhitespace ? 0 : 2,
            },
          ]);
        }
      }),
    );
  });

  describe("checkpoint file summaries", () => {
    it.effect("counts changes whose full patch exceeds the output limit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("large-checkpoint-summary");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const filePath = NodePath.join(tmp, "README.md");
        const lineCount = 20_000;
        yield* writeTextFile(filePath, `${"before".repeat(50)}\n`.repeat(lineCount));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(filePath, `${"after".repeat(60)}\n`.repeat(lineCount));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const numstat = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
          format: "numstat",
        });

        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "README.md", additions: lineCount, deletions: lineCount },
        ]);
        expect(numstat.length).toBeLessThan(100);
      }),
    );

    it.effect("preserves file paths and turn ranges without changing the user index", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.renames", "copies"]);
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-summary-paths");
        const baseline = checkpointRefForThreadTurn(threadId, 0);
        const firstTurn = checkpointRefForThreadTurn(threadId, 1);
        const secondTurn = checkpointRefForThreadTurn(threadId, 2);
        const copiedText = Array.from({ length: 20 }, (_, index) => `copy line ${index}\n`).join(
          "",
        );
        const platform = yield* HostProcess.Platform;
        const renamedPath = platform === "win32" ? "renamed café.txt" : "renamed\tcafé\nname.txt";
        const addedPath = platform === "win32" ? "new café.txt" : "new\tfile\n名.txt";
        for (const [path, contents] of Object.entries({
          "copy-source.txt": copiedText,
          "deleted.txt": "delete me\n",
          "rename-old.txt": "before\nkeep one\nkeep two\nkeep three\n",
          "binary.bin": "\0before",
        })) {
          yield* writeTextFile(NodePath.join(tmp, path), contents);
        }
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baseline });

        yield* fileSystem.rename(
          NodePath.join(tmp, "rename-old.txt"),
          NodePath.join(tmp, renamedPath),
        );
        yield* fileSystem.remove(NodePath.join(tmp, "deleted.txt"));
        for (const [path, contents] of Object.entries({
          "copy-source.txt": `${copiedText}one more\n`,
          "copied.txt": copiedText,
          [renamedPath]: "after\nkeep one\nkeep two\nkeep three\n",
          "binary.bin": "\0after",
          "empty.txt": "",
          [addedPath]: "first\nsecond\n",
        })) {
          yield* writeTextFile(NodePath.join(tmp, path), contents);
        }
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: firstTurn });
        const userIndex = yield* fileSystem.readFile(NodePath.join(tmp, ".git/index"));
        const input = {
          cwd: tmp,
          fromCheckpointRef: baseline,
          toCheckpointRef: firstTurn,
          ignoreWhitespace: false,
          format: "numstat" as const,
        };
        const firstSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints(input),
        );
        const expectedFiles = [
          { path: "binary.bin", additions: 0, deletions: 0 },
          { path: "copied.txt", previousPath: "copy-source.txt", additions: 0, deletions: 0 },
          { path: "copy-source.txt", additions: 1, deletions: 0 },
          { path: "deleted.txt", additions: 0, deletions: 1 },
          { path: "empty.txt", additions: 0, deletions: 0 },
          { path: addedPath, additions: 2, deletions: 0 },
          { path: renamedPath, previousPath: "rename-old.txt", additions: 1, deletions: 1 },
        ].toSorted((left, right) => left.path.localeCompare(right.path));
        expect(firstSummary).toEqual(expectedFiles);

        yield* fileSystem.remove(NodePath.join(tmp, "empty.txt"));
        yield* writeTextFile(NodePath.join(tmp, "copy-source.txt"), "replacement\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: secondTurn });
        const secondSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints({
            ...input,
            fromCheckpointRef: firstTurn,
            toCheckpointRef: secondTurn,
          }),
        );
        expect(secondSummary).toEqual([
          { path: "copy-source.txt", additions: 1, deletions: 21 },
          { path: "empty.txt", additions: 0, deletions: 0 },
        ]);

        const inclusiveSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints({ ...input, toCheckpointRef: secondTurn }),
        );
        expect(inclusiveSummary).toEqual(
          expectedFiles
            .filter((file) => file.path !== "empty.txt")
            .map((file) =>
              file.path === "copy-source.txt" ? { ...file, additions: 1, deletions: 20 } : file,
            ),
        );
        expect(
          yield* checkpointStore.diffCheckpoints({ ...input, toCheckpointRef: baseline }),
        ).toBe("");
        expect(yield* fileSystem.readFile(NodePath.join(tmp, ".git/index"))).toEqual(userIndex);
      }),
    );

    it.effect("uses HEAD for a missing baseline only when requested", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-summary-fallback");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "changed\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });
        const input = {
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
          format: "numstat" as const,
        };

        const error = yield* Effect.flip(checkpointStore.diffCheckpoints(input));
        expect(error._tag).toBe("VcsProcessExitError");
        const numstat = yield* checkpointStore.diffCheckpoints({
          ...input,
          fallbackFromToHead: true,
        });
        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "README.md", additions: 1, deletions: 1 },
        ]);
      }),
    );
    it.effect("limits a diff to repository paths from a subdirectory workspace", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = NodePath.join(tmp, "app");
        yield* fileSystem.makeDirectory(cwd);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-file-paths-subdirectory");
        const refs = {
          cwd,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: refs.fromCheckpointRef });
        yield* writeTextFile(NodePath.join(cwd, "kept.txt"), "kept\n");
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# hidden\n");
        yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: refs.toCheckpointRef });

        const patch = yield* checkpointStore.diffCheckpoints({
          ...refs,
          ignoreWhitespace: false,
          filePaths: ["app/kept.txt"],
        });
        expect(patch).toContain("+kept");
        expect(patch).not.toContain("hidden");
      }),
    );
  });

  describe("listAuthoredPaths", () => {
    it.effect("leaves out paths that only a merged upstream changed", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-authored-paths");
        const refs = {
          cwd: tmp,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        const commitBeforeTurn = (file: string, contents: string) =>
          Effect.gen(function* () {
            yield* writeTextFile(NodePath.join(tmp, file), contents);
            yield* git(tmp, ["add", "."]);
            yield* git(tmp, ["commit", "-m", file], { committedAt: "2020-01-01T00:00:00Z" });
          });

        yield* git(tmp, ["checkout", "-b", "upstream"]);
        yield* commitBeforeTurn("upstream.txt", "upstream\n");
        yield* commitBeforeTurn("shared.txt", "upstream\n");
        yield* git(tmp, ["checkout", "-"]);
        yield* commitBeforeTurn("shared.txt", "ours\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.fromCheckpointRef,
        });

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });
        expect(yield* checkpointStore.listAuthoredPaths(refs)).toBeNull();

        yield* git(tmp, ["merge", "upstream", "--no-edit"], { allowNonZeroExit: true });
        yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "upstream\n");
        yield* git(tmp, ["commit", "-am", "merge upstream"]);
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# edited\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });

        const numstat = yield* checkpointStore.diffCheckpoints({
          ...refs,
          ignoreWhitespace: false,
          format: "numstat",
        });
        expect(parseTurnDiffFilesFromNumstat(numstat).map((file) => file.path)).toEqual([
          "README.md",
          "shared.txt",
          "upstream.txt",
        ]);
        expect(yield* checkpointStore.listAuthoredPaths(refs)).toEqual(
          new Set(["README.md", "shared.txt"]),
        );
      }),
    );

    it.effect("leaves out paths that only a rebase onto upstream brought in", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-authored-paths-rebase");
        const refs = {
          cwd: tmp,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        const commitBeforeTurn = (file: string) =>
          Effect.gen(function* () {
            yield* writeTextFile(NodePath.join(tmp, file), `${file}\n`);
            yield* git(tmp, ["add", "."]);
            yield* git(tmp, ["commit", "-m", file], { committedAt: "2020-01-01T00:00:00Z" });
          });

        yield* git(tmp, ["checkout", "-b", "upstream"]);
        yield* commitBeforeTurn("upstream.txt");
        yield* git(tmp, ["checkout", "-"]);
        yield* commitBeforeTurn("feature.txt");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.fromCheckpointRef,
        });
        yield* git(tmp, ["rebase", "upstream"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });

        expect(yield* checkpointStore.listAuthoredPaths(refs)).toEqual(new Set(["feature.txt"]));
      }),
    );
  });

  describe("a game in a subfolder of a bigger repository", () => {
    it.effect("restores, diffs and copies only below its cwd, by paths relative to it", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const at = (file: string) => NodePath.join(tmp, file);
        const game = at("game");
        yield* initRepoWithCommit(tmp);
        // The repository's own top-level godot/ beside the game's.
        yield* fileSystem.makeDirectory(at("godot"), { recursive: true });
        yield* fileSystem.makeDirectory(at("game/godot"), { recursive: true });
        yield* writeTextFile(at("godot/outer.gd"), "outer v1\n");
        yield* writeTextFile(at("game/godot/main.gd"), "main v1\n");
        yield* writeTextFile(at("game/NOTES.md"), "notes\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "repo with a game"]);
        const oid = yield* checkpointStore.captureCheckpoint({
          cwd: game,
          checkpointRef: checkpointRefForGameRun("run_sub", "best"),
        });
        yield* writeTextFile(at("game/godot/main.gd"), "main v2\n");
        yield* writeTextFile(at("game/godot/new.gd"), "new\n");
        yield* writeTextFile(at("godot/outer.gd"), "outer v2\n");
        yield* writeTextFile(at("godot/outer-new.gd"), "outer new\n");
        const later = yield* checkpointStore.captureCheckpoint({
          cwd: game,
          checkpointRef: checkpointRefForGameRun("run_sub", "later"),
        });

        // The diff names the game's own paths, relative to it.
        const numstat = yield* checkpointStore.diffCheckpoints({
          cwd: game,
          fromCheckpointRef: CheckpointRef.make(oid),
          toCheckpointRef: CheckpointRef.make(later),
          ignoreWhitespace: false,
          format: "numstat",
          relative: true,
        });
        expect(
          parseTurnDiffFilesFromNumstat(numstat)
            .map((file) => file.path)
            .toSorted(),
        ).toEqual(["godot/main.gd", "godot/new.gd"]);

        // A restore of "godot" is the game's godot/, never the repository's.
        yield* checkpointStore.restoreCheckpoint({
          cwd: game,
          checkpointRef: CheckpointRef.make(oid),
          filePaths: ["godot"],
        });
        expect(yield* fileSystem.readFileString(at("game/godot/main.gd"))).toBe("main v1\n");
        expect(yield* fileSystem.exists(at("game/godot/new.gd"))).toBe(false);
        expect(yield* fileSystem.readFileString(at("godot/outer.gd"))).toBe("outer v2\n");
        expect(yield* fileSystem.readFileString(at("godot/outer-new.gd"))).toBe("outer new\n");

        // A copy holds the game's own files at their paths below it, nothing else.
        const copy = yield* makeTmpDir("checkpoint-sub-copy-");
        yield* checkpointStore.materializeCheckpoint({
          cwd: game,
          checkpointRef: CheckpointRef.make(oid),
          destination: copy,
          excludePaths: ["NOTES.md"],
        });
        expect(yield* fileSystem.readFileString(NodePath.join(copy, "godot/main.gd"))).toBe(
          "main v1\n",
        );
        expect(yield* fileSystem.exists(NodePath.join(copy, "game"))).toBe(false);
        expect(yield* fileSystem.exists(NodePath.join(copy, "README.md"))).toBe(false);
        expect(yield* fileSystem.exists(NodePath.join(copy, "NOTES.md"))).toBe(false);
      }),
    );
  });

  describe("a path-scoped restore", () => {
    it.effect(
      "changes only differing files in its scope, never the user's HEAD, branch or index",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const fileSystem = yield* FileSystem.FileSystem;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const at = (file: string) => NodePath.join(tmp, file);
          yield* initRepoWithCommit(tmp);
          yield* fileSystem.makeDirectory(at("game/scenes"), { recursive: true });
          yield* writeTextFile(at(".gitignore"), "game/.cache/\n");
          yield* writeTextFile(at("game/kept.txt"), "kept\n");
          yield* writeTextFile(at("game/scenes/level.txt"), "level 1\n");
          yield* writeTextFile(at("NOTES.md"), "notes v1\n");
          yield* git(tmp, ["add", "."]);
          yield* git(tmp, ["commit", "-m", "game"]);
          const build = checkpointRefForGameRun("run_1", "best");
          const oid = yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: build });
          expect(oid).toBe(yield* git(tmp, ["rev-parse", `${build}^{commit}`]));

          // The work a rejected round leaves, beside the user's own staged change.
          yield* writeTextFile(at("game/scenes/level.txt"), "level 2\n");
          yield* writeTextFile(at("game/new.txt"), "new\n");
          yield* fileSystem.makeDirectory(at("game/.cache"), { recursive: true });
          yield* writeTextFile(at("game/.cache/import.bin"), "cache\n");
          yield* writeTextFile(at("NOTES.md"), "notes v2\n");
          // Someone's own repository inside the game, which no build holds.
          yield* fileSystem.makeDirectory(at("game/addon"), { recursive: true });
          yield* writeTextFile(at("game/addon/plugin.gd"), "addon\n");
          yield* git(at("game/addon"), ["init"]);
          yield* writeTextFile(at("README.md"), "# staged by the user\n");
          yield* git(tmp, ["add", "README.md"]);
          const head = yield* git(tmp, ["rev-parse", "HEAD"]);
          const branch = yield* git(tmp, ["symbolic-ref", "HEAD"]);
          const index = yield* fileSystem.readFile(at(".git/index"));
          const old = 1_577_836_800;
          yield* fileSystem.utimes(at("game/kept.txt"), old, old);

          expect(
            yield* checkpointStore.restoreCheckpoint({
              cwd: tmp,
              checkpointRef: CheckpointRef.make(oid),
              filePaths: ["game"],
            }),
          ).toBe(true);

          // In scope: differing files come back, new files go, ignored files and
          // an unchanged file (its mtime too) stay as they are.
          expect(yield* fileSystem.readFileString(at("game/scenes/level.txt"))).toBe("level 1\n");
          expect(yield* fileSystem.exists(at("game/new.txt"))).toBe(false);
          expect(yield* fileSystem.readFileString(at("game/.cache/import.bin"))).toBe("cache\n");
          expect(yield* fileSystem.readFileString(at("game/addon/plugin.gd"))).toBe("addon\n");
          expect(yield* fileSystem.exists(at("game/addon/.git"))).toBe(true);
          const kept = yield* fileSystem.stat(at("game/kept.txt"));
          expect(Option.getOrThrow(kept.mtime).getTime()).toBe(old * 1000);
          // Outside it, and the user's git, nothing changed.
          expect(yield* fileSystem.readFileString(at("NOTES.md"))).toBe("notes v2\n");
          expect(yield* fileSystem.readFileString(at("README.md"))).toBe("# staged by the user\n");
          expect(yield* git(tmp, ["rev-parse", "HEAD"])).toBe(head);
          expect(yield* git(tmp, ["symbolic-ref", "HEAD"])).toBe(branch);
          expect(yield* fileSystem.readFile(at(".git/index"))).toEqual(index);
          expect(yield* git(tmp, ["diff", "--cached", "--name-only"])).toBe("README.md");

          // A run ref points at a recorded build; a copy of it has no git at all.
          const kept2 = checkpointRefForGameRun("run_1", "round-1");
          expect(
            yield* checkpointStore.updateCheckpointRef({ cwd: tmp, checkpointRef: kept2, oid }),
          ).toBe(true);
          expect(yield* git(tmp, ["rev-parse", kept2])).toBe(oid);
          const copy = yield* makeTmpDir("checkpoint-copy-");
          expect(
            yield* checkpointStore.materializeCheckpoint({
              cwd: tmp,
              checkpointRef: CheckpointRef.make(oid),
              destination: copy,
              excludePaths: ["NOTES.md"],
            }),
          ).toBe(true);
          expect(
            yield* fileSystem.readFileString(NodePath.join(copy, "game/scenes/level.txt")),
          ).toBe("level 1\n");
          expect(yield* fileSystem.exists(NodePath.join(copy, "NOTES.md"))).toBe(false);
          expect(yield* fileSystem.exists(NodePath.join(copy, ".git"))).toBe(false);
          expect(yield* fileSystem.readFile(at(".git/index"))).toEqual(index);
          // A build whose excluded file differs from both HEAD and the folder
          // (a run's notes drift every round) is still copied without it.
          yield* writeTextFile(at("NOTES.md"), "notes v3\n");
          const drifted = yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: checkpointRefForGameRun("run_1", "round-2"),
          });
          yield* writeTextFile(at("NOTES.md"), "notes v2\n");
          const driftedCopy = yield* makeTmpDir("checkpoint-copy-");
          expect(
            yield* checkpointStore.materializeCheckpoint({
              cwd: tmp,
              checkpointRef: CheckpointRef.make(drifted),
              destination: driftedCopy,
              excludePaths: ["NOTES.md"],
            }),
          ).toBe(true);
          expect(yield* fileSystem.exists(NodePath.join(driftedCopy, "NOTES.md"))).toBe(false);
          expect(yield* fileSystem.readFile(at(".git/index"))).toEqual(index);
          // A copy that would replace the repository or a folder in it is refused.
          for (const destination of [tmp, at("game")]) {
            const refused = yield* checkpointStore
              .materializeCheckpoint({
                cwd: tmp,
                checkpointRef: CheckpointRef.make(oid),
                destination,
              })
              .pipe(Effect.flip);
            expect(refused.message).toContain("Refusing to replace");
          }
          expect(yield* fileSystem.readFileString(at("game/scenes/level.txt"))).toBe("level 1\n");
        }),
    );

    it.effect("brings back files the user's index marks unchanged or skipped", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const at = (file: string) => NodePath.join(tmp, file);
        yield* initRepoWithCommit(tmp);
        yield* fileSystem.makeDirectory(at("game"), { recursive: true });
        yield* writeTextFile(at("game/a.txt"), "a v1\n");
        yield* writeTextFile(at("game/b.txt"), "b v1\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "game"]);
        const oid = yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: checkpointRefForGameRun("run_1", "best"),
        });
        // Flags that make git trust the index over the file.
        yield* git(tmp, ["update-index", "--assume-unchanged", "game/a.txt"]);
        yield* git(tmp, ["update-index", "--skip-worktree", "game/b.txt"]);
        yield* writeTextFile(at("game/a.txt"), "a v2\n");
        yield* writeTextFile(at("game/b.txt"), "b v2\n");

        expect(
          yield* checkpointStore.restoreCheckpoint({
            cwd: tmp,
            checkpointRef: CheckpointRef.make(oid),
            filePaths: ["game"],
          }),
        ).toBe(true);
        expect(yield* fileSystem.readFileString(at("game/a.txt"))).toBe("a v1\n");
        expect(yield* fileSystem.readFileString(at("game/b.txt"))).toBe("b v1\n");
      }),
    );
  });
});
