// @effect-diagnostics nodeBuiltinImport:off -- The test inspects the spawn environment a real server would receive and seeds a temporary home.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  benchmarkServerSpawn,
  externalServerOrigin,
  seedBenchmarkProviderSettings,
  type BenchmarkServerSpawn,
} from "./benchmark-server.ts";
import { DISPLAY_VARIABLES, sandboxDisplayEnvironment } from "./display-sandbox.ts";

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
      homeDir: "/checkout/.t3/benchmark-server",
      sandbox: {
        runtimeDirectory: "/checkout/.t3/run/display-sandbox",
        environment: sandboxDisplayEnvironment(
          {
            PATH: "/usr/bin",
            DISPLAY: ":0",
            WAYLAND_DISPLAY: "wayland-0",
            XAUTHORITY: "/run/user/1000/xauth",
          },
          "/checkout/.t3/run/display-sandbox",
        ),
      },
    });

  it("starts the server with the sandboxed environment, not the operator's", () => {
    const spec = spawn();
    for (const name of DISPLAY_VARIABLES) assert.equal(spec.env[name], undefined);
    assert.equal(spec.env.XDG_RUNTIME_DIR, "/checkout/.t3/run/display-sandbox");
    assert.equal(spec.env.PATH, "/usr/bin");
  });

  it("serves the private benchmark home", () => {
    const spec = spawn();
    assert.deepEqual(spec.args, [
      NodePath.join("/checkout", "apps/server/src/bin.ts"),
      "serve",
      "--base-dir",
      "/checkout/.t3/benchmark-server",
    ]);
  });
});
