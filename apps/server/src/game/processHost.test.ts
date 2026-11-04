import { expect, it } from "@effect/vitest";
import {
  HOST_OS,
  isOurLaunch,
  launchToken,
  processFacts,
  spawnOwned,
  stopRecorded,
  type ProcessFacts,
} from "./processHost.ts";

const facts = (overrides: Partial<ProcessFacts> = {}): ProcessFacts => ({
  pid: 4242,
  ppid: 1,
  pgid: 4242,
  start: "12345",
  exe: "/usr/bin/Xvfb",
  argv: ["/usr/bin/Xvfb", ":251"],
  command: "/usr/bin/Xvfb :251",
  ...overrides,
});

it("owns a launch only when pid, start time and token all match", () => {
  const token = launchToken();
  const record = { pid: 4242, start: "12345", token };
  expect(isOurLaunch(record, facts(), [token])).toBe(true);
  expect(isOurLaunch(record, facts({ argv: ["/x", token] }), [])).toBe(true);
  expect(isOurLaunch(record, facts({ argv: null, command: `/x ${token}` }), [])).toBe(true);
  // A reused pid has another start time, whatever it carries.
  expect(isOurLaunch(record, facts({ start: "99999" }), [token])).toBe(false);
  // The user's own process at the recorded pid and start carries no token of ours.
  expect(isOurLaunch(record, facts(), [])).toBe(false);
  expect(isOurLaunch(record, facts(), [launchToken()])).toBe(false);
  expect(isOurLaunch(record, null, [token])).toBe(false);
  // Records an agent could write: malformed tokens, pid 1, missing fields.
  expect(isOurLaunch({ ...record, token: "anything" }, facts({ argv: ["anything"] }), [])).toBe(
    false,
  );
  expect(isOurLaunch({ ...record, pid: 1 }, facts({ pid: 1 }), [token])).toBe(false);
  expect(isOurLaunch({ pid: 4242, token }, facts(), [token])).toBe(false);
});

it.skipIf(HOST_OS !== "linux")(
  "never signals a live process whose record does not verify",
  async () => {
    const owned = spawnOwned("sleep", ["30"], { env: process.env, stdio: "ignore", tree: true });
    const record = await owned.record;
    expect(record).not.toBeNull();
    try {
      await stopRecorded([{ ...record!, start: "1" }], { waitMs: 200 });
      await stopRecorded([{ ...record!, token: launchToken() }], { waitMs: 200 });
      await stopRecorded([{ ...record!, pid: record!.pid + 1 }], { waitMs: 200 });
      expect(owned.running()).toBe(true);
      await stopRecorded([record], { waitMs: 2_000 });
      expect(await processFacts(record!.pid)).toBeNull();
    } finally {
      await owned.stop({ graceMs: 200 });
    }
  },
);

it.skipIf(HOST_OS !== "linux")("a tree stop ends what the child started", async () => {
  const owned = spawnOwned("sh", ["-c", "sleep 30 & echo $!; wait"], {
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"],
    tree: true,
  });
  const grandchild = await new Promise<number>((resolve) =>
    owned.child.stdout?.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))),
  );
  expect(await processFacts(grandchild)).not.toBeNull();
  await owned.stop({ graceMs: 1_000 });
  expect(owned.alive()).toBe(false);
  expect(await processFacts(grandchild)).toBeNull();
});
