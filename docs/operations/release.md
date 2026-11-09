# Releases

> For maintainers. Using Kurambit? See [docs/user](../user/).

There is no release workflow. `release.yml`, `release-desktop.yml`, the macOS PR preview
workflows, AUR publishing, the hosted web preview and the mobile workflows were removed in
`b9494c87d`. Nothing in this repository publishes a GitHub Release, npm package, AUR package,
hosted web app or announcement.

## What CI runs

- [`ci.yml`](../../.github/workflows/ci.yml) on pull requests, pushes to `main`, and manual
  dispatch: lint and unused-code checks, `vp run build:desktop` and typecheck on Linux, the test
  shards, the Rust checks, and **Release Smoke**. Release Smoke runs
  [`scripts/release-smoke.ts`](../../scripts/release-smoke.ts), which exercises the version-bump,
  nightly-resolution and update-manifest scripts against a copy of the workspace. The Test job also
  runs `.github/scripts/check-nightly-release.test.cjs`.
- [`windows-tests.yml`](../../.github/workflows/windows-tests.yml), manual only, runs one package's
  tests, or every package with the server in ten shards, on Windows. It builds no installer.

No workflow builds a desktop installer.

## Build a desktop app by hand

Build on the platform you target. Artifacts land in `release/`, or in `--output-dir`.

| Target                 | Command                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| macOS DMG              | `vp run dist:desktop:dmg:arm64` or `vp run dist:desktop:dmg:x64` |
| Linux x64 AppImage     | `vp run dist:desktop:linux`                                      |
| Windows NSIS installer | `vp run dist:desktop:win:x64` or `vp run dist:desktop:win:arm64` |

Builds are unsigned unless you pass `--signed` (or set `KURAMBIT_DESKTOP_SIGNED=true`):

- macOS: the Developer ID certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`), notarization
  (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), and for passkeys
  `KURAMBIT_APPLE_TEAM_ID` and `KURAMBIT_MACOS_PROVISIONING_PROFILE`.
- Windows: Azure Trusted Signing (`AZURE_TRUSTED_SIGNING_ENDPOINT`,
  `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`,
  `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`).

Publishing the artifacts is manual.

The removed workflow's helpers remain in `scripts/` (CLI archive and npm launcher builds, macOS
signing, update-manifest merging, release notes, version bumps). Only Release Smoke and their unit
tests run them.
