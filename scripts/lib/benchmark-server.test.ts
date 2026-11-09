// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The test inspects the spawn environment a real server would receive and proves detached-group cleanup.
import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@kurambit/shared/HostProcess";
import {
  benchmarkServerSpawn,
  externalServerOrigin,
  seedBenchmarkProviderSettings,
  stopBenchmarkServerAt,
  type BenchmarkServerSpawn,
} from "./benchmark-server.ts";
import { DISPLAY_VARIABLES, sandboxDisplayEnvironment } from "./display-sandbox.ts";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate: () => boolean, attempts = 200): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for a process state.");
};

describe("externalServerOrigin", () => {
  it("refuses an external server unless the caller opts in", () => {
    assert.throws(
      () => externalServerOrigin({ url: "http://localhost:540", allowExternalServer: false }),
      /Refusing to run harness work against the external server/,
    );
    assert.equal(
      externalServerOrigin({ url: "http://localhost:540", allowExternalServer: true }),
      "http://localhost:540",
    );
  });

  it("returns null when the runner should start its own server", () => {
    assert.equal(externalServerOrigin({ url: undefined, allowExternalServer: false }), null);
  });
});

describe("seedBenchmarkProviderSettings", () => {
  const withHome = async (run: (home: string) => Promise<void>) => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "benchmark-settings-"));
    try {
      await run(home);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  };
  const readSettings = async (home: string) =>
    JSON.parse(
      await NodeFSP.readFile(NodePath.join(home, "userdata", "settings.json"), "utf8"),
    ) as {
      providerInstances: Record<string, { driver: string; enabled: boolean; config?: unknown }>;
    };

  it("enables the requested provider in a fresh private home", () =>
    withHome(async (home) => {
      await seedBenchmarkProviderSettings({ homeDir: home, provider: "opencode" });
      const settings = await readSettings(home);
      assert.deepEqual(settings.providerInstances, {
        opencode: { driver: "opencode", enabled: true },
      });
    }));

  it("keeps the rest of the home's settings and the instance's own config", () =>
    withHome(async (home) => {
      const directory = NodePath.join(home, "userdata");
      await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(directory, "settings.json"),
        JSON.stringify({
          responseStreamingMode: "turn",
          providerInstances: {
            codex: { driver: "codex", enabled: false },
            opencode: {
              driver: "opencode",
              enabled: false,
              config: { model: "chosen-by-the-operator" },
            },
          },
        }),
      );
      await seedBenchmarkProviderSettings({ homeDir: home, provider: "opencode" });
      const settings = await readSettings(home);
      assert.equal(
        (settings as unknown as { responseStreamingMode: string }).responseStreamingMode,
        "turn",
      );
      // Another provider's explicit choice is not the benchmark's to change.
      assert.deepEqual(settings.providerInstances.codex, { driver: "codex", enabled: false });
      assert.deepEqual(settings.providerInstances.opencode, {
        driver: "opencode",
        enabled: true,
        config: { model: "chosen-by-the-operator" },
      });
    }));

  it("keeps a custom instance's driver instead of guessing it from the id", () =>
    withHome(async (home) => {
      const directory = NodePath.join(home, "userdata");
      await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(directory, "settings.json"),
        JSON.stringify({
          providerInstances: { "work-claude": { driver: "claudeAgent", enabled: false } },
        }),
      );
      await seedBenchmarkProviderSettings({ homeDir: home, provider: "work-claude" });
      assert.deepEqual((await readSettings(home)).providerInstances["work-claude"], {
        driver: "claudeAgent",
        enabled: true,
      });
    }));
});

