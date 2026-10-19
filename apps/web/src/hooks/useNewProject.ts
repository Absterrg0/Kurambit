import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

export function useNewProject() {
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  return async (input: {
    readonly environmentId: EnvironmentId;
    readonly name: string;
  }): Promise<boolean> => {
    const result = await createNew({
      environmentId: input.environmentId,
      input: { name: input.name },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not create the project",
            description: errorMessage(squashAtomCommandFailure(result)),
          }),
        );
      }
      return false;
    }

    const { projectId, workspaceRoot, commitError } = result.value;
    toastManager.add(
      stackedThreadToast(
        commitError === undefined
          ? { type: "success", title: `Created ${input.name}`, description: workspaceRoot }
          : {
              type: "warning",
              title: `Created ${input.name} without a first commit`,
              description: `${commitError} The project is in ${workspaceRoot}.`,
            },
      ),
    );

    const projectRef = scopeProjectRef(input.environmentId, projectId);
    // Drafts key off the project's stored path, so wait for the create event
    // to reach the store before opening one.
    const project = await waitForProject(projectRef).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to open project",
          description: `${errorMessage(error)} It will appear in the sidebar once this client catches up.`,
        }),
      );
      return null;
    });
    if (project === null) return true;
    await handleNewThread(projectRef).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to open project",
          description: errorMessage(error),
        }),
      );
    });
    return true;
  };
}
