/**
 * The harness plumbing Kurambit fetches itself (never the user's engines or
 * tools), as one table per tool: the vendor's official build for each OS and
 * CPU, and the SHA-256 the vendor published for it. Every fetch goes through
 * one path (GameToolchain) that downloads, checks the hash, then unpacks.
 *
 * - uv 0.9.8: the GitHub release's per-asset `.sha256` files and sizes
 *   (https://github.com/astral-sh/uv/releases/tag/0.9.8).
 *
 * ffmpeg is not fetched: it is found like Blender (PATH or KURAMBIT_FFMPEG).
 */
export type PlumbingHost = `${"linux" | "darwin" | "win32"}-${"x64" | "arm64"}`;

export interface PlumbingBuild {
  readonly url: string;
  readonly sha256: string;
  /** The vendor's published size: the download stops past it. */
  readonly bytes: number;
  /** A tar.gz or zip archive (tar reads both on every OS), or null for the executable itself. */
  readonly archive: "tar" | null;
  /** Where the executables sit after unpacking, relative to where it was unpacked. */
  readonly dir: string;
}

export const plumbingHost = (platform: NodeJS.Platform, arch: string): PlumbingHost | null =>
  (platform === "linux" || platform === "darwin" || platform === "win32") &&
  (arch === "x64" || arch === "arm64")
    ? `${platform}-${arch}`
    : null;

export const UV_VERSION = "0.9.8";

const uv = (
  triple: string,
  extension: "tar.gz" | "zip",
  sha256: string,
  bytes: number,
): PlumbingBuild => ({
  url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.${extension}`,
  sha256,
  bytes,
  archive: "tar",
  // The tarballs hold a uv-<triple>/ folder; the Windows zips hold the files at their root.
  dir: extension === "zip" ? "." : `uv-${triple}`,
});

export const UV_BUILDS: Readonly<Record<PlumbingHost, PlumbingBuild>> = {
  "linux-x64": uv(
    "x86_64-unknown-linux-gnu",
    "tar.gz",
    "950bad4899800ab158db97081b30a601a3ff4237d705756fda8695342cfcc20a",
    21_384_900,
  ),
  "linux-arm64": uv(
    "aarch64-unknown-linux-gnu",
    "tar.gz",
    "8dc203a27c99f721545adc531279f0486ea3deb77c951a051e6bb9ea1d588a71",
    20_204_197,
  ),
  "darwin-x64": uv(
    "x86_64-apple-darwin",
    "tar.gz",
    "10423293b0b11ed019551a0cd3e5d6d66e2799fab25dd2403e1d63cc883eb671",
    19_707_653,
  ),
  "darwin-arm64": uv(
    "aarch64-apple-darwin",
    "tar.gz",
    "c021ce28988acbbfcb496e68cd9f2f6ba6401cc6d3292a5d25313873f825e002",
    18_245_333,
  ),
  "win32-x64": uv(
    "x86_64-pc-windows-msvc",
    "zip",
    "bb94629392b11d49f202e748d5842a0c89ebe570c152ad8ea1425ece01dc4222",
    20_840_146,
  ),
  "win32-arm64": uv(
    "aarch64-pc-windows-msvc",
    "zip",
    "911f354690319ef93f434ecaccd6a893861d231a2af0466b495edee9313d5759",
    19_403_408,
  ),
};
