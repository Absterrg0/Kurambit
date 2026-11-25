// @effect-diagnostics nodeBuiltinImport:off -- Reads one small record inside a game folder.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Where a game is published, kept in the game so Update reuses its address. */
export const PUBLISHED_FILE = ".studio/published.json";

const Published = Schema.Struct({ slug: Schema.String, url: Schema.String });
const decodePublished = Schema.decodeUnknownOption(Schema.fromJsonString(Published));

/** The game's published address, or null when it is not published or the record is unreadable. */
export const readPublished = (root: string) =>
  Effect.promise(() =>
    NodeFSP.readFile(NodePath.join(root, PUBLISHED_FILE), "utf8").then(
      (text) => Option.getOrNull(decodePublished(text)),
      () => null,
    ),
  );
