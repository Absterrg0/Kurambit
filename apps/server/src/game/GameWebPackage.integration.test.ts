// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off -- Runs the real pinned Godot toolchain, static preview server and managed headless Chrome against an isolated starter.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Yauzl from "yauzl";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import { candidateBuildDirectory, hashWebBuild, hashWebBuildDirectory } from "./webBuild.ts";
import { parseGodotViewport } from "./godotViewport.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  designApprovalTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  qualificationTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const workspaceRoot = (() => {
  let directory = process.cwd();
  for (
    let hops = 0;
    hops < 5 && !NodeFS.existsSync(NodePath.join(directory, "apps/server/package.json"));
    hops++
  ) {
    directory = NodePath.resolve(directory, "..");
  }
  return directory;
})();
const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);
const browserExecutable = (() => {
  const installRoot = NodePath.join(
    NodePath.join(workspaceRoot, ".t3"),
    "tools",
    "chrome-headless-shell",
  );
  if (!NodeFS.existsSync(installRoot)) return null;
  for (const platform of NodeFS.readdirSync(installRoot)) {
    const platformPath = NodePath.join(installRoot, platform);
    for (const version of NodeFS.readdirSync(platformPath)) {
      for (const name of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
        const candidate = NodePath.join(platformPath, version, name);
        if (NodeFS.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
})();
const templatesInstalled = (() => {
  const dataRoot = process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local/share");
  const roots = [
    NodePath.join(dataRoot, "godot/export_templates"),
    NodePath.join(
      GameToolchain.toolsDirectory(),
      `godot-${GameToolchain.GODOT_VERSION}`,
      "editor_data/export_templates",
    ),
  ];
  try {
    for (const root of roots) {
      if (!NodeFS.existsSync(root)) continue;
      for (const version of NodeFS.readdirSync(root))
        for (const name of ["web_nothreads_release.zip", "web_nothreads_debug.zip"])
          if (
            NodeFS.existsSync(NodePath.join(root, version, version, name)) ||
            NodeFS.existsSync(NodePath.join(root, version, name))
          )
            return true;
    }
  } catch {
    // Unreadable template roots count as missing.
  }
  return false;
})();
const available =
  NodeFS.existsSync(godotExecutable) && browserExecutable !== null && templatesInstalled;
const evidenceDirectory = process.env.GAME_STUDIO_WEB_PACKAGE_EVIDENCE_DIR?.trim();

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const extractArchive = (archive: string, destination: string) =>
  new Promise<
    readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[]
  >((resolve, reject) => {
    Yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("The package archive could not be opened."));
        return;
      }
      const files: { path: string; bytes: number; sha256: string }[] = [];
      zip.on("error", reject);
      zip.on("end", () => resolve(files));
      zip.on("entry", (entry: Yauzl.Entry) => {
        const relative = entry.fileName;
        const target = NodePath.resolve(destination, relative);
        if (
          relative.length === 0 ||
          relative.includes("\\") ||
          !target.startsWith(`${NodePath.resolve(destination)}${NodePath.sep}`)
        ) {
          reject(new Error(`Unsafe ZIP entry: ${relative}`));
          return;
        }
        if (relative.endsWith("/")) {
          NodeFSP.mkdir(target, { recursive: true }).then(() => zip.readEntry(), reject);
          return;
        }
        NodeFSP.mkdir(NodePath.dirname(target), { recursive: true }).then(() => {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              reject(streamError ?? new Error(`Could not read ${relative}.`));
              return;
            }
            const hash = NodeCrypto.createHash("sha256");
            let bytes = 0;
            const digest = new NodeStream.Transform({
              transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.byteLength;
                hash.update(chunk);
                callback(null, chunk);
              },
            });
            NodeStreamPromises.pipeline(
              stream,
              digest,
              NodeFS.createWriteStream(target, { flags: "wx" }),
            ).then(() => {
              files.push({ path: relative, bytes, sha256: hash.digest("hex") });
              zip.readEntry();
            }, reject);
          });
        }, reject);
      });
      zip.readEntry();
    });
  });

