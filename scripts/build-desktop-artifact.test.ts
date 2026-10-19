// @effect-diagnostics nodeBuiltinImport:off - Tests use Node's glob matcher to verify electron-builder exclusions.

import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { extractFile } from "@electron/asar";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { BundleNotSelfContainedError, BuildCommandFailedError, DesktopDmgBackgroundSourceMissingError, createStageWorkspaceConfig, createStagePatchedDependencies, readWorkspaceConfig, createBuildConfig, DESKTOP_FILE_EXCLUSIONS, DESKTOP_EXTRA_RESOURCES, LINUX_FILE_EXCLUSIONS, MAC_FILE_EXCLUSIONS, InvalidMockUpdateServerPortError, LinuxIconResizeError, LinuxDesktopBuildPrerequisitesMissingError, MacDesktopBuildPrerequisitesMissingError, MacPasskeySigningConfigurationResolutionError, packWindowsServerAsar, preflightLinuxDesktopBuild, preflightMacDesktopBuild, renderMacPasskeyEntitlements, resolveMacWebAuthnEntitlements, resolveMacPasskeySigningConfiguration, resolveDesktopRuntimeDependencies, resolveMergedStageDependencies, resolveFffNativeDependencies, resolveDesktopBuildIconAssets, resolveDesktopProductName, resolveDesktopUpdateChannel, resolveDesktopWebAssetBrand, resolveResourceMonitorRustTargets, resolveWindowsServerAsarIgnoreGlobs, resourceMonitorExecutableName, resolveGitHubPublishConfig, resolveMockUpdateServerPort, resolveMockUpdateServerUrl, resolvePackageManagerUserAgent, stageLinuxIconSize, stageDesktopDmgBackground, stageResourceMonitor, stageLinuxCaptureHelper, STAGE_INSTALL_ARGS, ancestorNodeModulesPaths, copyDirectoryPreservingSymlinks, LinuxBrowserSecretHostError, stageBrowserSecret, validateWindowsPackagedPayload, WindowsPrimaryNativeProbeError, WindowsPackagedPayloadValidationError, WINDOWS_NATIVE_ASAR_UNPACK_GLOB, stageCursorSdkPlatformPackages, WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT, WINDOWS_SERVER_ASAR_IGNORE_GLOBS, WINDOWS_SERVER_ASAR_RESOURCE } from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

// Keeps pnpm from auto-installing TypeScript, a types-only peer, into the app.
const stagePackageExtensions = {
  "electron-webauthn": { peerDependenciesMeta: { typescript: { optional: true } } },
  "@electron-webauthn/macos": { peerDependenciesMeta: { typescript: { optional: true } } },
};

const makeLinuxCliArchiveFixture = Effect.fn("test.makeLinuxCliArchiveFixture")(function* (input: {
  readonly root: string;
  readonly stem: string;
  readonly extraMembers?: ReadonlyArray<string>;
  readonly omitMembers?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const contentRoot = path.join(input.root, "content");
  const members = [
    `${input.stem}/t3`,
    `${input.stem}/client/index.html`,
    `${input.stem}/node_modules/node-pty/package.json`,
    `${input.stem}/node_modules/node-pty/build/Release/pty.node`,
    ...(input.extraMembers ?? []),
  ].filter((member) => !(input.omitMembers ?? []).includes(member));
  for (const member of members) {
    const memberPath = path.join(contentRoot, member);
    yield* fs.makeDirectory(path.dirname(memberPath), { recursive: true });
    yield* fs.writeFileString(memberPath, member);
  }
  const archivePath = path.join(input.root, `${input.stem}.tar.gz`);
  const tar = yield* spawner.spawn(
    ChildProcess.make("tar", ["-czf", archivePath, "-C", contentRoot, "."], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  assert.equal(Number(yield* tar.exitCode), 0);
  return archivePath;
});

function mockProcess(exitCode: number, stdout = "") {
  const encodedStdout = new TextEncoder().encode(stdout);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(encodedStdout) : Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function iconResizeSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  exitCodes: ReadonlyArray<number>,
) {
  let commandIndex = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockProcess(exitCodes[commandIndex++] ?? 0));
    }),
  );
}

const WINDOWS_PAYLOAD_FIXTURE_VERSION = "1.2.3";

