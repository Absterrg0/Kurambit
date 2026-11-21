// @effect-diagnostics nodeBuiltinImport:off -- Reads the shipped agent text as a game gets it.
// An op the agent's text names but the tool no longer takes is refused on every call that
// follows the text: each game paid that refusal, every turn, after ops were retired.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  GameAssetsToolInput,
  GameBlenderToolInput,
  GameBuildsToolInput,
  GameCheckToolInput,
  GameCopyToolInput,
  GameKeepGoingToolInput,
  GamePlayToolInput,
} from "@kurambit/contracts";

const OPS: Readonly<Record<string, ReadonlyArray<string>>> = {
  game_assets: Object.keys(GameAssetsToolInput.fields),
  game_blender: Object.keys(GameBlenderToolInput.fields),
  game_builds: Object.keys(GameBuildsToolInput.fields),
  game_check: Object.keys(GameCheckToolInput.fields),
  game_copy: Object.keys(GameCopyToolInput.fields),
  game_keep_going: Object.keys(GameKeepGoingToolInput.fields),
  game_play: Object.keys(GamePlayToolInput.fields),
};

const templates = NodeURL.fileURLToPath(new URL("../../templates/", import.meta.url));
const agentText = [
  ...NodeFS.readdirSync(NodePath.join(templates, "studio"), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(md|json)$/.test(file))
    .map((file) => NodePath.join(templates, "studio", file)),
  NodePath.join(templates, "blank-three", "TEMPLATE.md"),
];

it("names only ops the game tools take", () => {
  const stale = agentText.flatMap((file) =>
    [...NodeFS.readFileSync(file, "utf8").matchAll(/`(game_[a-z_]+)` op `([a-z_]+)`/g)]
      .filter(([, tool, op]) => tool !== undefined && op !== undefined && !OPS[tool]?.includes(op))
      .map(([named]) => `${NodePath.relative(templates, file)}: ${named}`),
  );
  expect(stale).toEqual([]);
});
