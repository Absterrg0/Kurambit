import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { GameOperationError, type GameTemplateId } from "@kurambit/contracts";
import { PROFILES } from "./engineProfile.ts";

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
  // Unity's ProjectSettings.asset carries the product name.
  ".asset",
];

const isTemplateTextFile = (relativePath: string): boolean =>
  textFileExtensions.some((extension) => relativePath.endsWith(extension));

const substituteGameName = (text: string, gameName: string): string =>
  text
    .replaceAll(gameNameEscapedPlaceholder, JSON.stringify(gameName).slice(1, -1))
    .replaceAll(gameNamePlaceholder, gameName);

/**
 * Unity identifies a project by the productGUID in ProjectSettings.asset
 * (player prefs, analytics, cloud links); every game gets its own instead of
 * the template's.
 */
const withProductGuid = (relativePath: string, text: string, guid: string): string =>
  relativePath.endsWith("ProjectSettings.asset")
    ? text.replace(/^(\s*productGUID: )[0-9a-f]{32}$/m, `$1${guid}`)
    : text;

const copyTemplateEntry = Effect.fnUntraced(function* (input: {
  readonly source: string;
  readonly target: string;
  readonly relativePath: string;
  readonly gameName: string;
  readonly productGuid: string;
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
  yield* fs.writeFileString(
    input.target,
    withProductGuid(
      input.relativePath,
      substituteGameName(text, input.gameName),
      input.productGuid,
    ),
  );
});

const copyFailure = (path: string) => (cause: unknown) =>
  new GameOperationError({ operation: "copy-template", path, reason: "io", cause });

/**
 * Copies a starter template's engine tree (`godot/`, `web/`, `unity/`, whichever the
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
  // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off -- A per-game project id, not a secret; the template copy needs no Crypto service for it.
  const productGuid = globalThis.crypto.randomUUID().replaceAll("-", "");
  for (const tree of PROFILES.map((profile) => profile.projectDirectory)) {
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
        productGuid,
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
