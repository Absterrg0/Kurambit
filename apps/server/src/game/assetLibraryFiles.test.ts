// @effect-diagnostics nodeBuiltinImport:off -- Builds hand-made archives on disk to prove the unpacker refuses them.
import { afterEach, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { entryProblem, pinProblem, unpackArchive, type UnpackLimits } from "./assetLibraryFiles.ts";

interface Member {
  readonly name: string;
  readonly data: Buffer;
  /** Unix mode in the external attributes; 0o100644 is a regular file. */
  readonly mode?: number;
  /** Deflate the data and claim this uncompressed size, as a zip bomb would. */
  readonly inflatesFrom?: number;
}

/** A minimal ZIP writer, so a test can write names, modes and sizes no tool would. */
const zip = (members: ReadonlyArray<Member>) => {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const crc = NodeZlib.crc32(member.data);
    const deflated = member.inflatesFrom !== undefined;
    const data = deflated ? NodeZlib.deflateRawSync(member.data) : member.data;
    const size = member.inflatesFrom ?? member.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflated ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(deflated ? 8 : 0, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((member.mode ?? 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

const LIMITS: UnpackLimits = { entries: 16, bytes: 64 * 1024, entryBytes: 32 * 1024 };

const unpack = (members: ReadonlyArray<Member>, limits = LIMITS) =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "assetlib-")),
    );
    roots.push(root);
    const archive = NodePath.join(root, "pack.zip");
    const target = NodePath.join(root, "pack", "files");
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(archive, zip(members));
    });
    const exit = yield* Effect.exit(unpackArchive(archive, target, limits));
    return { root, target, exit };
  });
const absent = (path: string) =>
  Effect.promise(() =>
    NodeFSP.lstat(path).then(
      () => false,
      () => true,
    ),
  );

const reasonOf = (exit: Exit.Exit<unknown, { readonly reason: string }>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.reason
    : undefined;

it.effect("unpacks plain files and folders", () =>
  Effect.gen(function* () {
    const { target, exit } = yield* unpack([
      { name: "Tiles/", data: Buffer.alloc(0), mode: 0o040755 },
      { name: "Tiles/tile_0000.png", data: Buffer.from("png") },
      { name: "License.txt", data: Buffer.from("CC0") },
    ]);
    expect(Exit.isSuccess(exit)).toBe(true);
    const text = yield* Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(target, "Tiles/tile_0000.png"), "utf8"),
    );
    expect(text).toBe("png");
  }),
);

it.effect("refuses a member that climbs out of the pack and writes nothing outside", () =>
  Effect.gen(function* () {
    const { root, exit } = yield* unpack([
      { name: "ok.txt", data: Buffer.from("ok") },
      { name: "../../evil.txt", data: Buffer.from("evil") },
    ]);
    expect(reasonOf(exit)).toBe("unsafe-archive");
    expect(yield* absent(NodePath.join(root, "evil.txt"))).toBe(true);
    expect(yield* absent(NodePath.join(root, "pack", "evil.txt"))).toBe(true);
  }),
);

it.effect("refuses absolute paths and symbolic links", () =>
  Effect.gen(function* () {
    const absolute = yield* unpack([{ name: "/etc/evil", data: Buffer.from("x") }]);
    expect(reasonOf(absolute.exit)).toBe("unsafe-archive");
    const link = yield* unpack([
      { name: "link", data: Buffer.from("/etc/passwd"), mode: 0o120777 },
    ]);
    expect(reasonOf(link.exit)).toBe("unsafe-archive");
    expect(yield* absent(NodePath.join(link.target, "link"))).toBe(true);
  }),
);

it.effect("refuses archives past the entry and size limits", () =>
  Effect.gen(function* () {
    const many = Array.from({ length: 17 }, (_, i) => ({ name: `f${i}`, data: Buffer.from("x") }));
    expect(reasonOf((yield* unpack(many)).exit)).toBe("unsafe-archive");
    const big = yield* unpack([
      { name: "a", data: Buffer.alloc(30 * 1024) },
      { name: "b", data: Buffer.alloc(30 * 1024) },
      { name: "c", data: Buffer.alloc(30 * 1024) },
    ]);
    expect(reasonOf(big.exit)).toBe("unsafe-archive");
    // 1 MB of zeros deflates to about 1 KB and claims to be 16 bytes: it must stop at 16.
    const bomb = yield* unpack([{ name: "a", data: Buffer.alloc(1024 * 1024), inflatesFrom: 16 }]);
    expect(reasonOf(bomb.exit)).toBe("unsafe-archive");
  }),
);

it("names what is unsafe about a member", () => {
  const plain = {
    externalFileAttributes: 0o100644 << 16,
    generalPurposeBitFlag: 0,
    compressionMethod: 8,
  };
  expect(entryProblem({ ...plain, fileName: "Tiles/a.png" })).toBeNull();
  expect(entryProblem({ ...plain, fileName: "a/../../b" })).toMatch(/climbs/);
  expect(entryProblem({ ...plain, fileName: "C:/x" })).toMatch(/absolute/);
  expect(entryProblem({ ...plain, fileName: "a\\b" })).toMatch(/backslash/);
  expect(entryProblem({ ...plain, fileName: "a", generalPurposeBitFlag: 1 })).toMatch(/encrypted/);
  expect(entryProblem({ ...plain, fileName: "l", externalFileAttributes: 0o120777 << 16 })).toMatch(
    /link/,
  );
});

it("accepts only the pinned bytes", () => {
  const pin = { sha256: "a".repeat(64), bytes: 10 };
  expect(pinProblem(pin, { sha256: "a".repeat(64), bytes: 10 })).toBeNull();
  expect(pinProblem(pin, { sha256: "b".repeat(64), bytes: 10 })).toMatch(/Pinned sha256/);
  expect(pinProblem(pin, { sha256: "a".repeat(64), bytes: 11 })).not.toBeNull();
});
