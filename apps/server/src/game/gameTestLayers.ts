// @effect-diagnostics nodeBuiltinImport:off -- Test boundary stubs replace registration and provider execution, never game operations.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ThreadId, type Project, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as GameQualification from "./GameQualification.ts";

/**
 * A qualification store under the test's temporary directory. Game operations
 * in these tests never qualify, so the directory only receives a record when the
 * test exercises recording explicitly.
 */
export function qualificationTestLayer(stateDir?: string) {
  return GameQualification.layer({
    stateDir: stateDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "game-qualification-")),
  });
}
export function previewBrowserTestLayer(
  executable?: string,
  installed = Effect.succeed(Option.fromUndefinedOr(executable)),
) {
  return Layer.succeed(
    PreviewBrowser.PreviewBrowser,
    PreviewBrowser.PreviewBrowser.of({
      executable:
        executable === undefined
          ? Effect.die("This test provides no headless browser.")
          : Effect.succeed(executable),
      installed,
    }),
  );
}
export function projectTestLayer(
  onLaunch?: (input: ThreadLaunchService.ThreadLaunchInput) => void,
  onSend?: (input: ThreadManagementService.ThreadManagementSendInput) => void,
  options?: {
    readonly threads?: () => ReadonlyArray<OrchestrationV2ThreadShell>;
  },
) {
  let project: Project | undefined;
  const defaultThread = (): OrchestrationV2ThreadShell =>
    ({
      id: ThreadId.make("game-test-thread"),
      projectId: project!.id,
      title: "Game session",
      updatedAt: DateTime.makeUnsafe("2026-10-20T00:00:00.000Z"),
      archivedAt: null,
      deletedAt: null,
      worktreePath: null,
    }) as OrchestrationV2ThreadShell;
  const projectThreads = () => options?.threads?.() ?? (project ? [defaultThread()] : []);
  return Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      bootstrap: (input) => {
        project = {
          id: input.projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          scripts: [],
          createdAt: "2026-10-19T00:00:00Z",
          updatedAt: "2026-10-19T00:00:00Z",
          deletedAt: null,
        };
        return Effect.succeed({ project, created: true });
      },
      getByWorkspaceRoot: () => Effect.succeed(Option.fromUndefinedOr(project)),
      getById: () => Effect.succeed(Option.fromUndefinedOr(project)),
      snapshot: Effect.sync(() => ({
        projects: project ? [project] : [],
        updatedAt: "2026-10-20T00:00:00.000Z",
      })),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed(
          project === undefined
            ? null
            : ({
                id: ThreadId.make("game-test-thread"),
                projectId: project.id,
                deletedAt: null,
                worktreePath: null,
              } as OrchestrationV2ThreadShell),
        ),
      listProjectThreads: () => Effect.succeed(projectThreads()),
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: projectThreads(),
          archivedThreads: [],
        }),
      sendToThread: (input) => {
        onSend?.(input);
        // Only the dispatch input crosses this boundary; the real service is
        // covered by the orchestration tests.
        return Effect.succeed({} as never);
      },
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) => {
        onLaunch?.(input);
        // Only threadId crosses this boundary; launch itself has separate integration tests.
        return Effect.succeed({
          threadId: ThreadId.make("game-test-thread"),
        } as ThreadLaunchService.ThreadLaunchResult);
      },
    }),
  );
}
