// @effect-diagnostics nodeBuiltinImport:off -- Writes scratch sources and archives on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { openZipArchive, writeZipArchive, type ZipSource } from "./zipArchive.ts";

const sha256 = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const source = (path: string, name: string, bytes: Buffer): ZipSource => ({
  name,
  size: bytes.byteLength,
  mtime: DateTime.toDate(DateTime.makeUnsafe("2024-05-06T07:08:10Z")),
  sha256: sha256(bytes),
  open: async () => NodeFS.createReadStream(path),
});

it.effect("stores sources byte for byte and refuses one that changed since it was hashed", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-zip-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const files = {
      "index.html": Buffer.from("<!doctype html>\n"),
      "assets/empty.bin": Buffer.alloc(0),
      "assets/big.bin": NodeCrypto.randomBytes(3 * 1024 * 1024 + 7),
    };
    const sources = Object.entries(files).map(([name, bytes]) => {
      const path = NodePath.join(root, "src", name);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, bytes);
      return source(path, name, bytes);
    });
    const archive = NodePath.join(root, "game.zip");
    const written = yield* writeZipArchive(archive, sources, (failure) => failure);
    expect(written.bytes).toBe(NodeFS.statSync(archive).size);
    expect(written.sha256).toBe(sha256(NodeFS.readFileSync(archive)));
    expect(written.files).toEqual(
      Object.entries(files).map(([name, bytes]) => ({
        name,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      })),
    );

    const zip = yield* openZipArchive(archive, (detail) => detail);
    const read: Record<string, string> = {};
    for (let entry = yield* zip.next; entry !== null; entry = yield* zip.next) {
      expect(entry.compressionMethod).toBe(0);
      const stream = yield* zip.streamEntry(entry);
      const chunks: Buffer[] = [];
      yield* Effect.promise(async () => {
        for await (const chunk of stream) chunks.push(chunk as Buffer);
      });
      read[entry.fileName] = sha256(Buffer.concat(chunks));
    }
    expect(read).toEqual(
      Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])),
    );

    // Same size, different bytes: the edit lands after hashing and before archiving.
    NodeFS.writeFileSync(NodePath.join(root, "src", "index.html"), "<!doctype htm!\n");
    const refused = yield* Effect.flip(
      writeZipArchive(NodePath.join(root, "refused.zip"), sources, (failure) => failure),
    );
    expect(refused.changed).toBe(true);
    expect(refused.source?.name).toBe("index.html");
  }).pipe(Effect.scoped),
);
