import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { KurambitProjectFile } from "@kurambit/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const KurambitProjectFileFromJson = fromLenientJson(KurambitProjectFile);

const decodeKurambitProjectFile = Schema.decodeExit(KurambitProjectFileFromJson);

export function parseKurambitProjectFile(contents: string): KurambitProjectFile | null {
  const decoded = decodeKurambitProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}
