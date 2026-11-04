import { expect, it } from "@effect/vitest";
import { UNITY_CLI_BUILDS, UV_BUILDS, plumbingHost, type PlumbingHost } from "./plumbingBuilds.ts";

const HOSTS: ReadonlyArray<PlumbingHost> = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
];

// How each vendor spells an OS and a CPU in its file names.
const SPELLING = {
  uv: { linux: "linux", darwin: "apple-darwin", win32: "windows", x64: "x86_64", arm64: "aarch64" },
  unity: { linux: "linux", darwin: "darwin", win32: "windows", x64: "x64", arm64: "arm64" },
} as const;

it("names one official, checksummed build per OS and CPU", () => {
  for (const [table, origin, spelling] of [
    [UV_BUILDS, "https://github.com/astral-sh/uv/releases/download/", SPELLING.uv],
    [UNITY_CLI_BUILDS, "https://public-cdn.cloud.unity3d.com/hub/prod/cli/", SPELLING.unity],
  ] as const) {
    expect(Object.keys(table).toSorted()).toEqual([...HOSTS].toSorted());
    const hashes = new Set<string>();
    for (const host of HOSTS) {
      const build = table[host];
      const [os, cpu] = host.split("-") as ["linux" | "darwin" | "win32", "x64" | "arm64"];
      const file = build.url.slice(build.url.lastIndexOf("/") + 1);
      expect(build.url.startsWith(origin)).toBe(true);
      expect(file).toContain(spelling[os]);
      expect(file).toContain(spelling[cpu]);
      expect(build.sha256).toMatch(/^[0-9a-f]{64}$/);
      hashes.add(build.sha256);
    }
    expect(hashes.size).toBe(HOSTS.length);
  }
  expect(UV_BUILDS["win32-x64"].url.endsWith(".zip")).toBe(true);
  expect(UV_BUILDS["darwin-arm64"].dir).toBe("uv-aarch64-apple-darwin");
  expect(plumbingHost("win32", "arm64")).toBe("win32-arm64");
  expect(plumbingHost("freebsd", "x64")).toBeNull();
  expect(plumbingHost("linux", "ia32")).toBeNull();
});
