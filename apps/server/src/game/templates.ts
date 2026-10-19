import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { GameOperationError, type GameTemplateId } from "@t3tools/contracts";

const gameNamePlaceholder = "{{GAME_NAME}}";
/** Quoted, escaped variant for engine config values: a name containing `"` or `\` cannot break them. */
const gameNameStringPlaceholder = "{{GAME_NAME_STRING}}";

// Text files receive placeholder substitution; everything else is copied byte for byte.
const textFileExtensions = [".godot", ".tscn", ".tres", ".gd", ".cfg", ".md", ".json"];

export const isTemplateTextFile = (relativePath: string): boolean =>
  textFileExtensions.some((extension) => relativePath.endsWith(extension));

export const substituteGameName = (text: string, gameName: string): string =>
  text
    .replaceAll(gameNameStringPlaceholder, JSON.stringify(gameName))
    .replaceAll(gameNamePlaceholder, gameName);

export const resolveTemplatesDirectory = Effect.fn("GameTemplates.resolveDirectory")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The packed server ships templates beside its bundle (dist/templates); in the
  // dev tree this module lives in src/game, with templates at apps/server/templates.
  const bundled = path.join(import.meta.dirname, "templates");
  const monorepo = path.join(import.meta.dirname, "../../templates");
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
 * Copies a starter template's `godot/` tree and `TEMPLATE.md` into a new game
 * folder, substituting the game name in text files.
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
  const godotSource = path.join(templateDirectory, "godot");
  const godotTarget = path.join(input.gameRoot, "godot");
  const entries = yield* fs
    .readDirectory(godotSource, { recursive: true })
    .pipe(Effect.mapError(copyFailure(godotSource)));
  for (const relative of entries) {
    const source = path.join(godotSource, relative);
    yield* copyTemplateEntry({
      source,
      target: path.join(godotTarget, relative),
      relativePath: relative,
      gameName: input.gameName,
    }).pipe(Effect.mapError(copyFailure(source)));
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
