// @effect-diagnostics nodeBuiltinImport:off -- A scratch game folder.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { recipeLines } from "./recipes.ts";

const RECIPE = `# Opens on the game

## Checks

\`\`\`yaml
- probe: player.cover
  label: covered
  want: "<= 0.3"
- fact: scene.report.player.contrast
  label: player ΔE
  want: ">= 20"
- agent: "one key starts play"
\`\`\`
`;

it.effect("reads picked recipes from the game only, and reports what it measured", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "recipes-"));
    NodeFS.mkdirSync(NodePath.join(root, "studio-skills/recipes"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "studio-skills/recipes/opens-on-game.md"), RECIPE);
    const lines = yield* recipeLines(root, ["opens-on-game", "../../etc/passwd", "a", "b"], {
      player: { status: "measured", report: { cover: 0.62 } },
    });
    expect(lines).toEqual([
      "recipe opens-on-game 1/2 measured · covered 0.62 (aim <= 0.3 ✗) · not measured: player ΔE · 1 by your own test",
      "recipe ../../etc/passwd: not a recipe id (studio-skills/AGENTS.md lists them)",
      "recipe a: no studio-skills/recipes/a.md (studio-skills/AGENTS.md lists them)",
      "recipes past the first 3 are not read: b",
    ]);
  }),
);
