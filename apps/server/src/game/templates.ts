import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { GameOperationError, type GameTemplateId } from "@t3tools/contracts";

const gameNamePlaceholder = "{{GAME_NAME}}";
/**
 * Escaped variant for engine string literals. It carries no quotes of its own, so
 * template authors write `config/name="{{GAME_NAME_ESCAPED}}"`, and a game name
 * containing `"` or `\` cannot break the file it lands in.
 */
const gameNameEscapedPlaceholder = "{{GAME_NAME_ESCAPED}}";

// Text files receive placeholder substitution; everything else is copied byte for byte.
const textFileExtensions = [
  ".godot",
  ".tscn",
  ".tres",
  ".gd",
  ".cfg",
  ".md",
  ".json",
  ".html",
  ".css",
  ".js",
];

export const isTemplateTextFile = (relativePath: string): boolean =>
  textFileExtensions.some((extension) => relativePath.endsWith(extension));

export const substituteGameName = (text: string, gameName: string): string =>
  text
    .replaceAll(gameNameEscapedPlaceholder, JSON.stringify(gameName).slice(1, -1))
    .replaceAll(gameNamePlaceholder, gameName);

export const templateDirectoryCandidates = (
  dirname: string,
  join: (left: string, right: string) => string,
): readonly [string, string] => [join(dirname, "templates"), join(dirname, "../../templates")];

export const resolveTemplatesDirectory = Effect.fn("GameTemplates.resolveDirectory")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The packed server ships templates beside its bundle (dist/templates); in the
  // dev tree this module lives in src/game, with templates at apps/server/templates.
  const [bundled, monorepo] = templateDirectoryCandidates(import.meta.dirname, (left, right) =>
    path.join(left, right),
  );
  for (const candidate of [bundled, monorepo])
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
  return yield* new GameOperationError({
    operation: "resolve-templates",
    path: bundled,
    reason: "starter-templates-missing",
  });
});

const copyTemplateEntry = Effect.fnUntraced(function* (input: {
  readonly source: string;
  readonly target: string;
  readonly relativePath: string;
  readonly gameName: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.stat(input.source);
  if (info.type === "Directory") {
    yield* fs.makeDirectory(input.target, { recursive: true });
    return;
  }
  yield* fs.makeDirectory(path.dirname(input.target), { recursive: true });
  if (!isTemplateTextFile(input.relativePath)) {
    yield* fs.copyFile(input.source, input.target);
    return;
  }
  const text = yield* fs.readFileString(input.source);
  yield* fs.writeFileString(input.target, substituteGameName(text, input.gameName));
});

const copyFailure = (path: string) => (cause: unknown) =>
  new GameOperationError({ operation: "copy-template", path, reason: "io", cause });

/**
 * Copies a starter template's engine tree (`godot/`, `web/`, whichever the
 * template ships) and `TEMPLATE.md` into a new game folder, substituting the
 * game name in text files.
 */
export const copyTemplateIntoGame = Effect.fn("GameTemplates.copyIntoGame")(function* (input: {
  readonly templatesDirectory: string;
  readonly templateId: GameTemplateId;
  readonly gameRoot: string;
  readonly gameName: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const templateDirectory = path.join(input.templatesDirectory, input.templateId);
  const hasTemplateMeta = yield* fs
    .exists(path.join(templateDirectory, "template.json"))
    .pipe(Effect.orElseSucceed(() => false));
  if (!hasTemplateMeta)
    return yield* new GameOperationError({
      operation: "copy-template",
      path: input.templateId,
      reason: "unknown-template",
    });
  for (const tree of ["godot", "web"]) {
    const treeSource = path.join(templateDirectory, tree);
    const treeExists = yield* fs.exists(treeSource).pipe(Effect.orElseSucceed(() => false));
    if (!treeExists) continue;
    const treeTarget = path.join(input.gameRoot, tree);
    const entries = yield* fs
      .readDirectory(treeSource, { recursive: true })
      .pipe(Effect.mapError(copyFailure(treeSource)));
    for (const relative of entries) {
      const source = path.join(treeSource, relative);
      yield* copyTemplateEntry({
        source,
        target: path.join(treeTarget, relative),
        relativePath: relative,
        gameName: input.gameName,
      }).pipe(Effect.mapError(copyFailure(source)));
    }
  }
  const templateDocument = path.join(templateDirectory, "TEMPLATE.md");
  const document = yield* fs
    .readFileString(templateDocument)
    .pipe(Effect.mapError(copyFailure(templateDocument)));
  yield* fs
    .writeFileString(
      path.join(input.gameRoot, "TEMPLATE.md"),
      substituteGameName(document, input.gameName),
    )
    .pipe(Effect.mapError(copyFailure("TEMPLATE.md")));
});
