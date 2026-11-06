// @effect-diagnostics nodeBuiltinImport:off -- A fake release writes its artifact into the staging folder it is given.
// A driver that behaves by the engine contract (CONTRACT §5) for tests of the
// code above the drivers (the run, explore, bots): the game's own failures are
// results, a tool's or the machine's are failures of the given reason, and a
// release writes a real artifact where the core asked for it.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import {
  GameOperationError,
  manifestProject,
  type GameActionResult,
  type GameCheckIssue,
  type GameEngineId,
} from "@kurambit/contracts";
import { engineProfile } from "./engineProfile.ts";
import { GameEngine, type GameEngineBackend, type GameEngineCheckReport } from "./GameEngine.ts";

type Step = "import" | "check" | "release";

export interface FakeDriverScript {
  /** Check errors the game has (a measured failure); none passes. */
  readonly checkErrors?: ReadonlyArray<GameCheckIssue>;
  /** Import errors the game has; none imports cleanly. */
  readonly importErrors?: ReadonlyArray<GameCheckIssue>;
  /**
   * Steps that fail on their own (a tool or the machine), with the reason and
   * how many times; each call spends one.
   */
  readonly faults?: Partial<
    Record<Step, { readonly reason: GameOperationError["reason"]; times: number }>
  >;
}

const processOf = (exitCode: number) => ({
  pid: 0,
  exitCode,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  logPath: "/dev/null",
});

const action = (
  success: boolean,
  message: string,
  path: string | null = null,
): GameActionResult => ({
  success,
  message,
  path,
  url: null,
  process: processOf(success ? 0 : 1),
});

/** One engine's driver, scripted; its profile is the engine's real one. */
export const fakeDriver = (
  engine: GameEngineId,
  script: FakeDriverScript = {},
): GameEngineBackend => {
  const profile = engineProfile(engine);
  const faults = { ...script.faults };
  const fault = (step: Step, path: string) =>
    Effect.suspend(() => {
      const planned = faults[step];
      if (planned === undefined || planned.times <= 0) return Effect.void;
      planned.times -= 1;
      return Effect.fail(
        new GameOperationError({
          operation: `fake ${step}`,
          path,
          reason: planned.reason,
          detail: `The fake driver's ${step} failed (${planned.reason}).`,
        }),
      );
    });
  const importErrors = script.importErrors ?? [];
  return {
    profile,
    resolveProject: (root, manifest) =>
      Effect.succeed({
        projectName: manifestProject(manifest),
        projectDir: NodePath.join(root, manifestProject(manifest)),
        binary: { path: `/fake/${engine}`, version: "0", templates: null },
      }),
    toolStatus: () => Effect.succeed(null),
    viewport: () => Effect.succeed(profile.viewport ?? { width: 1280, height: 720 }),
    projectSettingsFile: "project",
    projectDirectory: (manifest) => manifestProject(manifest),
    projectSettings: () => ({ viewport: profile.viewport ?? { width: 1280, height: 720 } }),
    importProject: (ctx) =>
      Effect.as(fault("import", ctx.root), {
        result: action(
          importErrors.length === 0,
          importErrors.length === 0 ? "Imported." : "Import failed.",
        ),
        issues: importErrors,
      }),
    runCheck: (ctx, input) =>
      Effect.as(fault("check", ctx.root), {
        reported: {
          entries: input.gameplayScene === "" ? ["main"] : ["main", "gameplay"],
          errors: script.checkErrors ?? [],
          warnings: [],
        },
        issues: [],
        run: processOf(0),
      } satisfies GameEngineCheckReport),
    exportReady: () => Effect.void,
    exportPreset: (_ctx, target) => Effect.succeed({ name: target, added: false }),
    release: (ctx, input) =>
      Effect.gen(function* () {
        yield* fault("release", ctx.root);
        const artifact = input.target === "Web" ? "index.html" : "game";
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(input.staging, artifact),
            `fake ${input.target} release\n`,
          ),
        );
        return {
          result: action(
            true,
            `Fake ${input.target} release.`,
            NodePath.join(input.staging, artifact),
          ),
          artifact,
          notes: [],
        };
      }),
    editor: null,
    playProcess: null,
    player: null,
  };
};

/**
 * A GameEngine service over fake drivers, for tests that provide GameEngine
 * directly. `check` reads the driver's scripted check the way the real one
 * does: errors are a failed result, faults fail the call.
 */
export const fakeGameEngine = (
  drivers: Partial<Record<GameEngineId, GameEngineBackend>>,
  manifestOf: (
    root: string,
  ) => Effect.Effect<{ readonly engine: GameEngineId; readonly project: string }>,
) => {
  const backendFor = (name: string) => {
    const driver = drivers[name as GameEngineId];
    return driver === undefined
      ? Effect.fail(
          new GameOperationError({
            operation: "resolve-engine",
            path: name,
            reason: "invalid-input",
            detail: `No fake driver for ${name}.`,
          }),
        )
      : Effect.succeed(driver);
  };
  const context = (root: string) =>
    Effect.gen(function* () {
      const manifest = yield* manifestOf(root);
      const backend = yield* backendFor(manifest.engine);
      return {
        backend,
        ctx: {
          root,
          projectName: manifest.project,
          projectDir: NodePath.join(root, manifest.project),
          binary: { path: "", version: "0", templates: null },
        },
      };
    });
  return GameEngine.of({
    backendFor,
    context,
    importProject: (root) =>
      Effect.flatMap(context(root), ({ backend, ctx }) =>
        Effect.map(backend.importProject(ctx), (imported) => imported.result),
      ),
    check: (root) =>
      Effect.flatMap(context(root), ({ backend, ctx }) =>
        Effect.map(backend.runCheck(ctx, { gameplayScene: "" }), (report) => ({
          ok: (report.reported?.errors.length ?? 1) === 0,
          errors: [...(report.reported?.errors ?? [])],
          warnings: [...(report.reported?.warnings ?? [])],
          entries: [...(report.reported?.entries ?? [])],
          durationMs: 0,
        })),
      ),
    toolStatus: () => Effect.succeed(null),
    viewport: (root) =>
      Effect.flatMap(context(root), ({ backend, ctx }) => backend.viewport(ctx.projectDir)),
  });
};
