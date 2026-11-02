import {
  KURAMBIT_PROJECT_FILE_NAME,
  type EnvironmentId,
  type KurambitProjectFile,
  type KurambitProjectFileScript,
} from "@kurambit/contracts";
import { parseKurambitProjectFile } from "@kurambit/shared/kurambitProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<KurambitProjectFileScript> = [];

export interface KurambitProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: KurambitProjectFile | null;
  scripts: ReadonlyArray<KurambitProjectFileScript>;
}

export function useKurambitProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): KurambitProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    KURAMBIT_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
    } as const;
  }
  const file = parseKurambitProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
}

export function useKurambitProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<KurambitProjectFileScript> {
  return useKurambitProjectFileState(environmentId, cwd).scripts;
}
