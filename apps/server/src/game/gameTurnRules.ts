// @effect-diagnostics nodeBuiltinImport:off -- Run execution reads the game record before any game service exists for it.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { GameManifest } from "@kurambit/contracts";

import { gameTurnRules } from "./scaffold.ts";

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(GameManifest));

/**
 * The harness rules for a turn that runs in `cwd`: its game's turn rules when the folder holds a
 * game, by the engine in its game.json; none for any other thread. It reads the folder rather
 * than asking GameProjectService, which launches threads through orchestration and so cannot be a
 * dependency of run execution.
 */
export const turnRulesForWorkspace = (cwd: string | null) =>
  cwd === null
    ? Effect.succeed(undefined)
    : Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(cwd, "game.json"), "utf8").catch(() => null),
      ).pipe(
        Effect.map((text) => {
          const manifest = text === null ? Option.none() : decodeManifest(text);
          return Option.isSome(manifest) ? gameTurnRules(manifest.value.engine.name) : undefined;
        }),
      );
