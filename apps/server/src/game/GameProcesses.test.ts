// @effect-diagnostics nodeBuiltinImport:off -- Exercise real child process ownership and filesystem logs.
import { it, expect } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "kills owned group descendants after the wrapper leader exits first",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;
        const processes = yield* GameProcesses.GameProcesses;
        // A wrapper that exits while its redirected child survives in the
        // owned group: the old stop() returned early once the leader's
        // exitCode was set and orphaned the child. The fix TERMs the group by
        // captured PGID on close even after the leader is gone.
        //
        // The handshake is event-ordered, never sleep-polled: the grandchild
        // installs its SIGTERM trap first and only then writes its ready
        // file, so a TERM can never land during Node boot (when the default
        // disposition would kill it before the trap exists). The wrapper
        // exits once the ready file appears, which is what orphans the group.
        const pidFile = NodePath.join(root, "wrapper-child.pid");
        const readyFile = NodePath.join(root, "wrapper-child.ready");
        const termedFile = NodePath.join(root, "child-termed");
        const readyBase = NodePath.basename(readyFile);
        const childSource = [
          `process.on("SIGTERM",()=>{require("node:fs").writeFileSync(${JSON.stringify(termedFile)},"termed");process.exit(0);});`,
          `require("node:fs").writeFileSync(${JSON.stringify(readyFile)},"ready");`,
          `setInterval(()=>{},1000);`,
        ].join("");
        const wrapper = [
          `const {spawn} = require("node:child_process");`,
          `const fs = require("node:fs");`,
          `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], {stdio: "ignore"});`,
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
          `child.unref();`,
          `const bail = setTimeout(()=>process.exit(3), 10000);`,
          `const leave = () => { clearTimeout(bail); process.exit(0); };`,
          `if (fs.existsSync(${JSON.stringify(readyFile)})) leave();`,
          `else { const watcher = fs.watch(${JSON.stringify(root)}, (_event, name) => { if (name === ${JSON.stringify(readyBase)}) { watcher.close(); leave(); } }); }`,
        ].join("");
        const watcher = yield* Effect.acquireRelease(
          Effect.sync(() => NodeFS.watch(root)),
          (watch) => Effect.sync(() => watch.close()),
        );
        const waitFor = (file: string, label: string) =>
          new Promise<void>((resolve, reject) => {
            // @effect-diagnostics-next-line globalTimers:off -- Bounds the group-kill handshake on failure; success resolves on the child's file write.
            const timer = setTimeout(() => reject(new Error(label)), 10_000);
            const name = NodePath.basename(file);
            const check = () => {
              NodeFSP.access(file)
                .then(() => {
                  clearTimeout(timer);
                  resolve();
                })
                .catch(() => undefined);
            };
            watcher.on("change", (_event, filename) => {
              if (filename === name) check();
            });
            check();
          });
        const owned = yield* processes.start({
          root,
          executable: process.execPath,
          args: ["-e", wrapper],
          operation: "native-capture",
          ownedProcessGroup: true,
        });
        yield* Effect.promise(() => waitFor(pidFile, "wrapper child never reported"));
        const descendantPid = Number(
          yield* Effect.promise(() => NodeFSP.readFile(pidFile, "utf8")),
        );
        expect(Number.isInteger(descendantPid)).toBe(true);
        // Wait until the trap is installed before anything may signal the
        // group: a TERM during Node boot would kill with the default
        // disposition instead of reaching the handler. The wrapper exits once
        // this file appears, which is what orphans the group; stop() then
        // covers whichever state the leader is in, and the close handler
        // covers the rest.
        yield* Effect.promise(() => waitFor(readyFile, "wrapper child never became ready"));
        yield* processes.stop(root);
        yield* Effect.promise(() => waitFor(termedFile, "group SIGTERM never reached the child"));
        expect(() => process.kill(owned.pid, 0)).toThrow();
        expect(() => process.kill(descendantPid, 0)).toThrow();
        expect(processes.list(root)).toEqual([]);
      }).pipe(Effect.provide(GameProcesses.layer)),
    ),
);
it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "kills an owned Linux process group and scopes extra env to one child",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporary;
        const processes = yield* GameProcesses.GameProcesses;
        // A wrapper's display server and engine child share its group; they must
        // die by group id, while an unrelated child is never matched by name.
        const script = [
          `if (process.env.STUDIO_CAPTURE_PROBE !== "scoped") process.exit(3);`,
          `const {spawn} = require("node:child_process");`,
          `const fs = require("node:fs");`,
          `const descendant = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio: "ignore"});`,
          `fs.writeFileSync(process.argv[1], String(descendant.pid));`,
          `setInterval(()=>{},1000);`,
        ].join("");
        const watcher = yield* Effect.acquireRelease(
          Effect.sync(() => NodeFS.watch(root)),
          (watch) => Effect.sync(() => watch.close()),
        );
        const ready = new Promise<void>((resolve, reject) => {
          // @effect-diagnostics-next-line globalTimers:off -- Bounds the group-kill handshake on failure; success resolves on the child's first write.
          const timer = setTimeout(() => reject(new Error("group child never reported")), 10_000);
          watcher.on("change", (_event, filename) => {
            if (filename === "grandchild.pid") {
              clearTimeout(timer);
              resolve();
            }
          });
        });
        const grandchildFile = NodePath.join(root, "grandchild.pid");
        const owned = yield* processes.start({
          root,
          executable: process.execPath,
          args: ["-e", script, grandchildFile],
          operation: "native-capture",
          env: { STUDIO_CAPTURE_PROBE: "scoped" },
          ownedProcessGroup: true,
        });
        const other = yield* processes.start({
          root: NodePath.join(root, "other"),
          executable: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          operation: "native",
        });
        yield* Effect.promise(() => ready);
        const descendantPid = Number(
          yield* Effect.promise(() => NodeFSP.readFile(grandchildFile, "utf8")),
        );
        expect(Number.isInteger(descendantPid)).toBe(true);
        yield* processes.stop(root);
        expect(() => process.kill(owned.pid, 0)).toThrow();
        expect(() => process.kill(descendantPid, 0)).toThrow();
        expect(() => process.kill(other.pid, 0)).not.toThrow();
        expect(processes.list(root)).toEqual([]);
      }).pipe(Effect.provide(GameProcesses.layer)),
    ),
);
