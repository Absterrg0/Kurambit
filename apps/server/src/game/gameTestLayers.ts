// @effect-diagnostics nodeBuiltinImport:off -- Test boundary stubs replace registration and provider execution, never game operations.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ThreadId, type Project, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
export function projectTestLayer(
  onLaunch?: (input: ThreadLaunchService.ThreadLaunchInput) => void,
) {
  let project: Project | undefined;
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
      getById: () => Effect.succeed(Option.fromUndefinedOr(project)),
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
