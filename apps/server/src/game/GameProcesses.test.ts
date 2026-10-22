// @effect-diagnostics nodeBuiltinImport:off -- Exercise real child process ownership and filesystem logs.
import { it, expect } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as GameProcesses from "./GameProcesses.ts";
const temporary = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-process-"))),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);
afterEach(() => vi.unstubAllEnvs());
const displayProbe =
  "process.stdout.write(JSON.stringify({display: process.env.DISPLAY ?? null, wayland: process.env.WAYLAND_DISPLAY ?? null, xauthority: process.env.XAUTHORITY ?? null}))";
it.effect("reports a spawn failure without leaving a tracked process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporary;
      const processes = yield* GameProcesses.GameProcesses;
      const result = yield* Effect.result(
        processes.start({
          root,
          executable: NodePath.join(root, "missing-executable"),
          args: [],
          operation: "native",
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(processes.list(root)).toEqual([]);
    }).pipe(Effect.provide(GameProcesses.layer)),
  ),
);
it.effect("captures command failure and output in a real log", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporary;
      const result = yield* Effect.gen(function* () {
        const processes = yield* GameProcesses.GameProcesses;
        return yield* processes.run({
          root,
          executable: process.execPath,
          args: [
            "-e",
            "process.stdout.write('hello'); process.stderr.write('broken'); process.exitCode=7",
          ],
          operation: "test",
        });
      }).pipe(Effect.provide(GameProcesses.layer));
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toBe("hello");
      expect(result.stderr).toBe("broken");
      expect(yield* Effect.promise(() => NodeFSP.readFile(result.logPath, "utf8"))).toContain(
        "broken",
      );
    }),
  ),
);
it.effect(
  "strips every display route from headless children and keeps it only for a watched game",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;
        vi.stubEnv("DISPLAY", ":0");
        vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
        vi.stubEnv("XAUTHORITY", "/run/user/1000/xauth");
        const processes = yield* GameProcesses.GameProcesses;
        const headless = yield* processes.run({
          root,
          executable: process.execPath,
          args: ["-e", displayProbe],
          operation: "godot-check",
        });
        expect(JSON.parse(headless.stdout)).toEqual({
          display: null,
          wayland: null,
          xauthority: null,
        });
        // The creator's own Play action is the only child that may see a display.
        const watched = yield* processes.run({
          root,
          executable: process.execPath,
          args: ["-e", displayProbe],
          operation: "native",
          display: "inherit",
        });
        expect(JSON.parse(watched.stdout)).toEqual({
          display: ":0",
          wayland: "wayland-0",
          xauthority: "/run/user/1000/xauth",
        });
      }).pipe(Effect.provide(GameProcesses.layer)),
    ),
);
it.effect("stops exactly the owned game's PID and closes remaining processes on scope exit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporary;
      let otherPid = -1;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const processes = yield* GameProcesses.GameProcesses;
          const owned = yield* processes.start({
            root,
            executable: process.execPath,
            args: ["-e", "setInterval(()=>{},1000)"],
            operation: "native",
          });
          const other = yield* processes.start({
            root: NodePath.join(root, "other"),
            executable: process.execPath,
            args: ["-e", "setInterval(()=>{},1000)"],
            operation: "native",
          });
          otherPid = other.pid;
          yield* processes.stop(root);
          expect(() => process.kill(owned.pid, 0)).toThrow();
          expect(() => process.kill(other.pid, 0)).not.toThrow();
          expect(processes.list(root)).toEqual([]);
        }).pipe(Effect.provide(GameProcesses.layer)),
      );
      expect(() => process.kill(otherPid, 0)).toThrow();
    }),
  ),
);
it.effect("times out a hung process and records its termination", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporary;
      const result = yield* Effect.gen(function* () {
        const processes = yield* GameProcesses.GameProcesses;
        return yield* processes.run({
          root,
          executable: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          operation: "test",
          timeoutMs: 100,
        });
      }).pipe(Effect.provide(GameProcesses.layer));
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(() => process.kill(result.pid, 0)).toThrow();
    }),
  ),
);