describe("benchmarkServerSpawn", () => {
  const spawn = (): BenchmarkServerSpawn =>
    benchmarkServerSpawn({
      checkout: "/checkout",
      homeDir: "/checkout/.kurambit/benchmark-server",
      sandbox: {
        runtimeDirectory: "/checkout/.kurambit/run/display-sandbox",
        environment: sandboxDisplayEnvironment(
          {
            PATH: "/usr/bin",
            DISPLAY: ":0",
            WAYLAND_DISPLAY: "wayland-0",
            XAUTHORITY: "/run/user/1000/xauth",
          },
          "/checkout/.kurambit/run/display-sandbox",
        ),
      },
    });

  it("starts the server with the sandboxed environment, not the operator's", () => {
    const spec = spawn();
    for (const name of DISPLAY_VARIABLES) assert.equal(spec.env[name], undefined);
    assert.equal(spec.env.XDG_RUNTIME_DIR, "/checkout/.kurambit/run/display-sandbox");
    assert.equal(spec.env.PATH, "/usr/bin");
  });

  it("serves the private benchmark home", () => {
    const spec = spawn();
    assert.deepEqual(spec.args, [
      NodePath.join("/checkout", "apps/server/src/bin.ts"),
      "serve",
      "--base-dir",
      "/checkout/.kurambit/benchmark-server",
    ]);
  });
});

describe("stopBenchmarkServerAt", () => {
  const withHome = async (run: (home: string) => Promise<void>) => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "benchmark-server-stop-"));
    try {
      await run(home);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  };

  // The harness stops its server by POSIX process group, which Windows does not have.
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "stops the detached server group left by a killed harness",
    () =>
      withHome(async (home) => {
        const checkout = NodePath.join(home, "checkout");
        const binDirectory = NodePath.join(checkout, "apps/server/src");
        await NodeFSP.mkdir(binDirectory, { recursive: true });
        const stub = NodePath.join(binDirectory, "bin.ts");
        const grandchildPidPath = NodePath.join(home, "grandchild.pid");
        await NodeFSP.writeFile(
          stub,
          [
            'import * as NodeChildProcess from "node:child_process";',
            'import * as NodeFS from "node:fs";',
            'const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
            "NodeFS.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(child.pid));",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
        );
        const server = NodeChildProcess.spawn(process.execPath, [stub, "--base-dir", home], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, GRANDCHILD_PID_FILE: grandchildPidPath },
        });
        const serverPid = server.pid;
        assert.notEqual(serverPid, undefined);
        let grandchildPid: number | undefined;
        try {
          await waitFor(() => NodeFS.existsSync(grandchildPidPath));
          grandchildPid = Number((await NodeFSP.readFile(grandchildPidPath, "utf8")).trim());
          assert.equal(isAlive(serverPid!), true);
          assert.equal(isAlive(grandchildPid), true);
          const logPath = NodePath.join(home, "server.log");
          await NodeFSP.writeFile(`${logPath}.pid`, `${serverPid}\n${process.pid}\n`);

          await stopBenchmarkServerAt({ logPath, homeDir: home, ownerPid: process.pid });

          await waitFor(() => !isAlive(serverPid!) && !isAlive(grandchildPid!));
          assert.equal(NodeFS.existsSync(`${logPath}.pid`), false);
        } finally {
          if (serverPid !== undefined && isAlive(serverPid)) process.kill(serverPid, "SIGKILL");
          if (grandchildPid !== undefined && isAlive(grandchildPid))
            process.kill(grandchildPid, "SIGKILL");
        }
      }),
  );

  it("leaves an unrelated PID alone when a stale pid file names it", () =>
    withHome(async (home) => {
      if (HostProcess.Platform.defaultValue() !== "linux") return;
      const unrelated = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore" },
      );
      const pid = unrelated.pid;
      assert.notEqual(pid, undefined);
      try {
        const logPath = NodePath.join(home, "server.log");
        // A pid file another e2e owns is not this run's to clean.
        await NodeFSP.writeFile(`${logPath}.pid`, `${pid}\n${process.pid + 1}\n`);
        await stopBenchmarkServerAt({ logPath, homeDir: home, ownerPid: process.pid });
        assert.equal(NodeFS.existsSync(`${logPath}.pid`), true);
        assert.equal(isAlive(pid!), true);

        // With this e2e as the owner, the command-line check still refuses the
        // unrelated process and removes only the stale file.
        await NodeFSP.writeFile(`${logPath}.pid`, `${pid}\n${process.pid}\n`);
        await stopBenchmarkServerAt({ logPath, homeDir: home, ownerPid: process.pid });
        assert.equal(NodeFS.existsSync(`${logPath}.pid`), false);
        assert.equal(isAlive(pid!), true);
      } finally {
        if (pid !== undefined && isAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }));
});
