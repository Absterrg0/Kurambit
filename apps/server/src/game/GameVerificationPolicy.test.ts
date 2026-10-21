// @effect-diagnostics nodeBuiltinImport:off -- Policy records live on the native filesystem beside the game.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type { GameManifest } from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import { designIntentFile } from "./GameDesignApproval.ts";

const manifest = (overrides: Partial<GameManifest> = {}): GameManifest => ({
  schemaVersion: 1,
  name: "Policy game",
  brief: "",
  artDirection: "",
  testSuite: "res://tests/smoke_test.gd",
  gameplayScene: "res://scenes/game.tscn",
  probe: true,
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
  ...overrides,
});

const withPolicyFixture = <A, E, R>(
  input: { readonly designDocument?: boolean },
  run: (fixture: {
    readonly root: string;
    readonly stateDir: string;
    readonly writeManifest: (value: GameManifest) => Effect.Effect<void>;
    readonly writeDesignDocument: (value: string) => Effect.Effect<void>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-policy-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "game.json"), JSON.stringify(manifest()));
        if (input.designDocument === true)
          await NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), "# Design\n");
      });
      return yield* run({
        root,
        stateDir,
        writeManifest: (value) =>
          Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(root, "game.json"), JSON.stringify(value)),
          ),
        writeDesignDocument: (value) =>
          Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), value)),
      }).pipe(Effect.provide(GameDesignApproval.layer({ stateDir })));
    }),
  );

it.effect("adopts an old game's policy once and ignores later manifest edits", () =>
  withPolicyFixture({}, ({ root, stateDir, writeManifest }) =>
    Effect.gen(function* () {
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      const adopted = yield* approvals.readPolicy(root, manifest());
      expect(adopted.policy).toEqual({
        testSuite: "res://tests/smoke_test.gd",
        gameplayScene: "res://scenes/game.tscn",
        probe: true,
      });
      const file = designIntentFile(stateDir, root);
      expect(JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8")))).toMatchObject(
        {
          verification: adopted.policy,
        },
      );
      // The manifest is a display mirror after adoption; editing it changes
      // nothing the service reads.
      yield* writeManifest(
        manifest({
          testSuite: "res://tests/trivial.gd",
          gameplayScene: "res://scenes/menu.tscn",
          probe: false,
        }),
      );
      const again = yield* approvals.readPolicy(root, manifest());
      expect(again).toEqual(adopted);
    }),
  ),
);

it.effect("adoption preserves a pre-record game's legacy design state", () =>
  withPolicyFixture({}, ({ root }) =>
    Effect.gen(function* () {
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      yield* approvals.readPolicy(root, manifest());
      // No DESIGN.md and no manifest design meant legacy; adoption must not turn
      // the game into a plan-first draft.
      expect(yield* approvals.readIntent(root)).toBe("skipped");
      expect((yield* approvals.status(root, manifest())).state).toBe("legacy");
    }),
  ),
);

it.effect("adoption keeps a document-owing game a draft", () =>
  withPolicyFixture({ designDocument: true }, ({ root }) =>
    Effect.gen(function* () {
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      const draft = manifest({ design: { status: "draft" } });
      yield* approvals.readPolicy(root, draft);
      expect(yield* approvals.readIntent(root)).toBe("required");
      expect((yield* approvals.status(root, draft)).state).toBe("draft");
    }),
  ),
);

it.effect("an explicit policy change gets a new revision", () =>
  withPolicyFixture({}, ({ root }) =>
    Effect.gen(function* () {
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      const before = yield* approvals.readPolicy(root, manifest());
      const after = yield* approvals.updatePolicy(root, {
        ...before.policy,
        testSuite: "res://tests/other.gd",
      });
      expect(after.revision).not.toBe(before.revision);
      expect((yield* approvals.readPolicy(root, manifest())).policy.testSuite).toBe(
        "res://tests/other.gd",
      );
      // The old record's `probe` mirror moves with the policy.
      expect(yield* approvals.readProbe(root)).toBe(before.policy.probe);
    }),
  ),
);

it.effect("a pre-27 game's probe files adopt the probe obligation on first read", () =>
  withPolicyFixture({}, ({ root, stateDir, writeManifest }) =>
    Effect.gen(function* () {
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      // The manifest mirrors no obligation, but the instrumented tree does.
      yield* writeManifest(manifest({ probe: false }));
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, "godot", "scripts"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot", "scripts", "studio_probe.gd"), "# probe\n"),
      );
      const adopted = yield* approvals.readPolicy(root, manifest({ probe: false }));
      expect(adopted.policy.probe).toBe(true);
      // The obligation is persisted once; deleting the probe files afterwards
      // cannot downgrade the policy — only an explicit policy change may.
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(root, "godot", "scripts", "studio_probe.gd")),
      );
      expect((yield* approvals.readPolicy(root, manifest({ probe: false }))).policy.probe).toBe(
        true,
      );
      expect(
        JSON.parse(
          yield* Effect.promise(() => NodeFSP.readFile(designIntentFile(stateDir, root), "utf8")),
        ),
      ).toMatchObject({ verification: { probe: true } });
    }),
  ),
);

it.effect("an autoload-only probe is adopted the same way", () =>
  withPolicyFixture({}, ({ root, writeManifest }) =>
    Effect.gen(function* () {
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      yield* writeManifest(manifest({ probe: false }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, "godot", "project.godot"),
          '[autoload]\nStudioProbe="*res://scripts/studio_probe.gd"\n',
        ),
      );
      expect((yield* approvals.readPolicy(root, manifest({ probe: false }))).policy.probe).toBe(
        true,
      );
    }),
  ),
);

it.effect("a game without any probe keeps its manifest-derived policy", () =>
  withPolicyFixture({}, ({ root }) =>
    Effect.gen(function* () {
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      const adopted = yield* approvals.readPolicy(root, manifest({ probe: false }));
      expect(adopted.policy.probe).toBe(false);
    }),
  ),
);
