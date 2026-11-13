// @effect-diagnostics nodeBuiltinImport:off -- A real repository on disk is what the identity reads.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeSourceIdentity } from "./sourceTree.ts";
import { UNITY_PROFILE } from "./unityProfile.ts";

const layer = Layer.mergeAll(
  CheckpointStore.layer.pipe(
    Layer.provide(
      VcsDriverRegistry.layer.pipe(
        Layer.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
      ),
    ),
  ),
  GitVcsDriver.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "source-tree-" })),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const game = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "source-tree-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  NodeFS.mkdirSync(NodePath.join(root, "web"));
  NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), "web/cache/\n");
  NodeFS.writeFileSync(NodePath.join(root, "web", "main.js"), "export {};\n");
  git("add", "-A");
  git("commit", "-qm", "game");
  return {
    root,
    write: (path: string, text: string) => NodeFS.writeFileSync(NodePath.join(root, path), text),
  };
};

const known = (identity: { readonly kind: string; readonly sourceId?: string }) => {
  assert.equal(identity.kind, "known");
  return identity.sourceId;
};

it.effect(
  "is the working folder's content: edits and new files move it, ignored files and the rest of the game do not",
  () =>
    Effect.gen(function* () {
      const identify = yield* makeSourceIdentity;
      const { root, write } = game();
      const first = known(yield* identify(root, "web", null));
      assert.equal(known(yield* identify(root, "web", null)), first);
      write("BRIEF.md", "notes\n");
      NodeFS.mkdirSync(NodePath.join(root, "web", "cache"));
      write("web/cache/x.bin", "output\n");
      assert.equal(known(yield* identify(root, "web", null)), first);
      write("web/extra.js", "export {};\n");
      const added = known(yield* identify(root, "web", null));
      assert.notEqual(added, first);
      write("web/main.js", "export const x = 1;\n");
      assert.notEqual(known(yield* identify(root, "web", null)), added);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(layer)),
);

it.effect("refuses a link in the engine folder, whatever it points at", () =>
  Effect.gen(function* () {
    const identify = yield* makeSourceIdentity;
    const { root } = game();
    NodeFS.symlinkSync(NodeOS.homedir(), NodePath.join(root, "web", "home"));
    const identity = yield* identify(root, "web", null);
    assert.deepStrictEqual(identity, { kind: "unknown", reason: "symlink", detail: "web/home" });
    NodeFS.rmSync(root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("reads Unity's runtime settings list as derived, and every other byte as itself", () =>
  Effect.gen(function* () {
    const identify = yield* makeSourceIdentity;
    const { root, write } = game();
    const settings = (list: string) =>
      `MonoBehaviour:\n  m_RuntimeSettings:\n    m_List:${list}\n  m_Other: 1\n`;
    write("web/URP.asset", settings(" []\n"));
    const empty = known(yield* identify(root, "web", UNITY_PROFILE.derivedInput));
    write("web/URP.asset", settings("\n    - rid: 42\n    - rid: -7\n"));
    assert.equal(known(yield* identify(root, "web", UNITY_PROFILE.derivedInput)), empty);
    write("web/URP.asset", settings(" []\n").replace("m_Other: 1", "m_Other: 2"));
    assert.notEqual(known(yield* identify(root, "web", UNITY_PROFILE.derivedInput)), empty);
    NodeFS.rmSync(root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("gives a build's copy, which is no repository, the game folder's identity", () =>
  Effect.gen(function* () {
    const identify = yield* makeSourceIdentity;
    const { root, write } = game();
    write("web/URP.asset", "MonoBehaviour:\n  m_RuntimeSettings:\n    m_List: []\n");
    NodeFS.mkdirSync(NodePath.join(root, "web", "cache"));
    write("web/cache/x.bin", "output\n");
    const copy = `${root}-copy`;
    NodeFS.cpSync(root, copy, { recursive: true, filter: (from) => !from.endsWith(".git") });
    for (const derived of [null, UNITY_PROFILE.derivedInput])
      assert.equal(
        known(yield* identify(copy, "web", derived)),
        known(yield* identify(root, "web", derived)),
      );
    NodeFS.symlinkSync(NodeOS.homedir(), NodePath.join(copy, "web", "home"));
    assert.equal((yield* identify(copy, "web", null)).kind, "unknown");
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(copy, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);
