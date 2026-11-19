// @effect-diagnostics nodeBuiltinImport:off -- Builds a scratch runtime folder with a link out of it.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

import type { GameManifest } from "@kurambit/contracts";
import { carriesOldShell, gameCanWin, runtimeRequestFile } from "./gameRuntime.ts";

it("serves a file of a known engine's major, and nothing outside the runtime", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-runtime-"));
  try {
    const runtimes = NodePath.join(root, "runtime");
    const shell = NodePath.join(runtimes, "three", "1", "shell");
    NodeFS.mkdirSync(shell, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(shell, "shell.js"), "//\n");
    NodeFS.writeFileSync(NodePath.join(root, "secret.txt"), "not the runtime's\n");
    NodeFS.symlinkSync(NodePath.join(root, "secret.txt"), NodePath.join(shell, "escape.js"));

    expect(await runtimeRequestFile(runtimes, "/_kurambit/runtime/three/1/shell/shell.js")).toBe(
      NodeFS.realpathSync(NodePath.join(shell, "shell.js")),
    );
    // A link inside the runtime that points out of it is refused.
    expect(await runtimeRequestFile(runtimes, "/_kurambit/runtime/three/1/shell/escape.js")).toBe(
      null,
    );
    for (const path of [
      "/_kurambit/runtime/nope/1/shell/shell.js",
      "/_kurambit/runtime/three/0/shell/shell.js",
      "/_kurambit/runtime/three/x/shell/shell.js",
      "/_kurambit/runtime/three/1/",
      "/_kurambit/runtime/three/1/shell//shell.js",
      "/_kurambit/runtime/three/1/./shell.js",
      "/shell/shell.js",
    ])
      expect(await runtimeRequestFile(runtimes, path), path).toBe(null);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("calls a page old only when it carries every screen of the older demo shell", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-old-shell-"));
  try {
    NodeFS.mkdirSync(NodePath.join(root, "web"));
    const manifest = { engine: { name: "three" }, project: "web" } as GameManifest;
    const page = (screens: ReadonlyArray<string>) =>
      NodeFS.writeFileSync(
        NodePath.join(root, "web", "index.html"),
        screens
          .map((id) => `<section class="screen screen-card" id="${id}" hidden></section>`)
          .join(""),
      );
    const all = ["loading", "title", "pause", "settings", "end", "credits", "controls"];
    page(all);
    expect(await carriesOldShell(root, manifest)).toBe(true);
    // A game that drew its own title (and kept some of the old ids) is not old.
    page(all.slice(1));
    expect(await carriesOldShell(root, manifest)).toBe(false);
    // The new template: no screens at all.
    NodeFS.copyFileSync(
      new URL("../../templates/blank-three/web/index.html", import.meta.url),
      NodePath.join(root, "web", "index.html"),
    );
    expect(await carriesOldShell(root, manifest)).toBe(false);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("says a game can be won only when its own code calls win()", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-can-win-"));
  try {
    const manifest = { engine: { name: "three" }, project: "web" } as GameManifest;
    const write = (file: string, text: string) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, file), text);
    };
    // No folder to read is not proof of no ending: the check stays.
    expect(await gameCanWin(root, manifest)).toBe(true);
    write(
      "web/src/main.js",
      "GameState.lose('The pond froze');\nhud.winStreak = 0;\nhud.window(1);\n",
    );
    // The runtime's and a vendored library's win() are not the game's.
    write("web/_kurambit/shell/run-state.js", "GameState.win('You win!');\n");
    write("web/vendor/lib.js", "api.win();\n");
    expect(await gameCanWin(root, manifest)).toBe(false);
    write("web/src/duel.js", "if (enemy.hp <= 0) GameState.win ('Victory');\n");
    expect(await gameCanWin(root, manifest)).toBe(true);
    // Another engine's code is not read: its check stays.
    expect(await gameCanWin(root, { ...manifest, engine: { name: "godot" } } as GameManifest)).toBe(
      true,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
