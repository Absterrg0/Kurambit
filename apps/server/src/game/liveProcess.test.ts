import { expect, it } from "@effect/vitest";
import { parseMemAvailable, shortfallDetail } from "./liveProcess.ts";

it("reads MemAvailable in bytes and nothing else", () => {
  const meminfo =
    "MemTotal:       16025956 kB\nMemFree:          601964 kB\nMemAvailable:    5085896 kB\nBuffers:             308 kB\n";
  expect(parseMemAvailable(meminfo)).toBe(5085896 * 1024);
  // Kernels before 3.14 have no MemAvailable; the guard is then off, not wrong.
  expect(
    parseMemAvailable("MemTotal:       16025956 kB\nMemFree:          601964 kB\n"),
  ).toBeNull();
});

it("refuses only when known available memory is under the need, and names both", () => {
  const MB = 1024 * 1024;
  expect(shortfallDetail("bot run", 1536, undefined, 2048 * MB)).toBeNull();
  // Without /proc the guard is off, never a refusal.
  expect(shortfallDetail("bot run", 1536, undefined, null)).toBeNull();
  expect(shortfallDetail("bot run", 1536, undefined, 1024 * MB)).toBe(
    "The bot run needs about 1.5 GB of free memory to open safely and this machine has 1.0 GB available. Opening it now risks the system killing it mid-work, or the whole machine hanging on swap.",
  );
  // The env override replaces the need in whole MB; 0 turns the check off; junk is ignored.
  expect(shortfallDetail("bot run", 1536, "4096", 3000 * MB)).toContain("about 4.0 GB");
  expect(shortfallDetail("bot run", 1536, "0", 1)).toBeNull();
  expect(shortfallDetail("bot run", 1536, "lots", 1024 * MB)).toContain("about 1.5 GB");
});
