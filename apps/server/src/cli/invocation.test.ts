import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@kurambit/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { formatCliCommand, resolveHostCliCommand, resolveRootCliCommand } from "./invocation.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/kurambit/dist/bin.mjs", "npx kurambit serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\kurambit\\dist\\bin.mjs",
      "npx kurambit serve",
    ],
    [
      "/home/theo/.cache/pnpm/dlx/abc/node_modules/kurambit/dist/bin.mjs",
      "pnpm dlx kurambit serve",
    ],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/kurambit/dist/bin.mjs",
      "pnpm dlx kurambit serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\kurambit\\dist\\bin.mjs",
      "pnpm dlx kurambit serve",
    ],
    ["/home/theo/.bun/install/cache/kurambit@0.0.31/dist/bin.mjs", "bunx kurambit serve"],
    ["/tmp/bunx-1000-kurambit@latest/node_modules/kurambit/dist/bin.mjs", "bunx kurambit serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-kurambit@latest\\node_modules\\kurambit\\dist\\bin.mjs",
      "bunx kurambit serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/kurambit/dist/bin.mjs",
    "/home/theo/Code/work/kurambit/apps/server/dist/bin.mjs",
    "/home/theo/.kurambit/runtime/0.0.31/node_modules/kurambit/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "kurambit serve",
    );
  }
});

it("re-suggests the prerelease channel only for prerelease builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx kurambit@nightly serve"],
    ["0.0.31-preview.20260729.1", "npx kurambit@preview serve"],
    ["0.0.31-foo-preview.20260729.1", "npx kurambit serve"],
    ["0.0.31", "npx kurambit serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/kurambit/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/kurambit/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx kurambit@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-kurambit@latest/node_modules/kurambit/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx kurambit serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/kurambit/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "kurambit serve",
  );
});

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: Record<string, string>;
    readonly executable?: boolean;
  }) =>
    resolveRootCliCommand("browser setup").pipe(
      Effect.provideService(HostProcess.ExecutablePath, input.node),
      Effect.provideService(HostProcess.Arguments, [input.node, input.entry]),
      Effect.provideService(HostProcess.IsExecutable, input.executable ?? false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: input.path ?? "", ...input.env }),
    );

  const pathWithKurambit = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(bin, "kurambit"), "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  });

  it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
    Effect.gen(function* () {
      const npx = "/home/theo/.npm/_npx/abc/node_modules/kurambit/dist/bin.mjs";
      // sudo's secure_path already has a system Node.
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: npx })).toBe(
        "sudo npx kurambit browser setup",
      );
      // nvm, fnm, and tarball installs are dropped by sudo's PATH reset.
      expect(
        yield* rootCommand({ node: "/home/theo/.nvm/versions/node/v24/bin/node", entry: npx }),
      ).toBe('sudo env "PATH=$PATH" npx kurambit browser setup');
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/kurambit/dist/bin.mjs",
          path: yield* pathWithKurambit,
        }),
      ).toBe('sudo env "PATH=$PATH" kurambit browser setup');
    }).pipe(Effect.scoped),
  );

  // A Linux PATH splits on `:`, so it cannot hold a Windows temp folder's drive path.
  it.effect.skipIf(windowsHost)("names this install's launcher when kurambit is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "kurambit");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
      const desktop = {
        node: "/tmp/.mount_Kurambitabc/kurambit",
        entry: "/tmp/.mount_Kurambitabc/resources/app.asar/apps/server/dist/bin.mjs",
        env: { KURAMBIT_CLI_PATH: shim },
      };

      expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);

      expect(yield* rootCommand({ ...desktop, path: yield* pathWithKurambit })).toBe(
        'sudo env "PATH=$PATH" kurambit browser setup',
      );

      expect(
        yield* rootCommand({
          node: "/opt/kurambit/kurambit",
          entry: "/opt/kurambit/kurambit",
          executable: true,
        }),
      ).toBe("sudo /opt/kurambit/kurambit browser setup");

      expect(
        yield* rootCommand({ ...desktop, env: { KURAMBIT_CLI_PATH: path.join(home, "gone") } }),
      ).toBe('sudo env "PATH=$PATH" kurambit browser setup');
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("host CLI commands", (it) => {
  it.effect("renders a PowerShell command line on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, "kurambit.cmd");
      yield* fs.writeFileString(shim, "@echo off\r\n");
      const hostCommand = (platform: NodeJS.Platform, env: Record<string, string>) =>
        resolveHostCliCommand("doctor", ["--base-dir", "C:\\Users\\Jane Doe\\.kurambit"]).pipe(
          Effect.provideService(
            HostProcess.ExecutablePath,
            "C:\\Program Files\\Kurambit\\kurambit.exe",
          ),
          Effect.provideService(HostProcess.Arguments, [
            "C:\\Program Files\\Kurambit\\kurambit.exe",
            "C:\\Program Files\\Kurambit\\resources\\app.asar\\apps\\server\\dist\\bin.mjs",
          ]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, { PATH: "", ...env }),
        );
      // The desktop shim is called through `&`, and each argument is quoted
      // the PowerShell way: no POSIX single quotes anywhere.
      expect((yield* hostCommand("win32", { KURAMBIT_CLI_PATH: shim })).command).toBe(
        `& "${shim}" doctor "--base-dir" "C:\\Users\\Jane Doe\\.kurambit"`,
      );
      // Without a launcher, plain `kurambit` with PowerShell-quoted arguments.
      expect((yield* hostCommand("win32", {})).command).toBe(
        'kurambit doctor "--base-dir" "C:\\Users\\Jane Doe\\.kurambit"',
      );
      // Typographic quotes also delimit PowerShell strings; doubling keeps them.
      expect(
        (yield* resolveHostCliCommand("doctor", [
          "--base-dir",
          "C:\\Kurambit\\\u201CArchive\u201D",
        ]).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
          Effect.provideService(HostProcess.ExecutablePath, "C:\\kurambit.exe"),
          Effect.provideService(HostProcess.Arguments, ["C:\\kurambit.exe", "C:\\bin.mjs"]),
          Effect.provideService(HostProcess.IsExecutable, false),
        )).command,
      ).toBe('kurambit doctor "--base-dir" "C:\\Kurambit\\\u201C\u201CArchive\u201D\u201D"');
      // POSIX hosts keep single quotes for the same input. The shim prefix is
      // a host path, so only the arguments are asserted.
      expect((yield* hostCommand("linux", { KURAMBIT_CLI_PATH: shim })).command).toMatch(
        / doctor --base-dir 'C:\\Users\\Jane Doe\\\.kurambit'$/,
      );
    }).pipe(Effect.scoped),
  );
});
