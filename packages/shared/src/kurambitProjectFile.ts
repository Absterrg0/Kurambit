import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { KurambitProjectFile, KURAMBIT_PROJECT_FILE_SCHEMA_URL } from "@kurambit/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const KurambitProjectFileFromJson = fromLenientJson(KurambitProjectFile);

const decodeKurambitProjectFile = Schema.decodeExit(KurambitProjectFileFromJson);

export function parseKurambitProjectFile(contents: string): KurambitProjectFile | null {
  const decoded = decodeKurambitProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildKurambitProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(KurambitProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: KURAMBIT_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
