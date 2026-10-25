// @effect-diagnostics nodeBuiltinImport:off -- Test fixtures write real build bytes into a temporary game folder.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Yauzl from "yauzl";
import type { GameSelectedBuild } from "@t3tools/contracts";
import { candidateBuildDirectory, hashWebBuildDirectory } from "./webBuild.ts";

export const writeFixtureFiles = async (
  directory: string,
  files: Readonly<Record<string, string | Buffer>>,
) => {
  for (const [path, bytes] of Object.entries(files)) {
    const target = NodePath.join(directory, ...path.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, bytes);
  }
};

/** Writes a build under its content-addressed directory and returns its record. */
export const writeWebBuildFixture = async (
  root: string,
  files: Readonly<Record<string, string | Buffer>> = {
    "index.html": '<html><script src="index.js"></script></html>',
    "index.js": "console.log('game')",
    "index.wasm": Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    "index.pck": "pck",
    "assets/data.bin": Buffer.from([1, 2, 3]),
  },
  entry = "index.html",
  sourceId: string | null = "source".repeat(10),
) => {
  const staging = NodePath.join(root, "builds/candidates", `staging-${NodeCrypto.randomUUID()}`);
  await writeFixtureFiles(staging, files);
  const hashed = await hashWebBuildDirectory(staging);
  if (hashed === null) throw new Error("The test build did not hash.");
  const directory = candidateBuildDirectory(hashed.buildId);
  const final = NodePath.join(root, directory);
  await NodeFSP.mkdir(NodePath.dirname(final), { recursive: true });
  await NodeFSP.rename(staging, final);
  const selected: GameSelectedBuild = {
    buildId: hashed.buildId,
    directory,
    sourceId,
    engine: "godot",
    target: "Web",
    entry,
    promotedAt: "2026-10-25T00:00:00.000Z",
    roundId: null,
  };
  return { selected, directory, hashed };
};

export const readZipArchive = (path: string) =>
  new Promise<Map<string, Buffer>>((resolve, reject) => {
    Yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("The test archive could not be opened."));
        return;
      }
      const entries = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry: Yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`Could not read ${entry.fileName}.`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });

export const sha256Of = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
