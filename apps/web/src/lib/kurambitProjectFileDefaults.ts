import {
  KURAMBIT_PROJECT_FILE_NAME,
  type EnvironmentId,
  type KurambitProjectFile,
} from "@kurambit/contracts";
import { parseKurambitProjectFile } from "@kurambit/shared/kurambitProjectFile";
import { executeAtomQuery } from "@kurambit/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export async function readKurambitProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<KurambitProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, KURAMBIT_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    KURAMBIT_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseKurambitProjectFile(data.contents);
}
