import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { KURAMBIT_PROJECT_FILE_NAME, type KurambitProjectFile } from "@kurambit/contracts";
import { KurambitProjectFileFromJson } from "@kurambit/shared/kurambitProjectFile";

const decodeKurambitProjectFileJson = Schema.decodeEffect(KurambitProjectFileFromJson);

export class KurambitProjectFileLoadError extends Schema.TaggedError<KurambitProjectFileLoadError>()(
  "KurambitProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${KURAMBIT_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

export class KurambitProjectFileLoader extends Context.Service<
  KurambitProjectFileLoader,
  {
    /**
     * Never fails: missing, unreadable, or invalid files resolve to `Option.none` (invalid files
     * are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<KurambitProjectFile>>;
  }
>()("kurambit/project/KurambitProjectFileLoader") {}

const logKurambitProjectFileLoadError = (error: KurambitProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: KurambitProjectFileLoader["Service"]["load"] = Effect.fn(
    "KurambitProjectFileLoader.load",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, KURAMBIT_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logKurambitProjectFileLoadError(
                new KurambitProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<KurambitProjectFile>();
    }
    return yield* decodeKurambitProjectFileJson(raw.value).pipe(
      Effect.asSome,
      Effect.catchTags({
        SchemaError: (error) =>
          logKurambitProjectFileLoadError(
            new KurambitProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<KurambitProjectFile>())),
      }),
    );
  });

  return KurambitProjectFileLoader.of({ load });
});

export const layer = Layer.effect(KurambitProjectFileLoader, make);
