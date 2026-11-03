import { expect, it } from "@effect/vitest";
import { parseMemAvailable } from "./liveProcess.ts";

it("reads MemAvailable in bytes and nothing else", () => {
  const meminfo =
    "MemTotal:       16025956 kB\nMemFree:          601964 kB\nMemAvailable:    5085896 kB\nBuffers:             308 kB\n";
  expect(parseMemAvailable(meminfo)).toBe(5085896 * 1024);
  // Kernels before 3.14 have no MemAvailable; the guard is then off, not wrong.
  expect(
    parseMemAvailable("MemTotal:       16025956 kB\nMemFree:          601964 kB\n"),
  ).toBeNull();
});
