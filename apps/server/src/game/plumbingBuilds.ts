/**
 * The harness plumbing Kurambit fetches itself (never the user's engines or
 * tools), as one table per tool: the vendor's official build for each OS and
 * CPU, and the SHA-256 the vendor published for it. Every fetch goes through
 * one path (GameToolchain) that downloads, checks the hash, then unpacks.
 *
 * - uv 0.9.8: the GitHub release's per-asset `.sha256` files
 *   (https://github.com/astral-sh/uv/releases/tag/0.9.8).
 * - Unity CLI 1.0.0-beta.15: the `binaries` of its manifest,
 *   https://public-cdn.cloud.unity3d.com/hub/prod/cli/1.0.0-beta.15/latest.json.
 *
 * ffmpeg is not fetched: it is found like the engines (PATH or KURAMBIT_FFMPEG).
 */
export type PlumbingHost = `${"linux" | "darwin" | "win32"}-${"x64" | "arm64"}`;

export interface PlumbingBuild {
  readonly url: string;
  readonly sha256: string;
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

const uv = (triple: string, extension: "tar.gz" | "zip", sha256: string): PlumbingBuild => ({
  url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.${extension}`,
  sha256,
  archive: "tar",
  // The tarballs hold a uv-<triple>/ folder; the Windows zips hold the files at their root.
  dir: extension === "zip" ? "." : `uv-${triple}`,
});

export const UV_BUILDS: Readonly<Record<PlumbingHost, PlumbingBuild>> = {
  "linux-x64": uv(
    "x86_64-unknown-linux-gnu",
    "tar.gz",
    "950bad4899800ab158db97081b30a601a3ff4237d705756fda8695342cfcc20a",
  ),
  "linux-arm64": uv(
    "aarch64-unknown-linux-gnu",
    "tar.gz",
    "8dc203a27c99f721545adc531279f0486ea3deb77c951a051e6bb9ea1d588a71",
  ),
  "darwin-x64": uv(
    "x86_64-apple-darwin",
    "tar.gz",
    "10423293b0b11ed019551a0cd3e5d6d66e2799fab25dd2403e1d63cc883eb671",
  ),
  "darwin-arm64": uv(
    "aarch64-apple-darwin",
    "tar.gz",
    "c021ce28988acbbfcb496e68cd9f2f6ba6401cc6d3292a5d25313873f825e002",
  ),
  "win32-x64": uv(
    "x86_64-pc-windows-msvc",
    "zip",
    "bb94629392b11d49f202e748d5842a0c89ebe570c152ad8ea1425ece01dc4222",
  ),
  "win32-arm64": uv(
    "aarch64-pc-windows-msvc",
    "zip",
    "911f354690319ef93f434ecaccd6a893861d231a2af0466b495edee9313d5759",
  ),
};

export const UNITY_CLI_VERSION = "1.0.0-beta.15";

const unityCli = (file: string, sha256: string): PlumbingBuild => ({
  url: `https://public-cdn.cloud.unity3d.com/hub/prod/cli/${UNITY_CLI_VERSION}/${file}`,
  sha256,
  archive: null,
  dir: ".",
});

export const UNITY_CLI_BUILDS: Readonly<Record<PlumbingHost, PlumbingBuild>> = {
  "linux-x64": unityCli(
    "unity-linux-x64",
    "cf3ddef260bba536332348bd5570fb80d90a8092784a893b30971f8ebf2a489e",
  ),
  "linux-arm64": unityCli(
    "unity-linux-arm64",
    "919178bee9ba827f4f52b0fc5e713fcae663abf23512db73488dbcdb2342295f",
  ),
  "darwin-x64": unityCli(
    "unity-darwin-x64",
    "865ed9de4dd13a4bcb331a343770dee66c8babefb6e1ad98f1256c5296ad1674",
  ),
  "darwin-arm64": unityCli(
    "unity-darwin-arm64",
    "1e9e09d429062338dc6a56290075829e731763a9b3a3b6c963f3be0c12b248f4",
  ),
  "win32-x64": unityCli(
    "unity-windows-x64.exe",
    "d0b19648ec313017958649abf524b8779fb0aadcdeb65ff7bb54a96bb1c1f0bb",
  ),
  "win32-arm64": unityCli(
    "unity-windows-arm64.exe",
    "d871f7b6d84c9e414eb16a52258c4730a75ca215166249a3eb3e0cb1574b13da",
  ),
};
