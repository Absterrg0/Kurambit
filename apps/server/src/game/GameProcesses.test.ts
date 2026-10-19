// @effect-diagnostics nodeBuiltinImport:off -- Exercise real child process ownership and filesystem logs.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as GameProcesses from "./GameProcesses.ts";
const temporary = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-process-"))),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
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
