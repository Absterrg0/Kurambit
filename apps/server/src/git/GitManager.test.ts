import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import type { ChangeRequest, GitPreparePullRequestThreadInput } from "@t3tools/contracts";

import {
  GitCommandError,
  SourceControlProviderError as SourceControlProviderFailure,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitManager from "./GitManager.ts";

const encodeCliJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeForgejoPullRequest = Schema.decodeEffect(ForgejoPullRequestSchema);

interface FakeGhScenario {
  prListSequence?: string[];
  prListByHeadSelector?: Record<string, string>;
  prListSequenceByHeadSelector?: Record<string, string[]>;
  createdPrUrl?: string;
  defaultBranch?: string;
  pullRequest?: {
    number: number;
    title: string;
    url: string;
    baseRefName: string;
    headRefName: string;
    state?: "open" | "closed" | "merged";
    isDraft?: boolean;
    isCrossRepository?: boolean;
    headRepositoryNameWithOwner?: string | null;
    headRepositoryOwnerLogin?: string | null;
  };
  repositoryCloneUrls?: Record<string, { url: string; sshUrl: string }>;
  failWith?: string;
  failCause?: unknown;
  failAfterCalls?: number;
}

function fakeGhOutput(stdout: string): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

type FakeGitTextGeneration = TextGeneration.TextGeneration["Service"];

type FakePullRequest = NonNullable<FakeGhScenario["pullRequest"]>;

type FakePullRequestSummary = Omit<ChangeRequest, "provider" | "state" | "updatedAt"> & {
  readonly state?: ChangeRequest["state"];
  readonly updatedAt?: string;
};

function normalizeFakePullRequestSummary(raw: unknown): FakePullRequestSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const number = record.number;
  const title = record.title;
  const url = record.url;
  const baseRefName = record.baseRefName;
  const headRefName = record.headRefName;
  const headRepository =
    typeof record.headRepository === "object" && record.headRepository !== null
      ? (record.headRepository as Record<string, unknown>)
      : null;
  const headRepositoryOwner =
    typeof record.headRepositoryOwner === "object" && record.headRepositoryOwner !== null
      ? (record.headRepositoryOwner as Record<string, unknown>)
      : null;

  if (
    typeof number !== "number" ||
    typeof title !== "string" ||
    typeof url !== "string" ||
    typeof baseRefName !== "string" ||
    typeof headRefName !== "string"
  ) {
    return null;
  }

  const state =
    typeof record.state === "string"
      ? record.state === "OPEN" || record.state === "open"
        ? "open"
        : record.state === "CLOSED" || record.state === "closed"
          ? "closed"
          : "merged"
      : undefined;
  const isDraft = typeof record.isDraft === "boolean" ? record.isDraft : undefined;
  const isCrossRepository =
    typeof record.isCrossRepository === "boolean" ? record.isCrossRepository : undefined;
  const headRepositoryNameWithOwner =
    typeof record.headRepositoryNameWithOwner === "string"
      ? record.headRepositoryNameWithOwner
      : typeof headRepository?.nameWithOwner === "string"
        ? headRepository.nameWithOwner
        : undefined;
  const headRepositoryOwnerLogin =
    typeof record.headRepositoryOwnerLogin === "string"
      ? record.headRepositoryOwnerLogin
      : typeof headRepositoryOwner?.login === "string"
        ? headRepositoryOwner.login
        : undefined;

  return {
    number,
    title,
    url,
    baseRefName,
    headRefName,
    ...(state ? { state } : {}),
    ...(isDraft === true ? { isDraft: true } : {}),
    ...(isCrossRepository !== undefined ? { isCrossRepository } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

function runGitSyncForFakeGh(cwd: string, args: readonly string[]): void {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return;
  }
  throw new Error(
    `Failed to simulate gh checkout with git ${args.join(" ")}: ${result.stderr?.trim() || "unknown error"}`,
  );
}

function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function removePath(
  targetPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.remove(targetPath, { recursive: true, force: true });
  });
}

function makeDirectory(
  dirPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(dirPath, { recursive: true });
  });
}