const makeWindowsPayloadFixture = Effect.fn("test.makeWindowsPayloadFixture")(function* (input: {
  readonly copyUnpackedNatives: boolean;
  readonly serverEntrySource?: string;
  readonly targetArch?: "x64" | "arm64";
  readonly ptyPrebuildArch?: "x64" | "arm64";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-windows-payload-test-",
  });
  const sourceDir = path.join(tempDir, "server-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  const nativePath = path.join(sourceDir, "node_modules/native/addon.node");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
  yield* fs.writeFileString(serverEntryPath, input.serverEntrySource ?? "console.log('server');\n");
  yield* fs.writeFileString(nativePath, "MZ native-binary");

  const generatedAsarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
  yield* packWindowsServerAsar({ sourceDir, asarPath: generatedAsarPath, arch: "x64" });

  const stageDistDir = path.join(tempDir, "dist");
  const packagedAppDir = path.join(stageDistDir, "win-unpacked");
  const resourcesDir = path.join(packagedAppDir, "resources");
  yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
  yield* fs.copyFile(generatedAsarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
  if (input.copyUnpackedNatives) {
    yield* fs.copy(
      `${generatedAsarPath}.unpacked`,
      path.join(resourcesDir, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`),
    );
  }
  yield* fs.writeFileString(
    path.join(resourcesDir, "resource-monitor/t3-resource-monitor.exe"),
    "monitor",
  );
  const appExecutableName = "t3code.exe";
  yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
  yield* fs.writeFileString(path.join(packagedAppDir, "chrome_crashpad_handler.exe"), "crashpad");



  return {
    stageDistDir,
    packagedAppDir,
    sourceDir,
    generatedAsarPath,
    appExecutableName,
  } as const;
});

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.1.0"), "Game Studio");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "Game Studio");
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("switches the bundled splash and favicon branding for nightly versions", () => {
    assert.equal(resolveDesktopWebAssetBrand("0.0.17"), "production");
    assert.equal(resolveDesktopWebAssetBrand("0.0.17-nightly.20260413.42"), "nightly");
  });

  it.effect("resolves GitHub desktop publish config from Effect config", () =>
    Effect.gen(function* () {
      const latestConfig = yield* resolveGitHubPublishConfig("latest").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
              },
            }),
          ),
        ),
      );
      const nightlyConfig = yield* resolveGitHubPublishConfig("nightly").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_REPOSITORY: "pingdotgg/t3code",
              },
            }),
          ),
        ),
      );

      assert.isUndefined(latestConfig);
      assert.isUndefined(nightlyConfig);
    }),
  );

  it.effect(
    "omits update feeds for every build despite inherited upstream publishing configuration",
    () =>
      Effect.gen(function* () {
        const preview = yield* createBuildConfig(
          "mac",
          "dmg",
          "0.0.33-pr.8182.1",
          false,
          false,
          undefined,
          undefined,
        );
        const release = yield* createBuildConfig(
          "mac",
          "dmg",
          "0.0.33",
          false,
          false,
          undefined,
          undefined,
        );

        const previewChannel = yield* createBuildConfig(
          "mac",
          "dmg",
          "0.0.41-preview.20260912.1589",
          false,
          false,
          undefined,
          undefined,
        );

        assert.isNull(preview.publish);
        assert.isNull(previewChannel.publish);
        assert.isNull(release.publish);
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "pingdotgg/t3code" } }),
          ),
        ),
      ),
  );

  it("stages only the desktop main-process externals", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "example-electron": "catalog:",
          "example-native": "catalog:",
          "@crowecawcaw/xa11y": "0.13.0",
          "@effect/platform-node": "catalog:",
          "@napi-rs/keyring": "^1.3.0",
          "@t3tools/contracts": "workspace:*",
          "@t3tools/shared": "workspace:*",
          "dbus-next": "0.10.2",
          effect: "catalog:",
          electron: "41.5.0",
          "electron-updater": "^6.6.2",
          "ffi-rs": "1.3.2",
          "playwright-core": "1.60.0",
        },
        {
          "example-electron": "0.0.37",
            "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@crowecawcaw/xa11y": "0.13.0",
        "@napi-rs/keyring": "^1.3.0",
        "ffi-rs": "1.3.2",
        "playwright-core": "1.60.0",
      },
    );
  });

  it("carries only staged dependency patch metadata into staged desktop installs", () => {
    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "alchemy@2.0.0-beta.49": "patches/alchemy@2.0.0-beta.49.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        {
          "@ff-labs/fff-node": "0.9.4",
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.73",
        },
      ),
      {
        "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
        "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
        "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
      },
    );

    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.73" },
      ),
      {},
    );
  });

  it("installs optional native dependencies for the target desktop architecture", () => {
    assert.deepStrictEqual(STAGE_INSTALL_ARGS, ["install", "--prod"]);
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "x64" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["x64"],
      },
      packageExtensions: stagePackageExtensions,
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "linux", arch: "x64" }), {
      supportedArchitectures: {
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
      packageExtensions: stagePackageExtensions,
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "x64" }), {
      supportedArchitectures: {
        os: ["win32"],
        cpu: ["x64"],
      },
      packageExtensions: stagePackageExtensions,
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "arm64" }), {
      supportedArchitectures: {
        os: ["win32"],
        cpu: ["arm64"],
      },
      packageExtensions: stagePackageExtensions,
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "universal" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["arm64", "x64"],
      },
      packageExtensions: stagePackageExtensions,
    });
  });

  // pnpm writes "set this to true or false" placeholders into allowBuilds when a
  // tarball changes. pnpm ignores them, but the release build decode rejects them.
  it.effect("decodes the repo allowBuilds and every file: tarball it names exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { allowBuilds = {} } = yield* readWorkspaceConfig();
      const repoRoot = path.join(import.meta.dirname, "..");
      for (const key of Object.keys(allowBuilds)) {
        const tarball = key.split("@file:")[1];
        if (tarball === undefined) continue;
        assert.isTrue(
          yield* fs.exists(path.join(repoRoot, tarball)),
          `allowBuilds names a missing tarball: ${key}`,
        );
      }
    }),
  );

  it("stages pnpm 11 allowBuilds and patchedDependencies in the workspace yaml", () => {
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "linux",
        arch: "x64",
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      }),
      {
        supportedArchitectures: {
          os: ["linux"],
          cpu: ["x64"],
          libc: ["glibc"],
        },
        packageExtensions: stagePackageExtensions,
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      },
    );

    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "mac",
        arch: "arm64",
        allowBuilds: {},
        patchedDependencies: {},
        overrides: {},
      }),
      {
        supportedArchitectures: {
          os: ["darwin"],
          cpu: ["arm64"],
        },
        packageExtensions: stagePackageExtensions,
      },
    );
  });

  it("excludes foreign node-pty prebuilds from macOS and Linux packages", () => {
    assert.deepStrictEqual(MAC_FILE_EXCLUSIONS, [
      "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
      "!**/node_modules/node-pty/third_party/conpty/**/*",
    ]);
    assert.deepStrictEqual(LINUX_FILE_EXCLUSIONS, [
      ...MAC_FILE_EXCLUSIONS,
      "!**/node_modules/node-pty/prebuilds/darwin-*/**/*",
    ]);
  });

  it("unpacks native binaries while keeping their JavaScript and metadata archived", () => {
    for (const file of [
      "node_modules/@napi-rs/keyring/keyring.win32-x64-msvc.node",
      "node_modules/example-native/electron-passkeys.win32-x64-msvc.node",
      "node_modules/@ff-labs/fff-bin-win32-x64/fff_c.dll",
      "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
      "node_modules/native/addon.so",
      "node_modules/native/addon.so.1",
      "node_modules/native/addon.dylib",
    ]) {
      assert.isTrue(
        NodePath.matchesGlob(file, WINDOWS_NATIVE_ASAR_UNPACK_GLOB),
        `${file} must be available as a real file`,
      );
    }

    for (const file of [
      "node_modules/@napi-rs/keyring/index.js",
      "node_modules/@napi-rs/keyring/keytar.js",
      "node_modules/example-native/index.js",
    ]) {
      assert.isFalse(
        NodePath.matchesGlob(file, WINDOWS_NATIVE_ASAR_UNPACK_GLOB),
        `${file} should remain inside the archive`,
      );
    }
  });

  it("stages only the externals of both bundles in merged packages", () => {
    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "mac",
        serverDependencies: {
          "@cursor/sdk": "1.0.22",
          "@anthropic-ai/claude-agent-sdk": "^0.3.170",
          "@ff-labs/fff-node": "0.9.4",
          "@opencode-ai/sdk": "^1.3.15",
          "@pierre/diffs": "1.3.0",
          "node-pty": "1.1.0",
        },
        desktopDependencies: {
          "@napi-rs/keyring": "1.3.0",
          "playwright-core": "1.60.0",
        },
        arch: "arm64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@cursor/sdk": "1.0.22",
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@napi-rs/keyring": "1.3.0",
        "playwright-core": "1.60.0",
        "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      },
    );

    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "linux",
        serverDependencies: { "@ff-labs/fff-node": "0.9.4", "node-pty": "1.1.0", effect: "4.0.0" },
        desktopDependencies: { "@crowecawcaw/xa11y": "0.13.0" },
        arch: "x64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@crowecawcaw/xa11y": "0.13.0",
        "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
        "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
      },
    );
  });

  it.effect("ships Cursor platform assets outside asar for spawning and native loading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-helpers-" });
        const nodeModules = path.join(root, "node_modules");
        const destination = path.join(root, "resources/node_modules/@cursor");
        const cursorDirectory = symlinksSupported
          ? path.join(root, "store/@cursor")
          : path.join(nodeModules, "@cursor");
        yield* fs.makeDirectory(path.join(cursorDirectory, "sdk"), { recursive: true });
        if (symlinksSupported) {
          yield* fs.makeDirectory(path.join(nodeModules, "@cursor"), { recursive: true });
          yield* fs.symlink(
            path.join(cursorDirectory, "sdk"),
            path.join(nodeModules, "@cursor/sdk"),
          );
        }
        const helpers = [
          "sdk-darwin-arm64/bin/rg",
          "sdk-darwin-arm64/bin/cursorsandbox",
          "sdk-darwin-arm64/vendor/tree-sitter/index.js",
          "sdk-darwin-arm64/vendor/tree-sitter/binding.node",
          "sdk-darwin-arm64/vendor/tree-sitter-bash/binding.node",
          "sdk-darwin-arm64/package.json",
          "sdk-win32-x64/bin/rg.exe",
        ];
        for (const helper of helpers) {
          const source = path.join(cursorDirectory, helper);
          yield* fs.makeDirectory(path.dirname(source), { recursive: true });
          yield* fs.writeFileString(source, "fixture helper", { mode: 0o755 });
        }
        yield* stageCursorSdkPlatformPackages(nodeModules, destination);
        for (const helper of helpers) {
          assert.equal(yield* fs.readFileString(path.join(destination, helper)), "fixture helper");
          const packagedPath = `node_modules/@cursor/${helper}`;
          assert.isTrue(
            DESKTOP_FILE_EXCLUSIONS.some((glob) =>
              NodePath.matchesGlob(packagedPath, glob.slice(1)),
            ),
          );
          assert.isTrue(
            WINDOWS_SERVER_ASAR_IGNORE_GLOBS.some((glob) =>
              NodePath.matchesGlob(packagedPath, glob),
            ),
          );
        }
      }),
    ),
  );

  it("excludes node-pty binaries for the other Windows architecture", () => {
    assert.deepStrictEqual(resolveWindowsServerAsarIgnoreGlobs("x64"), [
      ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
      "**/node_modules/node-pty/prebuilds/win32-arm64",
      "**/node_modules/node-pty/prebuilds/win32-arm64/**",
      "**/node_modules/node-pty/third_party/conpty/*/win10-arm64",
      "**/node_modules/node-pty/third_party/conpty/*/win10-arm64/**",
    ]);
    assert.deepStrictEqual(resolveWindowsServerAsarIgnoreGlobs("arm64"), [
      ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
      "**/node_modules/node-pty/prebuilds/win32-x64",
      "**/node_modules/node-pty/prebuilds/win32-x64/**",
      "**/node_modules/node-pty/third_party/conpty/*/win10-x64",
      "**/node_modules/node-pty/third_party/conpty/*/win10-x64/**",
    ]);
  });

  it.effect("unpacks target Windows natives while excluding the other architecture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-windows-architecture-test-",
        });
        const sourceDir = path.join(tempDir, "server");
        const nativeFiles = [
          "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
          "node_modules/node-pty/prebuilds/win32-arm64/conpty/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-x64/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64/OpenConsole.exe",
          "node_modules/node-pty/prebuilds/win32-x64/pty.node",
          "node_modules/node-pty/prebuilds/linux-x64/pty.node",
        ];

        for (const nativeFile of nativeFiles) {
          const nativePath = path.join(sourceDir, nativeFile);
          yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
          yield* fs.writeFileString(nativePath, nativeFile.includes("linux") ? "\x7fELF" : "MZ");
        }

        const asarPath = path.join(tempDir, "server.asar");
        yield* packWindowsServerAsar({ sourceDir, asarPath, arch: "x64" });
        const unpackedRoot = `${asarPath}.unpacked`;

        assert.isTrue(
          yield* fs.exists(
            path.join(
              unpackedRoot,
              "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
            ),
          ),
        );
        assert.isTrue(
          yield* fs.exists(
            path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-x64/pty.node"),
          ),
        );
        assert.isFalse(
          yield* fs.exists(path.join(unpackedRoot, "node_modules/node-pty/prebuilds/linux-x64")),
        );
        assert.equal(
          extractFile(
            asarPath,
            path.join("node_modules", "node-pty", "prebuilds", "linux-x64", "pty.node"),
          ).toString(),
          "\x7fELF",
        );
        assert.isFalse(
          yield* fs.exists(path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-arm64")),
        );
        assert.isFalse(
          yield* fs.exists(
            path.join(unpackedRoot, "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64"),
          ),
        );
      }),
    ),
  );

  it.effect("stages a cached resource monitor without invoking Cargo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-resource-monitor-cache-test-",
        });
        const binaryPath = path.join(
          repoRoot,
          "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor",
        );
        const stageResourcesDir = path.join(repoRoot, "stage");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "cached monitor");

        yield* stageResourceMonitor({
          repoRoot,
          stageResourcesDir,
          platform: "linux",
          arch: "x64",
          verbose: false,
        }).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
              }),
            ),
          ),
        );

        assert.equal(
          yield* fs.readFileString(
            path.join(stageResourcesDir, "resource-monitor/t3-resource-monitor"),
          ),
          "cached monitor",
        );
      }),
    ),
  );

  it.effect("reports every missing Linux desktop build prerequisite with an install command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
          [];
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            commands.push(childProcess);
            const fails =
              childProcess.command === "cargo" ||
              childProcess.command === "rustc" ||
              childProcess.command === "pkg-config";
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );

        const error = yield* preflightLinuxDesktopBuild("arm64").pipe(
          Effect.provide(spawner),
          Effect.flip,
        );

        assert.instanceOf(error, LinuxDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["cargo", "rust-target", "libsecret"]);
        assert.include(error.message, "Rust compiler and Cargo (cargo, rustc)");
        assert.include(error.message, "Requested Rust standard library");
        assert.include(
          error.message,
          "sudo apt-get install cargo rustc libsecret-1-dev pkg-config",
        );
        assert.include(error.message, "rustup target add aarch64-unknown-linux-gnu");
        assert.isTrue(
          commands.some(
            (command) =>
              command.command === "rustc" && command.args.includes("aarch64-unknown-linux-gnu"),
          ),
        );
      }),
    ),
  );

  it.effect("reports missing macOS tools and Rust targets before building", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            const fails =
              childProcess.command === "rustc" ||
              (childProcess.command === "xcrun" && childProcess.args.includes("iconutil"));
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );
        const error = yield* preflightMacDesktopBuild("universal").pipe(
          Effect.provide(spawner),
          Effect.flip,
        );

        assert.instanceOf(error, MacDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["rust", "iconutil"]);
        assert.deepStrictEqual(error.rustTargets, ["aarch64-apple-darwin", "x86_64-apple-darwin"]);
        assert.include(error.message, "xcode-select --install");
        assert.include(error.message, "rustup target add aarch64-apple-darwin x86_64-apple-darwin");
      }),
    ),
  );

  it.effect("builds and stages native capture helpers for each Linux architecture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kde-stage-test-" });
        const protocols = path.join(repoRoot, "native/hyprland-snap-shot/protocols");
        yield* fs.makeDirectory(protocols, { recursive: true });
        yield* fs.writeFileString(path.join(protocols, "capture.xml"), "BSD protocol notice");
        for (const backend of ["kde", "hyprland"] as const) {
          for (const [arch, target] of [
            ["x64", "x86_64-unknown-linux-gnu"],
            ["arm64", "aarch64-unknown-linux-gnu"],
          ] as const) {
            const binary = path.join(
              repoRoot,
              `native/${backend}-snap-shot/target`,
              target,
              `release/t3-${backend}-snap-shot`,
            );
            const stageResourcesDir = path.join(repoRoot, "stage", backend, arch);
            const spawner = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) =>
                Effect.gen(function* () {
                  assert.equal(command._tag, "StandardCommand");
                  if (command._tag !== "StandardCommand") return mockProcess(1);
                  assert.equal(command.command, "cargo");
                  assert.deepEqual(command.args, [
                    "build",
                    "--locked",
                    "--release",
                    "--manifest-path",
                    path.join(repoRoot, `native/${backend}-snap-shot/Cargo.toml`),
                    "--target",
                    target,
                  ]);
                  yield* fs.makeDirectory(path.dirname(binary), { recursive: true });
                  yield* fs.writeFileString(binary, `helper-${arch}`);
                  return mockProcess(0);
                }),
              ),
            );
            yield* stageLinuxCaptureHelper({
              backend,
              repoRoot,
              stageResourcesDir,
              arch,
              verbose: false,
            }).pipe(Effect.provide(spawner));
            const installed = path.join(
              stageResourcesDir,
              `${backend}-capture/t3-${backend}-snap-shot`,
            );
            assert.equal(yield* fs.readFileString(installed), `helper-${arch}`);
            assert.equal((yield* fs.stat(installed)).mode & 0o777, 0o755);
            if (backend === "hyprland")
              assert.equal(
                yield* fs.readFileString(
                  path.join(stageResourcesDir, "hyprland-capture/protocols/capture.xml"),
                ),
                "BSD protocol notice",
              );
          }
        }
      }),
    ),
  );

  // The fixture's t3code.exe is a text placeholder, not an executable. These
  // cases reach the native-load probe, so pin only that host-platform check to
  // Linux. Host-native paths and the real Windows tar/archive checks still run.
  it.effect("validates every ASAR-unpacked native in the packaged Windows payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        const secondAsarPath = path.join(path.dirname(fixture.generatedAsarPath), "second.asar");
        yield* packWindowsServerAsar({
          sourceDir: fixture.sourceDir,
          asarPath: secondAsarPath,
          arch: "x64",
        });
        const [firstAsar, secondAsar] = yield* Effect.all([
          fs.readFile(fixture.generatedAsarPath),
          fs.readFile(secondAsarPath),
        ]);

        assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        assert.deepStrictEqual(result.unpackedFiles, ["node_modules/native/addon.node"]);
        assert.isBelow(result.fileCount, WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT);
        assert.deepStrictEqual(secondAsar, firstAsar);
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("probes fff through the packaged Windows primary instead of helper executables", () => {
    const commands: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: {
        readonly cwd?: string;
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        const primaryProbe = commands.find(
          (command) => command.options.env?.ELECTRON_RUN_AS_NODE === "1",
        );
        if (primaryProbe === undefined) return assert.fail("Windows primary probe was not spawned");

        assert.equal(
          primaryProbe.command,
          path.join(fixture.packagedAppDir, fixture.appExecutableName),
        );
        assert.deepStrictEqual(primaryProbe.args.slice(0, 3), [
          "--no-global-search-paths",
          "--input-type=module",
          "--eval",
        ]);
        assert.include(primaryProbe.args[3], "FileFinder.create");
        assert.equal(
          primaryProbe.args[4],
          path.join(
            fixture.packagedAppDir,
            "resources/server.asar/node_modules/@ff-labs/fff-node/dist/index.js",
          ),
        );
        assert.equal(primaryProbe.options.cwd, fixture.packagedAppDir);
        assert.equal(primaryProbe.options.env?.NODE_PATH, "");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    );
  });

  it.effect("builds the Linux browser secret helper for a concrete architecture", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.gen(function* () {
      yield* stageBrowserSecret({
        repoRoot: "/repo",
        stageResourcesDir: "/stage/resources",
        platform: "linux",
        arch: "universal",
        verbose: false,
      });
      const helper = commands.find((command) =>
        command.args.some((arg) => arg.endsWith("build-browser-secret.mjs")),
      );
      assert.isDefined(helper);
      const path = yield* Path.Path;
      assert.deepStrictEqual(helper.args.slice(-4), [
        "--arch",
        "x64",
        "--output",
        path.join("/stage/resources", "browser-secret", "t3-browser-secret"),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "linux"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    );
  });

  it.effect("refuses a Linux build on a host that cannot build the browser secret helper", () => {
    const commands: Array<{ readonly command: string }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.gen(function* () {
      const error = yield* stageBrowserSecret({
        repoRoot: "/repo",
        stageResourcesDir: "/stage/resources",
        platform: "linux",
        arch: "x64",
        verbose: false,
      }).pipe(Effect.flip);
      assert.instanceOf(error, LinuxBrowserSecretHostError);
      assert.equal(error.hostPlatform, "darwin");
      assert.include(error.message, "Linux host");
      assert.lengthOf(commands, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "darwin"),
          Layer.succeed(HostProcess.Architecture, "arm64"),
        ),
      ),
    );
  });

  it.effect("skips the primary native probe for cross-architecture Windows payloads", () => {
    const commands: Array<{
      readonly command: string;
      readonly options: {
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        assert.isFalse(
          commands.some(
            (command) =>
              command.command === NodePath.join(fixture.packagedAppDir, fixture.appExecutableName),
          ),
        );
        assert.isTrue(
          commands.some(
            (command) =>
              command.command === process.execPath && command.options.env?.NODE_PATH === "",
          ),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    );
  });

  it.effect("rejects a cross-architecture Windows payload without its primary executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const executablePath = path.join(fixture.packagedAppDir, fixture.appExecutableName);
        yield* fs.remove(executablePath);

        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPrimaryNativeProbeError);
        assert.equal(error.executablePath, executablePath);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    ),
  );

  it.effect("rejects a packaged sidecar whose ASAR-unpacked native is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: false });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unpacked-native-missing");
        assert.deepStrictEqual(error.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);
      }),
    ),
  );

  it.effect("rejects directories in place of packaged executable files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const nativePath = path.join(
          fixture.packagedAppDir,
          "resources/server.asar.unpacked/node_modules/native/addon.node",
        );
        yield* fs.remove(nativePath);
        yield* fs.makeDirectory(nativePath);

        const nativeError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(nativeError, WindowsPackagedPayloadValidationError);
        assert.equal(nativeError.reason, "unpacked-native-missing");
        assert.deepStrictEqual(nativeError.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);

        yield* fs.remove(nativePath, { recursive: true });
        yield* fs.writeFileString(nativePath, "native-binary");
        const resourceMonitorPath = path.join(
          fixture.packagedAppDir,
          "resources/resource-monitor/t3-resource-monitor.exe",
        );
        yield* fs.remove(resourceMonitorPath);
        yield* fs.makeDirectory(resourceMonitorPath);

        const resourceMonitorError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(resourceMonitorError, WindowsPackagedPayloadValidationError);
        assert.equal(resourceMonitorError.reason, "resource-monitor-missing");
        assert.deepStrictEqual(resourceMonitorError.missingFiles, [
          "resource-monitor/t3-resource-monitor.exe",
        ]);
      }),
    ),
  );

  it.effect("rejects a Windows payload that regresses above the file-count budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          fileLimit: 2,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "file-limit-exceeded");
        assert.isAbove(error.fileCount ?? 0, 2);
      }),
    ),
  );

  it.effect("rejects a sidecar whose extracted server bundle cannot resolve", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          serverEntrySource: 'import "t3code-deliberately-missing-package";\n',
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, BundleNotSelfContainedError);
        assert.include(error.output, "t3code-deliberately-missing-package");
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("preserves both Linux icon resize failures with structural context", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const error = yield* stageLinuxIconSize("source.png", "target.png", 512, false).pipe(
        Effect.provide(iconResizeSpawnerLayer(commands, [1, 2])),
        Effect.flip,
      );

      assert.instanceOf(error, LinuxIconResizeError);
      assert.equal(error.operation, "resize");
      assert.equal(error.iconSize, 512);
      assert.equal(error.primaryTool, "magick");
      assert.equal(error.fallbackTool, "convert");
      assert.include(error.message, "512x512");
      assert.include(error.message, "`magick`");
      assert.include(error.message, "`convert`");
      assert.notInclude(error.message, "non-zero exit code");

      assert.instanceOf(error.cause, AggregateError);
      const aggregateCause = error.cause as AggregateError;
      assert.lengthOf(aggregateCause.errors, 2);
      assert.strictEqual(aggregateCause.cause, aggregateCause.errors[0]);
      assert.instanceOf(aggregateCause.errors[0], BuildCommandFailedError);
      assert.instanceOf(aggregateCause.errors[1], BuildCommandFailedError);
      const primaryError = aggregateCause.errors[0] as BuildCommandFailedError;
      const fallbackError = aggregateCause.errors[1] as BuildCommandFailedError;
      assert.equal(primaryError.command, "magick linux icon 512x512");
      assert.equal(primaryError.exitCode, 1);
      assert.include(primaryError.message, "magick linux icon");
      assert.equal(fallbackError.command, "convert linux icon 512x512");
      assert.equal(fallbackError.exitCode, 2);
      assert.include(fallbackError.message, "convert linux icon");
      assert.deepStrictEqual(
        commands.map(({ command }) => command),
        ["magick", "convert"],
      );
    });
  });

  it.effect("rasterizes staged DMG backgrounds at standard and Retina sizes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3code-dmg-background-",
        });
        const dmgDir = path.join(stageResourcesDir, "dmg");
        yield* fs.makeDirectory(dmgDir, { recursive: true });
        const sourcePath = path.join(dmgDir, "dmg-background-nightly.svg");
        yield* fs.writeFileString(sourcePath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
        const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
          [];

        yield* stageDesktopDmgBackground(stageResourcesDir, "nightly", false).pipe(
          Effect.provide(iconResizeSpawnerLayer(commands, [0, 0])),
        );

        assert.deepStrictEqual(
          commands.map((command) => [command.command, ...command.args]),
          [
            [
              "sips",
              "-s",
              "format",
              "png",
              "-z",
              "432",
              "640",
              sourcePath,
              "--out",
              path.join(dmgDir, "dmg-background-nightly.png"),
            ],
            [
              "sips",
              "-s",
              "format",
              "png",
              "-z",
              "864",
              "1280",
              sourcePath,
              "--out",
              path.join(dmgDir, "dmg-background-nightly@2x.png"),
            ],
          ],
        );
      }),
    ),
  );

  it.effect("fails clearly when the selected DMG background source is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3code-dmg-background-missing-",
        });

        const error = yield* stageDesktopDmgBackground(stageResourcesDir, "latest", false).pipe(
          Effect.flip,
        );

        assert.instanceOf(error, DesktopDmgBackgroundSourceMissingError);
        assert.equal(error.channel, "latest");
        assert.include(error.sourcePath, "dmg-background-latest.svg");
      }),
    ),
  );

  it("normalizes explicit macOS passkey RP domains and renders required entitlements", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      GAME_STUDIO_PASSKEY_RP_DOMAINS:
        " Passkeys.Example.com,passkeys.example.test,passkeys.example.com ",
    });
    const entitlements = renderMacPasskeyEntitlements(configuration, {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });

    assert.deepStrictEqual(configuration.rpDomains, [
      "passkeys.example.com",
      "passkeys.example.test",
    ]);
    assert.include(entitlements, "<string>ABC1234567.dev.gamestudio.app</string>");
    assert.include(entitlements, "<string>webcredentials:passkeys.example.com</string>");
    assert.include(entitlements, "<string>webcredentials:passkeys.example.test</string>");
    assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
    assert.notInclude(entitlements, "keychain-access-groups");
    assert.notInclude(entitlements, "com.apple.developer.web-browser.public-key-credential");
  });

  it("grants in-app browser passkey entitlements only when the provisioning profile does", () => {
    const configuration = { appId: "dev.gamestudio.app", teamId: "ABC1234567" };
    const profile = (entitlements: string, outside = "") =>
      `0\x82\x1f\x9a\x06\t*\x86H<?xml version="1.0"?><plist version="1.0"><dict>${outside}<key>Entitlements</key><dict>${entitlements}</dict></dict></plist>\x00\x01`;
    const teamWildcardGroups = `<key>keychain-access-groups</key>
      <array>
        <string>ABC1234567.*</string>
        <string>com.apple.token</string>
      </array>`;

    assert.deepStrictEqual(resolveMacWebAuthnEntitlements(profile(""), configuration), {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile("<key>keychain-access-groups</key><array><string>OTHERTEAM1.*</string></array>"),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `<!-- ${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key><true/> -->
          <key>com.apple.developer.web-browser.public-key-credential</key><false/>`,
          teamWildcardGroups,
        ),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key>
          <true/>`,
        ),
        configuration,
      ),
      {
        touchIdKeychainAccessGroup: "ABC1234567.dev.gamestudio.app.webauthn",
        browserPasskeys: true,
      },
    );

    const entitlements = renderMacPasskeyEntitlements(
      { ...configuration, rpDomains: ["passkeys.example.com"], provisioningProfilePath: "" },
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}<key>com.apple.developer.web-browser.public-key-credential</key><true/>`,
        ),
        configuration,
      ),
    );
    assert.match(
      entitlements,
      /<key>keychain-access-groups<\/key>\s*<array>\s*<string>ABC1234567\.dev\.gamestudio\.app\.webauthn<\/string>\s*<\/array>/u,
    );
    assert.match(
      entitlements,
      /<key>com\.apple\.developer\.web-browser\.public-key-credential<\/key>\s*<true\/>/u,
    );
  });

  it("wraps unknown passkey signing configuration defects without copying cause text", () => {
    const secret = "pk_test_do-not-retain";
    const cause = new Error(secret);
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(cause);

    assert.instanceOf(error, MacPasskeySigningConfigurationResolutionError);
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message, "Failed to resolve macOS passkey signing configuration.");
    assert.notInclude(error.message, secret);
  });

  it.effect("adds passkey entitlements and both renderer protocols to signed macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", true, false, undefined, {
        entitlementsPath: "/tmp/entitlements.mac.plist",
        provisioningProfilePath: "/tmp/t3code.provisionprofile",
      });

      const mac = config.mac as Record<string, unknown>;
      assert.equal(config.appId, "dev.gamestudio.app");
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.equal(mac.provisioningProfile, "/tmp/t3code.provisionprofile");
      assert.match(String(mac.sign), /[\\/]scripts[\\/]sign-macos\.ts$/);
      assert.deepStrictEqual(mac.protocols, [
        { name: "Game Studio", schemes: ["game-studio", "game-studio-dev"] },
        { name: "Web site URL", schemes: ["http", "https"], role: "Viewer" },
      ]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("uses the nightly DMG background for nightly macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3-nightly.20260815.1",
        false,
        false,
        undefined,
        undefined,
      );

      assert.equal(
        (config.dmg as Record<string, unknown>).background,
        "dmg/dmg-background-nightly.png",
      );
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("configures Windows executable metadata and native signing extensions", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );

      const win = config.win as Record<string, unknown>;
      assert.equal(win.icon, "icon.ico");
      assert.deepStrictEqual(win.signExts, [".node", ".dll"]);
      assert.equal(win.signAndEditExecutable, true);
      assert.notProperty(win, "azureSignOptions");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("stages the resource monitor as an external executable resource", () => {
    assert.deepStrictEqual(DESKTOP_EXTRA_RESOURCES, [
      {
        from: "apps/desktop/prod-resources/cursor-sdk",
        to: "node_modules/@cursor",
      },
      {
        from: "apps/desktop/prod-resources/resource-monitor",
        to: "resource-monitor",
      },
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("mac", "universal"), [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("linux", "x64"), [
      "x86_64-unknown-linux-gnu",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("win", "arm64"), [
      "aarch64-pc-windows-msvc",
    ]);
    assert.equal(resourceMonitorExecutableName("mac"), "t3-resource-monitor");
    assert.equal(resourceMonitorExecutableName("win"), "t3-resource-monitor.exe");
  });

  it("promotes target fff binaries to direct staged dependencies", () => {
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "universal", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      "@ff-labs/fff-bin-darwin-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("win", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-win32-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-arm64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-arm64-musl": "0.9.4",
    });
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it("derives the electron-builder package manager user agent from packageManager", () => {
    assert.equal(resolvePackageManagerUserAgent("pnpm@11.10.0"), "pnpm/11.10.0");
    assert.equal(resolvePackageManagerUserAgent(" yarn@4.9.2 "), "yarn/4.9.2");
    assert.equal(resolvePackageManagerUserAgent("pnpm"), "pnpm");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it("classifies invalid configured ports with the decoder's number grammar", () => {
    const cause = new Error("invalid configured port");

    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).reason,
      "not-numeric",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("12.5", cause).reason,
      "not-integer",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("65536", cause).reason,
      "out-of-range",
    );
    assert.strictEqual(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).cause,
      cause,
    );
  });
});

it("lists ancestor node_modules, nearest first, excluding the start directory", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"), [
    "C:\\tmp\\probe\\node_modules",
    "C:\\tmp\\node_modules",
    "C:\\node_modules",
  ]);
});

it("includes the filesystem root for posix paths", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("/tmp/probe", "/"), [
    "/tmp/node_modules",
    "/node_modules",
  ]);
});

it("keeps the prefix of a UNC path instead of going relative", () => {
  const paths = ancestorNodeModulesPaths("\\\\server\\share\\tmp\\app", "\\");
  for (const candidate of paths) {
    assert.ok(candidate.startsWith("\\\\server\\share"), candidate);
  }
  assert.deepStrictEqual(paths[0], "\\\\server\\share\\tmp\\node_modules");
});

it.effect.skipIf(!symlinksSupported)("rebases packaged links into the isolated tree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copy-symlinks-" });
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const packageDir = path.join(source, "node_modules/.pnpm/example@1/node_modules/example");
    const relativePackageLink = path.join(source, "node_modules/example-relative");
    const absolutePackageLink = path.join(source, "node_modules/example-absolute");

    yield* fs.makeDirectory(packageDir, { recursive: true });
    yield* fs.writeFileString(path.join(packageDir, "index.js"), "module.exports = true;\n");
    yield* fs.symlink(
      path.join(".pnpm", "example@1", "node_modules", "example"),
      relativePackageLink,
    );
    yield* fs.symlink(packageDir, absolutePackageLink);

    yield* copyDirectoryPreservingSymlinks(source, destination);

    const copiedPackage = path.join(
      destination,
      "node_modules/.pnpm/example@1/node_modules/example",
    );
    const resolvedCopiedPackage = yield* fs.realPath(copiedPackage);
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-relative")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-absolute")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-relative")),
      resolvedCopiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-absolute")),
      resolvedCopiedPackage,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("ignores trailing separators", () => {
  assert.deepStrictEqual(
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app\\", "\\"),
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"),
  );
});
