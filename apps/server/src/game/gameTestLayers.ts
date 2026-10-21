// @effect-diagnostics nodeBuiltinImport:off -- Test boundary stubs replace registration and provider execution, never game operations.
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ThreadId, type Project, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameQualification from "./GameQualification.ts";

/**
 * A qualification store inside the calling fixture's temporary directory. The
 * fixture owns the directory and its cleanup; a test layer must not allocate a
 * record store nothing later removes.
 */
export function qualificationTestLayer(stateDir: string) {
  return GameQualification.layer({ stateDir });
}
/** A design approval store inside the calling fixture's temporary directory. */
export function designApprovalTestLayer(stateDir: string) {
  return GameDesignApproval.layer({ stateDir });
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
    /** Hold the first send until released, so a second approval can race it. */
    readonly sendGate?: {
      readonly started: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
    /** Fail this many dispatches before accepting them, to test a pre-commit failure. */
    readonly sendFailures?: number;
    /**
     * Accept this many dispatches and then fail reading the reply projection, the
     * boundary `sendToThread` has after the command commits.
     */
    readonly sendProjectionFailures?: number;
  },
) {
  let remainingSendFailures = options?.sendFailures ?? 0;
  let remainingProjectionFailures = options?.sendProjectionFailures ?? 0;
  const accepted = new Set<string>();
  let enteredGate = false;
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
        const fail = remainingSendFailures > 0;
        if (fail) remainingSendFailures -= 1;
        const projectionFails = !fail && remainingProjectionFailures > 0;
        if (projectionFails) remainingProjectionFailures -= 1;
        const gate = options?.sendGate;
        // Only the dispatch input crosses this boundary; the real service is
        // covered by the orchestration tests.
        return Effect.gen(function* () {
          if (fail)
            return yield* new ThreadManagementService.ThreadManagementThreadArchivedError({
              threadId: input.threadId,
            });
          // Past this point the command committed. The gate models a reply
          // projection that is still loading, not another chance to refuse.
          accepted.add(input.commandId);
          if (gate !== undefined && !enteredGate) {
            enteredGate = true;
            yield* Deferred.succeed(gate.started, undefined);
            yield* Deferred.await(gate.release);
          }
          if (projectionFails)
            return yield* new ThreadManagementService.ThreadManagementDurableRunProjectionError({
              threadId: input.threadId,
              messageId: input.messageId,
            });
          return {} as never;
        });
      },
      hasReceipt: (commandId) => Effect.succeed(accepted.has(commandId)),
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