function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<
  {
    readonly exitCode: GitVcsDriver.ExecuteGitResult["exitCode"];
    readonly stdout: string;
    readonly stderr: string;
  },
  GitCommandError,
  GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* git.execute({
      operation: "GitManager.test.runGit",
      cwd,
      args,
      allowNonZeroExit,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
}

function initRepo(
  cwd: string,
): Effect.Effect<
  void,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test User"]);
    // Hermetic line endings: machine-global `core.autocrlf=true` on Windows
    // makes Git check out CRLF, which breaks exact-content assertions that
    // write LF with Node. Local config overrides the global so the fixture
    // (and its linked worktrees, which share config) always checks out LF.
    yield* runGit(cwd, ["config", "core.autocrlf", "false"]);
    yield* fs.writeFileString(NodePath.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
  });
}

function createBareRemote(): Effect.Effect<
  string,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const remoteDir = yield* makeTempDir("t3code-git-remote-");
    yield* runGit(remoteDir, ["init", "--bare"]);
    return remoteDir;
  });
}

function configureRemote(
  cwd: string,
  remoteName: string,
  remotePath: string,
  fetchNamespace: string,
): Effect.Effect<void, GitCommandError, GitVcsDriver.GitVcsDriver> {
  return Effect.gen(function* () {
    yield* runGit(cwd, ["config", `remote.${remoteName}.url`, remotePath]);
    yield* runGit(cwd, [
      "config",
      "--replace-all",
      `remote.${remoteName}.fetch`,
      `+refs/heads/*:refs/remotes/${fetchNamespace}/*`,
    ]);
  });
}

function configureVisibleRemoteUrlWithLocalRewrite(
  cwd: string,
  remoteName: string,
  visibleUrl: string,
  localRemotePath: string,
): Effect.Effect<void, GitCommandError, GitVcsDriver.GitVcsDriver> {
  return Effect.gen(function* () {
    yield* runGit(cwd, ["config", `remote.${remoteName}.url`, visibleUrl]);
    yield* runGit(cwd, ["config", `url.${localRemotePath}.insteadOf`, visibleUrl]);
  });
}

