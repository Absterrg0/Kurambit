// @effect-diagnostics nodeBuiltinImport:off -- The test inspects the spawn environment a real server would receive.
import { assert, describe, it } from "@effect/vitest";
import * as NodePath from "node:path";
import {
  benchmarkServerSpawn,
  externalServerOrigin,
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
