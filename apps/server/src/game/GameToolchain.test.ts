// @effect-diagnostics nodeBuiltinImport:off -- The test stages real files on disk, as the code under test reads them.
import { afterEach, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { verifiedFile } from "./GameToolchain.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await NodeFSP.rm(dir, { recursive: true, force: true });
});

it("counts a Blender extension as installed only with exactly its pinned bytes", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "extension-"));
  dirs.push(dir);
  const zip = NodePath.join(dir, "mpfb.zip");
  const bytes = Buffer.from("the pinned extension");
  const pin = {
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  expect(await verifiedFile(zip, pin)).toBe(false);
  await NodeFSP.writeFile(zip, bytes);
  expect(await verifiedFile(zip, pin)).toBe(true);
  // Same size, other bytes: replaced on disk after it was verified.
  await NodeFSP.writeFile(zip, Buffer.from("the pinned extensioN"));
  expect(await verifiedFile(zip, pin)).toBe(false);
  // A link to the right bytes is not the installed file.
  const real = NodePath.join(dir, "real.zip");
  await NodeFSP.writeFile(real, bytes);
  await NodeFSP.rm(zip);
  await NodeFSP.symlink(real, zip);
  expect(await verifiedFile(zip, pin)).toBe(false);
});