function createTextGeneration(
  overrides: Partial<FakeGitTextGeneration> = {},
): TextGeneration.TextGeneration["Service"] {
  const implementation: FakeGitTextGeneration = {
    generateCommitMessage: (input) =>
      Effect.succeed({
        subject: "Implement stacked git actions",
        body: "",
        ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
      }),
    generatePrContent: () =>
      Effect.succeed({
        title: "Add stacked git actions",
        body: "## Summary\n- Add stacked git workflow\n\n## Testing\n- Not run",
      }),
    generateBranchName: () =>
      Effect.succeed({
        branch: "update-workflow",
      }),
    generateThreadTitle: () =>
      Effect.succeed({
        title: "Update workflow",
      }),
    generateReviewGuide: () => Effect.succeed({ stops: [] }),
    ...overrides,
  };

  return {
    generateCommitMessage: (input) =>
      implementation.generateCommitMessage(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generatePrContent: (input) =>
      implementation.generatePrContent(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateBranchName: (input) =>
      implementation.generateBranchName(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateThreadTitle: (input) =>
      implementation.generateThreadTitle(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateReviewGuide: (input) => implementation.generateReviewGuide(input),
  };
}

function createGitHubProviderWithFakeGh(scenario: FakeGhScenario = {}): {
  service: SourceControlProvider["Service"];
  ghCalls: string[];
} {
  const prListQueue = [...(scenario.prListSequence ?? [])];
  const prListQueueByHeadSelector = new Map(
    Object.entries(scenario.prListSequenceByHeadSelector ?? {}).map(([headSelector, values]) => [
      headSelector,
      [...values],
    ]),
  );
  const ghCalls: string[] = [];

  const fail = (cwd: string, detail: string, cause?: unknown, operation = "fakeGh") =>
    new SourceControlProviderFailure({
      provider: SourceControlProviderKind.make("github"),
      operation,
      cwd,
      detail,
      cause,
    });

  const execute = (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly operation: string;
  }): Effect.Effect<VcsProcess.VcsProcessOutput, SourceControlProviderFailure> => {
    const args = [...input.args];
    ghCalls.push(args.join(" "));

    if (scenario.failWith && ghCalls.length > (scenario.failAfterCalls ?? 0)) {
      return Effect.fail(fail(input.cwd, scenario.failWith, scenario.failCause, input.operation));
    }

    if (args[0] === "pr" && args[1] === "list") {
      const headSelectorIndex = args.findIndex((value) => value === "--head");
      const headSelector =
        headSelectorIndex >= 0 && headSelectorIndex < args.length - 1
          ? args[headSelectorIndex + 1]
          : undefined;
      const mappedQueue =
        typeof headSelector === "string"
          ? prListQueueByHeadSelector.get(headSelector)?.shift()
          : undefined;
      const mappedStdout =
        typeof headSelector === "string"
          ? scenario.prListByHeadSelector?.[headSelector]
          : undefined;
      const stdout = (mappedQueue ?? mappedStdout ?? prListQueue.shift() ?? "[]") + "\n";
      return Effect.succeed(fakeGhOutput(stdout));
    }

    if (args[0] === "pr" && args[1] === "create") {
      return Effect.succeed(
        fakeGhOutput(
          (scenario.createdPrUrl ?? "https://github.com/pingdotgg/codething-mvp/pull/101") + "\n",
        ),
      );
    }

    if (args[0] === "pr" && args[1] === "view") {
      const pullRequest: FakePullRequest = scenario.pullRequest ?? {
        number: 101,
        title: "Pull request",
        url: "https://github.com/pingdotgg/codething-mvp/pull/101",
        baseRefName: "main",
        headRefName: "feature/pull-request",
        state: "open",
      };
      return Effect.succeed(
        fakeGhOutput(
          JSON.stringify({
            ...pullRequest,
            ...(pullRequest.headRepositoryNameWithOwner
              ? {
                  headRepository: {
                    nameWithOwner: pullRequest.headRepositoryNameWithOwner,
                  },
                }
              : {}),
            ...(pullRequest.headRepositoryOwnerLogin
              ? {
                  headRepositoryOwner: {
                    login: pullRequest.headRepositoryOwnerLogin,
                  },
                }
              : {}),
          }) + "\n",
        ),
      );
    }

    if (args[0] === "pr" && args[1] === "checkout") {
      return Effect.try({
        try: () => {
          const headBranch = scenario.pullRequest?.headRefName;
          if (headBranch) {
            const existingBranch = NodeChildProcess.spawnSync(
              "git",
              ["show-ref", "--verify", "--quiet", `refs/heads/${headBranch}`],
              {
                cwd: input.cwd,
                encoding: "utf8",
              },
            );
            if (existingBranch.status === 0) {
              runGitSyncForFakeGh(input.cwd, ["checkout", headBranch]);
            } else {
              runGitSyncForFakeGh(input.cwd, ["checkout", "-b", headBranch]);
            }
          }
          return fakeGhOutput("");
        },
        catch: (error) => fail(input.cwd, "GitHub request failed.", error),
      });
    }

    if (args[0] === "repo" && args[1] === "view") {
      const repository = args[2];
      if (typeof repository === "string" && args.includes("nameWithOwner,url,sshUrl")) {
        const cloneUrls = scenario.repositoryCloneUrls?.[repository];
        if (!cloneUrls) {
          return Effect.fail(fail(input.cwd, `Unexpected repository lookup: ${repository}`));
        }
        return Effect.succeed(
          fakeGhOutput(
            JSON.stringify({
              nameWithOwner: repository,
              url: cloneUrls.url,
              sshUrl: cloneUrls.sshUrl,
            }) + "\n",
          ),
        );
      }
      return Effect.succeed(fakeGhOutput(`${scenario.defaultBranch ?? "main"}\n`));
    }

    return Effect.fail(fail(input.cwd, `Unexpected gh command: ${args.join(" ")}`));
  };

  const toChangeRequest = (summary: FakePullRequestSummary): ChangeRequest => ({
    ...summary,
    provider: SourceControlProviderKind.make("github"),
    state: summary.state ?? "open",
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    updatedAt:
      summary.updatedAt === undefined
        ? Option.none()
        : Option.some(DateTime.makeUnsafe(summary.updatedAt)),
  });

  return {
    service: {
      kind: SourceControlProviderKind.make("github"),
      headBranchProbe: ({ headSelectors }) => ({
        headSelectors: headSelectors.filter((selector) => !selector.includes(":")),
        limit: 100,
      }),

      listChangeRequests: (input) =>
        input.state === "open"
          ? execute({
              operation: "listChangeRequests",
              cwd: input.cwd,
              args: [
                "pr",
                "list",
                "--head",
                input.headSelector,
                "--state",
                "open",
                "--limit",
                String(input.limit ?? 1),
                "--json",
                "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,isCrossRepository,headRepository,headRepositoryOwner",
              ],
            }).pipe(
              Effect.map((result) => JSON.parse(result.stdout) as unknown[]),
              Effect.map((raw) =>
                raw
                  .map((entry) => normalizeFakePullRequestSummary(entry))
                  .filter((entry): entry is FakePullRequestSummary => entry !== null)
                  .map(toChangeRequest),
              ),
            )
          : execute({
              operation: "listChangeRequests",
              cwd: input.cwd,
              args: [
                "pr",
                "list",
                "--head",
                input.headSelector,
                "--state",
                input.state,
                "--limit",
                String(input.limit ?? 20),
                "--json",
                "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
              ],
            }).pipe(
              Effect.map((result) => {
                const raw = result.stdout.trim();
                if (raw.length === 0) return [];
                const decoded = decodeGitHubPullRequestListJson(raw);
                return Result.isSuccess(decoded)
                  ? decoded.success.map((record) => ({
                      provider: SourceControlProviderKind.make("github"),
                      ...record,
                    }))
                  : [];
              }),
            ),
      createChangeRequest: (input) =>
        execute({
          operation: "createChangeRequest",
          cwd: input.cwd,
          args: [
            "pr",
            "create",
            "--base",
            input.baseRefName,
            "--head",
            input.headSelector,
            "--title",
            input.title,
            "--body-file",
            input.bodyFile,
          ],
        }).pipe(Effect.asVoid),
      getDefaultBranch: (input) =>
        execute({
          operation: "getDefaultBranch",
          cwd: input.cwd,
          args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        }).pipe(
          Effect.map((result) => {
            const value = result.stdout.trim();
            return value.length > 0 ? value : null;
          }),
        ),
      getChangeRequest: (input) =>
        execute({
          operation: "getChangeRequest",
          cwd: input.cwd,
          args: [
            "pr",
            "view",
            input.reference,
            "--json",
            "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        }).pipe(
          Effect.map((result) =>
            toChangeRequest(JSON.parse(result.stdout) as FakePullRequestSummary),
          ),
        ),
      getRepositoryCloneUrls: (input) =>
        execute({
          operation: "getRepositoryCloneUrls",
          cwd: input.cwd,
          args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
        }).pipe(Effect.map((result) => JSON.parse(result.stdout))),
      createRepository: (input) =>
        Effect.fail(fail(input.cwd, `Unexpected repository create: ${input.repository}`)),
      checkoutChangeRequest: (input) =>
        execute({
          operation: "checkoutChangeRequest",
          cwd: input.cwd,
          args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
        }).pipe(Effect.asVoid),
    },
    ghCalls,
  };
}

function runStackedAction(
  manager: GitManager.GitManager["Service"],
  input: {
    cwd: string;
    action: "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";
    actionId?: string;
    commitMessage?: string;
    featureBranch?: boolean;
    filePaths?: readonly string[];
  },
  options?: Parameters<GitManager.GitManager["Service"]["runStackedAction"]>[1],
) {
  return manager.runStackedAction(
    {
      ...input,
      actionId: input.actionId ?? "test-action-id",
    },
    options,
  );
}

function resolvePullRequest(
  manager: GitManager.GitManager["Service"],
  input: { cwd: string; reference: string },
) {
  return manager.resolvePullRequest(input);
}

function preparePullRequestThread(
  manager: GitManager.GitManager["Service"],
  input: GitPreparePullRequestThreadInput,
) {
  return manager.preparePullRequestThread(input);
}

function makeManager(input?: {
  ghScenario?: FakeGhScenario;
  sourceControlProvider?: SourceControlProvider["Service"];
  textGeneration?: Partial<FakeGitTextGeneration>;
  serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  setupScriptRunner?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  gitConfigReads?: string[];
  gitCommands?: string[];
  gitSpawnGate?: {
    readonly matches: (args: ReadonlyArray<string>) => boolean;
    readonly reached: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
  seed?: Effect.Effect<
    void,
    ProjectionStore.ProjectionStoreV2Error | ProjectStore.ProjectStoreV2Error,
    ProjectionStore.ProjectionStoreV2 | ProjectStore.ProjectStoreV2
  >;
}) {
  const { service: fakeGitHubProvider, ghCalls } = createGitHubProviderWithFakeGh(
    input?.ghScenario,
  );
  const textGeneration = createTextGeneration(input?.textGeneration);
  const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-git-manager-test-",
  });

  const layerServerSettings = ServerSettings.ServerSettingsService.layerTest(input?.serverSettings);

  const gitCommands = input?.gitCommands;
  const gitSpawnGate = input?.gitSpawnGate;
  const watchesGitSpawns = gitCommands !== undefined || gitSpawnGate !== undefined;
  const layerGitDriverSpawner = watchesGitSpawns
    ? Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) => {
            // On Windows the driver starts git by its full path to git.exe.
            const args =
              command._tag === "StandardCommand" &&
              NodePath.parse(command.command).name.toLowerCase() === "git"
                ? command.args
                : null;
            if (args !== null) gitCommands?.push(args.join(" "));
            if (args === null || gitSpawnGate === undefined || !gitSpawnGate.matches(args)) {
              return spawner.spawn(command);
            }
            return spawner
              .spawn(command)
              .pipe(
                Effect.tap((handle) =>
                  handle.exitCode.pipe(
                    Effect.andThen(Deferred.succeed(gitSpawnGate.reached, undefined)),
                    Effect.andThen(Deferred.await(gitSpawnGate.release)),
                  ),
                ),
              );
          });
        }),
      ).pipe(Layer.provide(NodeServices.layer))
    : Layer.empty;
  const gitVcsDriver = input?.gitConfigReads
    ? Layer.effect(
        GitVcsDriver.GitVcsDriver,
        GitVcsDriver.make.pipe(
          Effect.map((service) =>
            GitVcsDriver.GitVcsDriver.of({
              ...service,
              readConfigValue: (cwd, key) =>
                Effect.sync(() => input.gitConfigReads?.push(key)).pipe(
                  Effect.andThen(service.readConfigValue(cwd, key)),
                ),
            }),
          ),
        ),
      )
    : GitVcsDriver.layer;
  const layerVcsDriver = (watchesGitSpawns ? Layer.fresh(gitVcsDriver) : gitVcsDriver).pipe(
    Layer.provide(layerGitDriverSpawner),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(layerServerConfig),
  );
  const layerSourceControlRegistry = Layer.empty;

  const layerManager = Layer.mergeAll(
    Layer.succeed(TextGeneration.TextGeneration, textGeneration),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([]),
    }),
    Layer.succeed(
      ProjectSetupScriptRunner.ProjectSetupScriptRunner,
      input?.setupScriptRunner ?? {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      },
    ),
    layerServerSettings,
  ).pipe(
    Layer.provideMerge(layerSourceControlRegistry),
    Layer.provideMerge(layerVcsDriver),
    Layer.provideMerge(NodeServices.layer),
  );
  const layerStores = Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

  return Effect.gen(function* () {
    const stores = yield* Layer.build(layerStores);
    if (input?.seed !== undefined) {
      yield* input.seed.pipe(Effect.provideContext(stores), Effect.orDie);
    }
    const manager = yield* GitManager.make.pipe(
      Effect.provide(layerManager),
      Effect.provideContext(stores),
    );
    return { manager, ghCalls };
  });
}

const asThreadId = (threadId: string) => threadId as ThreadId;

const layerGitManagerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-manager-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