const fetchExact = async (url: string, path: string) => {
  const response = await fetch(url);
  if (response.status !== 200) throw new Error(`${path} returned ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
};

/** The same playable 2D fixture both real proofs export and replay. */
const writePlayableScene = async (root: string) => {
  await NodeFSP.writeFile(
    NodePath.join(root, "godot/scenes/main.tscn"),
    `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]

[node name="Main" type="Node2D"]
script = ExtResource("1")

[node name="Background" type="ColorRect" parent="."]
offset_right = 960.0
offset_bottom = 540.0
color = Color(0.08, 0.1, 0.16, 1)

[node name="Player" type="Node2D" parent="." groups=["player"]]
position = Vector2(160, 280)

[node name="Body" type="Polygon2D" parent="Player"]
polygon = PackedVector2Array(-40, -40, 40, -40, 40, 40, -40, 40)
color = Color(0.95, 0.55, 0.2, 1)
`,
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "godot/scripts/game_state.gd"),
    `extends Node

## A run value the probe reports; it drains while the game runs.
var energy := 100.0
`,
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "godot/scripts/main.gd"),
    `extends Node2D

func _process(delta: float) -> void:
	GameState.energy = maxf(0.0, GameState.energy - 60.0 * delta)
	if Input.is_action_pressed("ui_right"):
		$Player.position.x = min($Player.position.x + 260.0 * delta, 820.0)
`,
  );
};

it.live.skipIf(!available)(
  "packages a real selected Web export, unzips it and plays the extracted static site",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-web-package-real-")),
        ),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const stateDir = NodePath.join(parent, ".test-state");
      const dependencies = GameService.layer.pipe(
        Layer.provideMerge(GameProjectService.layer),
        Layer.provideMerge(GameOperations.layer),
        Layer.provideMerge(GameToolchain.layer),
        Layer.provideMerge(GamePreview.layer),
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(projectTestLayer()),
        Layer.provide(previewBrowserTestLayer(browserExecutable!)),
        Layer.provideMerge(qualificationTestLayer(stateDir)),
        Layer.provideMerge(designApprovalTestLayer(stateDir)),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projects = yield* GameProjectService.GameProjectService;
          const game = yield* GameService.GameService;
          const preview = yield* GamePreview.GamePreview;
          const created = yield* projects.create({
            name: "Web Package",
            parentDirectory: parent,
            template: "blank",
            brief: "Hold right and the square slides across the screen.",
            planFirst: false,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-6.1-sol",
            },
          });
          yield* Effect.addFinalizer(() =>
            game.action(created.threadId, "stop").pipe(Effect.ignore),
          );
          yield* Effect.promise(() => writePlayableScene(created.root));

          const verified = yield* game.verify(created.threadId, {
            steps: [
              { key: "ArrowRight", holdMs: 600 },
              { key: "ArrowRight", holdMs: 600 },
            ],
            bootTimeoutMs: 45_000,
          });
          expect(verified.success, verified.message).toBe(true);
          expect(verified.export?.success, verified.export?.message).toBe(true);
          expect(verified.playtest?.booted).toBe(true);
          const status = yield* game.status(created.threadId);
          const buildId = status.selectedBuildId;
          expect(buildId).toMatch(/^[0-9a-f]{64}$/);
          expect(verified.build?.buildId).toBe(buildId);

          const packaged = yield* game.packageWeb(created.threadId);
          expect(packaged.buildId).toBe(buildId);
          expect(packaged.entry).toBe("index.html");
          expect(packaged.sourceEntry).toBe("index.html");
          const build = yield* Effect.promise(() =>
            hashWebBuild(created.root, `builds/candidates/${buildId!}`),
          );
          expect(build).not.toBeNull();
          expect(packaged.files.map((file) => file.path).sort()).toEqual(
            build!.files.map((file) => file.path).sort(),
          );
          const packagedFiles = new Map(packaged.files.map((file) => [file.path, file.sha256]));
          for (const file of build!.files) expect(packagedFiles.get(file.path)).toBe(file.sha256);
          expect([...packagedFiles.keys()]).toContain("index.wasm");
          expect([...packagedFiles.keys()]).toContain("index.pck");
          const archive = yield* Effect.promise(() => NodeFSP.readFile(packaged.archivePath));
          expect(packaged.bytes).toBe(archive.byteLength);
          expect(packaged.sha256).toBe(sha256(archive));
          expect((yield* game.status(created.threadId)).selectedBuildId).toBe(buildId);

          const siteRoot = NodePath.join(parent, "package-site");
          const extractedRoot = NodePath.join(siteRoot, "extracted");
          yield* Effect.promise(() => NodeFSP.mkdir(siteRoot, { recursive: true }));
          const extracted = yield* Effect.promise(() =>
            extractArchive(packaged.archivePath, extractedRoot),
          );
          expect(extracted.map((file) => file.path).sort()).toEqual(
            build!.files.map((file) => file.path).sort(),
          );
          for (const file of build!.files) {
            const written = extracted.find((entry) => entry.path === file.path);
            expect(written?.sha256, file.path).toBe(file.sha256);
            expect(written?.bytes, file.path).toBe(file.size);
          }
          const extractedBytes = extracted.reduce((total, file) => total + file.bytes, 0);
          const buildBytes = build!.files.reduce((total, file) => total + file.size, 0);
          expect(extractedBytes).toBe(buildBytes);

          // Serve the extracted files with the product's static preview server,
          // not a test-only server, and check every required resource by HTTP.
          const url = yield* preview.open(siteRoot, "extracted");
          const served = {
            "index.html": yield* Effect.promise(() =>
              fetchExact(new URL("index.html", url).href, "index.html"),
            ),
            "index.js": yield* Effect.promise(() =>
              fetchExact(new URL("index.js", url).href, "index.js"),
            ),
            "index.wasm": yield* Effect.promise(() =>
              fetchExact(new URL("index.wasm", url).href, "index.wasm"),
            ),
            "index.pck": yield* Effect.promise(() =>
              fetchExact(new URL("index.pck", url).href, "index.pck"),
            ),
          };
          for (const [path, bytes] of Object.entries(served)) {
            const file = build!.files.find((entry) => entry.path === path);
            expect(file, path).toBeDefined();
            expect(sha256(bytes), path).toBe(file!.sha256);
          }

          const projectText = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(created.root, "godot/project.godot"), "utf8"),
          );
          const viewport = parseGodotViewport(projectText);
          const profile = NodePath.join(parent, "extracted-playtest-profile");
          const played = yield* GameWebPlaytest.playtest({
            executable: browserExecutable!,
            url,
            profileDirectory: profile,
            width: viewport.width,
            height: viewport.height,
            bootTimeoutMs: 45_000,
            steps: [
              { key: "ArrowRight", holdMs: 600 },
              { key: "ArrowRight", holdMs: 600 },
            ],
            captureAllSteps: true,
            probeRequired: true,
            acceptance: null,
          });
          expect(played.booted, played.message).toBe(true);
          expect(played.responded, played.message).toBe(true);
          expect(played.executedInputSteps ?? 0).toBe(2);
          const consoleErrors = played.consoleMessages.filter(
            (message) => message.level === "error",
          );
          expect(consoleErrors.map((message) => message.text)).toEqual([]);
          expect(played.state?.playerMoved ?? 0).toBeGreaterThan(0.75);
          expect(played.screenshots.length).toBeGreaterThan(0);
          const statusAfterPackage = yield* game.status(created.threadId);
          expect(statusAfterPackage.selectedBuildId).toBe(buildId);

          if (evidenceDirectory !== undefined) {
            yield* Effect.promise(async () => {
              const target = NodePath.join(evidenceDirectory, "web-package");
              await NodeFSP.mkdir(target, { recursive: true });
              await NodeFSP.copyFile(packaged.archivePath, NodePath.join(target, "game-web.zip"));
              await NodeFSP.copyFile(
                NodePath.join(extractedRoot, "index.html"),
                NodePath.join(target, "index.html"),
              );
              const frames: string[] = [];
              for (const [index, frame] of played.screenshots.entries()) {
                const bytes = Buffer.from(frame.data, "base64");
                expect(bytes.subarray(0, 8)).toEqual(
                  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                );
                const name = `frame-${String(index + 1).padStart(2, "0")}-${frame.label}.png`;
                await NodeFSP.writeFile(NodePath.join(target, name), bytes);
                frames.push(name);
              }
              await NodeFSP.writeFile(
                NodePath.join(target, "proof.json"),
                `${JSON.stringify(
                  {
                    selectedBuildId: buildId,
                    selectedBuildAfterPackage: statusAfterPackage.selectedBuildId,
                    selectedBeforeExtractedPlaytest: buildId,
                    package: {
                      archive: "game-web.zip",
                      archivePath: packaged.archivePath,
                      bytes: packaged.bytes,
                      sha256: packaged.sha256,
                      entry: packaged.entry,
                      sourceEntry: packaged.sourceEntry,
                      files: packaged.files,
                    },
                    extracted: {
                      root: extractedRoot,
                      bytes: extractedBytes,
                      files: extracted,
                    },
                    servedOverHttp: Object.fromEntries(
                      Object.entries(served).map(([path, bytes]) => [
                        path,
                        { bytes: bytes.byteLength, sha256: sha256(bytes) },
                      ]),
                    ),
                    playtestFromExtractedBytes: {
                      booted: played.booted,
                      responded: played.responded,
                      executedInputSteps: played.executedInputSteps,
                      consoleErrors: consoleErrors.length,
                      interaction: played.interaction,
                      state: played.state,
                      message: played.message,
                      frames,
                    },
                  },
                  null,
                  2,
                )}\n`,
              );
            });
          }
          yield* Effect.log(
            `Web package real run: ${packaged.message} ZIP ${packaged.sha256}; extracted ${extractedBytes} bytes; playback booted=${played.booted} responded=${played.responded} errors=${consoleErrors.length}; frames=${played.screenshots.length}`,
          );
        }).pipe(Effect.provide(dependencies)),
      );
    }),
  900_000,
);

it.live.skipIf(!available)(
  "packages a real game.html export as index.html and plays the extracted site",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-web-package-entry-")),
        ),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const stateDir = NodePath.join(parent, ".test-state");
      const dependencies = GameService.layer.pipe(
        Layer.provideMerge(GameProjectService.layer),
        Layer.provideMerge(GameOperations.layer),
        Layer.provideMerge(GameToolchain.layer),
        Layer.provideMerge(GamePreview.layer),
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(projectTestLayer()),
        Layer.provide(previewBrowserTestLayer(browserExecutable!)),
        Layer.provideMerge(qualificationTestLayer(stateDir)),
        Layer.provideMerge(designApprovalTestLayer(stateDir)),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projects = yield* GameProjectService.GameProjectService;
          const game = yield* GameService.GameService;
          const preview = yield* GamePreview.GamePreview;
          const processes = yield* GameProcesses.GameProcesses;
          const rounds = yield* GameRoundStore.GameRoundStore;
          const created = yield* projects.create({
            name: "Custom Entry",
            parentDirectory: parent,
            template: "blank",
            brief: "Hold right and the square slides across the screen.",
            planFirst: false,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-6.1-sol",
            },
          });
          yield* Effect.addFinalizer(() =>
            game.action(created.threadId, "stop").pipe(Effect.ignore),
          );
          yield* Effect.promise(() => writePlayableScene(created.root));

          // A real Godot export whose HTML entry is game.html, not index.html.
          const godotRoot = NodePath.join(created.root, "godot");
          const imported = yield* processes.run({
            root: created.root,
            executable: godotExecutable,
            args: ["--headless", "--path", godotRoot, "--editor", "--import"],
            operation: "godot-import",
            timeoutMs: 180_000,
          });
          expect(imported.exitCode, `${imported.stdout}\n${imported.stderr}`).toBe(0);
          const staging = NodePath.join(
            created.root,
            "builds",
            `custom-entry-${NodeCrypto.randomUUID()}`,
          );
          yield* Effect.promise(() => NodeFSP.mkdir(staging, { recursive: true }));
          const exported = yield* processes.run({
            root: created.root,
            executable: godotExecutable,
            args: [
              "--headless",
              "--path",
              godotRoot,
              "--export-release",
              "Web",
              NodePath.join(staging, "game.html"),
            ],
            operation: "export-web-custom-entry",
            timeoutMs: 300_000,
          });
          expect(exported.exitCode, `${exported.stdout}\n${exported.stderr}`).toBe(0);

          const hashed = yield* Effect.promise(() => hashWebBuildDirectory(staging));
          expect(hashed).not.toBeNull();
          expect(hashed!.files.map((file) => file.path)).toContain("game.html");
          expect(hashed!.files.map((file) => file.path)).toContain("game.js");
          expect(hashed!.files.map((file) => file.path)).toContain("game.wasm");
          expect(hashed!.files.map((file) => file.path)).toContain("game.pck");
          const buildId = hashed!.buildId;
          const directory = candidateBuildDirectory(buildId);
          const final = NodePath.join(created.root, directory);
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(NodePath.dirname(final), { recursive: true });
            await NodeFSP.rename(staging, final);
          });
          yield* rounds.select(created.root, {
            buildId,
            directory,
            sourceId: null,
            engine: "godot",
            target: "Web",
            entry: "game.html",
          });

          const packaged = yield* game.packageWeb(created.threadId);
          expect(packaged.buildId).toBe(buildId);
          expect(packaged.sourceEntry).toBe("game.html");
          expect(packaged.entry).toBe("index.html");
          expect(packaged.notes.join(" ")).toContain("stored as index.html");
          const expectedArchiveFiles = hashed!.files
            .map((file) => (file.path === "game.html" ? "index.html" : file.path))
            .sort();
          expect(packaged.files.map((file) => file.path).sort()).toEqual(expectedArchiveFiles);
          const archive = yield* Effect.promise(() => NodeFSP.readFile(packaged.archivePath));
          expect(packaged.bytes).toBe(archive.byteLength);
          expect(packaged.sha256).toBe(sha256(archive));

          const siteRoot = NodePath.join(parent, "custom-entry-site");
          const extractedRoot = NodePath.join(siteRoot, "extracted");
          yield* Effect.promise(() => NodeFSP.mkdir(siteRoot, { recursive: true }));
          const extracted = yield* Effect.promise(() =>
            extractArchive(packaged.archivePath, extractedRoot),
          );
          expect(extracted.map((file) => file.path)).not.toContain("game.html");
          const originalByPath = new Map(hashed!.files.map((file) => [file.path, file]));
          const extractedByPath = new Map(extracted.map((file) => [file.path, file]));
          expect(extractedByPath.has("index.html")).toBe(true);
          for (const name of ["index.html", "game.js", "game.wasm", "game.pck"]) {
            const original =
              name === "index.html" ? originalByPath.get("game.html") : originalByPath.get(name);
            expect(original, name).toBeDefined();
            expect(extractedByPath.get(name)?.sha256, name).toBe(original!.sha256);
          }
          const originalHtml = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(final, "game.html")),
          );
          const extractedHtml = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(extractedRoot, "index.html")),
          );
          expect(extractedHtml.equals(originalHtml)).toBe(true);
          const html = extractedHtml.toString("utf8");
          expect(html).toContain('src="game.js"');
          expect(html).toContain('"executable":"game"');
          expect(html).not.toContain('src="index.js"');

          const url = yield* preview.open(siteRoot, "extracted");
          const served = {
            "index.html": yield* Effect.promise(() =>
              fetchExact(new URL("index.html", url).href, "index.html"),
            ),
            "game.js": yield* Effect.promise(() =>
              fetchExact(new URL("game.js", url).href, "game.js"),
            ),
            "game.wasm": yield* Effect.promise(() =>
              fetchExact(new URL("game.wasm", url).href, "game.wasm"),
            ),
            "game.pck": yield* Effect.promise(() =>
              fetchExact(new URL("game.pck", url).href, "game.pck"),
            ),
          };
          for (const [name, bytes] of Object.entries(served)) {
            const original =
              name === "index.html" ? originalByPath.get("game.html") : originalByPath.get(name);
            expect(sha256(bytes), name).toBe(original!.sha256);
          }

          const projectText = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(created.root, "godot/project.godot"), "utf8"),
          );
          const viewport = parseGodotViewport(projectText);
          const played = yield* GameWebPlaytest.playtest({
            executable: browserExecutable!,
            url,
            profileDirectory: NodePath.join(parent, "custom-entry-playtest-profile"),
            width: viewport.width,
            height: viewport.height,
            bootTimeoutMs: 45_000,
            steps: [
              { key: "ArrowRight", holdMs: 600 },
              { key: "ArrowRight", holdMs: 600 },
            ],
            captureAllSteps: true,
            probeRequired: true,
            acceptance: null,
          });
          expect(played.booted, played.message).toBe(true);
          expect(played.responded, played.message).toBe(true);
          expect(played.executedInputSteps ?? 0).toBe(2);
          const consoleErrors = played.consoleMessages.filter(
            (message) => message.level === "error",
          );
          expect(consoleErrors.map((message) => message.text)).toEqual([]);
          expect(played.state?.playerMoved ?? 0).toBeGreaterThan(0.75);
          const statusAfterPackage = yield* game.status(created.threadId);

          if (evidenceDirectory !== undefined) {
            yield* Effect.promise(async () => {
              const target = NodePath.join(evidenceDirectory, "web-package-custom-entry");
              await NodeFSP.mkdir(target, { recursive: true });
              await NodeFSP.copyFile(packaged.archivePath, NodePath.join(target, "game-web.zip"));
              await NodeFSP.copyFile(
                NodePath.join(extractedRoot, "index.html"),
                NodePath.join(target, "index.html"),
              );
              const frames: string[] = [];
              for (const [index, frame] of played.screenshots.entries()) {
                const bytes = Buffer.from(frame.data, "base64");
                expect(bytes.subarray(0, 8)).toEqual(
                  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                );
                const name = `frame-${String(index + 1).padStart(2, "0")}-${frame.label}.png`;
                await NodeFSP.writeFile(NodePath.join(target, name), bytes);
                frames.push(name);
              }
              await NodeFSP.writeFile(
                NodePath.join(target, "proof.json"),
                `${JSON.stringify(
                  {
                    selectedBuildId: buildId,
                    selectedBuildAfterPackage: statusAfterPackage.selectedBuildId,
                    package: {
                      archive: "game-web.zip",
                      archivePath: packaged.archivePath,
                      bytes: packaged.bytes,
                      sha256: packaged.sha256,
                      entry: packaged.entry,
                      sourceEntry: packaged.sourceEntry,
                      files: packaged.files,
                    },
                    sourceExport: {
                      directory,
                      entry: "game.html",
                      files: hashed!.files,
                    },
                    extracted: {
                      root: extractedRoot,
                      files: extracted,
                    },
                    htmlReferences: {
                      script: "game.js",
                      executable: "game",
                      gameHtmlBytes: originalHtml.byteLength,
                    },
                    servedOverHttp: Object.fromEntries(
                      Object.entries(served).map(([path, bytes]) => [
                        path,
                        { bytes: bytes.byteLength, sha256: sha256(bytes) },
                      ]),
                    ),
                    playtestFromExtractedBytes: {
                      booted: played.booted,
                      responded: played.responded,
                      executedInputSteps: played.executedInputSteps,
                      consoleErrors: consoleErrors.length,
                      interaction: played.interaction,
                      state: played.state,
                      message: played.message,
                      frames,
                    },
                  },
                  null,
                  2,
                )}\n`,
              );
            });
          }
          yield* Effect.log(
            `Custom entry real run: ${packaged.message} ZIP ${packaged.sha256}; game.html -> index.html; playback booted=${played.booted} responded=${played.responded} errors=${consoleErrors.length}; frames=${played.screenshots.length}`,
          );
        }).pipe(Effect.provide(dependencies)),
      );
    }),
  900_000,
);
